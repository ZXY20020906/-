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
  ALLOWED_MIME, limitForMime, kindMatchesMime, readDurationMs, readMediaMeta, readVideoInfo,
} from '../../core/image-meta.js';
import {
  badRequest, conflict, internal, notFound, payloadTooLarge, storageVerifyFailed, unsupportedMedia,
} from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { wallpaperDto } from '../dto.js';
import { assetKey, deleteAsset, mediaBaseFor, putAsset, thumbKey, verifyAsset } from '../storage.js';
import { newId, safeJsonParse, sha256Bytes } from '../util.js';
import { buildReorderPlan, nextSortOrder } from '../../core/ordering.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { allowedTagNames } from './tags.js';

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
  // 类型不再让人手选：传视频就是动态、传图片就是静态；
  // zip 保留原来的类型（皮肤包是静态，开机动画包是动态）。
  const nextKind = meta.mime.startsWith('video/')
    ? 'dynamic'
    : meta.mime.startsWith('image/') ? 'static' : row.kind;

  // 大文件跳过哈希：Worker 内存只有 128MB，对 80MB+ 的文件再算一遍 sha256 容易被打爆。
  // 代价是超大资源包不做去重，可以接受。
  const HASH_LIMIT = 40 * 1024 * 1024;
  let sha = null;
  if (bytes.byteLength <= HASH_LIMIT) {
    sha = await sha256Bytes(bytes);
    const duplicate = await first(env, Q.wallpaperShaTaken, sha);
    if (duplicate && duplicate.id !== row.id) {
      throw conflict('这个文件已经在库里了', { wallpaperId: duplicate.id, title: duplicate.title });
    }
  }

  const key = assetKey(row.id, sha ?? `${Date.now()}${bytes.byteLength}`, meta.mime);
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

  // 视频顺便读时长和编码信息：开机动画是按秒循环的，moov 位置决定能不能边下边播
  const durationMs = readDurationMs(bytes, meta.mime);
  const videoInfo = readVideoInfo(bytes, meta.mime);
  await run(
    env, Q.updateWallpaperAsset,
    key, meta.mime, check.size, meta.width, meta.height, durationMs, sha, nextKind, nowMs(), row.id,
  );
  await run(
    env, Q.markWallpaperVerified,
    nowMs(), videoInfo.codec, videoInfo.faststart, row.id,
  );

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_ASSET,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `${meta.mime} ${meta.width ?? '?'}x${meta.height ?? '?'} ${Math.round(bytes.byteLength / 1024)}KB${
      durationMs ? ` ${(durationMs / 1000).toFixed(1)}s` : ''}`,
  });

  const fresh = await first(env, Q.wallpaperById, row.id);
  return json({ wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }), url: `/media/${key}` });
}

/**
 * 缩略图上传。图由浏览器 canvas 生成（Worker 没有图像解码能力），
 * 单独存 thumbs/ 前缀，列表页用它，详情页才加载原图。
 */
export async function uploadThumb({ env, actor, request, params }) {
  const row = await loadWallpaper(env, params.id);
  assertCan(actor, ACTION.ASSET_UPLOAD);
  assertCan(actor, ACTION.WALLPAPER_UPDATE, row);

  const MAX = 2 * 1024 * 1024;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX) throw payloadTooLarge('缩略图不能超过 2MB');

  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!bytes.byteLength) throw badRequest('缩略图是空的');
  if (bytes.byteLength > MAX) throw payloadTooLarge('缩略图不能超过 2MB');

  const meta = readMediaMeta(bytes);
  if (!meta.mime || !meta.mime.startsWith('image/')) throw unsupportedMedia('缩略图必须是图片');

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
