/**
 * 应用路由。判定顺序：安全头/CSRF → 匹配路由 → 取会话 → 业务权限 → 执行。
 * 权限只在 routes/* 里用 assertCan 判定，路由表不重复声明，避免两处规则打架。
 */
import { assertSafeRequest, corsHeaders, failure, methodNotAllowed, preflight } from './http.js';
import { etagMatches } from '../core/etag.js';
import { readSession, clientIp } from './session.js';
import { hit } from './rate-limit.js';
import { findApiKey, readApiKey, touchApiKey } from './api-keys.js';
import { HttpError, notFound, tooManyRequests, unauthorized } from '../core/errors.js';
import * as authRoutes from './routes/auth.js';
import * as publicRoutes from './routes/public.js';
import * as publicV1Routes from './routes/public-v1.js';
import * as wallpaperRoutes from './routes/wallpapers.js';
import * as uploadRoutes from './routes/uploads.js';
import * as categoryRoutes from './routes/categories.js';
import * as tagRoutes from './routes/tags.js';
import * as likeRoutes from './routes/likes.js';
import * as subtagRoutes from './routes/subtags.js';
import * as memberRoutes from './routes/members.js';
import * as auditRoutes from './routes/audit.js';

/** @type {{method:string, path:string, handler:Function, auth:'none'|'session', cors?:boolean}[]} */
const DEFINITIONS = [
  // 公开只读（旧路径，v1 的兼容壳；字段与 v1 完全一致）
  { method: 'GET', path: '/api/meta', handler: publicRoutes.meta, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/categories', handler: publicRoutes.listCategories, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/tags', handler: publicRoutes.listTags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/subtags', handler: publicRoutes.listSubtags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/wallpapers', handler: publicRoutes.listWallpapers, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/wallpapers/:slug', handler: publicRoutes.getWallpaper, auth: 'none', cors: true },

  // 公开只读 v1（素材网 API 地基；详情也在匿名白名单里）
  { method: 'GET', path: '/api/v1/public/categories', handler: publicV1Routes.listCategories, auth: 'none', cors: true },
  { method: 'GET', path: '/api/v1/public/tags', handler: publicV1Routes.listTags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/v1/public/subtags', handler: publicV1Routes.listSubtags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/v1/public/manifest.json', handler: publicV1Routes.manifest, auth: 'none', cors: true },
  { method: 'GET', path: '/api/v1/public/wallpapers', handler: publicV1Routes.listWallpapers, auth: 'none', cors: true },
  { method: 'GET', path: '/api/v1/public/wallpapers/:slug', handler: publicV1Routes.getWallpaper, auth: 'none', cors: true },

  // 认证
  { method: 'POST', path: '/api/setup', handler: authRoutes.setup, auth: 'none' },
  // 插件专用：精简清单 + ETag
  { method: 'GET', path: '/api/plugin/feed', handler: publicRoutes.pluginFeed, auth: 'none', cors: true },
  { method: 'GET', path: '/api/auth/me', handler: authRoutes.me, auth: 'session' },
  { method: 'POST', path: '/api/auth/login', handler: authRoutes.login, auth: 'none' },
  { method: 'POST', path: '/api/auth/logout', handler: authRoutes.logout, auth: 'none' },
  { method: 'POST', path: '/api/auth/password', handler: authRoutes.changePassword, auth: 'session' },

  // 壁纸
  { method: 'GET', path: '/api/admin/wallpapers', handler: wallpaperRoutes.list, auth: 'session' },
  { method: 'POST', path: '/api/admin/wallpapers', handler: wallpaperRoutes.create, auth: 'session' },
  { method: 'POST', path: '/api/admin/wallpapers/approve-all', handler: wallpaperRoutes.approveAll, auth: 'session' },
  // 批量入口（立即扫描/添加目录 + 批量导入本地文件）：一个文件一枪，返回导入报告。
  // 与单条 PUT /asset 走同一个 ingestAsset()，见 routes/wallpapers.js 的 importAsset()。
  { method: 'POST', path: '/api/admin/wallpapers/import', handler: wallpaperRoutes.importAsset, auth: 'session' },
  { method: 'POST', path: '/api/admin/wallpapers/reorder', handler: wallpaperRoutes.reorder, auth: 'session' },
  { method: 'GET', path: '/api/admin/wallpapers/:id', handler: wallpaperRoutes.get, auth: 'session' },
  { method: 'GET', path: '/api/admin/subtags', handler: subtagRoutes.list, auth: 'session' },
  { method: 'POST', path: '/api/admin/subtags', handler: subtagRoutes.create, auth: 'session' },
  // 作品里实际用过的子标签（筛选下拉用），和字典分开
  { method: 'GET', path: '/api/admin/subtags/used', handler: wallpaperRoutes.subtags, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/subtags/:id', handler: subtagRoutes.update, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/subtags/:id', handler: subtagRoutes.remove, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/wallpapers/:id', handler: wallpaperRoutes.update, auth: 'session' },
  { method: 'PUT', path: '/api/admin/wallpapers/:id/asset', handler: wallpaperRoutes.upload, auth: 'session' },
  { method: 'PUT', path: '/api/admin/wallpapers/:id/thumb', handler: wallpaperRoutes.uploadThumb, auth: 'session' },
  // 大文件分片上传（R2 multipart）
  { method: 'POST', path: '/api/admin/uploads/init', handler: uploadRoutes.init, auth: 'session' },
  { method: 'PUT', path: '/api/admin/uploads/part', handler: uploadRoutes.part, auth: 'session' },
  { method: 'POST', path: '/api/admin/uploads/complete', handler: uploadRoutes.complete, auth: 'session' },
  { method: 'POST', path: '/api/admin/uploads/abort', handler: uploadRoutes.abort, auth: 'session' },
  { method: 'POST', path: '/api/admin/uploads/cleanup', handler: uploadRoutes.cleanup, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/wallpapers/:id', handler: wallpaperRoutes.remove, auth: 'session' },

  // 分类
  { method: 'GET', path: '/api/admin/categories', handler: categoryRoutes.list, auth: 'session' },
  { method: 'POST', path: '/api/admin/categories', handler: categoryRoutes.create, auth: 'session' },
  { method: 'POST', path: '/api/admin/categories/reorder', handler: categoryRoutes.reorder, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/categories/:id', handler: categoryRoutes.update, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/categories/:id', handler: categoryRoutes.remove, auth: 'session' },
  { method: 'GET', path: '/api/admin/category-options', handler: categoryRoutes.options, auth: 'session' },
  { method: 'GET', path: '/api/admin/tag-stats', handler: categoryRoutes.tagStats, auth: 'session' },

  // 标签（分类页的第二块）
  { method: 'GET', path: '/api/admin/tags', handler: tagRoutes.list, auth: 'session' },
  { method: 'POST', path: '/api/admin/tags', handler: tagRoutes.create, auth: 'session' },
  { method: 'POST', path: '/api/admin/tags/reorder', handler: tagRoutes.reorder, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/tags/:id', handler: tagRoutes.update, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/tags/:id', handler: tagRoutes.remove, auth: 'session' },

  // 喜欢（按账号存在 D1）
  { method: 'GET', path: '/api/likes', handler: likeRoutes.list, auth: 'session' },
  { method: 'PUT', path: '/api/likes/:slug', handler: likeRoutes.add, auth: 'session' },
  { method: 'DELETE', path: '/api/likes/:slug', handler: likeRoutes.remove, auth: 'session' },

  // 成员
  { method: 'GET', path: '/api/admin/members', handler: memberRoutes.list, auth: 'session' },
  { method: 'POST', path: '/api/admin/members', handler: memberRoutes.create, auth: 'session' },
  { method: 'PATCH', path: '/api/admin/members/:id', handler: memberRoutes.update, auth: 'session' },
  { method: 'DELETE', path: '/api/admin/members/:id', handler: memberRoutes.remove, auth: 'session' },

  // 审计
  { method: 'GET', path: '/api/admin/audit', handler: auditRoutes.list, auth: 'session' },
];

function escapeSegment(segment) {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(definition) {
  const keys = [];
  const source = definition.path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return escapeSegment(segment);
    })
    .join('/');
  return { ...definition, pattern: new RegExp(`^${source}$`), keys };
}

const ROUTES = DEFINITIONS.map(compile);

/**
 * 公开接口缓存键的参数白名单。
 *
 * 为什么要这么干：缓存键原来是整个 url.toString()，于是 `?x=1` 这种随机参数
 * 每次都能绕过边缘缓存、直接打到 D1 —— 一个脚本就能把库打满。
 * 现在只把路由真正会读的参数按固定顺序拼回 key，未知参数一律丢弃。
 *
 * 注意「按固定顺序重新 append」而不是在原 URL 上 delete：URLSearchParams 的
 * 顺序取决于请求方写法，同一个逻辑请求换一下参数顺序就会变成另一个 key。
 *
 * 列表来自 routes/public.js（wallpapers / tags / subtags / categories）实际读取的参数；
 * `type` 是 /api/plugin/feed 自己的筛选参数，也必须留在 key 里，否则插件拿错清单。
 */
export const CACHE_PARAMS = [
  'category', 'kind', 'q', 'sort', 'featured', 'page', 'cursor', 'limit', 'tag', 'aspect', 'subtag', 'type',
  // 第一期：许可证筛选
  'license',
  // 第二期：尺寸 / 时长 / 体积 / 帧率上限 / 可播档位 / 音轨（顺序固定，新参数只能往后加）
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'minDurationMs', 'maxDurationMs', 'minBytes', 'maxBytes',
  'fpsMax', 'playable', 'audio',
];

export function cacheKeyUrl(url) {
  const normalized = new URL(url.origin + url.pathname);
  for (const name of CACHE_PARAMS) {
    for (const value of url.searchParams.getAll(name)) normalized.searchParams.append(name, value);
  }
  return normalized.toString();
}

/** 公开读接口的频率上限：每 IP 每分钟 120 次（isolate 内存计数，见 rate-limit.js 的局限说明）。 */
export const PUBLIC_RATE = { max: 120, windowMs: 60 * 1000 };

/**
 * 公开只读路径前缀（旧路径 + v1）。OPTIONS 预检只对这些路径回 CORS 头：
 * 插件 / 素材网客户端从任意源 fetch 都要能过预检，写接口一个都不放。
 */
export function isPublicReadPath(pathname) {
  return pathname.startsWith('/api/public/') || pathname.startsWith('/api/v1/public/');
}

function match(method, pathname) {
  // HEAD 与 GET 同义：HTTP 语义要求二者行为一致（只是不要 body）。
  // 路由表只声明 GET，不映射的话 HEAD 探针会拿到 405，边缘缓存命中标记也没法验证（TASK §5 A7）。
  const effective = method === 'HEAD' ? 'GET' : method;
  const byPath = [];
  for (const route of ROUTES) {
    const result = route.pattern.exec(pathname);
    if (!result) continue;
    byPath.push(route);
    if (route.method !== effective) continue;
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(result[index + 1]);
    });
    return { route, params };
  }
  return { route: null, params: null, allowed: byPath.map((r) => r.method) };
}

