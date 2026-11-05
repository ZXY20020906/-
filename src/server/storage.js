/** R2 对象读写。key 里带内容哈希，所以可以放心用 immutable 缓存。 */
import { EXT_BY_MIME } from '../core/image-meta.js';
import { variantKeyTag } from '../core/variant-label.js';

/**
 * key 里的哈希前缀长度。曾用 12 位；2026-11-04「同址双版本」事故说明 12 位太短——
 * 内容换过的重打包没换 key，同名覆盖后旧 URL 上长期并存两个版本。统一扩到 16 位，
 * 让"新内容落在从未服务过的 URL"这件事在位数上就成立。见 docs/r2.md / docs/UPLOAD-SOP.md。
 */
export const HASH_PREFIX_LEN = 16;

/** 去掉 id 里的非法字符，避免把路径分隔符带进 key */
function safeId(wallpaperId) {
  return String(wallpaperId).replace(/[^A-Za-z0-9_-]/g, '');
}

export function assetKey(wallpaperId, sha256, mime) {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  return `wallpapers/${safeId(wallpaperId)}/${sha256.slice(0, HASH_PREFIX_LEN)}.${ext}`;
}

/** 缩略图单独放 thumbs/ 前缀，方便以后整体清理或换尺寸策略 */
export function thumbKey(wallpaperId, sha256, mime) {
  const ext = EXT_BY_MIME[mime] ?? 'webp';
  return `thumbs/${safeId(wallpaperId)}/${sha256.slice(0, HASH_PREFIX_LEN)}.${ext}`;
}

/**
 * 首帧海报（v1 `posterUrl`）：`posters/<id>/<sha16>.webp`。
 *
 * 和 thumbs/ 分开的理由：缩略图是「卡片封面」（浏览器 canvas 抓的一帧，可能带播放器 UI），
 * 海报是「首帧原样 1280 宽」（分享卡片 / 详情页大图 / 客户端列表预加载）。
 * 两者内容不同，key 必须各不相同，否则先占位的那个会长期覆盖另一个。
 */
export function posterKey(wallpaperId, sha256, mime = 'image/webp') {
  const ext = EXT_BY_MIME[mime] ?? 'webp';
  return `posters/${safeId(wallpaperId)}/${sha256.slice(0, HASH_PREFIX_LEN)}.${ext}`;
}

/**
 * 变体的 key：`wallpapers/<id>/<sha16>.1080p.mp4` / `.30fps.mp4`
 * （docs/UPLOAD-SOP.md 第 1 条铁律）。
 *
 * 变体和原画是**两个对象、两份内容哈希** —— 插件用各自的 sha256 校验（见
 * lib/variant-pick.js 的 resolveMediaExpectation），所以 key 里必须是变体自己的哈希。
 *
 * 后缀**只由 `variantKeyTag()` 决定**（`1080p` / `30fps` / `alt`），不在这里按高度拼：
 * 按高度拼会把 4K@30 档写成 `.2160p.mp4`，和存量的 `.30fps.mp4` 分成两套命名。
 *
 * @param {string} wallpaperId
 * @param {string} sha256 变体自身的内容哈希
 * @param {object} spec 变体规格（见 core/variant-label.js 的 labelForVariant）
 * @param {string} [mime]
 */
export function variantKey(wallpaperId, sha256, spec = {}, mime = 'video/mp4') {
  const ext = EXT_BY_MIME[mime] ?? 'mp4';
  const tag = variantKeyTag(spec);
  return `wallpapers/${safeId(wallpaperId)}/${sha256.slice(0, HASH_PREFIX_LEN)}.${tag}.${ext}`;
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

/**
 * 写完立刻回读一次：R2 put 成功不代表对象真的落盘、大小一致。
 * 之前的坑就是「D1 说有、R2 没有」，用户点下载直接 404。
 * 返回真实字节数，调用方拿它记账，而不是拿内存里的 length。
 */
export async function verifyAsset(env, key, expectedBytes) {
  if (typeof env.BUCKET.head !== 'function') {
    // 测试用假桶没有 head：跳过校验，但仍按写入长度记账
    return { ok: true, size: expectedBytes ?? 0 };
  }
  const head = await env.BUCKET.head(key);
  if (!head) return { ok: false, reason: 'missing', size: 0 };
  if (typeof expectedBytes === 'number' && head.size !== expectedBytes) {
    return { ok: false, reason: 'size', size: head.size };
  }
  return { ok: true, size: head.size, etag: head.httpEtag };
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
