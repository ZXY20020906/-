/** R2 对象读写。key 里带内容哈希，所以可以放心用 immutable 缓存。 */
import { EXT_BY_MIME } from '../core/image-meta.js';

export function assetKey(wallpaperId, sha256, mime) {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  return `wallpapers/${String(wallpaperId).replace(/[^A-Za-z0-9_-]/g, '')}/${sha256.slice(0, 12)}.${ext}`;
}

/** 缩略图单独放 thumbs/ 前缀，方便以后整体清理或换尺寸策略 */
export function thumbKey(wallpaperId, sha256, mime) {
  const ext = EXT_BY_MIME[mime] ?? 'webp';
  return `thumbs/${String(wallpaperId).replace(/[^A-Za-z0-9_-]/g, '')}/${sha256.slice(0, 12)}.${ext}`;
}

/**
 * routes 层统一用这个拿媒体前缀，避免各处手写 fallback。
 * 注意：PUBLIC_ORIGIN 是站点源，不是媒体根，必须补 /media；
 * MEDIA_BASE 则是 R2 自定义域名，对象直接在根。
 */
export function mediaBaseFor(env) {
  if (!env) return '';
  if (env.MEDIA_BASE) return String(env.MEDIA_BASE).replace(/\/+$/, '');
  const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
  return origin ? `${origin}/media` : '';
}

export async function putAsset(env, key, bytes, mime) {
  await env.BUCKET.put(key, bytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: { uploadedAt: String(Date.now()) },
  });
}

export async function deleteAsset(env, key) {
  if (!key) return;
  try {
    await env.BUCKET.delete(key);
  } catch (error) {
    console.error('[storage] delete failed', key, error?.message ?? error);
  }
}

/**
 * 生成前台可用的直链。
 * 默认走本 Worker 的 /media/*；如果绑了 R2 自定义域名（推荐，省请求且更快），
 * 在 wrangler.toml 里设 MEDIA_BASE=https://img.example.com 即可全部切换。
 */
export function publicUrl(key, mediaBase = '') {
  if (!key) return null;
  const prefix = String(mediaBase || '').replace(/\/+$/, '');
  return prefix ? `${prefix}/${key}` : `/media/${key}`;
}
