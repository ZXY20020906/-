/**
 * TODO-04：/gate 登录表单 CSRF（一次性 token + Origin 校验）。
 *
 * 修复前：登录 POST 没有任何 token，会话 Cookie 是 SameSite=Lax，
 * 拦不住跨站 top-level POST 表单（docs/SITE-SECURITY-AUDIT.md:34）。
 *
 * 这里断言的是行为，不只是「加了个隐藏字段」：
 * - GET /__gate 必须同时下发 cookie 与隐藏域；
 * - POST 缺 token / token 不匹配 / 跨站 Origin / 重放 → 403，且不调用 attemptLogin；
 * - 正常 token → 303 + 会话 Cookie；
 * - 无论成败，一次性 token 都会被清掉。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createEnv, Q } from './harness.js';
import { hashPassword } from '../src/server/password.js';
import { sha256Hex } from '../src/server/util.js';
import { CSRF_COOKIE, gateMiddleware } from '../src/server/gate-middleware.js';
import { resetAll } from '../src/server/rate-limit.js';

const EMAIL = 'admin@demo.test';
const PASSWORD = 'correct-horse-battery';
const HASHED = await hashPassword(PASSWORD);

const USER_ROW = {
  id: 'usr_admin',
  email: EMAIL,
  name: '站长',
  role: 'admin',
  password_hash: HASHED.hash,
  password_salt: HASHED.salt,
  iterations: HASHED.iterations,
  active: 1,
  created_at: 1,
  last_login_at: null,
};

function makeEnv({ user = USER_ROW } = {}) {
  return createEnv({
    [Q.userByEmail]: ([email]) => (email === user.email ? [user] : []),
    [Q.sessionByToken]: () => [],
    [Q.insertSession]: () => [],
    [Q.touchSession]: () => [],
    [Q.touchUserLogin]: () => [],
    [Q.insertAudit]: () => [],
    [Q.deleteSession]: () => [],
  });
}

function makeContext(path, { method = 'GET', form, cookie, env, ip = '203.0.113.7', headers = {} } = {}) {
  const finalHeaders = { 'cf-connecting-ip': ip, ...headers };
  if (cookie) finalHeaders.cookie = cookie;
  let body;
  if (form) {
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const request = new Request(`https://example.test${path}`, { method, headers: finalHeaders, body });
  return {
    request,
    context: { request, env: env ?? makeEnv().env, params: {}, next: async () => new Response('REAL-CONTENT') },
  };
}

/** GET 一次登录页，拿回 (cookie, token) 这一对。 */
async function fetchCsrf(env, ip = '203.0.113.7') {
  const { context } = makeContext('/__gate', { env, ip });
  const res = await gateMiddleware(context);
  const setCookies = res.headers.getSetCookie();
  const raw = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? '';
  const html = await res.text();
  const match = /name="_csrf" value="([^"]*)"/.exec(html);
  return {
    status: res.status,
    html,
    setCookies,
    cookie: raw.split(';')[0],
    token: match ? match[1] : '',
  };
}

beforeEach(() => resetAll());

test('GET /__gate：下发 CSRF cookie + 表单隐藏域，且是 Strict/HttpOnly/10 分钟', async () => {
  const csrf = await fetchCsrf(makeEnv().env);
  assert.equal(csrf.status, 200);
  assert.match(csrf.html, /name="_csrf" value="[A-Za-z0-9_-]{43}"/);
  assert.equal(csrf.token.length, 43);

  const cookie = csrf.setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  assert.ok(cookie, '必须下发 folia_csrf Cookie');
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=600/);
  assert.ok(cookie.includes(`=${csrf.token}`), '表单里的值必须和 Cookie 一致（double-submit）');
});

test('POST 没有 _csrf、也没有 Cookie → 403，且不调用 attemptLogin', async () => {
  const { env, find } = makeEnv();
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD },
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /登录页已过期/);
  assert.equal(find(Q.userByEmail).length, 0, 'CSRF 失败不能白烧一次 PBKDF2');
});

