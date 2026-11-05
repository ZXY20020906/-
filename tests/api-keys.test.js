/**
 * 第三期验收：API key 与配额。
 *
 * 覆盖：
 *   - 不带 key：按 IP 限流（120/min），且**不查 api_keys 表**（匿名路径不增加 D1 读）；
 *   - 带 key（Authorization 或 ?key=）：按 key 的 rpm 限流，超限 429 + Retry-After + 限流头；
 *   - 无效/停用 key：401 `api_key_invalid`（带 CORS 与 hint），不能静默降级成匿名；
 *   - 库里只出现 key 的 SHA-256，明文不进任何 SQL 参数；
 *   - last_used_at 有 60s 写节流；
 *   - 老路径（/api/public/*）不解析 key（第三期只给 v1 加配额）。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { createEnv } from './harness.js';
import { reset } from '../src/server/rate-limit.js';
import { sha256Hex } from '../src/server/util.js';

const RAW_KEY = `flk_${'a'.repeat(40)}`;
const KEY_HASH = await sha256Hex(RAW_KEY);
const INVALID_KEY = `flk_${'b'.repeat(40)}`;

const KEY_ROW = {
  id: 'key_1', label: '测试 key', rpm: 2, active: 1, created_at: 1, last_used_at: 0,
};

function site({ rows = [], keyRow = KEY_ROW, extra = {} } = {}) {
  return createEnv({
    [Q.publicRecent]: () => rows,
    [Q.publicCount]: () => [{ n: rows.length }],
    [Q.publicManifest]: () => [],
    [Q.publicMaxUpdatedAt]: () => [{ n: 0 }],
    [Q.apiKeyByHash]: ([hash]) => (keyRow && hash === KEY_HASH ? [keyRow] : []),
    [Q.touchApiKey]: () => [],
    ...extra,
  });
}

async function call(env, path, { headers = {}, ip = '198.51.100.9' } = {}) {
  const request = new Request(`https://example.test${path}`, { headers: { 'cf-connecting-ip': ip, ...headers } });
  const response = await handle(request, env);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null, text };
}

const bearer = (key) => ({ authorization: `Bearer ${key}` });

beforeEach(() => {
  reset('key:key_1');
  reset('pub:198.51.100.9');
  reset('pub:198.51.100.10');
});

test('无 key：正常读取且**不查 api_keys**（匿名不增加 D1 读）', async () => {
  const { env, calls } = site();
  const res = await call(env, '/api/v1/public/wallpapers');
  assert.equal(res.status, 200);
  assert.equal(calls.filter((entry) => entry.sql === Q.apiKeyByHash).length, 0);
});

test('有 key（Authorization Bearer）：200，按哈希查库，明文不进 SQL 参数', async () => {
  const { env, calls } = site();
  const res = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(res.status, 200);

  const lookups = calls.filter((entry) => entry.sql === Q.apiKeyByHash);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].args.length, 1);
  assert.equal(lookups[0].args[0], KEY_HASH, '查库用的必须是 sha256(key)');
  assert.notEqual(lookups[0].args[0], RAW_KEY);
  // 所有 SQL 参数里都不能出现明文 key
  for (const entry of calls) {
    for (const arg of entry.args) {
      assert.notEqual(String(arg), RAW_KEY, '明文 key 绝不能出现在 SQL 参数里');
    }
  }
});

test('有 key（?key= 查询参数）：同样生效', async () => {
  const { env, calls } = site();
  const res = await call(env, `/api/v1/public/wallpapers?key=${encodeURIComponent(RAW_KEY)}`);
  assert.equal(res.status, 200);
  assert.equal(calls.filter((entry) => entry.sql === Q.apiKeyByHash).length, 1);
});

test('配额：key 的 rpm=2，第 3 次 429 + Retry-After + 限流头 + CORS', async () => {
  const { env } = site();
  for (let i = 0; i < 2; i += 1) {
    const ok = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
    assert.equal(ok.status, 200, `第 ${i + 1} 次应放行`);
  }
  const blocked = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_requests');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(blocked.headers.get('x-ratelimit-limit'), '2');
  assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(blocked.headers.get('access-control-allow-origin'), '*');
});

test('配额：key 的额度用尽后，同 IP 的匿名请求不受影响（两档独立）', async () => {
  const { env } = site();
  for (let i = 0; i < 3; i += 1) await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  const anon = await call(env, '/api/v1/public/wallpapers', { ip: '198.51.100.10' });
  assert.equal(anon.status, 200);
});

test('无效 key：401 api_key_invalid（带 hint + CORS），且不返回数据', async () => {
  const { env, calls } = site();
  const res = await call(env, '/api/v1/public/wallpapers', { headers: bearer(INVALID_KEY) });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'api_key_invalid');
  assert.ok(res.body.error.hint);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // 无效 key 不应该继续查公开数据
  assert.equal(calls.filter((entry) => entry.sql === Q.publicRecent).length, 0);
});

test('停用的 key（active=0）同样 401', async () => {
  const { env } = site({ keyRow: { ...KEY_ROW, active: 0 } });
  const res = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'api_key_invalid');
});

test('last_used_at 写节流：60s 内不重复 UPDATE，过期才写', async () => {
  const fresh = site({ keyRow: { ...KEY_ROW, last_used_at: Date.now() } });
  await call(fresh.env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(fresh.calls.filter((entry) => entry.sql === Q.touchApiKey).length, 0, '刚用过不重复写');

  const stale = site({ keyRow: { ...KEY_ROW, last_used_at: Date.now() - 120_000 } });
  await call(stale.env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  const touched = stale.calls.filter((entry) => entry.sql === Q.touchApiKey);
  assert.equal(touched.length, 1);
  assert.equal(touched[0].args[1], 'key_1');
  assert.equal(typeof touched[0].args[0], 'number');
});

test('老路径不解析 key：/api/public/* 仍按 IP 限流（无效 key 也不报错）', async () => {
  const { env, calls } = site();
  const res = await call(env, `/api/public/wallpapers?key=${encodeURIComponent(INVALID_KEY)}`, { ip: '198.51.100.10' });
  assert.equal(res.status, 200);
  assert.equal(calls.filter((entry) => entry.sql === Q.apiKeyByHash).length, 0);
});

test('降级：api_keys 表还没迁移（查库抛错）⇒ 回落匿名限流，不 500', async () => {
  let warned = 0;
  const { env } = site({
    extra: {
      [Q.apiKeyByHash]: () => { warned += 1; throw new Error('no such table: api_keys'); },
    },
  });
  const res = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY), ip: '198.51.100.10' });
  assert.equal(res.status, 200, '表没建好也不能把公开读取打成 500');
  assert.equal(warned, 1);
});

test('CORS：401/429 都能被浏览器读到（access-control-allow-origin=*）', async () => {
  const { env } = site({ keyRow: { ...KEY_ROW, rpm: 1 } });
  const ok = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(ok.status, 200);
  const limited = await call(env, '/api/v1/public/wallpapers', { headers: bearer(RAW_KEY) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('access-control-allow-origin'), '*');
  // 429 的 JSON 也能被前端读出来（不是空 body）
  assert.equal(limited.body.error.code, 'too_many_requests');
});
