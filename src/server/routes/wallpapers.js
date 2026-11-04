/**
 * 壁纸管理接口（都需要登录）：
 *   GET    /api/admin/wallpapers       列表（可按状态/分类/类型/仅自己/关键词筛）
 *   POST   /api/admin/wallpapers       新建草稿（拿到 id 后再传文件）
 *   GET    /api/admin/wallpapers/:id
 *   PATCH  /api/admin/wallpapers/:id   改标题/分类/标签/状态/置顶
 *   PUT    /api/admin/wallpapers/:id/asset  上传原图或视频（原始二进制 body）
 *   DELETE /api/admin/wallpapers/:id   删除（连 R2 对象一起删）
 *   POST   /api/admin/wallpapers/reorder    重排
 */
import { Q } from '../queries.js';
import { all, batch, first, run, statement } from '../db.js';
import { MAX_UPLOAD_BYTES } from '../../core/image-meta.js';
import { nowMs } from '../db.js';
import { ACTION, assertCan, can } from '../../core/permissions.js';
import {
  cleanCategoryRef, cleanEnum, cleanId, has, parseLimit, parseWallpaperCreate, parseWallpaperPatch,
} from '../../core/validate.js';
import { KINDS, REVIEW_STATUSES, STATUSES } from '../../core/validate.js';
import { uniqueSlug } from '../../core/slug.js';
import {
  ALLOWED_MIME, isVideoMime, limitForMime, kindMatchesMime, readDurationMs, readMediaMeta, readVideoInfo,
} from '../../core/image-meta.js';
import {
  COMPLIANCE_HINT, checkVideoCompliance, complianceMessage, describeWarnings,
} from '../media-compliance.js';
import {
  badRequest, conflict, HttpError, internal, mediaNonCompliant, notFound, payloadTooLarge,
  storageVerifyFailed, tooManyRequests, unsupportedMedia,
} from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { wallpaperDto } from '../dto.js';
import { assetKey, deleteAsset, mediaBaseFor, putAsset, thumbKey, verifyAsset } from '../storage.js';
import { newId, safeJsonParse, sampleFingerprint, sha256Bytes } from '../util.js';
import { buildReorderPlan, nextSortOrder } from '../../core/ordering.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { MEDIA_ACTOR, setMediaIdentity } from '../media-audit.js';
import { allowedTagNames } from './tags.js';
import { hit } from '../rate-limit.js';
import { clientIp } from '../session.js';

/** 大文件跳过完整 sha256 的阈值；测试可用 env.UPLOAD_HASH_LIMIT 调小来覆盖大文件分支。 */
export const HASH_LIMIT = 40 * 1024 * 1024;
const DEFAULT_DAILY_BYTES = 1024 * 1024 * 1024;

/**
 * 上传限流：账号级 30 次/小时 + IP 级 60 次/小时，两层都要有。
 * 只做账号级的话，一个账号换 IP 就能绕过；只做 IP 级的话，同 IP 上多个账号会互相顶。
 * 已知局限：rate-limit.js 是 isolate 内存计数，不是全局配额（Cloudflare 控制台的
 * Rate Limiting 规则才是真正的兜底）。
 */
export const UPLOAD_ACTOR_MAX = 30;
export const UPLOAD_IP_MAX = 60;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

