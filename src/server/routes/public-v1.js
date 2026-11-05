/**
 * v1 公开只读接口（`/api/v1/public/*`）。
 *
 * 这一层只做「HTTP 形状」：JSON 包装、ETag/304、缓存头。所有 SQL / DTO / 分页逻辑
 * 都在 `../public-api.js`，旧路径（`src/server/routes/public.js`）直接转发到这里的
 * 同名 handler —— 于是「旧路径与 v1 逐字段一致」是一条结构性事实，而不是手工同步。
 *
 * 匿名可读：`gate-middleware.js` 的 PUBLIC_READ_PREFIXES 放行 `/api/v1/public/`
 * （只认 GET/HEAD/OPTIONS）。详情接口必须公开，否则素材网客户端拿不到单条元数据。
 */
import { json } from '../http.js';
import { sha256Hex } from '../util.js';
import { etagMatches, normalizeEtag } from '../../core/etag.js';
import {
  categoriesPayload, subtagsPayload, tagsPayload, wallpapersPayload, wallpaperPayload, manifestPayload,
} from '../public-api.js';

/**
 * 公开接口边缘缓存 5 分钟。
 *
 * 原先是 30 秒：插件面板 15–20 秒轮询一次，30 秒缓存意味着**每个轮询周期都可能回源**，
 * 而一次清单要跑「清单 + count + facets」三条 SQL。2026-11-05 线上 D1 免费额度被耗尽，
 * 公开接口全部 500，根子是读取量而不是数据坏了。5 分钟缓存把回源次数压到原来的 1/10，
 * 配合 app.js 的「条件请求也走缓存」，插件轮询基本不再产生 D1 读。
 */
const CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

// 兼容旧引用：ETag 规则已经收敛到 src/core/etag.js，这里只做转发。
export { normalizeEtag };

/**
 * 给 JSON 载荷加 ETag：客户端带 If-None-Match 且命中时回 304（无 body）。
 * 只对**完整载荷**算 hash，所以分页/筛选/排序任何一位变化都会换 ETag，不会拿错缓存。
 *
 * @param {object} payload
 * @param {Request} request
 * @param {{status?: number, headers?: Record<string,string>}} [options]
 */
export async function etagJson(payload, request, { status = 200 } = {}) {
  const body = JSON.stringify(payload);
  const etag = `"${(await sha256Hex(body)).slice(0, 24)}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    etag,
    'cache-control': CACHE_CONTROL,
  };
  if (etagMatches(request?.headers?.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}

export async function listCategories({ env }) {
  return json(await categoriesPayload(env));
}

export async function listTags({ env, url }) {
  return json(await tagsPayload({ env, url }));
}

export async function listSubtags({ env, url }) {
  return json(await subtagsPayload({ env, url }));
}

/** `GET /api/v1/public/wallpapers`：清单 + facets，带 ETag/304（与旧路径同一份响应）。 */
export async function listWallpapers(ctx) {
  const payload = await wallpapersPayload(ctx);
  return etagJson(payload, ctx.request);
}

/** `GET /api/v1/public/wallpapers/:slug`：详情，公开可读。 */
export async function getWallpaper(ctx) {
  return json(await wallpaperPayload(ctx));
}

/**
 * `GET /api/v1/public/manifest.json`：全量快照（不分页）。
 *
 * 形状是**文档**而不是 `{ok,data}` 包装：`{ apiVersion, generatedAt, etag, total, items }`
 * （见 docs/API-V1.md）。`generatedAt` 取数据里最新的 `updated_at`，所以同一批内容
 * 重复请求不会「变新」；`etag` 同时出现在 body 与响应头里，客户端二选一即可。
 */
export async function manifest(ctx) {
  const core = await manifestPayload(ctx.env);
  const body = JSON.stringify(core);
  const stamp = (await sha256Hex(body)).slice(0, 24);
  const etag = `"${stamp}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    etag,
    'cache-control': CACHE_CONTROL,
  };
  if (etagMatches(ctx.request?.headers?.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify({ ...core, etag: stamp }), { status: 200, headers });
}
