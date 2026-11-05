/**
 * 站点门：只有管理员会话能进。
 *
 * 规则：
 * - 有效会话且 role=admin → 照常放行；
 * - 有会话但不是管理员 → 清掉会话，回登录页并说明原因（避免“登录了却一直弹回登录页”的死循环）；
 * - 没有会话 → 页面给登录页（401），/api/* 给 401 site_locked，/media/* 给 403；
 * - 认证接口放行，否则登录页自己没法登录、后台会话过期后也没法重新登；
 * - 插件只读白名单放行：GET/HEAD 的 /api/public/wallpapers、/api/public/categories、
 *   /api/public/tags、/api/public/subtags 与 /media/*（见下）；
 * - /__gate 本身处理：GET 登录页、POST 登录、?logout=1 退出。
 *
 * 会话读库有成本（每个请求一次 D1 读），换来的是“停用账号/退出登录立刻生效”，
 * 私人站点这点量完全值得。
 */
import { readSession, applyCookies, clearSessionCookies, destroySession, isSecureRequest } from './session.js';
import { attemptLogin } from './routes/auth.js';
import { writeAudit, AUDIT_ACTION } from './audit.js';
import { parseLogin } from '../core/validate.js';
import { ROLE } from '../core/permissions.js';
import { HttpError } from '../core/errors.js';
import { isGatePath, safeNext } from './gate.js';
import { loginPage, lockedJson, lockedMedia } from './gate-page.js';
import { constantTimeEqual, randomBytes, sha256Hex, toBase64Url } from './util.js';

const MAX_BODY_BYTES = 4096;

/**
 * 登录表单的 CSRF：
 * - GET /__gate 时发一枚一次性 token，同时写进 Cookie 和表单隐藏域（double-submit）；
 * - POST 时先判来源（同源 Origin / PUBLIC_ORIGIN / 同源 Referer，见 checkSource），
 *   再要求两边都有 token 且格式合法；两边是否**逐字节相等**只做 best-effort（不一致不拦人）；
 * - Cookie 用 SameSite=Strict + HttpOnly，有效期 10 分钟，POST 之后一律清掉；
 *   GET 一定会 Set-Cookie，所以「从外站链接点进来 → 直接提交」也有 token 可用。
 * 为什么要做：会话 Cookie 是 SameSite=Lax，拦不住跨站 top-level POST 表单；
 * CSP 的 form-action 'self' 只是纵深，不是校验。
 *
 * 为什么「相等」只是 best-effort（2026-11 线上事故后改的）：
 * 真实浏览器里两边对不上的原因太多，且全都不是攻击 —— 多个标签页各渲染过登录页、浏览器留着
 * 历史同名 Cookie（换过 Path/Domain）、代理折叠 Set-Cookie、isolate 之间不共享内存……
 * 只要还有一处不一致就 403，管理员就彻底登不进来（刷新也没用：刷新只覆盖同名同路径的那一枚）。
 * 真正的防护链条是 SameSite=Strict + HttpOnly + 来源校验 + 凭据校验，其中没有任何一环
 * 依赖「Cookie 与隐藏域逐字节相等」——所以这里退化成：不一致 → 记结构化日志 → 继续走账号密码。
 *
 * 关于「一次性」：已用 token 的集合在 isolate 内存里，只用于压制**同 isolate 内**的重放，
 * 跨 isolate 的重放不一定被识别。它只会拒绝「哈希已在本 isolate 出现过」的 token，
 * 全新 token 的哈希不可能落在别的 isolate 的集合里，所以不会因为多 isolate 误判失效。
 * 重放判定只在 double-submit 真的对上时才做：对不上时把它当「一次性」拒绝纯属误伤。
 */
export const CSRF_COOKIE = 'folia_csrf';
export const CSRF_FIELD = '_csrf';
export const CSRF_TTL_MS = 10 * 60 * 1000;

/**
 * 令牌格式：32 字节随机数的 base64url（去掉 `=` 填充）→ 43 个字符。
 * 放宽到 32~128 位，是为了以后改长度时不至于把老页面全部判死；
 * 但「必须是 base64url 字符」这条要留着，否则 `_csrf="` 之类的东西也能混进日志与哈希表。
 */
const CSRF_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** 已用过的 token 哈希（一次性语义）。只存哈希，且有空闲上限，避免无界增长。 */
const usedCsrfTokens = new Map();
const MAX_USED_CSRF = 2000;

