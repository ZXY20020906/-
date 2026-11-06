/**
 * 壁纸管理接口（都需要登录）：
 *   GET    /api/admin/wallpapers       列表（可按状态/分类/类型/仅自己/关键词筛）
 *   POST   /api/admin/wallpapers       新建草稿（拿到 id 后再传文件）
 *   POST   /api/admin/wallpapers/import  批量入口：一条文件 = 建草稿 + 入库 + 报告
 *   GET    /api/admin/wallpapers/:id
 *   PATCH  /api/admin/wallpapers/:id   改标题/分类/标签/状态/置顶
 *   PUT    /api/admin/wallpapers/:id/asset  上传原图或视频（原始二进制 body）
 *   PUT    /api/admin/wallpapers/:id/thumb  上传缩略图（浏览器 canvas 生成）
 *   DELETE /api/admin/wallpapers/:id   删除（连 R2 对象一起删）
 *   POST   /api/admin/wallpapers/reorder    重排
 *
 * ⚠️ 所有写 R2 + 媒体列的动作都在 `../ingest.js` 的 `ingestAsset()` 里，
 *    本文件只负责「鉴权 / 读请求 / 拼响应」。**不许**在这里直接 putAsset 或写媒体列：
 *    4.23.17 的事故就是某条批量路径绕过了合规体检。
 */
import { Q } from '../queries.js';
import { all, first, run, statement, batch, nowMs } from '../db.js';
import { MAX_UPLOAD_BYTES } from '../../core/image-meta.js';
import { THUMB_MAX_BYTES } from '../../core/media-limits.js';
import { specFromFileName } from '../../core/variant-label.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import {
  cleanCategoryRef, cleanEnum, cleanId, cleanLicense, cleanNullableText, has, parseLimit,
  parseWallpaperCreate, parseWallpaperPatch, AUTHOR_MAX, SOURCE_MAX,
} from '../../core/validate.js';
import { KINDS, REVIEW_STATUSES, STATUSES } from '../../core/validate.js';
import { kindMatchesMime } from '../../core/image-meta.js';
import {
  badRequest, notFound, payloadTooLarge, storageVerifyFailed, tooManyRequests, unsupportedMedia,
} from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { wallpaperDto } from '../dto.js';
import { deleteAsset, mediaBaseFor, putAsset as putR2, thumbKey, verifyAsset } from '../storage.js';
import { newId, safeJsonArray, sha256Bytes } from '../util.js';
import { buildReorderPlan } from '../../core/ordering.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { allowedTagNames } from './tags.js';
import { hit } from '../rate-limit.js';
import { clientIp } from '../session.js';
import { readMediaMeta } from '../../core/image-meta.js';
import {
  assertDailyQuota, buildImportReport, createWallpaperRow, importMedia, ingestAsset,
  recordDailyUsage,
} from '../ingest.js';

/** 大文件跳过完整 sha256 的阈值（真正的实现在 ingest.js，这里 re-export 供测试/工具引用）。 */
export { HASH_LIMIT, THUMB_WIDTH, DEFAULT_MEDIA_TOOLS, AUTO_FIX, IMPORT_WARNING } from '../ingest.js';

/**
 * 上传限流：账号级 30 次/小时 + IP 级 60 次/小时，两层都要有。
 * 只做账号级的话，一个账号换 IP 就能绕过；只做 IP 级的话，同 IP 上多个账号会互相顶。
 * 已知局限：rate-limit.js 是 isolate 内存计数，不是全局配额（Cloudflare 控制台的
 * Rate Limiting 规则才是真正的兜底）。
 */
export const UPLOAD_ACTOR_MAX = 30;
export const UPLOAD_IP_MAX = 60;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/**
 * 批量导入的限流另算：一次「目录扫描」可能就是几十上百条，套单条那 30 次/小时
 * 会把正常的批量作业直接砍死。批量入口单请求只处理**一个文件**（浏览器按文件循环），
 * 所以阈值按「文件」给，仍然是双层的。
 */
export const IMPORT_ACTOR_MAX = 300;
export const IMPORT_IP_MAX = 600;

