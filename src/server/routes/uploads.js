/**
 * 大文件分片上传（R2 multipart）。
 *
 * 浏览器把文件切块 → 每块一次 PUT → 最后 complete 合并。整条链路不经过
 * 「一次请求传整个文件」，所以单文件可以到 2GB（Worker 单请求 100MB 的限制不再相关）。
 *
 * 临时对象写在 `_tmp/uploads/<id>/<name>`；complete 成功后：
 *   · ≤48MB：整段读回，调用 ingestAsset（完整入库：缩略图/海报/compliance）
 *   · >48MB：调用 ingestStreamedAsset（同一份 ingest.js，流式复制，不整段进内存）
 *
 * 为什么不用 S3 预签名：国内网络连不上 r2.cloudflarestorage.com，必须走绑定。
 */
import { Q } from '../queries.js';
import { first } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import { ALLOWED_MIME } from '../../core/image-meta.js';
import { badRequest, notFound, payloadTooLarge } from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { deleteAsset, mediaBaseFor } from '../storage.js';
import { wallpaperDto } from '../dto.js';
import { newId } from '../util.js';
import { ingestAsset, ingestStreamedAsset, ingestVariantFromObject } from '../ingest.js';

/** 单文件上限：2GB（产品需求） */
export const MAX_MULTIPART_BYTES = 2 * 1024 * 1024 * 1024;
/** 小于这个尺寸整段读回，走 ingestAsset（保留缩略图/海报/compliance 全套） */
export const MULTIPART_INLINE_LIMIT = 48 * 1024 * 1024;

const TMP_PREFIX = '_tmp/uploads/';
const PART_SMALL = 8 * 1024 * 1024;
const PART_LARGE = 16 * 1024 * 1024;

function isTmpKey(key) {
  return typeof key === 'string' && key.startsWith(TMP_PREFIX) && !key.includes('..');
}

function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-80);
  return cleaned || 'upload.bin';
}

async function loadRow(env, id) {
  const safe = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw badRequest('缺少 wallpaperId');
  const row = await first(env, Q.wallpaperById, safe);
  if (!row) throw notFound('作品不存在');
  return row;
}

/** POST /api/admin/uploads/init */
export async function init({ request, env, actor }) {
  assertCan(actor, ACTION.ASSET_UPLOAD);
  const body = await readJson(request);
  const fileName = String(body.fileName ?? '').trim();
  const size = Number(body.size);
  const contentType = String(body.contentType ?? 'application/octet-stream').toLowerCase();

  if (!fileName) throw badRequest('缺少 fileName');
  if (!Number.isFinite(size) || size <= 0) throw badRequest('size 不合法');
  if (size > MAX_MULTIPART_BYTES) {
    throw payloadTooLarge(`单文件最大 ${Math.round(MAX_MULTIPART_BYTES / 1024 / 1024 / 1024)}GB`);
  }
  if (typeof env.BUCKET.createMultipartUpload !== 'function') {
    throw badRequest('当前环境不支持分片上传');
  }

  const partSize = size <= 64 * 1024 * 1024 ? PART_SMALL : PART_LARGE;
  const maxParts = Math.ceil(size / partSize);
  if (maxParts > 10000) throw payloadTooLarge('分片数量过多');

  const token = newId('up');
  const key = `${TMP_PREFIX}${token}/${safeFileName(fileName)}`;
  const upload = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: ALLOWED_MIME.includes(contentType) ? contentType : 'application/octet-stream' },
  });

  return created({
    uploadId: upload.uploadId,
    key,
    partSize,
    maxParts,
    expiresInSeconds: 24 * 60 * 60,
  });
}

/** PUT /api/admin/uploads/part?uploadId=&part=&key= */
export async function part({ request, env, actor, url }) {
  assertCan(actor, ACTION.ASSET_UPLOAD);
  const uploadId = url.searchParams.get('uploadId') ?? '';
  const key = url.searchParams.get('key') ?? '';
  const partNumber = Number(url.searchParams.get('part'));

  if (!uploadId) throw badRequest('缺少 uploadId');
  if (!isTmpKey(key)) throw badRequest('key 不合法');
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw badRequest('part 不合法');
  if (!request.body) throw badRequest('分片内容为空');
  if (typeof env.BUCKET.resumeMultipartUpload !== 'function') throw badRequest('当前环境不支持分片上传');

  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const result = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber, etag: result.etag });
}

