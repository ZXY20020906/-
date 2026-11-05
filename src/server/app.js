/**
 * 应用路由。判定顺序：安全头/CSRF → 匹配路由 → 取会话 → 业务权限 → 执行。
 * 权限只在 routes/* 里用 assertCan 判定，路由表不重复声明，避免两处规则打架。
 */
import { assertSafeRequest, corsHeaders, failure, methodNotAllowed, preflight } from './http.js';
import { readSession, clientIp } from './session.js';
import { hit } from './rate-limit.js';
import { HttpError, notFound, tooManyRequests, unauthorized } from '../core/errors.js';
import * as authRoutes from './routes/auth.js';
import * as publicRoutes from './routes/public.js';
import * as publicV1Routes from './routes/public-v1.js';
import * as wallpaperRoutes from './routes/wallpapers.js';
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
  // 第一期新增：许可证筛选（第二期的数值/可播筛选依次追加在后面，顺序固定）
  'license',
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
    // 这是 isolate 内存计数的兜底；真正抗打要在 Cloudflare 控制台给 /api/public/* 配 Rate Limiting 规则。
    if (route.cors && (request.method === 'GET' || request.method === 'HEAD')) {
      const rl = hit(`pub:${clientIp(request)}`, PUBLIC_RATE);
      if (rl.limited) {
        const limited = failure(tooManyRequests(`请求过于频繁，请 ${rl.retryAfter} 秒后再试`));
        const headers = new Headers(limited.headers);
        headers.set('retry-after', String(Math.max(1, rl.retryAfter)));
        for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
        return new Response(limited.body, { status: limited.status, headers });
      }
    }

    let actor = null;
    if (route.auth === 'session') {
      const session = await readSession(env, request);
      if (!session) throw unauthorized('登录已过期，请重新登录');
      actor = session.user;
    }

    // 公开只读接口在边缘缓存 30 秒：插件反复打开列表时不用每次都查 D1。
    // 只缓存公开路由（GET/HEAD），带身份的管理接口一律不缓存。
    // cacheKey 只吃白名单参数（cacheKeyUrl），未知 query 不会把缓存击穿。
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
        return new Response(cached.body, { status: cached.status, headers });
      }
    }

    const response = await route.handler({ request, env, url, params, actor });
    const final = route.cors ? withCors(response, env) : response;

    if (edgeCacheable && final.status === 200) {
      const headers = new Headers(final.headers);
      headers.set('cache-control', 'public, max-age=30, stale-while-revalidate=60');
      headers.set('x-folia-edge', 'MISS');
      await caches.default.put(cacheKey, new Response(final.clone().body, { status: 200, headers: new Headers(headers) }));
      // 回源响应也带 x-folia-edge: MISS，线上探针才能区分「回源」和「命中」
      return new Response(final.body, { status: final.status, headers });
    }

    return final;
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status >= 500) console.error('[api]', error.status, error.code, error.message);
      return failure(error);
    }
    console.error('[api] unhandled', url.pathname, error?.stack ?? error?.message ?? error);
    // 排查用：DEBUG_API=1 时把真实异常带出来，默认关闭
    if (env && env.DEBUG_API === '1') {
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'internal_error',
          message: String(error?.message ?? error),
          stack: String(error?.stack ?? '').split('\n').slice(0, 6),
        },
      }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    return failure(error);
  }
}

export { ROUTES, DEFINITIONS };