function assertUploadRate(actor, request) {
  const byActor = hit(`upload:${actor.id}`, { max: UPLOAD_ACTOR_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byActor.limited) throw tooManyRequests(`上传过于频繁，请 ${byActor.retryAfter} 秒后再试`);
  const byIp = hit(`upload-ip:${clientIp(request)}`, { max: UPLOAD_IP_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byIp.limited) throw tooManyRequests(`上传过于频繁，请 ${byIp.retryAfter} 秒后再试`);
}

function assertImportRate(actor, request) {
  const byActor = hit(`import:${actor.id}`, { max: IMPORT_ACTOR_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byActor.limited) throw tooManyRequests(`批量导入过于频繁，请 ${byActor.retryAfter} 秒后再试`);
  const byIp = hit(`import-ip:${clientIp(request)}`, { max: IMPORT_IP_MAX, windowMs: UPLOAD_WINDOW_MS });
  if (byIp.limited) throw tooManyRequests(`批量导入过于频繁，请 ${byIp.retryAfter} 秒后再试`);
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
  // 阶段二：待转码队列（needs_variant=1），后台专用
  if (url.searchParams.get('needsVariant') === '1') {
    const rows = await all(env, Q.listNeedsVariant, 200);
    return json({
      items: rows.map((row) => wallpaperDto(row, { admin: true, mediaBase: mediaBaseFor(env) })),
      total: rows.length,
    });
  }
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

  const row = await createWallpaperRow(env, actor, input);

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_CREATE,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `${input.title}（${input.kind === 'dynamic' ? '动态' : '静态'}）`,
  });

  const fresh = await first(env, Q.wallpaperById, row.id);
  return created({ wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }) });
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
    tags: patch.tags ?? safeJsonArray(row.tags, []),
    featured: patch.featured !== undefined ? patch.featured : row.featured === 1,
    sortOrder: patch.sortOrder ?? Number(row.sort_order ?? 0),
    // 授权信息（schema/016）：没传就沿用库里的值，不会被 PATCH 顺手清空
    license: patch.license !== undefined ? patch.license : (row.license ?? null),
    source: patch.source !== undefined ? patch.source : (row.source ?? null),
    author: patch.author !== undefined ? patch.author : (row.author ?? null),
  };

  const now = nowMs();
  await run(
    env,
    Q.updateWallpaper,
    row.slug, next.title, next.description, next.subtag, next.categoryId, nextKind, nextStatus,
    next.reviewStatus, JSON.stringify(next.tags), next.featured ? 1 : 0, next.sortOrder, now, publishedAt,
    next.license, next.source, next.author, row.id,
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

/**
 * 单条上传 / 替换：读 body 后**整单交给 ingestAsset()**。
 * 合规体检、sha256/指纹、HEAD 回读、D1 三值成对写、缩略图、变体都在那里，
 * 这里只做鉴权、限流、审计与响应。
 */
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
  const result = await ingestAsset(env, actor, row, { bytes: new Uint8Array(buffer) });

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_ASSET,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `${result.mime} ${result.width ?? '?'}x${result.height ?? '?'} ${Math.round(result.bytes / 1024)}KB${
      result.durationMs ? ` ${(result.durationMs / 1000).toFixed(1)}s` : ''}`,
  });

  // 只有警告时照常入库，但要留痕：这些文件「能播」，只是不在目标规格里
  // （体积超限、WebM 容器、帧率探测不到）。查 warning 就查这个 action。
  const complianceWarnings = result.compliance?.warnings ?? [];
  if (complianceWarnings.length) {
    await writeAudit(env, {
      actor,
      action: AUDIT_ACTION.WALLPAPER_COMPLIANCE_WARN,
      targetType: 'wallpaper',
      targetId: row.id,
      detail: `${complianceWarnings.length} 项：${complianceWarnings.map((item) => `${item.code}: ${item.message}`).join(' / ')}`,
    });
  }

  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({
    wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
    url: result.url,
    ...(result.compliance ? { compliance: { warnings: complianceWarnings } } : {}),
    // 自动修正项（转封装 / 降帧 / 缩略图 / 变体）也回给前端，让「上传成功」不再是一个黑箱
    ingest: { autoFixes: result.autoFixes, warnings: result.warnings },
  });
}

/**
 * 批量入口（后台「立即扫描 / 添加目录」+「批量导入本地文件」）的单条接口。
 *
 * Body: `multipart/form-data`
 *   - `file`           必填，一个媒体文件
 *   - `thumb`          可选，浏览器 canvas 生成的 WebP（1280 宽）
 *   - `variant`        可选，可重复；1080p 变体（命名 `xxx.1080p.mp4` 时自动认高度）
 *   - `title` / `kind` / `categoryId` / `tags`(JSON) / `publish`(0|1) / `reportId`
 *
 * 返回 **HTTP 200 + 报告**（不是 422）：批量导入里「某一条失败」是**数据**，不是异常，
 * 界面要能把每条原因列出来。单个文件的失败码在 `item.code` / `item.reason` 里，
 * 与单条 `PUT /asset` 的 422 一一对应（media_non_compliant / import_incomplete / …）。
 */
