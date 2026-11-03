import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createEnv, Q } from './harness.js';
import { hashPassword } from '../src/server/password.js';
import { sha256Hex } from '../src/server/util.js';
import { safeNext } from '../src/server/gate.js';
import { SESSION_IDLE_MS } from '../src/server/session.js';
import { gateMiddleware } from '../src/server/gate-middleware.js';
import { resetAll } from '../src/server/rate-limit.js';

const EMAIL = 'admin@demo.test';
const PASSWORD = 'correct-horse-battery';
const SESSION_TOKEN = 'test-session-token';
const DEVICE_ID = 'd'.repeat(43);
const SESSION_HASH = await sha256Hex(SESSION_TOKEN);
const DEVICE_HASH = await sha256Hex(DEVICE_ID);
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

function sessionRow(overrides = {}) {
  return {
    token_hash: SESSION_HASH,
    expires_at: Date.now() + 60 * 60 * 1000,
    created_at: Date.now() - 60_000,
    device_hash: DEVICE_HASH,
    last_seen_at: Date.now() - 1000,
    id: 'usr_admin',
    email: EMAIL,
    name: '站长',
    role: 'admin',
    active: 1,
    ...overrides,
  };
}

function makeEnv({ user = USER_ROW, session } = {}) {
  // 默认会话行跟着 user 走（停用/角色变化要真实反映到 join 结果里）
  const row = session ?? sessionRow({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
  });
  return createEnv({
    [Q.userByEmail]: ([email]) => (user && email === user.email ? [user] : []),
    [Q.sessionByToken]: ([hash]) => (row && hash === row.token_hash ? [row] : []),
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
  const state = { nextCalls: 0 };
  return {
    state,
    context: {
      request,
      env: env ?? makeEnv().env,
      params: {},
      next: async () => {
        state.nextCalls += 1;
        return new Response('REAL-CONTENT', { status: 200 });
      },
    },
  };
}

const loggedInCookie = `folia_session=${SESSION_TOKEN}; folia_device=${DEVICE_ID}`;

/**
 * 取一枚登录表单 CSRF：GET /__gate 会同时下发 folia_csrf Cookie 与表单隐藏域。
 * 登录 POST 现在强制要求这一对（见 TODO-04），所以下面的登录用例必须先拿票。
 */
async function csrfPair(env, ip = '203.0.113.7') {
  const { context } = makeContext('/__gate', { env: env ?? makeEnv().env, ip });
  const res = await gateMiddleware(context);
  const cookie = (res.headers.getSetCookie().find((c) => c.startsWith('folia_csrf=')) ?? '').split(';')[0];
  const html = await res.text();
  const match = /name="_csrf" value="([^"]*)"/.exec(html);
  return { cookie, token: match ? match[1] : '' };
}

beforeEach(() => resetAll());

test('未登录：页面给登录页，未放行的接口给 site_locked', async () => {
  const page = makeContext('/');
  const pageRes = await gateMiddleware(page.context);
  assert.equal(pageRes.status, 401);
  assert.match(pageRes.headers.get('content-type'), /text\/html/);
  assert.equal(page.state.nextCalls, 0);
  const html = await pageRes.text();
  assert.match(html, /欢迎回家/);
  assert.match(html, /name="password"/);

  const api = makeContext('/api/public/categories');
  const apiRes = await gateMiddleware(api.context);
  assert.equal(apiRes.status, 401);
  assert.equal((await apiRes.json()).error.code, 'site_locked');
});

