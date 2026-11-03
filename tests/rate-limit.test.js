import test from 'node:test';
import assert from 'node:assert/strict';

import { hit, reset, resetAll } from '../src/server/rate-limit.js';

test('达到上限后开始拦截', () => {
  resetAll();
  const key = 'login:acct:1.2.3.4:a@b.co';
  for (let i = 0; i < 5; i += 1) {
    assert.equal(hit(key, { max: 5, windowMs: 60_000 }).limited, false);
  }
  const blocked = hit(key, { max: 5, windowMs: 60_000 });
  assert.equal(blocked.limited, true);
  assert.ok(blocked.retryAfter > 0);
});

test('不同 key 互不影响', () => {
  resetAll();
  for (let i = 0; i < 5; i += 1) hit('a', { max: 5, windowMs: 60_000 });
  assert.equal(hit('a', { max: 5, windowMs: 60_000 }).limited, true);
  assert.equal(hit('b', { max: 5, windowMs: 60_000 }).limited, false);
});

test('登录成功后 reset 可以恢复额度', () => {
  resetAll();
  const key = 'login:acct:x';
  for (let i = 0; i < 6; i += 1) hit(key, { max: 5, windowMs: 60_000 });
  reset(key);
  assert.equal(hit(key, { max: 5, windowMs: 60_000 }).limited, false);
});

test('窗口过期后重新计数', () => {
  resetAll();
  const key = 'login:ip:1.1.1.1';
  for (let i = 0; i < 6; i += 1) hit(key, { max: 5, windowMs: -1 });
  // windowMs 为负 → resetAt 已过期，下一次重新开始
  assert.equal(hit(key, { max: 5, windowMs: 60_000 }).limited, false);
});
