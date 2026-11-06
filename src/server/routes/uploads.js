/**
 * 大文件分片上传（R2 multipart）。
 *
 * 浏览器把文件切块 → 每块一次 PUT → 最后 complete 合并。整条链路不经过
 * 「一次请求传整个文件」，所以单文件可以到 2GB（Worker 单请求 100MB 的限制不再相关）。
 *
 * 临时对象写在 `_tmp/uploads/<id>/<name>`；complete 成功后：
 *   · 小文件（≤ INLINE_LIMIT）整段读回，复用 ingestAsset 走完整入库（缩略图/海报/compliance）
 *   · 大文件走「流式入库」：只读首尾几 MB 做探测与指纹，然后用 R2 的流复制到最终 key，
 *     不再把整个文件读进内存（Worker 只有 128MB）
 *
 * 为什么不用 S3 预签名：国内网络连不上 r2.cloudflarestorage.com，必须走绑定。
 */
import { Q } from '../queries.js';
import { first, run } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import {
  ALLOWED_MIME, EXT_BY_MIME, isVideoMime, readDurationMs, readMediaMeta, readVideoAudio,
  readVideoFps, readVideoInfo,
} from '../../core/image-meta.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../../core/errors.js';
import { readJson, created, json } from '../http.js';
import { assetKey, deleteAsset, mediaBaseFor, putAsset, verifyAsset } from '../storage.js';
import { MEDIA_ACTOR, setMediaIdentity } from '../media-audit.js';
import { wallpaperDto } from '../dto.js';
import { newId, sha256Bytes } from '../util.js';
import { ingestAsset } from '../ingest.js';
import { checkVideoCompliance, complianceMessage, COMPLIANCE_HINT } from '../media-compliance.js';

/** 单文件上限：2GB（产品需求） */
export const MAX_MULTIPART_BYTES = 2 * 1024 * 1024 * 1024;
/** 小于这个尺寸直接整段读回，走 ingestAsset（保留缩略图/海报/compliance 全套） */
export const MULTIPART_INLINE_LIMIT = 48 * 1024 * 1024;
/** 探测读多少字节：首尾各 4MB，足够读 moov / mvhd / 指纹 */
const PROBE_BYTES = 4 * 1024 * 1024;
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

