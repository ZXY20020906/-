/**
 * TODO-08：删除成员口令。
 *
 * - 比较改成 constantTimeEqual（长度不等直接 false，语义与旧的 `!==` 一致）；
 * - 加限流：同一操作者 15 分钟内最多 5 次，第 6 次 429（在读 body 之前就拦）。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { constantTimeEqual } from '../src/server/util.js';
import {
  createEnv, jsonRequest, sessionCookie, sessionDeviceFields, USERS,
} from './harness.js';
import { reset } from '../src/server/rate-limit.js';

const PASSCODE = 'test-delete-passcode';

const sessionOf = (user) => () => [{
  token_hash: 'hashed',
  expires_at: Date.now() + 60_000,
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  active: user.active,
  ...sessionDeviceFields(),
}];

function makeEnv() {
  const target = { ...USERS.editor, id: 'usr_other' };
  return createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [target],
    [Q.countActiveAdmins]: () => [{ n: 2 }],
    [Q.insertAudit]: () => [],
    [Q.deleteUserSessions]: () => [],
    [Q.deleteUser]: () => [],
  });
}

function attempt(env, passcode) {
  return handle(jsonRequest('/api/admin/members/usr_other', {
    method: 'DELETE',
    cookie: sessionCookie(),
    body: { passcode },
  }), env);
}

beforeEach(() => {
  reset(`passcode:${USERS.admin.id}`);
});

test('constantTimeEqual：等长逐字节比较，长度不等直接 false', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  // 旧逻辑 `givenHash !== expectedHash` 的语义在长度不等时同样是 false
  assert.equal(constantTimeEqual('a', 'ab'), false);
});

test('口令错误 5 次仍 403，第 6 次 429 too_many_requests', async () => {
  const { env, find } = makeEnv();
  env.ADMIN_PASSCODE = PASSCODE;

  for (let i = 0; i < 5; i += 1) {
    const res = await attempt(env, 'not-the-passcode');
    assert.equal(res.status, 403, `第 ${i + 1} 次应当是 403`);
    assert.equal((await res.json()).error.code, 'forbidden');
  }
  assert.equal(find(Q.deleteUser).length, 0, '口令不对一律不删');

  const blocked = await attempt(env, 'not-the-passcode');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'too_many_requests');
  assert.equal(find(Q.deleteUser).length, 0);
});

test('口令正确 → 200（限流窗口内不会被误伤）', async () => {
  const { env, find } = makeEnv();
  env.ADMIN_PASSCODE = PASSCODE;
  const res = await attempt(env, PASSCODE);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.deleted, true);
  assert.equal(find(Q.deleteUser).length, 1);
});

test('没配置 ADMIN_PASSCODE → 403，且不消耗口令尝试次数', async () => {
  const { env } = makeEnv();
  for (let i = 0; i < 6; i += 1) {
    const res = await attempt(env, PASSCODE);
    assert.equal(res.status, 403, `第 ${i + 1} 次应当是 403（配置缺失），不是 429`);
  }
});