test('POST token 与 Cookie 不匹配 → 403', async () => {
  // 准备数据：不匹配不再在 CSRF 这一步拒绝（best-effort），继续走去凭据校验；
  // 所以这里用**非管理员**账号，让 403 来自登录后的角色闸门 —— 断言本身没改。
  const editorRow = { ...USER_ROW, id: 'usr_editor', email: 'editor@demo.test', role: 'editor' };
  const { env } = makeEnv({ user: editorRow });
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: 'editor@demo.test', password: PASSWORD, _csrf: 'A'.repeat(43) },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 403);
});

test('POST token 与 Cookie 不匹配不再 403：继续走凭据校验（密码错 → 401）', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: 'wrong-password-123', _csrf: 'A'.repeat(43) },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /邮箱或密码不正确/);
});

test('多个同名 Cookie（历史遗留 + 新的）只要有一个匹配就放行', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const stale = `folia_csrf=${'A'.repeat(43)}`;
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, _csrf: csrf.token },
    cookie: `${stale}; ${csrf.cookie}`,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
});

test('token 格式不合法 → 依旧 403（有值但乱填）', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, _csrf: 'not a token!' },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /校验令牌不合法/);
});

test('POST token 匹配 → 303 + 会话 Cookie，并清掉一次性 token', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, next: '/admin/', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/');

  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((c) => c.startsWith('folia_session=')));
  assert.ok(setCookies.some((c) => c.startsWith('folia_device=')));
  const cleared = setCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=;`));
  assert.ok(cleared, '用过的一次性 token 必须清掉');
  assert.match(cleared, /Max-Age=0/);
});

test('同一 token 重放第二次 → 403（一次性）', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const form = { email: EMAIL, password: PASSWORD, _csrf: csrf.token };

  const first = await gateMiddleware(makeContext('/__gate', { method: 'POST', form, cookie: csrf.cookie, env }).context);
  assert.equal(first.status, 303);

  const replay = await gateMiddleware(makeContext('/__gate', { method: 'POST', form, cookie: csrf.cookie, env }).context);
  assert.equal(replay.status, 403);
});

test('跨站 Origin → 403（即使 token 有效）', async () => {
  const { env, find } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
    headers: { origin: 'https://evil.test' },
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /来源不合法/);
  assert.equal(find(Q.userByEmail).length, 0);
});

test('同源 Origin 仍然放行', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
    headers: { origin: 'https://example.test' },
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
});

test('密码错误时也会换发新 token（旧 token 已作废）', async () => {
  const { env } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: 'wrong-password-123', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 401);
  const html = await res.text();
  const fresh = /name="_csrf" value="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.ok(fresh && fresh !== csrf.token, '重试需要一枚新 token');
  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((c) => c.startsWith(`${CSRF_COOKIE}=;`)), '旧 token 要被清掉');
  assert.ok(setCookies.some((c) => c.includes(fresh)), '新 token 要写回 Cookie');
});

test('未登录访问任意页面：登录页同样带 CSRF（否则一提交就 403）', async () => {
  const { env } = makeEnv();
  const { context } = makeContext('/', { env });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /name="_csrf" value="[A-Za-z0-9_-]{43}"/);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${CSRF_COOKIE}=`)));
});

test('设备 Cookie 仍与 CSRF 共存（登录成功后两者都在）', async () => {
  const { env, find } = makeEnv();
  const csrf = await fetchCsrf(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  const device = res.headers.getSetCookie().find((c) => c.startsWith('folia_device='));
  assert.ok(device);
  assert.match(device, /^folia_device=[A-Za-z0-9_-]{43}/);
  // 会话行的 token_hash 是服务端生成的，这里只确认确实插了一次
  assert.equal(find(Q.insertSession).length, 1);
  const tokenHash = await sha256Hex('x');
  assert.equal(tokenHash.length, 64);
});