test('插件只读白名单：GET 清单与媒体匿名放行，其它路径和方法照旧要管理员', async () => {
  const list = makeContext('/api/public/wallpapers?category=assistant-skin&limit=100');
  const listRes = await gateMiddleware(list.context);
  assert.equal(listRes.status, 200);
  assert.equal(list.state.nextCalls, 1);

  for (const path of ['/media/wallpapers/wp_1/abc123.zip', '/media/thumbs/wp_1/abc123.webp']) {
    const ctx = makeContext(path);
    const res = await gateMiddleware(ctx.context);
    assert.equal(res.status, 200, path);
    assert.equal(ctx.state.nextCalls, 1, path);
  }

  // 带 Range 的媒体请求会先发预检，OPTIONS 也必须放行
  for (const path of ['/api/public/wallpapers', '/media/wallpapers/wp_1/abc123.zip']) {
    const ctx = makeContext(path, { method: 'OPTIONS' });
    const res = await gateMiddleware(ctx.context);
    assert.equal(res.status, 200, `OPTIONS ${path}`);
    assert.equal(ctx.state.nextCalls, 1, `OPTIONS ${path}`);
  }

  // 写方法不在白名单里：POST 仍然被门挡住
  const post = makeContext('/api/public/wallpapers', { method: 'POST' });
  const postRes = await gateMiddleware(post.context);
  assert.equal(postRes.status, 401);
  assert.equal((await postRes.json()).error.code, 'site_locked');
  assert.equal(post.state.nextCalls, 0);

  // 只放了一条精确路径，别的公开接口没有顺手放开
  for (const path of ['/api/public/categories', '/api/public/tags', '/api/plugin/feed', '/api/admin/wallpapers']) {
    const ctx = makeContext(path);
    const res = await gateMiddleware(ctx.context);
    assert.equal(res.status, 401, path);
    assert.equal(ctx.state.nextCalls, 0, path);
  }
});

test('登录页可访问，认证接口放行', async () => {
  const gate = makeContext('/__gate');
  const gateRes = await gateMiddleware(gate.context);
  assert.equal(gateRes.status, 200);
  assert.match(await gateRes.text(), /欢迎回家/);

  const auth = makeContext('/api/auth/login', { method: 'POST' });
  const authRes = await gateMiddleware(auth.context);
  assert.equal(authRes.status, 200);
  assert.equal(await authRes.text(), 'REAL-CONTENT');
});

test('会话 + 设备都匹配才放行', async () => {
  for (const path of ['/', '/admin/', '/assets/site.css', '/api/admin/wallpapers']) {
    const ctx = makeContext(path, { cookie: loggedInCookie });
    const res = await gateMiddleware(ctx.context);
    assert.equal(res.status, 200, path);
    assert.equal(ctx.state.nextCalls, 1, path);
  }
});

test('只有会话 Cookie、没有设备 Cookie：拒绝', async () => {
  const ctx = makeContext('/', { cookie: `folia_session=${SESSION_TOKEN}` });
  const res = await gateMiddleware(ctx.context);
  assert.equal(res.status, 401);
  assert.equal(ctx.state.nextCalls, 0);
});

test('设备 Cookie 不匹配：拒绝（偷走会话也用不了）', async () => {
  const ctx = makeContext('/', { cookie: `folia_session=${SESSION_TOKEN}; folia_device=${'x'.repeat(43)}` });
  const res = await gateMiddleware(ctx.context);
  assert.equal(res.status, 401);
  assert.equal(ctx.state.nextCalls, 0);
});

test('会话过期 / 伪造 Token：拒绝', async () => {
  const expired = makeContext('/', { env: makeEnv({ session: sessionRow({ expires_at: Date.now() - 1000 }) }).env, cookie: loggedInCookie });
  assert.equal((await gateMiddleware(expired.context)).status, 401);

  const forged = makeContext('/', { cookie: 'folia_session=not-a-real-token; folia_device=' + DEVICE_ID });
  assert.equal((await gateMiddleware(forged.context)).status, 401);
});

test('闲置超过 30 分钟：拒绝并删会话', async () => {
  const { env, find } = makeEnv({ session: sessionRow({ last_seen_at: Date.now() - SESSION_IDLE_MS - 60_000 }) });
  const ctx = makeContext('/', { cookie: loggedInCookie, env });
  const res = await gateMiddleware(ctx.context);
  assert.equal(res.status, 401);
  assert.equal(find(Q.deleteSession).length, 1);
});