function csrfCookie(request, token) {
  const parts = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  parts.push(`Max-Age=${token ? Math.floor(CSRF_TTL_MS / 1000) : 0}`);
  if (isSecureRequest(request)) parts.push('Secure');
  return parts.join('; ');
}

/** 不管校验成功还是失败，POST 之后这枚 Cookie 都作废。 */
function clearCsrfCookie(request, response) {
  response.headers.append('set-cookie', csrfCookie(request, ''));
  return response;
}

/**
 * 读出请求里**所有** `folia_csrf` 值。
 *
 * 浏览器对「同名但不同 Path/Domain」的 Cookie 会一次全发过来（顺序按路径长度，长的在前）。
 * 旧实现只 `exec` 第一条，于是历史遗留的那枚 stale Cookie 永远排在前面、永远被拿去比较，
 * 表现为「刷新也没用，一直说令牌不匹配」——这次一并修掉：全部读出来，任何一个对上就算对上。
 */
function csrfTokensFromCookie(request) {
  const header = request.headers.get('cookie') ?? '';
  const values = [];
  const pattern = /(?:^|;\s*)folia_csrf=([^;]*)/g;
  let match;
  while ((match = pattern.exec(header)) !== null) values.push(match[1].trim());
  return values;
}

/**
 * 渲染登录页并顺手发一枚新 token。
 *
 * 硬约束：**一次渲染只生成一次随机数**，Cookie 与 HTML 隐藏域必须是同一个值。
 * 历史教训：如果 Cookie 和页面各生成一次（或 /__gate 存在两条 GET 渲染路径），
 * 页面里的值就永远对不上最后一次 Set-Cookie，用户会看到「校验令牌不匹配」且刷新无用。
 * 所以这里只留一个生成点，两条渲染入口共用它。
 *
 * `clearFirst`：POST 失败重渲染时先清旧 Cookie 再发新的（浏览器的 Set-Cookie 按顺序生效，
 * 最终留在 jar 里的是这一枚新 token，与页面里的值一致）。
 */
function issueCsrf(request, options = {}, { clearFirst = false } = {}) {
  const token = toBase64Url(randomBytes(32));
  const headers = { ...(options.headers ?? {}) };
  if (clearFirst) headers['set-cookie'] = csrfCookie(request, '');
  const response = loginPage({ ...options, csrf: token, headers });
  response.headers.append('set-cookie', csrfCookie(request, token));
  return response;
}

/** GET /__gate 或任意被门拦下的页面：发一枚新 token（HTML + Cookie 同源）。 */
function csrfLoginPage(request, options = {}) {
  return issueCsrf(request, options);
}

/**
 * POST 失败后重渲染登录页：旧 token 立刻作废（清 Cookie），同时发一枚新的，
 * 用户不用刷新页面就能重试。两条 Set-Cookie 顺序 = 先清后发，浏览器以最后一条为准。
 * 新 token 同样只生成一次，Cookie 与隐藏域同值（见 issueCsrf）。
 */
function csrfLoginPageAfterPost(request, options = {}) {
  return issueCsrf(request, options, { clearFirst: true });
}

async function consumeCsrfToken(token) {
  const now = Date.now();
  if (usedCsrfTokens.size > MAX_USED_CSRF) {
    for (const [key, expiresAt] of usedCsrfTokens) {
      if (now > expiresAt) usedCsrfTokens.delete(key);
      if (usedCsrfTokens.size <= MAX_USED_CSRF / 2) break;
    }
  }
  const hash = await sha256Hex(token);
  if (usedCsrfTokens.has(hash)) return false;
  usedCsrfTokens.set(hash, now + CSRF_TTL_MS);
  return true;
}

/**
 * 归一化成 `scheme://host[:port]`；拿不到合法 http(s) 来源时返回空串。
 *
 * `Origin: null`（沙箱 iframe、非 http 文档、部分隐私模式/代理）和畸形值一律算「没给来源」，
 * 交给 Referer 再判一次，而不是直接判失败——线上「登录请求来源不合法」误拦就是这么来的。
 */
function normalizeOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'null') return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * 来源判定：
 *   1) 有任何一个**能解析出来**的来源（Origin 或 Referer 的 origin），就必须命中其中之一：
 *        origin === selfOrigin            // request.url 自己的源
 *        || origin === env.PUBLIC_ORIGIN  // 归一化后的线上站点源（自定义域名 / 反向代理换 Host 时有差异）
 *        || refererOrigin === selfOrigin  // 浏览器给不出 Origin，但同源 Referer 还在
 *      否则 → 「来源不合法」。
 *   2) 两个头都没有、或都解析不出 origin（`Origin: null` 这种不透明来源）→ 只剩 double-submit 判。
 *
 * 为什么这么改：旧判据只比 `new URL(origin).host`，而且 Origin 解析失败就立刻 403。
 * Pages 后面隔着自定义域名 / 代理 / 隐私策略时，Origin 的字面 host 与 request.url 不一定相等，
 * 一次误拦就是「管理员彻底登不进来」。
 *
 * 为什么不担心放宽：浏览器发起的跨站表单 POST 一定带**可解析**的 `Origin: <攻击者站点>`，
 * 落进第 1 条照样 403；而「拿不到任何可解析来源」的请求既拿不到 HttpOnly 的 folia_csrf Cookie，
 * 也过不了 SameSite=Strict，double-submit 仍然必须成立。
 */
function checkSource(request, url, env) {
  const selfOrigin = url.origin;
  const envOrigin = normalizeOrigin(env?.PUBLIC_ORIGIN);
  const origin = normalizeOrigin(request.headers.get('origin'));
  const refererOrigin = normalizeOrigin(request.headers.get('referer'));

  const originOk = Boolean(origin) && (origin === selfOrigin || (envOrigin ? origin === envOrigin : false));
  const refererOk = Boolean(refererOrigin) && refererOrigin === selfOrigin;
  // 有没有「可用的来源信号」：Origin: null、畸形值都算没有
  const hasSignal = Boolean(origin) || Boolean(refererOrigin);

  return {
    ok: hasSignal ? originOk || refererOk : true,
    via: originOk ? 'origin' : refererOk ? 'referer' : hasSignal ? 'mismatch' : 'double-submit-only',
    detail: {
      selfOrigin,
      envOrigin,
      origin,
      refererOrigin,
      rawOrigin: String(request.headers.get('origin') ?? ''),
    },
  };
}

/**
 * 校验登录 POST：来源（同上）+ 表单/Cookie 双份 token「有值且格式合法」+ best-effort 相等 + 一次性。
 *
 * 分级：
 *   - 来源不合法            → 403（外站 Origin 一律挡住，不降级）
 *   - 缺 token / 格式不合法 → 403（这时确实没有可用票据，重开登录页就好）
 *   - 两边都对不上          → **不拒绝**，只记一条结构化日志（reason=csrf-mismatch），继续走凭据校验
 *   - 对上了但哈希已用过    → 403（一次性/重放抑制，只在既然 double-submit 成立时才判）
 * @returns {Promise<string>} 失败原因（空字符串表示通过）
 */
async function checkCsrf(request, form, url, env) {
  const source = checkSource(request, url, env);
  if (!source.ok) {
    // 只记来源，绝不记 token
    console.warn('[gate] 登录来源校验失败', source.via, JSON.stringify(source.detail));
    return '登录请求来源不合法，请从登录页重新进入。';
  }

  const fromForm = String(form.get(CSRF_FIELD) ?? '').trim();
  const cookieValues = csrfTokensFromCookie(request);
  const cookiePresent = cookieValues.some((value) => value !== '');
  if (!fromForm || !cookiePresent) return '登录页已过期（缺少校验令牌），请刷新重试';

  const formWellFormed = CSRF_TOKEN_RE.test(fromForm);
  const cookieWellFormed = cookieValues.some((value) => CSRF_TOKEN_RE.test(value));
  if (!formWellFormed || !cookieWellFormed) {
    console.warn(
      '[gate] csrf-invalid-format',
      JSON.stringify({
        reason: 'csrf-invalid-format',
        path: url.pathname,
        sourceVia: source.via,
        cookiePresent,
        cookieCount: cookieValues.length,
        formLength: fromForm.length,
      }),
    );
    return '登录页已过期（校验令牌不合法），请刷新重试';
  }

  // 逐字节相等降级为 best-effort：不相等不拦人。
  const matched = cookieValues.some((value) => constantTimeEqual(fromForm, value));
  if (!matched) {
    console.warn(
      '[gate] csrf-mismatch',
      JSON.stringify({
        reason: 'csrf-mismatch',
        path: url.pathname,
        sourceVia: source.via,
        // 来源：归一化后的 Origin / Referer 源（都可能是空串，表示浏览器没给）
        origin: source.detail.origin,
        referer: source.detail.refererOrigin,
        cookiePresent,
        cookieCount: cookieValues.length,
        // 只记长度，绝不记 token 本身
        formLength: fromForm.length,
        cookieLengths: cookieValues.map((value) => value.length),
        action: 'continue-to-credentials',
      }),
    );
    return '';
  }

  // 一次性：只有 double-submit 真的对上才谈重放，否则「已用过」会误伤正常用户
  if (!(await consumeCsrfToken(fromForm))) return '登录页已过期（校验令牌已被使用），请刷新重试';
  return '';
}

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
 * 桌面插件（以及以后别的客户端）要能在不登录的情况下拉「已发布」清单、分类/标签/子标签
 * 筛选面板，并把清单里的封面和原文件直接当 <img src> / 下载地址用——否则整条链路都被登录门挡住。
 *
 * 放开的是「已发布」数据（草稿、下线作品本来就不在公开接口里），而且媒体 key 里带
 * wallpaper id + 内容哈希，没法枚举。写接口一个都没放。
 *
 * 只认 GET/HEAD（外加 CORS 预检的 OPTIONS，它不是写操作），并且是精确路径 / 前缀，
 * 别的路径照旧要管理员会话。分类/标签/子标签这三个接口只是「给下拉框喂数据」，
 * 与清单用的是同一套「已发布」过滤条件，放开它们不会多露出任何非公开内容。
 */
