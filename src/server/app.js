/**
 * 应用路由。判定顺序：安全头/CSRF → 匹配路由 → 取会话 → 业务权限 → 执行。
 * 权限只在 routes/* 里用 assertCan 判定，路由表不重复声明，避免两处规则打架。
 */
import { assertSafeRequest, corsHeaders, failure, methodNotAllowed, preflight } from './http.js';
import { readSession } from './session.js';
import { HttpError, notFound, unauthorized } from '../core/errors.js';
import * as authRoutes from './routes/auth.js';
import * as publicRoutes from './routes/public.js';
import * as wallpaperRoutes from './routes/wallpapers.js';
import * as categoryRoutes from './routes/categories.js';
import * as tagRoutes from './routes/tags.js';
import * as likeRoutes from './routes/likes.js';
import * as subtagRoutes from './routes/subtags.js';
import * as memberRoutes from './routes/members.js';
import * as auditRoutes from './routes/audit.js';

/** @type {{method:string, path:string, handler:Function, auth:'none'|'session', cors?:boolean}[]} */
const DEFINITIONS = [
  // 公开只读
  { method: 'GET', path: '/api/meta', handler: publicRoutes.meta, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/categories', handler: publicRoutes.listCategories, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/tags', handler: publicRoutes.listTags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/subtags', handler: publicRoutes.listSubtags, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/wallpapers', handler: publicRoutes.listWallpapers, auth: 'none', cors: true },
  { method: 'GET', path: '/api/public/wallpapers/:slug', handler: publicRoutes.getWallpaper, auth: 'none', cors: true },

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

function match(method, pathname) {
  const byPath = [];
  for (const route of ROUTES) {
    const result = route.pattern.exec(pathname);
    if (!result) continue;
    byPath.push(route);
    if (route.method !== method) continue;
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
      if (url.pathname.startsWith('/api/public/')) return preflight(env);
      return new Response(null, { status: 204 });
    }

    assertSafeRequest(request, env);

    const { route, params, allowed } = match(request.method, url.pathname);
    if (!route) {
      if (allowed && allowed.length) return methodNotAllowed(allowed);
      throw notFound('接口不存在');
    }

    let actor = null;
    if (route.auth === 'session') {
      const session = await readSession(env, request);
      if (!session) throw unauthorized('登录已过期，请重新登录');
      actor = session.user;
    }

    // 公开只读接口在边缘缓存 30 秒：插件反复打开列表时不用每次都查 D1。
    // 只缓存 GET 的公开路由，带身份的管理接口一律不缓存。
    const edgeCacheable = route.cors
      && request.method === 'GET'
      && typeof caches !== 'undefined'
      && caches.default;
    const cacheKey = edgeCacheable ? new Request(url.toString(), { method: 'GET' }) : null;

    if (edgeCacheable) {
      const hit = await caches.default.match(cacheKey);
      if (hit) {
        const headers = new Headers(hit.headers);
        for (const [key, value] of Object.entries(corsHeaders(env))) headers.set(key, value);
        headers.set('x-folia-edge', 'HIT');
        return new Response(hit.body, { status: hit.status, headers });
      }
    }

    const response = await route.handler({ request, env, url, params, actor });
    const final = route.cors ? withCors(response, env) : response;

    if (edgeCacheable && final.status === 200) {
      const headers = new Headers(final.headers);
      headers.set('cache-control', 'public, max-age=30, stale-while-revalidate=60');
      headers.set('x-folia-edge', 'MISS');
      await caches.default.put(cacheKey, new Response(final.clone().body, { status: 200, headers }));
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
