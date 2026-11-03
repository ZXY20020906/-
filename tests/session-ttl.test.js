/**
 * TODO-07：会话过期的两条口径必须一致，且行为符合注释。
 *
 * 静态口径（常量）：闲置 60 分钟、绝对 7 天。
 * 行为口径：
 * - last_seen_at 早于 60 分钟 → readSession 返回 null 并删行；
 * - expires_at 已过（哪怕 last_seen_at 很新）→ 返回 null（绝对过期优先）；
 * - touch 只刷 last_seen_at，不延长 expires_at（所以 7 天是真绝对上限）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_IDLE_MS, SESSION_TTL_MS, SESSION_TOUCH_MS, readSession, sessionTokenFromRequest,
} from '../src/server/session.js';
import { Q } from '../src/server/queries.js';
import { createEnv, sessionCookie, TEST_DEVICE_HASH, TEST_DEVICE_ID } from './harness.js';
import { sha256Hex } from '../src/server/util.js';

const TOKEN = 'test-token';
const TOKEN_HASH = await sha256Hex(TOKEN);

function sessionEnv(row) {
  return createEnv({
    [Q.sessionByToken]: ([hash]) => (row && hash === row.token_hash ? [row] : []),
    [Q.deleteSession]: () => [],
    [Q.touchSession]: () => [],
  });
}

function row(overrides = {}) {
  return {
    token_hash: TOKEN_HASH,
    expires_at: Date.now() + SESSION_TTL_MS,
    created_at: Date.now() - 1000,
    device_hash: TEST_DEVICE_HASH,
    last_seen_at: Date.now() - 1000,
    id: 'usr_admin',
    email: 'admin@folia.test',
    name: '站长',
    role: 'admin',
    active: 1,
    ...overrides,
  };
}

const request = () => new Request('https://example.test/api/admin/wallpapers', {
  headers: { cookie: sessionCookie(TOKEN), 'cf-connecting-ip': '203.0.113.8' },
});

test('常量口径：闲置 60 分钟、绝对 7 天、touch 粒度 1 分钟', () => {
  assert.equal(SESSION_IDLE_MS, 60 * 60 * 1000);
  assert.equal(SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(SESSION_TOUCH_MS, 60 * 1000);
});

test('闲置 61 分钟 → 拒绝并删会话', async () => {
  const { env, find } = sessionEnv(row({ last_seen_at: Date.now() - SESSION_IDLE_MS - 60_000 }));
  assert.equal(sessionTokenFromRequest(request()), TOKEN);
  assert.equal(await readSession(env, request()), null);
  assert.equal(find(Q.deleteSession).length, 1);
});

test('绝对过期优先：expires_at 已过但 last_seen_at 很新 → 仍然拒绝', async () => {
  const { env, find } = sessionEnv(row({ expires_at: Date.now() - 1, last_seen_at: Date.now() - 1000 }));
  assert.equal(await readSession(env, request()), null);
  assert.equal(find(Q.deleteSession).length, 1);
});

test('touch 不延长 expires_at：只写 last_seen_at 一个时间戳', async () => {
  const now = Date.now();
  const { env, find } = sessionEnv(row({ last_seen_at: now - 5 * 60 * 1000 }));
  const session = await readSession(env, request());
  assert.ok(session, '会话仍然有效');
  const touch = find(Q.touchSession);
  assert.equal(touch.length, 1);
  // touchSession 的 SQL 只有 (last_seen_at, token_hash) 两个参数，没有 expires_at
  assert.equal(touch[0].args.length, 2);
  assert.equal(touch[0].args[1], TOKEN_HASH);
  assert.doesNotMatch(Q.touchSession, /expires_at/, 'touchSession 不允许写 expires_at');
});

test('刚活动过就不写库（避免每个静态资源都打一次 D1）', async () => {
  const { env, find } = sessionEnv(row({ last_seen_at: Date.now() - 1000 }));
  assert.ok(await readSession(env, request()));
  assert.equal(find(Q.touchSession).length, 0);
});

test('设备 Cookie 缺失/不匹配仍然拒绝（与闲置逻辑互不影响）', async () => {
  const { env } = sessionEnv(row({}));
  const noDevice = new Request('https://example.test/api/admin/wallpapers', {
    headers: { cookie: `folia_session=${TOKEN}` },
  });
  assert.equal(await readSession(env, noDevice), null);

  const wrongDevice = new Request('https://example.test/api/admin/wallpapers', {
    headers: { cookie: `folia_session=${TOKEN}; folia_device=${'x'.repeat(43)}` },
  });
  assert.notEqual(TEST_DEVICE_ID, 'x'.repeat(43));
  assert.equal(await readSession(env, wrongDevice), null);
});
