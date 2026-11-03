/**
 * 认证相关接口：
 *   GET  /api/auth/me
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   POST /api/auth/password
 *   POST /api/setup            首次初始化管理员（只在 users 为空时可用）
 */
import { Q } from '../queries.js';
import { count, first, run } from '../db.js';
import { nowMs } from '../db.js';
import { hashPassword, needsRehash, verifyPassword } from '../password.js';
import { applyCookies, clearSessionCookies, createSession, destroyAllSessions, destroySession, readSession } from '../session.js';
import { clientIp } from '../session.js';
import { parseLogin, parsePasswordChange, parseSetup } from '../../core/validate.js';
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from '../../core/errors.js';
import { writeAudit, AUDIT_ACTION } from '../audit.js';
import { newId } from '../util.js';
import { ROLE } from '../../core/permissions.js';
import { sessionUserDto } from '../dto.js';
import { hit, reset } from '../rate-limit.js';
import { created, json, readJson } from '../http.js';

const WINDOW = 15 * 60 * 1000;

export async function me({ request, env }) {
  const session = await readSession(env, request);
  if (!session) throw unauthorized('未登录');
  return json({ user: sessionUserDto(session.user) });
}

/**
 * 校验邮箱口令并建立会话；失败抛 HttpError。
 * 登录接口与站点登录页（/__gate）共用这一份逻辑，限流、审计、rehash 不会两套。
 */
export async function attemptLogin(env, request, email, password) {
  const ip = clientIp(request);

  const byIp = hit(`login:ip:${ip}`, { max: 30, windowMs: WINDOW });
  if (byIp.limited) throw tooManyRequests('登录尝试过于频繁，请稍后再试');
  const byAccount = hit(`login:acct:${ip}:${email}`, { max: 5, windowMs: WINDOW });
  if (byAccount.limited) throw tooManyRequests('该账号尝试次数过多，请 15 分钟后再试');

  const user = await first(env, Q.userByEmail, email);
  if (!user) {
    // 无此账号也跑一次 PBKDF2，避免用响应时间探测邮箱是否存在
    await hashPassword(password);
    await writeAudit(env, { action: AUDIT_ACTION.LOGIN_FAILED, targetType: 'auth', detail: `${email} (无此账号)` });
    throw unauthorized('邮箱或密码不正确');
  }

  const valid = await verifyPassword(password, user);
  if (!valid || !(user.active === 1 || user.active === true)) {
    await writeAudit(env, {
      actor: { id: user.id, email: user.email, role: user.role },
      action: AUDIT_ACTION.LOGIN_FAILED,
      targetType: 'auth',
      targetId: user.id,
      detail: valid ? '账号已停用' : '密码错误',
    });
    throw unauthorized('邮箱或密码不正确');
  }

  if (needsRehash(user)) {
    const rehashed = await hashPassword(password);
    await run(env, Q.updateUserPassword, rehashed.hash, rehashed.salt, rehashed.iterations, nowMs(), user.id);
  }

  const session = await createSession(env, user, request);
  await run(env, Q.touchUserLogin, nowMs(), user.id);
  await writeAudit(env, {
    actor: user,
    action: AUDIT_ACTION.LOGIN,
    targetType: 'auth',
    targetId: user.id,
    detail: `${user.role} 登录`,
  });
  reset(`login:acct:${ip}:${email}`);

  return { user, session };
}

export async function login({ request, env }) {
  const { email, password } = parseLogin(await readJson(request));
  const { user, session } = await attemptLogin(env, request, email, password);

  return applyCookies(
    json({ user: sessionUserDto(user), expiresAt: session.expiresAt }),
    session.cookies,
  );
}

export async function logout({ request, env }) {
  const session = await readSession(env, request);
  if (session) {
    await destroySession(env, session.tokenHash);
    await writeAudit(env, { actor: session.user, action: AUDIT_ACTION.LOGOUT, targetType: 'auth', targetId: session.user.id });
  }
  return applyCookies(json({ loggedOut: true }), clearSessionCookies(request));
}

export async function changePassword({ request, env }) {
  const session = await readSession(env, request);
  if (!session) throw unauthorized('未登录');
  const { currentPassword, newPassword } = parsePasswordChange(await readJson(request));

  const row = await first(env, Q.userById, session.user.id);
  if (!row || !(await verifyPassword(currentPassword, row))) {
    throw badRequest('当前密码不正确', { field: 'currentPassword' });
  }
  if (currentPassword === newPassword) throw badRequest('新密码不能与当前密码相同', { field: 'newPassword' });

  const hashed = await hashPassword(newPassword);
  await run(env, Q.updateUserPassword, hashed.hash, hashed.salt, hashed.iterations, nowMs(), session.user.id);
  // 改密后踢掉所有旧会话（含当前），再给当前设备发一个新会话
  await destroyAllSessions(env, session.user.id);
  const fresh = await createSession(env, session.user, request);
  await writeAudit(env, {
    actor: session.user,
    action: AUDIT_ACTION.PASSWORD_CHANGED,
    targetType: 'member',
    targetId: session.user.id,
  });

  return applyCookies(json({ changed: true }), fresh.cookies);
}

export async function setup({ request, env }) {
  const body = await readJson(request);
  const existing = await count(env, Q.countUsers);
  if (existing > 0) throw conflict('站点已经初始化过，请直接登录');

  if (!env.BOOTSTRAP_TOKEN) {
    throw forbidden('服务端未配置 BOOTSTRAP_TOKEN，无法初始化');
  }
  const { token, email, name, password } = parseSetup(body);
  if (token !== env.BOOTSTRAP_TOKEN) throw forbidden('初始化令牌不正确');

  const hashed = await hashPassword(password);
  const now = nowMs();
  const id = newId('usr');
  await run(env, Q.insertUser, id, email, name, ROLE.ADMIN, hashed.hash, hashed.salt, hashed.iterations, 1, now, now);
  await writeAudit(env, {
    actor: { id, email, role: ROLE.ADMIN },
    action: AUDIT_ACTION.SETUP,
    targetType: 'member',
    targetId: id,
    detail: '初始化第一位管理员',
  });

  const user = { id, email, name, role: ROLE.ADMIN, active: true };
  const session = await createSession(env, user, request);
  return applyCookies(created({ user: sessionUserDto(user) }), session.cookies);
}
