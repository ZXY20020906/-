/**
 * 会话：随机 32 字节令牌 → 只把 sha256 存库；Cookie 取不到明文就偷不走。
 *
 * 加固两层：
 * 1. 设备绑定：登录时服务端再发一个随机 folia_device Cookie，库里只存它的 sha256。
 *    之后每个请求必须同时带上会话 Cookie 和设备 Cookie，且两者哈希匹配。
 *    只偷到一枚 folia_session（代理日志、截图、单条复制）用不了。
 * 2. 闲置超时：库里记 last_seen_at，闲置超过 SESSION_IDLE_MS（60 分钟）就要求重新登录；
 *    有活动时最多每分钟刷新一次 last_seen_at，避免每个静态资源都写库。
 *
 * 过期口径（只有两条，别记混）：
 * - 闲置过期：now - last_seen_at > SESSION_IDLE_MS（60 分钟）→ 删会话，要求重新登录；
 * - 绝对过期：expires_at = 创建时间 + SESSION_TTL_MS（7 天）。touchSession 只刷新
 *   last_seen_at，**不延长** expires_at，所以「7 天」是真正的绝对上限（滑动续期是刻意不做的：
 *   会话一旦泄漏，最迟 7 天必然失效；改这个行为属于安全策略变更，需单独立项）。
 *
 * Cookie 策略：HttpOnly + SameSite=Lax + Path=/ + Secure（HTTPS），且不带 Max-Age，
 * 关掉浏览器就消失。「关浏览器消失」只是浏览器侧行为，**不等于服务端过期**：
 * 服务端仍按上面的 60 分钟闲置 + 7 天绝对过期两条独立判定。
 */
import { Q } from './queries.js';
import { first, run } from './db.js';
import { constantTimeEqual, randomBytes, sha256Hex, toBase64Url } from './util.js';

export const SESSION_COOKIE = 'folia_session';
export const DEVICE_COOKIE = 'folia_device';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 60 分钟没有请求就要重新登录。 */
export const SESSION_IDLE_MS = 60 * 60 * 1000;
/** last_seen_at 最多每分钟写一次库。 */
export const SESSION_TOUCH_MS = 60 * 1000;

const DEVICE_RE = /^[A-Za-z0-9_-]{43}$/;

function parseCookieHeader(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

function cookiesOf(request) {
  return parseCookieHeader(request.headers.get('cookie'));
}

export function sessionTokenFromRequest(request) {
  return cookiesOf(request).get(SESSION_COOKIE) ?? null;
}

export function deviceIdFromRequest(request) {
  return cookiesOf(request).get(DEVICE_COOKIE) ?? null;
}

export function isValidDeviceId(value) {
  return typeof value === 'string' && DEVICE_RE.test(value);
}

export function isSecureRequest(request) {
  return new URL(request.url).protocol === 'https:';
}

function serializeCookie(name, value, { maxAge, secure }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 一次响应要下两枚 Cookie，Headers 得逐个 append，不能拼在一个字符串里。 */
export function applyCookies(response, cookies) {
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}

export function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

export async function hashIp(ip) {
  return (await sha256Hex(`folia:${ip}`)).slice(0, 16);
}

function buildUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active === 1 || row.active === true,
  };
}

/**
 * 建会话：同时生成设备标识，返回两枚需要下发的 Cookie。
 * @returns {Promise<{token: string, tokenHash: string, expiresAt: number, cookies: string[]}>}
 */
export async function createSession(env, user, request) {
  const token = toBase64Url(randomBytes(32));
  const tokenHash = await sha256Hex(token);

  const deviceId = toBase64Url(randomBytes(32));
  const deviceHash = await sha256Hex(deviceId);

  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await run(
    env,
    Q.insertSession,
    tokenHash,
    user.id,
    now,
    expiresAt,
    (request.headers.get('user-agent') ?? '').slice(0, 300),
    await hashIp(clientIp(request)),
    deviceHash,
    now,
  );

  const secure = isSecureRequest(request);
  return {
    token,
    tokenHash,
    expiresAt,
    cookies: [
      serializeCookie(SESSION_COOKIE, token, { secure }),
      serializeCookie(DEVICE_COOKIE, deviceId, { secure }),
    ],
  };
}

/** @returns {Promise<{user: object, tokenHash: string}|null>} */
export async function readSession(env, request) {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await first(env, Q.sessionByToken, tokenHash);
  if (!row) return null;

  const now = Date.now();
  if (Number(row.expires_at) <= now) {
    await run(env, Q.deleteSession, tokenHash).catch(() => {});
    return null;
  }
  if (row.active !== 1 && row.active !== true) return null;

  // 设备绑定：迁移前的老会话没有 device_hash，一律作废，逼一次重新登录。
  if (!row.device_hash) return null;
  const deviceId = deviceIdFromRequest(request);
  if (!deviceId) return null;
  const deviceHash = await sha256Hex(deviceId);
  if (!constantTimeEqual(deviceHash, row.device_hash)) return null;

  // 闲置超时
  const lastSeen = Number(row.last_seen_at ?? row.created_at ?? 0);
  if (!lastSeen || now - lastSeen > SESSION_IDLE_MS) {
    await run(env, Q.deleteSession, tokenHash).catch(() => {});
    return null;
  }

  // 有活动就续期，但最多每分钟写一次库
  if (now - lastSeen > SESSION_TOUCH_MS) {
    await run(env, Q.touchSession, now, tokenHash).catch(() => {});
  }

  return { user: buildUser(row), tokenHash };
}

export function clearSessionCookies(request) {
  const secure = isSecureRequest(request);
  return [
    serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure }),
    serializeCookie(DEVICE_COOKIE, '', { maxAge: 0, secure }),
  ];
}

export async function destroySession(env, tokenHash) {
  if (!tokenHash) return;
  await run(env, Q.deleteSession, tokenHash);
}

export async function destroyAllSessions(env, userId) {
  await run(env, Q.deleteUserSessions, userId);
}

export async function pruneExpiredSessions(env) {
  await run(env, Q.deleteExpiredSessions, Date.now()).catch(() => {});
}