function withCors(response, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Pages Functions 入口。
 * @param {Request} request
 * @param {{DB: D1Database, BUCKET: R2Bucket, BOOTSTRAP_TOKEN?: string, PUBLIC_ORIGIN?: string}} env
 */
export async function handle(request, env) {
  const url = new URL(request.url);

  try {
    if (!url.pathname.startsWith('/api/')) throw notFound('接口不存在');

    if (request.method === 'OPTIONS') {
      if (isPublicReadPath(url.pathname)) return preflight(env);
      return new Response(null, { status: 204 });
    }

    assertSafeRequest(request, env);

    const { route, params, allowed } = match(request.method, url.pathname);
    if (!route) {
      if (allowed && allowed.length) return methodNotAllowed(allowed);
      throw notFound('接口不存在');
    }

    // 公开读接口限速（只对带 CORS 的公开 GET/HEAD 生效）。
    //
    // 两档配额（第三期）：
    //   · 带 API key（仅 v1）：按 key 的 rpm 计，默认 600/min；
    //   · 不带 key：按 IP 120/min（PUBLIC_RATE，见 rate-limit.js 的 isolate 内存局限）。
    // key 无效/停用必须 401，不能静默降级成匿名 —— 否则「配额」只是摆设。
    // 这一层在边缘缓存之前：命中缓存的请求同样计数，防止用缓存当免费通道刷配额。
    if (route.cors && (request.method === 'GET' || request.method === 'HEAD')) {
      let apiKey = null;
      if (url.pathname.startsWith('/api/v1/public/')) {
        const raw = readApiKey(request, url);
        if (raw) {
          const lookup = await findApiKey(env, raw);
          if (lookup.unavailable) {
            // 表还没迁移：回落匿名限流（公开读取优先可用），但字段已带 key 也不放行数据以外的特权
            apiKey = null;
          } else if (!lookup.key) {
            return withCors(failure(new HttpError(401, 'api_key_invalid', 'API key 无效或已停用')), env);
          } else {
            apiKey = lookup.key;
          }
        }
      }
      const plan = apiKey ? { max: apiKey.rpm, windowMs: 60 * 1000 } : PUBLIC_RATE;
      const bucket = apiKey ? `key:${apiKey.id}` : `pub:${clientIp(request)}`;
      const rl = hit(bucket, plan);
      if (rl.limited) {
        const limited = failure(tooManyRequests(`请求过于频繁，请 ${rl.retryAfter} 秒后再试`));
        const headers = new Headers(limited.headers);
        headers.set('retry-after', String(Math.max(1, rl.retryAfter)));
        headers.set('x-ratelimit-limit', String(plan.max));
        headers.set('x-ratelimit-remaining', '0');
        headers.set('x-ratelimit-window', String(Math.round(plan.windowMs / 1000)));
        for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
        return new Response(limited.body, { status: limited.status, headers });
      }
      // 使用时间回写（60s 节流），失败不影响读取
      if (apiKey) await touchApiKey(env, apiKey);
    }

    let actor = null;
    if (route.auth === 'session') {
      const session = await readSession(env, request);
      if (!session) throw unauthorized('登录已过期，请重新登录');
      actor = session.user;
    }

    // 公开只读接口在边缘缓存 5 分钟：插件反复打开列表时不用每次都查 D1。
    // 只缓存公开路由（GET/HEAD），带身份的管理接口一律不缓存。
    // cacheKey 只吃白名单参数（cacheKeyUrl），未知 query 不会把缓存击穿。
    //
    // **条件请求也必须走缓存**（2026-11-05 D1 额度事故的修复点之一）：
    // 原先带 If-None-Match 就绕过缓存、由 handler 重新查库算 ETag，于是插件每轮
    // 条件轮询都会回源（一次清单 = 清单 + count + facets 三条 SQL）。现在缓存里
    // 已经存了完整 200 + ETag，直接和它比较：命中回 304，没命中回缓存的 200，
    // 两种情况都不碰 D1。
    const edgeCacheable = route.cors
      && (request.method === 'GET' || request.method === 'HEAD')
      && typeof caches !== 'undefined'
      && caches.default;
    const cacheKey = edgeCacheable ? new Request(cacheKeyUrl(url), { method: 'GET' }) : null;

    if (edgeCacheable) {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
        headers.set('x-folia-edge', 'HIT');
        if (etagMatches(request.headers.get('if-none-match'), headers.get('etag'))) {
          headers.delete('content-length');
          headers.delete('content-type');
          return new Response(null, { status: 304, headers });
        }
        return new Response(request.method === 'HEAD' ? null : cached.body, { status: cached.status, headers });
      }
    }

    // 冷缓存 + 条件请求：先不带 If-None-Match 调 handler，拿到完整 200 才能写缓存；
    // 304 等缓存写入后再由本层判，避免「第一次条件请求把 304 写进缓存」。
    let handlerRequest = request;
    if (edgeCacheable && request.headers.get('if-none-match')) {
      const headers = new Headers(request.headers);
      headers.delete('if-none-match');
      handlerRequest = new Request(request.url, { method: request.method, headers });
    }

    const response = await route.handler({ request: handlerRequest, env, url, params, actor });
    const final = route.cors ? withCors(response, env) : response;

    // 只缓存 GET 的完整实体：HEAD 没有 body，若把 HEAD 的响应写进 GET 的 key，
    // 后续 GET 会拿到空 body。HEAD 仍然可以**读**上面的缓存。
    if (edgeCacheable && final.status === 200 && request.method === 'GET') {
      const headers = new Headers(final.headers);
      headers.set('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
      headers.set('x-folia-edge', 'MISS');
      try {
        await caches.default.put(cacheKey, new Response(final.clone().body, { status: 200, headers: new Headers(headers) }));
      } catch (error) {
        // 缓存写失败不是业务失败：照常把刚查到的 200 返回给客户端。
        console.warn('[api] 边缘缓存写入失败', url.pathname, error?.message ?? error);
      }
      // 回源响应也带 x-folia-edge: MISS，线上探针才能区分「回源」和「命中」。
      if (etagMatches(request.headers.get('if-none-match'), headers.get('etag'))) {
        headers.delete('content-length');
        headers.delete('content-type');
        return new Response(null, { status: 304, headers });
      }
      return new Response(request.method === 'HEAD' ? null : final.body, { status: final.status, headers });
    }

    return final;
  } catch (error) {
    // 公开路径的错误也带 CORS：浏览器里的素材网客户端要能读到 4xx 的 JSON，
    // 否则 fetch 只会抛一个没有信息的 TypeError（跨域被拦）。
    const respond = (response) => (isPublicReadPath(url.pathname) ? withCors(response, env) : response);
    if (error instanceof HttpError) {
      if (error.status >= 500) console.error('[api]', error.status, error.code, error.message);
      return respond(failure(error));
    }
    console.error('[api] unhandled', url.pathname, error?.stack ?? error?.message ?? error);
    // 排查用：DEBUG_API=1 时把真实异常带出来，默认关闭
    if (env && env.DEBUG_API === '1') {
      return respond(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'internal_error',
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').split('\n').slice(0, 6),
        },
      }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }));
    }
    return respond(failure(error));
  }
}

export { ROUTES, DEFINITIONS };
