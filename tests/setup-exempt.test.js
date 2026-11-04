/**
 * TODO-03：/api/setup 必须进 AUTH_EXEMPT。
 *
 * 修复前：/api/setup 在路由表里是 auth:'none'，但被站点门挡成 401 site_locked，
 * 空库环境无法通过 HTTP 完成初始化。
 * 安全前提不变：已有用户 → 409；BOOTSTRAP_TOKEN 缺失/不匹配 → 403。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { gateMiddleware } from '../src/server/gate-middleware.js';
import { Q } from '../src/server/queries.js';
import { createEnv, jsonRequest } from './harness.js';
import { resetAll } from '../src/server/rate-limit.js';

beforeEach(() => resetAll());

function emptyDbEnv() {
  return createEnv({
    [Q.countUsers]: () => [{ n: 0 }],
    [Q.insertUser]: () => [],
    [Q.insertAudit]: () => [],
    [Q.insertSession]: () => [],
    [Q.touchUserLogin]: () => [],
  });
}

const SETUP_BODY = { token: 'boot-token', email: 'owner@folia.test', name: '站长', password: 'Folia-2026-x' };

test('站点门：POST /api/setup 已放行（不再 401 site_locked）', async () => {
  const { env } = emptyDbEnv();
  const state = { nextCalls: 0 };
  const request = new Request('https://example.test/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
    body: JSON.stringify(SETUP_BODY),
  });
  const res = await gateMiddleware({
    request,
    env,
    params: {},
    next: async () => {
      state.nextCalls += 1;
      return new Response('REAL-CONTENT', { status: 200 });
    },
  });
  assert.equal(state.nextCalls, 1, '应当穿透站点门');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'REAL-CONTENT');
});

test('相邻接口仍然被门挡住（没有顺手放开别的路径）', async () => {
  const { env } = emptyDbEnv();
  for (const path of ['/api/plugin/feed', '/api/admin/wallpapers']) {
    const request = new Request(`https://example.test${path}`);
    const res = await gateMiddleware({ request, env, params: {}, next: async () => new Response('NOPE') });
    assert.equal(res.status, 401, path);
    assert.equal((await res.json()).error.code, 'site_locked', path);
  }
});

test('空库 + 正确 token → 201，并下发会话 Cookie', async () => {
  const { env } = emptyDbEnv();
  const res = await handle(jsonRequest('/api/setup', { method: 'POST', body: SETUP_BODY }), env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.user.email, SETUP_BODY.email);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('folia_session=')));
});

test('空库 + 错 token → 403 forbidden', async () => {
  const { env } = emptyDbEnv();
  const res = await handle(jsonRequest('/api/setup', {
    method: 'POST',
    body: { ...SETUP_BODY, token: 'definitely-wrong' },
  }), env);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'forbidden');
});

test('已有用户 → 409 conflict（不是 site_locked）', async () => {
  const { env } = createEnv({ [Q.countUsers]: () => [{ n: 1 }] });
  const res = await handle(jsonRequest('/api/setup', { method: 'POST', body: SETUP_BODY }), env);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'conflict');
});