/** POST /api/admin/uploads/complete */
export async function complete({ request, env, actor }) {
  assertCan(actor, ACTION.ASSET_UPLOAD);
  const body = await readJson(request);
  const uploadId = String(body.uploadId ?? '');
  const key = String(body.key ?? '');
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

  if (!uploadId) throw badRequest('缺少 uploadId');
  if (!isTmpKey(key)) throw badRequest('key 不合法');
  if (!parts.length) throw badRequest('缺少分片列表');
  if (parts.length > 10000) throw badRequest('分片数量过多');

  const normalized = parts
    .map((item) => ({ partNumber: Number(item.partNumber ?? item.part), etag: String(item.etag ?? '') }))
    .sort((a, b) => a.partNumber - b.partNumber);
  for (const item of normalized) {
    if (!Number.isInteger(item.partNumber) || item.partNumber < 1) throw badRequest('分片编号非法');
    if (!item.etag) throw badRequest('分片 etag 缺失');
  }

  const row = await loadRow(env, meta.wallpaperId);
  assertCan(actor, ACTION.WALLPAPER_UPDATE, row);

  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  let object;
  try {
    object = await upload.complete(normalized);
  } catch (error) {
    await deleteAsset(env, key);
    throw badRequest(`分片合并失败：${error?.message ?? error}`);
  }

  const size = Number(object?.size ?? 0);
  const expected = Number(meta.size ?? 0);
  if (!size) {
    await deleteAsset(env, key);
    throw badRequest('合并后的对象为空');
  }
  if (expected && expected !== size) {
    await deleteAsset(env, key);
    throw badRequest(`总长度不符：声明 ${expected}，实际 ${size}`);
  }

  // 变体模式：分片对象直接转成变体（>100MB 的变体走这条路）
  if (meta.variantLabel) {
    try {
      const row = await loadRow(env, meta.wallpaperId);
      assertCan(actor, ACTION.WALLPAPER_UPDATE, row);
      const label = String(meta.variantLabel).trim().slice(0, 24) || '1080p';
      const result = await ingestVariantFromObject(env, actor, row, {
        key, size, label, fps: Number(meta.fps) || null,
      });
      await deleteAsset(env, key);
      const freshRow = await first(env, Q.wallpaperById, row.id);
      return json({
        variant: { label, key: result.key },
        variants: result.variants,
        wallpaper: wallpaperDto(freshRow, { admin: true, mediaBase: mediaBaseFor(env) }),
        mode: 'variant',
      });
    } catch (error) {
      await deleteAsset(env, key).catch(() => {});
      throw error;
    }
  }

  try {
    let result;
    let mode;
    if (size <= MULTIPART_INLINE_LIMIT) {
      const source = await env.BUCKET.get(key);
      if (!source) throw notFound('临时对象不存在');
      const buffer = await source.arrayBuffer();
      result = await ingestAsset(env, actor, row, { bytes: new Uint8Array(buffer) });
      mode = 'inline';
    } else {
      result = await ingestStreamedAsset(env, actor, row, { key, size });
      mode = 'streamed';
    }
    await deleteAsset(env, key);

    const fresh = await first(env, Q.wallpaperById, row.id);
    return json({
      wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }),
      warnings: result?.warnings ?? [],
      mode,
    });
  } catch (error) {
    await deleteAsset(env, key).catch(() => {});
    throw error;
  }
}

/** POST /api/admin/uploads/abort */
export async function abort({ request, env, actor }) {
  assertCan(actor, ACTION.ASSET_UPLOAD);
  const body = await readJson(request);
  const uploadId = String(body.uploadId ?? '');
  const key = String(body.key ?? '');
  if (!uploadId) throw badRequest('缺少 uploadId');
  if (!isTmpKey(key)) throw badRequest('key 不合法');

  try {
    const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
    await upload.abort();
  } catch (error) {
    console.warn('[uploads] abort 失败（可能已完成）', error?.message ?? error);
  }
  await deleteAsset(env, key);
  return json({ aborted: true });
}

/**
 * POST /api/admin/uploads/cleanup
 * 清理 `_tmp/` 下超过 24 小时的遗留对象（中断的上传）。
 * 由 tools/cleanup-orphan-uploads.mjs 定时调用。
 */
export async function cleanup({ env, actor, url }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  // `?dryRun=1`：只列出「会被删掉的东西」，一个对象都不动。
  // 验收 E4 要的就是这个语义（先看清楚再删），也给运维一个安全的预演开关。
  const dryRun = url?.searchParams?.get('dryRun') === '1';
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cursor;
  let scanned = 0;
  let deleted = 0;
  const failed = [];
  const wouldDelete = [];

  for (let page = 0; page < 100; page += 1) {
    const listed = await env.BUCKET.list({ prefix: TMP_PREFIX, limit: 1000, cursor });
    for (const object of listed.objects ?? []) {
      scanned += 1;
      const uploaded = object.uploaded ? new Date(object.uploaded).getTime() : 0;
      if (uploaded && uploaded > cutoff) continue;
      if (dryRun) {
        wouldDelete.push({ key: object.key, uploaded: object.uploaded ?? null });
        continue;
      }
      try {
        await env.BUCKET.delete(object.key);
        deleted += 1;
      } catch (error) {
        failed.push({ key: object.key, error: error?.message ?? String(error) });
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  if (dryRun) return json({ scanned, deleted: 0, failed, dryRun: true, wouldDelete });
  return json({ scanned, deleted, failed });
}
