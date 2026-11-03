/**
 * 站点门：只有管理员会话能进。
 *
 * 规则：
 * - 有效会话且 role=admin → 照常放行；
 * - 有会话但不是管理员 → 清掉会话，回登录页并说明原因（避免“登录了却一直弹回登录页”的死循环）；
 * - 没有会话 → 页面给登录页（401），/api/* 给 401 site_locked，/media/* 给 403；
 * - 认证接口放行，否则登录页自己没法登录、后台会话过期后也没法重新登；
 * - 插件只读白名单放行：GET/HEAD 的 /api/public/wallpapers 与 /media/*（见下）；
 * - /__gate 本身处理：GET 登录页、POST 登录、?logout=1 退出。
 *
 * 会话读库有成本（每个请求一次 D1 读），换来的是“停用账号/退出登录立刻生效”，
 * 私人站点这点量完全值得。
 */
import { readSession, applyCookies, clearSessionCookies, destroySession } from './session.js';
import { attemptLogin } from './routes/auth.js';
import { writeAudit, AUDIT_ACTION } from './audit.js';
import { parseLogin } from '../core/validate.js';
import { ROLE } from '../core/permissions.js';
import { HttpError } from '../core/errors.js';
import { isGatePath, safeNext } from './gate.js';
import { loginPage, lockedJson, lockedMedia } from './gate-page.js';

const MAX_BODY_BYTES = 4096;

/** 这些接口由它们自己校验身份，放行登录页才能工作。 */
const AUTH_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/meta',
  '/api/setup', // 空库初始化：靠 BOOTSTRAP_TOKEN + countUsers 自校验
]);

/**
 * 匿名只读白名单。
 *
 * 桌面插件（以及以后别的客户端）要能在不登录的情况下拉「已发布」清单，
 * 并把清单里的封面和原文件直接当 <img src> / 下载地址用——否则整条链路都被登录门挡住。
 *
 * 放开的是「已发布」数据（草稿、下线作品本来就不在公开接口里），而且媒体 key 里带
 * wallpaper id + 内容哈希，没法枚举。写接口一个都没放。
 *
 * 只认 GET/HEAD，并且是精确路径 / 前缀，别的路径照旧要管理员会话。
 */
const PUBLIC_READ_PATHS = new Set(['/api/public/wallpapers']);
const PUBLIC_READ_PREFIXES = ['/media/'];

function isPublicRead(request, url) {
  // OPTIONS 也要放：带 Range 的媒体请求会触发预检，不放就只有 401，插件下不动文件
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') return false;
  if (PUBLIC_READ_PATHS.has(url.pathname)) return true;
  return PUBLIC_READ_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

const NO_STORE = {
  'cache-control': 'no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow',
};

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, location, ...extraHeaders },
  });
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  return text;
}

async function currentSession(env, request) {
  try {
    return await readSession(env, request);
  } catch (error) {
    console.error('[gate] 会话查询失败', error?.message ?? error);
    return null;
  }
}

const isAdminSession = (session) => session?.user?.role === ROLE.ADMIN;

/**
 * 有会话但不是管理员：把会话销毁并清 Cookie。
 * 不这么做的话，编辑账号会卡在“登录成功 → 被弹回登录页 → 再登录”的循环里。
 */
async function dropNonAdminSession(env, request, session) {
  try {
    await destroySession(env, session.tokenHash);
    await writeAudit(env, {
      actor: session.user,
      action: AUDIT_ACTION.LOGOUT,
      targetType: 'auth',
      targetId: session.user.id,
      detail: '非管理员访问站点，会话已清除',
    });
  } catch (error) {
    console.error('[gate] 清理非管理员会话失败', error?.message ?? error);
  }
  return clearSessionCookies(request);
}

async function logout(context) {
  const { request, env } = context;
  try {
    const session = await readSession(env, request);
    if (session) {
      await destroySession(env, session.tokenHash);
      await writeAudit(env, {
        actor: session.user,
        action: AUDIT_ACTION.LOGOUT,
        targetType: 'auth',
        targetId: session.user.id,
      });
    }
  } catch (error) {
    console.error('[gate] 退出失败', error?.message ?? error);
  }
  return applyCookies(redirect('/'), clearSessionCookies(request));
}

async function handleGate(context, url) {
  const { request, env } = context;
  const next = safeNext(url.searchParams.get('next'));

  if (url.searchParams.get('logout') === '1') return logout(context);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const session = await currentSession(env, request);
    if (isAdminSession(session)) return redirect(next);
    if (session?.user) {
      return applyCookies(
        loginPage({
          status: 200,
          next,
          error: '这个账号不是管理员，无法进入站点。',
        }),
        await dropNonAdminSession(env, request, session),
      );
    }
    return loginPage({ status: 200, next });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...NO_STORE, allow: 'GET, HEAD, POST' },
    });
  }

  const text = await readBody(request);
  if (text === null) return loginPage({ status: 400, error: '提交内容过大，请重试。', next: '/' });

  const form = new URLSearchParams(text);
  const target = safeNext(form.get('next'));

  try {
    const { email, password } = parseLogin({
      email: form.get('email') ?? '',
      password: form.get('password') ?? '',
    });
    const { user, session } = await attemptLogin(env, request, email, password);

    // 登录成功但角色不是管理员：立刻销毁会话，不给任何访问权限。
    if (user.role !== ROLE.ADMIN) {
      await destroySession(env, session.tokenHash);
      await writeAudit(env, {
        actor: user,
        action: AUDIT_ACTION.LOGIN_FAILED,
        targetType: 'auth',
        targetId: user.id,
        detail: '非管理员账号尝试进入站点，已拒绝',
      });
      return applyCookies(
        loginPage({
          status: 403,
          next: target,
          error: '这个账号没有站点访问权限，只有管理员可以进入。',
        }),
        clearSessionCookies(request),
      );
    }

    return applyCookies(redirect(target), session.cookies);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : '登录失败，请稍后再试';
    return loginPage({ status, error: message, next: target });
  }
}

/**
 * Pages Functions 根中间件入口。
 * @param {{request: Request, env: Record<string, unknown>, next: () => Promise<Response>}} context
 */
export async function gateMiddleware(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (isGatePath(url.pathname)) return handleGate(context, url);
  if (AUTH_EXEMPT.has(url.pathname)) return context.next();
  // 插件只读清单 / 媒体文件：不查会话，直接放行（不碰 D1，顺带省一次查询）
  if (isPublicRead(request, url)) return context.next();

  const session = await currentSession(env, request);
  if (isAdminSession(session)) return context.next();

  if (session?.user) {
    return loginPage({
      status: 401,
      next: `${url.pathname}${url.search}`,
      error: '这个站点只对管理员开放。',
      headers: { 'set-cookie': await dropNonAdminSession(env, request, session) },
    });
  }

  if (url.pathname.startsWith('/api/')) return lockedJson();
  if (url.pathname.startsWith('/media/')) return lockedMedia();
  return loginPage({ status: 401, next: `${url.pathname}${url.search}` });
}