test('停用账号即使一切匹配也进不来', async () => {
  const { env } = makeEnv({ user: { ...USER_ROW, active: 0 } });
  const ctx = makeContext('/', { cookie: loggedInCookie, env });
  assert.equal((await gateMiddleware(ctx.context)).status, 401);
});

test('登录成功：303 + 同时下发会话与设备两枚 Cookie', async () => {
  const { env } = makeEnv();
  const csrf = await csrfPair(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: PASSWORD, next: '/admin/', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/');

  const cookies = res.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith('folia_session='));
  const device = cookies.find((c) => c.startsWith('folia_device='));
  assert.ok(session, 'session cookie');
  assert.ok(device, 'device cookie');
  assert.match(session, /HttpOnly/);
  assert.match(device, /HttpOnly/);
  assert.doesNotMatch(session, /Max-Age/);
  assert.match(device, /^folia_device=[A-Za-z0-9_-]{43}/);
});

test('密码错误：留在登录页并提示', async () => {
  const { env } = makeEnv();
  const csrf = await csrfPair(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: 'wrong-password-123', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /邮箱或密码不正确/);
});

test('连续输错会限流', async () => {
  const { env } = makeEnv();
  for (let i = 0; i < 5; i += 1) {
    const csrf = await csrfPair(env, '198.51.100.9');
    const { context } = makeContext('/__gate', {
      method: 'POST',
      form: { email: EMAIL, password: 'wrong-password-123', _csrf: csrf.token },
      cookie: csrf.cookie,
      env,
      ip: '198.51.100.9',
    });
    assert.equal((await gateMiddleware(context)).status, 401);
  }
  const csrf = await csrfPair(env, '198.51.100.9');
  const blocked = makeContext('/__gate', {
    method: 'POST',
    form: { email: EMAIL, password: 'wrong-password-123', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
    ip: '198.51.100.9',
  });
  const res = await gateMiddleware(blocked.context);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('已登录访问 /__gate 直接跳回去', async () => {
  const { context } = makeContext('/__gate?next=/admin/', { cookie: loggedInCookie });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/');
});

test('退出：清两枚 Cookie、删会话、回首页', async () => {
  const { env, find } = makeEnv();
  const { context } = makeContext('/__gate?logout=1', { cookie: loggedInCookie, env });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const cookies = res.headers.getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith('folia_session=;')));
  assert.ok(cookies.some((c) => c.startsWith('folia_device=;')));
  assert.equal(find(Q.deleteSession).length, 1);
});

test('编辑会话也进不来：清会话并提示只有管理员', async () => {
  const { env, find } = makeEnv({ session: sessionRow({ role: 'editor' }) });
  const { context } = makeContext('/api/admin/wallpapers', { cookie: loggedInCookie, env });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /只对管理员开放/);
  assert.equal(find(Q.deleteSession).length, 1);
});

test('编辑账号登录被拒：不发会话、立刻销毁', async () => {
  const editorRow = { ...USER_ROW, id: 'usr_editor', email: 'editor@demo.test', role: 'editor' };
  const { env, find } = makeEnv({ user: editorRow });
  const csrf = await csrfPair(env);
  const { context } = makeContext('/__gate', {
    method: 'POST',
    form: { email: 'editor@demo.test', password: PASSWORD, next: '/', _csrf: csrf.token },
    cookie: csrf.cookie,
    env,
  });
  const res = await gateMiddleware(context);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /只有管理员可以进入/);
  assert.equal(find(Q.deleteSession).length, 1);
});

test('跳转白名单挡住站外地址', () => {
  assert.equal(safeNext('/admin/?a=1'), '/admin/?a=1');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('/\\evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('javascript:alert(1)'), '/');
  assert.equal(safeNext(''), '/');
  assert.equal(safeNext(null), '/');
});
