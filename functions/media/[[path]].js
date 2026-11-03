/**
 * 壁纸原图/视频出口：/media/<R2 key>
 *
 * 三个关键点（都是被外部调用踩出来的）：
 * 1. CORS 全开 —— 插件、扩展、别的域名都要能直接取；
 * 2. 走 Cloudflare 边缘缓存 —— Workers 响应默认不进缓存，每次都回源 R2 会很慢；
 * 3. key 里带内容哈希，可以给一年 immutable。
 */
import { notFound } from '../../src/core/errors.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range, content-type, accept',
  'access-control-max-age': '86400',
};

/** 对象不存在时给一个正经的 404 JSON：以前 return notFound() 会漏成 500 HTML。 */
function missing(message = '文件不存在') {
  return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message } }), {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...CORS,
    },
  });
}

/**
 * Range 解析：三态返回，避免调用方猜。
 *
 *   { range: {start, end} }  可以满足 → 206
 *   { unsatisfiable: true }  语法合法但要不到（start >= size 或对象 0 字节）→ 416
 *   null                     语法不合法 → 忽略 Range，照常回 200 全量
 *
 * 为什么要区分后两者：越界不能当成「没写 Range」——`bytes=999999999-` 退化成
 * 200 + 整个文件，等于让客户端白拉几十 MB。HTTP 规范要求 416 + `content-range: bytes * /size`。
 * 反过来 `bytes=5-2`（起止颠倒）属于语法错误，按规范忽略 Range 回 200 就行，不该 416。
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return null;

  let start;
  let end;
  let explicitEnd = false;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    explicitEnd = Boolean(endRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // 空对象：任何 Range 都要不到内容
  if (size === 0) return { unsatisfiable: true };
  // 起点越界：必须在 start > end 之前判定，否则 `bytes=999999999-` 会被误判成语法错误而回 200 全量
  if (start >= size) return { unsatisfiable: true };
  // 两端都是显式数字但 start > end（`bytes=5-2`）→ 语法不合法，忽略 Range
  if (explicitEnd && start > end) return null;
  return { range: { start, end: Math.min(end, size - 1) } };
}

/**
 * 416：body 必须为空，`content-range: bytes * /size` 让客户端知道真实大小。
 * 不复用 missing()（那是 404），也不写进 caches.default（416 不该被缓存）。
 */
function rangeNotSatisfiable(size) {
  return new Response(null, {
    status: 416,
    headers: {
      'content-range': `bytes */${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...CORS,
    },
  });
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.filter(Boolean).map((part) => decodeURIComponent(part)).join('/');
  if (!key || key.includes('..')) return missing();

  const url = new URL(request.url);
  const rangeHeader = request.headers.get('range');
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });

  // 整段请求走边缘缓存；Range 请求不缓存（视频拖动频繁，缓存收益低还容易出错）
  if (!rangeHeader) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = new Response(hit.body, hit);
      cached.headers.set('x-folia-cache', 'HIT');
      // 媒体已经在白名单里（匿名可读），所以允许任何缓存层长期缓存：
      // 插件反复拉同一批皮肤包时，命中缓存比回源 R2 快得多。
      cached.headers.set('cache-control', 'public, max-age=31536000, immutable');
      for (const [name, value] of Object.entries(CORS)) cached.headers.set(name, value);
      return cached;
    }
  }

  const object = await env.BUCKET.get(key);
  if (!object) return missing();

  const size = object.size;
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';
  const headers = new Headers({
    'content-type': contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    etag: object.httpEtag,
    ...CORS,
  });

  const wantsDownload = url.searchParams.has('download');
  if (wantsDownload) {
    const ext = key.split('.').pop() || 'bin';
    const rawName = url.searchParams.get('download') || `folia.${ext}`;
    const name = String(rawName).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '').trim().slice(0, 80) || `folia.${ext}`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    headers.set('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  }

  // 三态：unsatisfiable 先拦（416），合法区间才走 206，其余（语法不合法）忽略 Range
  const parsed = !wantsDownload && rangeHeader ? parseRange(rangeHeader, size) : null;
  if (parsed?.unsatisfiable) return rangeNotSatisfiable(size);

  const range = parsed?.range ?? null;
  if (range) {
    const partial = await env.BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
    if (!partial) return missing();
    headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('content-length', String(range.end - range.start + 1));
    return new Response(partial.body, { status: 206, headers });
  }

  headers.set('content-length', String(size));
  headers.set('x-folia-cache', 'MISS');
  const response = new Response(object.body, { status: 200, headers });

  // 填充边缘缓存（不阻塞响应）。只缓存可复用的一次性整段请求。
  if (!rangeHeader && !wantsDownload && request.method === 'GET' && context.waitUntil) {
    const forCache = new Response(response.clone().body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        etag: object.httpEtag,
      },
    });
    context.waitUntil(cache.put(cacheKey, forCache));
  }

  return response;
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (method === 'GET' || method === 'HEAD') return onRequestGet(context);
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { allow: 'GET, HEAD, OPTIONS', ...CORS },
  });
}