function assertUploadRate(actor, request) {
  const byActor = hit(`upload:${actor.id}`, { max: UPLOAD_ACTOR_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byActor.limited) throw tooManyRequests(`上传过于频繁，请 ${byActor.retryAfter} 秒后再试`);
  const byIp = hit(`upload-ip:${clientIp(request)}`, { max: UPLOAD_IP_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byIp.limited) throw tooManyRequests(`上传过于频繁，请 ${byIp.retryAfter} 秒后再试`);
}

/**
 * upload_usage 表来自 schema/013。缺表时只降级（跳过配额记账并 warn 一次），
 * 绝不让上传 500 —— 和 codec/faststart 的探测一个模式。
 */
let uploadUsageReady = null;
let warnedNoUsageTable = false;
async function supportsUploadUsage(env) {
  if (uploadUsageReady === true) return true;
  try {
    const rows = await all(env, Q.tableExists, 'upload_usage');
    if (rows.length > 0) {
      uploadUsageReady = true;
      return true;
    }
    if (!warnedNoUsageTable) {
      warnedNoUsageTable = true;
      console.warn('[upload] 没有 upload_usage 表（schema/013 未执行），跳过每日配额记账');
    }
    return false;
  } catch (error) {
    if (!warnedNoUsageTable) {
      warnedNoUsageTable = true;
      console.warn('[upload] 探测 upload_usage 表失败，跳过每日配额记账', error?.message ?? error);
    }
    return false;
  }
}

function usageDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** 每日字节配额（默认 1 GiB / 账号 / 天，env.UPLOAD_DAILY_BYTES 可调）。 */
async function assertDailyQuota(env, actor, bytes) {
  if (!(await supportsUploadUsage(env))) return;
  const limit = Number(env.UPLOAD_DAILY_BYTES ?? DEFAULT_DAILY_BYTES) || DEFAULT_DAILY_BYTES;
  try {
    const used = Number((await first(env, Q.uploadUsageGet, usageDay(), actor.id))?.bytes ?? 0);
    if (used + bytes > limit) {
      throw tooManyRequests('今天的上传容量已经用完，请明天再试');
    }
  } catch (error) {
    // 429 必须原样抛出去；其余（查库失败）只降级，不能让容量统计把上传卡死
    if (error instanceof HttpError) throw error;
    console.warn('[upload] 读取上传用量失败，跳过配额校验', error?.message ?? error);
  }
}

/** 记账失败不阻断上传：容量统计是审计用途，不能反过来把文件卡住。 */
async function recordDailyUsage(env, actor, bytes) {
  if (!(await supportsUploadUsage(env))) return;
  try {
    await run(env, Q.uploadUsageAdd, usageDay(), actor.id, bytes);
  } catch (error) {
    console.warn('[upload] 记录上传用量失败', error?.message ?? error);
  }
}

/**
 * content_fingerprint 列来自 schema/013。列不在就跳过指纹去重（老库照常能传）。
 * 只缓存「有」这个结果：缺列时保持每次探测，避免测试/灰度环境切换后被永久写死。
 */
let fingerprintColumnReady = null;
async function supportsFingerprintColumn(env) {
  if (fingerprintColumnReady === true) return true;
  try {
    const rows = await all(env, Q.wallpaperColumnExists, 'content_fingerprint');
    if (rows.length > 0) {
      fingerprintColumnReady = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function likePattern(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[%_\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned ? `%${cleaned}%` : null;
}

async function loadWallpaper(env, id) {
  const safeId = cleanId(id, 'id');
  const row = await first(env, Q.wallpaperById, safeId);
  if (!row) throw notFound('壁纸不存在');
  return row;
}

async function ensureCategory(env, categoryId) {
  if (!categoryId) return;
  const row = await first(env, Q.categoryById, categoryId);
  if (!row) throw badRequest('分类不存在', { field: 'categoryId' });
}

export async function list({ env, actor, url }) {
  assertCan(actor, ACTION.WALLPAPER_READ);
  const params = url.searchParams;
  const status = params.get('status') ? cleanEnum(params.get('status'), 'status', STATUSES) : null;
  const kind = params.get('kind') ? cleanEnum(params.get('kind'), 'kind', KINDS) : null;
  const review = params.get('review') ? cleanEnum(params.get('review'), 'review', REVIEW_STATUSES) : null;
  const categoryId = params.get('categoryId') ? cleanId(params.get('categoryId'), 'categoryId') : null;
  const mine = params.get('mine') === '1' || params.get('mine') === 'true';
  const likedOnly = params.get('liked') === '1' || params.get('liked') === 'true';
  const like = likePattern(params.get('q'));
  // 标签筛选：tags 存的是 JSON 数组，用 "%\"标签\"%" 精确匹配整个标签名。
  const tag = String(params.get('tag') ?? '').replace(/["%_\\]/g, '').trim().slice(0, 32);
  const tagLike = tag ? `%"${tag}"%` : null;
  const subtag = String(params.get('subtag') ?? '').replace(/[%_\\]/g, '').trim().slice(0, 40) || null;
  // 格式筛选：视频（mp4/webm）/ zip 包 / 图片
  const formatRaw = String(params.get('format') ?? '').trim();
  const format = ['video', 'zip', 'image'].includes(formatRaw) ? formatRaw : null;
  const limit = parseLimit(params.get('limit'), { def: 50, max: 200 });
  const offset = Math.min(100000, Math.max(0, Number(params.get('offset') ?? 0) || 0));

  const rows = await all(env, Q.adminListWallpapers, status, categoryId, kind, mine ? actor.id : null, like, tagLike, limit, offset, likedOnly ? actor.id : null, review, subtag, format);
  const total = Number((await first(env, Q.adminCountWallpapers, status, categoryId, kind, mine ? actor.id : null, like, tagLike, likedOnly ? actor.id : null, review, subtag, format))?.n ?? 0);

  return json({ items: rows.map((row) => wallpaperDto(row, { admin: true, mediaBase: mediaBaseFor(env) })), total, limit, offset });
}

export async function get({ env, actor, params }) {
  assertCan(actor, ACTION.WALLPAPER_READ);
  const row = await loadWallpaper(env, params.id);
  return json({ wallpaper: wallpaperDto(row, { admin: true, mediaBase: mediaBaseFor(env) }) });
}

/** 后台「子标签」筛选/输入提示；带 ?tag= 就只列那个标签下的子标签。 */
export async function subtags({ env, actor, url }) {
  assertCan(actor, ACTION.WALLPAPER_READ);
  const tag = String(url?.searchParams.get('tag') ?? '').replace(/[%_\\"]/g, '').trim().slice(0, 32);
  const rows = tag
    ? await all(env, Q.listSubtagsByTag, `%"${tag}"%`)
    : await all(env, Q.listSubtags);
  return json({ subtags: rows.map((row) => row.subtag) });
}

export async function create({ env, actor, request }) {
  assertCan(actor, ACTION.WALLPAPER_CREATE);
  const allowedTags = await allowedTagNames(env);
  const input = parseWallpaperCreate(await readJson(request), { allowedTags });
  await ensureCategory(env, input.categoryId);
  // 置顶影响首页，只给有发布权限的人
  if (input.featured) assertCan(actor, ACTION.WALLPAPER_PUBLISH);

  const slug = await uniqueSlug(
    input.slug || input.title,
    async (candidate) => Boolean(await first(env, Q.wallpaperSlugTaken, candidate)),
    { fallback: 'wallpaper' },
  );
  const sortOrder = nextSortOrder([{ sort_order: Number((await first(env, Q.maxWallpaperSort))?.m ?? 0) }]);
  const id = newId('wp');
  const now = nowMs();

  await run(
    env,
    Q.insertWallpaper,
    id, slug, input.title, input.description, input.subtag, input.reviewStatus,
    input.categoryId, input.kind, 'draft',
    null, null, 0, null, null, null,
    JSON.stringify(input.tags), input.featured ? 1 : 0, sortOrder, actor.id, now, now, null,
  );

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_CREATE,
    targetType: 'wallpaper',
    targetId: id,
    detail: `${input.title}（${input.kind === 'dynamic' ? '动态' : '静态'}）`,
  });

  const row = await first(env, Q.wallpaperById, id);
  return created({ wallpaper: wallpaperDto(row, { admin: true, mediaBase: mediaBaseFor(env) }) });
}

export async function update({ env, actor, request, params }) {
  const row = await loadWallpaper(env, params.id);
  assertCan(actor, ACTION.WALLPAPER_UPDATE, row);

  const allowedTags = await allowedTagNames(env);
  const patch = parseWallpaperPatch(await readJson(request), { allowedTags });

  // 发布状态与置顶都属于「上线动作」，编辑角色没有这个权限
  if (has(patch, 'status')) assertCan(actor, ACTION.WALLPAPER_PUBLISH, row);
  if (has(patch, 'featured')) assertCan(actor, ACTION.WALLPAPER_PUBLISH, row);
  if (has(patch, 'categoryId')) await ensureCategory(env, patch.categoryId);

  const nextKind = patch.kind ?? row.kind;
  if (patch.kind && row.mime && !kindMatchesMime(patch.kind, row.mime)) {
    throw badRequest(`已上传的文件是${row.mime.startsWith('video/') ? '视频' : '图片'}，不能改成${
      patch.kind === 'dynamic' ? '动态' : '静态'}壁纸`);
  }

  const nextStatus = patch.status ?? row.status;
  if (nextStatus === 'published' && !row.storage_key) {
    throw badRequest('请先上传壁纸文件再发布');
  }

  let publishedAt = row.published_at ?? null;
  if (nextStatus === 'published' && row.status !== 'published') publishedAt = nowMs();
  if (nextStatus !== 'published') publishedAt = null;

  const next = {
    title: patch.title ?? row.title,
    description: patch.description !== undefined ? patch.description : (row.description ?? ''),
    subtag: patch.subtag !== undefined ? patch.subtag : (row.subtag ?? ''),
    reviewStatus: patch.reviewStatus ?? row.review_status ?? 'pending',
    categoryId: patch.categoryId !== undefined ? patch.categoryId : row.category_id,
    tags: patch.tags ?? safeJsonParse(row.tags, []),
    featured: patch.featured !== undefined ? patch.featured : row.featured === 1,
    sortOrder: patch.sortOrder ?? Number(row.sort_order ?? 0),
  };

  const now = nowMs();
  await run(
    env,
    Q.updateWallpaper,
    row.slug, next.title, next.description, next.subtag, next.categoryId, nextKind, nextStatus,
    next.reviewStatus, JSON.stringify(next.tags), next.featured ? 1 : 0, next.sortOrder, now, publishedAt, row.id,
  );

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_UPDATE,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `字段：${Object.keys(patch).join(', ')}`,
  });

  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({ wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }) });
}

export async function upload({ env, actor, request, params }) {
  const row = await loadWallpaper(env, params.id);
  assertCan(actor, ACTION.ASSET_UPLOAD);
  assertCan(actor, ACTION.WALLPAPER_UPDATE, row);
  assertUploadRate(actor, request);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared && declared > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(`文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) throw badRequest('文件为空');
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(`文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }

  const meta = readMediaMeta(bytes);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的文件类型');
  if (!ALLOWED_MIME.includes(meta.mime)) throw unsupportedMedia(`不支持的类型：${meta.mime}`);
  if (bytes.byteLength > limitForMime(meta.mime)) {
    throw payloadTooLarge(`${meta.mime} 最大 ${Math.round(limitForMime(meta.mime) / 1024 / 1024)} MB`);
  }

  // 视频探针只解析 box 头，几 MB 的文件几毫秒；编码/帧率/faststart 全靠它。
  const videoInfo = readVideoInfo(bytes, meta.mime);

  /**
   * 播放合规体检（上传 / 替换都走这里）。
   *
   * Workers 没有 ffmpeg ⇒ 服务端只能「拒」，不能「转」。所以判违规时直接 422：
   * 此刻还没有 putAsset、没有 sha 去重、没有配额记账，更没有写 D1 —— 一个字节都不落盘。
   * 只有 warning 的情况照常入库，warning 记进 audit_log（action = wallpaper.asset_compliance_warn）。
   * 规则与本地工具 tools/prepare-upload.mjs 共用 src/server/media-compliance.js。
   */
  const compliance = isVideoMime(meta.mime)
    ? checkVideoCompliance({
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      fps: videoInfo.fps,
      codec: videoInfo.codec,
      faststart: videoInfo.faststart,
      bytes: bytes.byteLength,
    })
    : null;
  if (compliance && !compliance.ok) {
    throw mediaNonCompliant(complianceMessage(compliance), {
      mime: meta.mime,
      width: meta.width,
      height: meta.height,
      fps: videoInfo.fps,
      codec: videoInfo.codec,
      faststart: videoInfo.faststart,
      bytes: bytes.byteLength,
      violations: compliance.violations,
      warnings: compliance.warnings,
      hint: COMPLIANCE_HINT,
    });
  }

  // 每日字节配额：先校验再写盘，超了直接 429，别等 90MB 传完才拒
  await assertDailyQuota(env, actor, bytes.byteLength);

  // 类型不再让人手选：传视频就是动态、传图片就是静态；
  // zip 保留原来的类型（皮肤包是静态，开机动画包是动态）。
  const nextKind = meta.mime.startsWith('video/')
    ? 'dynamic'
    : meta.mime.startsWith('image/') ? 'static' : row.kind;

  // 大文件跳过完整 sha256：Worker 只有有限的 CPU 预算（免费档 10ms/请求），
  // 40MB+ 的 digest 会把它吃穿并抛 exceededCpu。也不能拿 Date.now() 当 key ——
  // 那样同一个文件每次上传都是新对象，R2 里只会堆垃圾。
  const hashLimit = Number(env.UPLOAD_HASH_LIMIT ?? HASH_LIMIT) || HASH_LIMIT;
  let sha = null;
  if (bytes.byteLength <= hashLimit) {
    sha = await sha256Bytes(bytes);
    const duplicate = await first(env, Q.wallpaperShaTaken, sha);
    if (duplicate && duplicate.id !== row.id) {
      throw conflict('这个文件已经在库里了', { wallpaperId: duplicate.id, title: duplicate.title });
    }
  }

  // 大文件没有完整 sha，用「首 1MB + 尾 1MB」的采样指纹做内容寻址：
  // 同一个文件稳定得到同一个 key（能去重、URL 不会每次都变），内容变了 key 基本必变。
  const keySeed = sha ?? await sampleFingerprint(bytes);

  // 指纹去重：只在 content_fingerprint 列存在时生效（schema/013；老库跳过）
  if (!sha && (await supportsFingerprintColumn(env))) {
    const duplicate = await first(env, Q.wallpaperFingerprintTaken, keySeed);
    if (duplicate && duplicate.id !== row.id) {
      throw conflict('这个文件已经在库里了', { wallpaperId: duplicate.id, title: duplicate.title });
    }
  }

  const key = assetKey(row.id, keySeed, meta.mime);

  if (!sha) {
    // 大文件不算完整 sha256，D1 的 sha256 列会是 NULL —— "全量下载比对 sha256" 这条验收
    // 对这一条记录无解。留一条 warn（而不是静默留空），让后来人知道这是设计取舍不是漏写；
    // 兜底只能靠 HEAD 长度 + Range 总量双长度检查（见 docs/UPLOAD-SOP.md 第 3 节）。
    console.warn(
      `[upload] sha256 skipped (>40MB), integrity verification unavailable — wallpaper=${row.id} size=${bytes.byteLength} hashLimit=${hashLimit} key=${key}`,
    );
  }

  await putAsset(env, key, bytes, meta.mime);

  // 写完立刻回读：D1 记账必须来自刚校验过的对象，否则就是「库里有、桶里没有」
  const check = await verifyAsset(env, key, bytes.byteLength);
  if (!check.ok) {
    await deleteAsset(env, key);
    throw storageVerifyFailed(check.reason === 'size'
      ? `上传校验失败：R2 里的对象大小不一致（写入 ${bytes.byteLength}，实际 ${check.size}）`
      : '上传校验失败：R2 里找不到刚写入的对象，请重试');
  }
  if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);

  // 视频顺便读时长：开机动画是按秒循环的，moov 位置决定能不能边下边播。
  // 编码/faststart/帧率在上面的合规体检里已经读过，这里复用 videoInfo，不重复解析。
  const durationMs = readDurationMs(bytes, meta.mime);
  // 媒体三列（storage_key/bytes/sha256）统一走 setMediaIdentity：
  // 它先 UPDATE，再把 schema/015 触发器刚写入的审计行补上 changed_by。
  await setMediaIdentity(env, row.id, {
    storageKey: key,
    mime: meta.mime,
    bytes: check.size,
    width: meta.width,
    height: meta.height,
    durationMs,
    sha256: sha,
    kind: nextKind,
    actor: row.storage_key ? MEDIA_ACTOR.REPLACE : MEDIA_ACTOR.UPLOAD,
  });
  await run(
    env, Q.markWallpaperVerified,
    nowMs(), videoInfo.codec, videoInfo.faststart, row.id,
  );

  // 大文件的内容指纹单独落进 content_fingerprint（schema/013；列不在就跳过）。
  // 刻意不写进 sha256：那一列是对外输出的真 sha256，写个采样值会让 dto 说谎。
  if (!sha && (await supportsFingerprintColumn(env))) {
    try {
      await run(env, Q.updateWallpaperFingerprint, keySeed, nowMs(), row.id);
    } catch (error) {
      console.warn('[upload] 写入 content_fingerprint 失败', error?.message ?? error);
    }
  }

  // 配额记账放在落盘校验通过之后：失败的上传不该占用户当天的额度
  await recordDailyUsage(env, actor, check.size);

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_ASSET,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `${meta.mime} ${meta.width ?? '?'}x${meta.height ?? '?'} ${Math.round(bytes.byteLength / 1024)}KB${
      durationMs ? ` ${(durationMs / 1000).toFixed(1)}s` : ''}`,
  });

  // 只有警告时照常入库，但要留痕：这些文件「能播」，只是不在目标规格里
  // （体积超限、WebM 容器、帧率探测不到）。查 warning 就查这个 action。
  if (compliance && compliance.warnings.length) {
    await writeAudit(env, {
      actor,
      action: AUDIT_ACTION.WALLPAPER_COMPLIANCE_WARN,
      targetType: 'wallpaper',
      targetId: row.id,
      detail: `${compliance.warnings.length} 项：${describeWarnings(compliance.warnings)}`,
    });
  }

  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({
    wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
    url: `/media/${key}`,
    ...(compliance ? { compliance: { warnings: compliance.warnings } } : {}),
  });
}

/**
 * 缩略图上传。图由浏览器 canvas 生成（Worker 没有图像解码能力），
 * 单独存 thumbs/ 前缀，列表页用它，详情页才加载原图。
 */
export async function uploadThumb({ env, actor, request, params }) {
  const row = await loadWallpaper(env, params.id);
  assertCan(actor, ACTION.ASSET_UPLOAD);
  assertCan(actor, ACTION.WALLPAPER_UPDATE, row);
  // 缩略图也计入同一套限流与配额：否则可以靠反复传小图把 R2 写爆
  assertUploadRate(actor, request);

  const MAX = 2 * 1024 * 1024;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX) throw payloadTooLarge('缩略图不能超过 2MB');

  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!bytes.byteLength) throw badRequest('缩略图是空的');
  if (bytes.byteLength > MAX) throw payloadTooLarge('缩略图不能超过 2MB');

  const meta = readMediaMeta(bytes);
  if (!meta.mime || !meta.mime.startsWith('image/')) throw unsupportedMedia('缩略图必须是图片');

  await assertDailyQuota(env, actor, bytes.byteLength);

  const sha = await sha256Bytes(bytes);
  const key = thumbKey(row.id, sha, meta.mime);
  await putAsset(env, key, bytes, meta.mime);
  const thumbCheck = await verifyAsset(env, key, bytes.byteLength);
  if (!thumbCheck.ok) {
    await deleteAsset(env, key);
    throw storageVerifyFailed('缩略图写入校验失败，请重试');
  }
  if (row.thumb_key && row.thumb_key !== key) await deleteAsset(env, row.thumb_key);
  await run(env, Q.updateWallpaperThumb, key, nowMs(), row.id);
  await recordDailyUsage(env, actor, bytes.byteLength);

  return json({ thumbUrl: `/media/${key}`, width: meta.width, height: meta.height });
}