export async function importAsset({ env, actor, request }) {
  assertCan(actor, ACTION.ASSET_UPLOAD);
  assertCan(actor, ACTION.WALLPAPER_CREATE);
  assertImportRate(actor, request);

  let form = null;
  try {
    form = await request.formData();
  } catch {
    throw badRequest('批量导入必须用 multipart/form-data（字段 file）');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') throw badRequest('缺少 file（一个媒体文件）');

  const reportId = String(form.get('reportId') ?? '') || newId('report');
  const title = String(form.get('title') ?? '').trim()
    || String(file.name ?? '').replace(/\.[^.]+$/, '').slice(0, 120);
  const publish = String(form.get('publish') ?? '') === '1';
  // 发布是「上线动作」，权限在入口就判：不要等落盘之后再因为 403 把文件白传一遍
  if (publish) assertCan(actor, ACTION.WALLPAPER_PUBLISH);
  const categoryRaw = String(form.get('categoryId') ?? '');
  // 表单里的 tags 是 JSON 文本；坏 JSON 不是错误（前端偶发传空串），回落成 [] 即可，
  // 与 `safeJsonParseLocal` 原来是同一套行为，现在统一走 util.safeJsonArray。
  const tags = safeJsonArray(String(form.get('tags') ?? '[]') || '[]')
    .filter((item) => typeof item === 'string');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kindRaw = String(form.get('kind') ?? '');
  const kind = kindRaw === 'dynamic' || kindRaw === 'static' ? kindRaw : 'static';
  const categoryId = categoryRaw ? cleanCategoryRef(categoryRaw) : null;
  if (categoryId) await ensureCategory(env, categoryId);

  const thumbFile = form.get('thumb');
  const thumb = thumbFile && typeof thumbFile !== 'string'
    ? new Uint8Array(await thumbFile.arrayBuffer())
    : null;

  // 首帧海报（1280 宽 WebP）：浏览器把视频 seek 到 0 后用 canvas 抓一帧；
  // 没传也不影响入库（posterUrl 为 null，客户端回落 thumbUrl）。
  const posterFile = form.get('poster');
  const poster = posterFile && typeof posterFile !== 'string'
    ? new Uint8Array(await posterFile.arrayBuffer())
    : null;

  // 授权信息（schema/016）：表单里可选，留空就是「未声明」
  const license = cleanLicense(String(form.get('license') ?? ''));
  const source = cleanNullableText(String(form.get('source') ?? '') || null, 'source', SOURCE_MAX);
  const author = cleanNullableText(String(form.get('author') ?? '') || null, 'author', AUTHOR_MAX);

  const variants = [];
  for (const entry of form.getAll('variant')) {
    if (!entry || typeof entry === 'string') continue;
    // 文件名只用来「标预期种类」（`xxx.1080p.mp4` / `xxx.30fps.mp4`）；
    // 真实尺寸与 fps 由 ingest 探测文件头后重新算，文件名撒谎不会让 label 撒谎。
    const spec = specFromFileName(entry.name);
    variants.push({
      bytes: new Uint8Array(await entry.arrayBuffer()),
      kind: spec.kind,
      height: spec.height,
    });
  }

  const item = await importMedia({
    env,
    actor,
    item: {
      title, kind, categoryId, tags, bytes, thumb, poster, variants, publish, reportId,
      license, source, author,
      fileName: String(file.name ?? ''),
    },
  });

  const report = buildImportReport(reportId, [item]);
  return json({ item, report });
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

  const MAX = THUMB_MAX_BYTES;
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
  await putR2(env, key, bytes, meta.mime);
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


/** 阶段二：登记一个变体（元数据；文件由 uploadVariant 落盘） */
export async function addVariant({ env, actor, request, params }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  const row = await loadWallpaper(env, params.id);
  const body = await readJson(request);
  const label = String(body.label ?? '').trim().slice(0, 24);
  if (!label) throw badRequest('缺少变体 label');
  const variants = await attachVariant(env, actor, row, {
    label,
    width: Number(body.width) || null,
    height: Number(body.height) || null,
    fps: Number(body.fps) || null,
    codec: body.codec ?? 'h264',
    bytes: Number(body.bytes) || 0,
    sha256: body.sha256 ?? null,
    key: typeof body.key === 'string' ? body.key : null,
    url: body.url ?? null,
  });
  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({
    variants,
    wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
  });
}

/** 阶段二：上传变体文件（走 ingest.js 落 R2 + 写 variants 列） */
export async function uploadVariant({ env, actor, request, params, url }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  const row = await loadWallpaper(env, params.id);
  const label = String(url.searchParams.get('label') ?? '1080p').trim().slice(0, 24) || '1080p';
  const fps = Number(url.searchParams.get('fps') ?? 0) || null;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw payloadTooLarge('变体文件过大');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) throw badRequest('变体文件为空');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw payloadTooLarge('变体文件过大');
  const result = await ingestVariantAsset(env, actor, row, { bytes, label, fps });
  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({
    variant: { label, key: result.key },
    variants: result.variants,
    wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
  });
}

/** 阶段二：发布（原片可播 或 已有可播变体），成功后清 needs_variant */
export async function publish({ env, actor, params }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  const row = await loadWallpaper(env, params.id);
  const result = await publishWallpaper(env, actor, row);
  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({
    ...result,
    wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
  });
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