const PUBLIC_READ_PATHS = new Set([
  '/api/public/wallpapers',
  '/api/public/categories',
  '/api/public/tags',
  '/api/public/subtags',
]);
/**
 * v1 整棵 `/api/v1/public/` 子树都放行的理由（2026-11 起）：
 *   - 它下面**只有**只读接口（列表 / 详情 / 分类 / 标签 / 子标签 / manifest）；
 *   - 素材网客户端必须能匿名拿详情，否则只有列表没有单条元数据，等于不可用；
 *   - 放行的是前缀而不是逐个路径：新增 v1 只读端点（如 manifest.json）不该每次改门禁，
 *     而 `/api/v1/` 下不存在任何写接口（写接口全在 `/api/admin/*`，需要会话）。
 * 媒体文件（/media/）继续单独放行。
 */
const PUBLIC_READ_PREFIXES = ['/media/', '/api/v1/public/'];

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
      const page = csrfLoginPage(request, {
        status: 200,
        next,
        error: '这个账号不是管理员，无法进入站点。',
      });
      for (const cookie of await dropNonAdminSession(env, request, session)) {
        page.headers.append('set-cookie', cookie);
      }
      return page;
    }
    return csrfLoginPage(request, { status: 200, next });
  }

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...NO_STORE, allow: 'GET, HEAD, POST' },
    });
  }

  const text = await readBody(request);
  if (text === null) {
    return csrfLoginPageAfterPost(request, { status: 400, error: '提交内容过大，请重试。', next: '/' });
  }

  const form = new URLSearchParams(text);
  const target = safeNext(form.get('next'));

  // CSRF 校验放在 attemptLogin 之前：失败时不白烧一次 PBKDF2，也不占用登录限流计数。
  const csrfError = await checkCsrf(request, form, url, env);
  if (csrfError) {
    console.warn('[gate] 登录 CSRF 校验失败', url.pathname);
    return csrfLoginPageAfterPost(request, { status: 403, next: target, error: csrfError });
  }

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
      return csrfLoginPageAfterPost(request, {
        status: 403,
        next: target,
        error: '这个账号没有站点访问权限，只有管理员可以进入。',
      });
    }

    // 登录成功：清掉用完的一次性 token，再下发会话 Cookie。
    return clearCsrfCookie(request, applyCookies(redirect(target), session.cookies));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : '登录失败，请稍后再试';
    return csrfLoginPageAfterPost(request, { status, error: message, next: target });
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
    const page = csrfLoginPage(request, {
      status: 401,
      next: `${url.pathname}${url.search}`,
      error: '这个站点只对管理员开放。',
    });
    // 两枚 Cookie（会话 + 设备）必须各自 append，塞进一个 header 会被逗号拼坏
    for (const cookie of await dropNonAdminSession(env, request, session)) {
      page.headers.append('set-cookie', cookie);
    }
    return page;
  }

  if (url.pathname.startsWith('/api/')) return lockedJson();
  if (url.pathname.startsWith('/media/')) return lockedMedia();
  return csrfLoginPage(request, { status: 401, next: `${url.pathname}${url.search}` });
}