export async function remove({ env, actor, params }) {
  assertCan(actor, ACTION.WALLPAPER_DELETE);
  const row = await loadWallpaper(env, params.id);
  await deleteAsset(env, row.storage_key);
  await run(env, Q.deleteWallpaper, row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_DELETE,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: row.title,
  });
  return json({ deleted: true, id: row.id });
}

/**
 * 一键把所有「已发布但未审核」的作品标记为已审核。
 * 公开接口只下发 approved，所以存量作品上线前必须走一次这里（或逐条在后台点审核）。
 */
export async function approveAll({ env, actor }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  await run(env, Q.approvePendingPublished, nowMs());
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_UPDATE,
    targetType: 'wallpaper',
    targetId: 'bulk',
    detail: '批量通过审核（已发布未审核）',
  });
  return json({ approved: true });
}

export async function reorder({ env, actor, request }) {
  assertCan(actor, ACTION.WALLPAPER_REORDER);
  const body = await readJson(request);
  if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');

  const scoped = has(body, 'categoryId');
  const categoryId = scoped ? cleanCategoryRef(body.categoryId) : null;

  const rows = scoped
    ? await all(env, Q.listWallpaperIdsInCategory, categoryId)
    : await all(env, Q.listAllWallpaperIds);

  const plan = buildReorderPlan(rows.map((r) => r.id), body.ids);
  const now = nowMs();
  await batch(env, plan.map((item) => statement(env, Q.updateWallpaperSort, item.sortOrder, now, item.id)));

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_REORDER,
    targetType: 'wallpaper',
    targetId: categoryId ?? 'all',
    detail: `重排 ${plan.length} 项`,
  });

  return json({ reordered: plan.length });
}

/** 前端用来判断按钮是否可点：把「能不能改某一条」的判定留在服务端。 */
export function describePermissions(actor, row) {
  return {
    canUpdate: can(actor, ACTION.WALLPAPER_UPDATE, row),
    canDelete: can(actor, ACTION.WALLPAPER_DELETE),
    canPublish: can(actor, ACTION.WALLPAPER_PUBLISH),
  };
}