async function readRange(env, key, offset, length) {
  const object = await env.BUCKET.get(key, { range: { offset, length } });
  if (!object) return null;
  const buffer = await object.arrayBuffer();
  return new Uint8Array(buffer);
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

/**
 * 大文件流式入库：只读首尾探测，再用 R2 流复制到最终 key。
 * 不走 ingestAsset 是因为它要求把整个文件放进内存。
 */
async function ingestStreamed(env, actor, row, tmpKey, size, warnings) {
  const head = await readRange(env, tmpKey, 0, Math.min(PROBE_BYTES, size));
  const tail = size > PROBE_BYTES
    ? await readRange(env, tmpKey, Math.max(0, size - PROBE_BYTES), Math.min(PROBE_BYTES, size))
    : new Uint8Array(0);

  const meta = readMediaMeta(head);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的文件类型');
  if (!ALLOWED_MIME.includes(meta.mime)) throw unsupportedMedia(`不支持的类型：${meta.mime}`);

  const videoInfo = isVideoMime(meta.mime) ? readVideoInfo(head, meta.mime) : { fps: null, codec: null, faststart: null };
  if (isVideoMime(meta.mime) && videoInfo.faststart === false) {
    throw unsupportedMedia('mp4 需要 faststart（moov 在文件头）。请先用 ffmpeg -movflags +faststart 重封装');
  }
  if (isVideoMime(meta.mime)) {
    const fps = readVideoFps(head, meta.mime) ?? videoInfo.fps ?? null;
    const compliance = checkVideoCompliance({
      mime: meta.mime, width: meta.width, height: meta.height, fps,
      codec: videoInfo.codec, bytes: size,
    });
    if (!compliance.ok) {
      throw unsupportedMedia(complianceMessage(compliance), {
        violations: compliance.violations,
        warnings: compliance.warnings,
        hint: COMPLIANCE_HINT,
      });
    }
  }

  const merged = new Uint8Array(head.byteLength + tail.byteLength);
  merged.set(head, 0);
  merged.set(tail, head.byteLength);
  const fingerprint = await sha256Bytes(merged);

  const mime = meta.mime;
  const key = assetKey(row.id, fingerprint, mime);
  const source = await env.BUCKET.get(tmpKey);
  if (!source) throw notFound('临时对象不存在');

  await env.BUCKET.put(key, source.body, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const check = await verifyAsset(env, key, size);
  if (!check.ok) {
    await deleteAsset(env, key);
    throw badRequest('分片合并后写入校验失败，请重试');
  }
  if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);

  const durationMs = isVideoMime(mime) ? readDurationMs(head, mime) : null;
  const nextKind = isVideoMime(mime) ? 'dynamic' : mime.startsWith('image/') ? 'static' : row.kind;

  await setMediaIdentity(env, row.id, {
    storageKey: key,
    mime,
    bytes: size,
    width: meta.width ?? null,
    height: meta.height ?? null,
    durationMs,
    sha256: null,
    kind: nextKind,
    actor: row.storage_key ? MEDIA_ACTOR.REPLACE : MEDIA_ACTOR.UPLOAD,
    updatedAt: Date.now(),
  });
  await run(env, Q.markWallpaperVerified, Date.now(), videoInfo.codec ?? null, videoInfo.faststart ?? null, row.id);
  try {
    await run(env, Q.updateWallpaperFingerprint, fingerprint, Date.now(), row.id);
  } catch (error) {
    console.warn('[uploads] 写 content_fingerprint 失败', error?.message ?? error);
  }
  if (isVideoMime(mime)) {
    const hasAudio = readVideoAudio(head, mime);
    try {
      await run(env, Q.updateWallpaperTech, readVideoFps(head, mime) ?? null, null, hasAudio === null ? null : (hasAudio ? 1 : 0), row.id);
    } catch (error) {
      console.warn('[uploads] 写技术元数据失败', error?.message ?? error);
    }
  }

  warnings.push({
    code: 'large-upload-no-thumb',
    message: '超过 48MB 的文件走流式入库，没有自动生成缩略图/海报；可用后台“换文件”补，或跑 tools/backfill-metadata.mjs',
  });

  const fresh = await first(env, Q.wallpaperById, row.id);
  return { wallpaper: wallpaperDto(fresh, { admin: true, mediaBase: mediaBaseFor(env) }), warnings };
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
    // etag 不符 / 分片缺失：R2 会直接拒绝；顺手清掉临时残留
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

  const warnings = [];
  try {
    if (size <= MULTIPART_INLINE_LIMIT) {
      const buffer = await (await env.BUCKET.get(key))?.arrayBuffer();
      if (!buffer) throw notFound('临时对象不存在');
      const result = await ingestAsset(env, actor, row, { bytes: new Uint8Array(buffer) });
      await deleteAsset(env, key);
      return json({ wallpaper: result.wallpaper ?? result, warnings: result.warnings ?? [], mode: 'inline' });
    }
    const result = await ingestStreamed(env, actor, row, key, size, warnings);
    await deleteAsset(env, key);
    return json({ ...result, mode: 'streamed' });
  } catch (error) {
    await deleteAsset(env, key).catch(() => {});
    throw error;
  }
}


/**
 * POST /api/admin/uploads/cleanup
 * 清理 `_tmp/` 下超过 24 小时的遗留对象（中断的上传）。
 * 由 tools/cleanup-orphan-uploads.mjs 定时调用。
 */
export async function cleanup({ env, actor }) {
  assertCan(actor, ACTION.WALLPAPER_UPDATE);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let cursor;
  let scanned = 0;
  let deleted = 0;
  const failed = [];

  for (let page = 0; page < 100; page += 1) {
    const listed = await env.BUCKET.list({ prefix: TMP_PREFIX, limit: 1000, cursor });
    for (const object of listed.objects ?? []) {
      scanned += 1;
      const uploaded = object.uploaded ? new Date(object.uploaded).getTime() : 0;
      if (uploaded && uploaded > cutoff) continue;
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

  return json({ scanned, deleted, failed });
}
/** POST /api/admin/uploads/abort */export async function abort({ request, env, actor }) {
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
