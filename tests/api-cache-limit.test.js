/**
 * TODO-02：公开接口的边缘缓存键 + 限速。
 *
 * 1) 缓存键只吃白名单参数：`?limit=1&x=1` 与 `?limit=1&y=2` 必须命中同一个 key，
 *    否则随便加个随机参数就能每次都打到 D1。
 * 2) 公开读接口每 IP 每分钟 120 次，超了 429 + error.code=too_many_requests + retry-after。
 */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CACHE_PARAMS, cacheKeyUrl, handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { createEnv } from './harness.js';
import { reset } from '../src/server/rate-limit.js';

/** 假边缘缓存：按序列化后的响存取，模拟 Cloudflare 的 caches.default。 */
function installCache() {
  const store = new Map();
  const saved = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? new Response(hit.text, { status: hit.status, headers: hit.headers }) : undefined;
      },
      async put(request, response) {
        const text = await response.text();
        store.set(request.url, { status: response.status, headers: new Headers(response.headers), text });
      },
    },
  };
  return {
    store,
    restore() {
      if (saved === undefined) delete globalThis.caches;
      else globalThis.caches = saved;
    },
  };
}

let cache = null;
beforeEach(() => {
  cache = installCache();
});
afterEach(() => {
  cache?.restore();
  cache = null;
});

function publicEnv(rows = []) {
  return createEnv({
    [Q.publicRecent]: () => rows,
    [Q.publicCount]: () => [{ n: rows.length }],
    [Q.listPublicCategories]: () => [],
  });
}

const URL_BASE = 'https://example.test/api/public/wallpapers';

test('缓存键：未知 query 不影响命中（第二次是 HIT，且不再查库）', async () => {
  const { env, calls } = publicEnv();
  const first = await handle(new Request(`${URL_BASE}?limit=1&x=1`), env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-folia-edge'), 'MISS');
  const queryCountAfterFirst = calls.filter((c) => c.sql === Q.publicRecent).length;

  const second = await handle(new Request(`${URL_BASE}?limit=1&y=2`), env);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-folia-edge'), 'HIT', '未知参数不得击穿缓存');
  assert.equal(
    calls.filter((c) => c.sql === Q.publicRecent).length,
    queryCountAfterFirst,
    '命中缓存后不该再查 D1',
  );
});

test('缓存键：参数顺序不同也是同一个 key，白名单参数仍然区分', async () => {
  assert.equal(
    cacheKeyUrl(new URL(`${URL_BASE}?tag=夜&limit=2&zzz=1`)),
    cacheKeyUrl(new URL(`${URL_BASE}?limit=2&tag=夜`)),
  );
  // 未知参数被丢掉、白名单参数按固定顺序排好
  assert.equal(cacheKeyUrl(new URL('https://a.test/p?z=1&sort=name&category=anime&limit=3')), 'https://a.test/p?category=anime&sort=name&limit=3');
  assert.notEqual(
    cacheKeyUrl(new URL(`${URL_BASE}?limit=1`)),
    cacheKeyUrl(new URL(`${URL_BASE}?limit=2`)),
  );
  assert.ok(CACHE_PARAMS.includes('limit'));
  assert.ok(CACHE_PARAMS.includes('type'), 'plugin/feed 的 type 必须留在 key 里');
});

test('限速：同一 IP 第 121 次 → 429 too_many_requests + retry-after', async () => {
  const ip = '198.51.100.55';
  reset(`pub:${ip}`);
  const { env } = publicEnv();

  for (let i = 0; i < 120; i += 1) {
    const res = await handle(new Request(`${URL_BASE}?limit=1`, { headers: { 'cf-connecting-ip': ip } }), env);
    assert.equal(res.status, 200, `第 ${i + 1} 次应当放行`);
  }

  const blocked = await handle(new Request(`${URL_BASE}?limit=1`, { headers: { 'cf-connecting-ip': ip } }), env);
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.error.code, 'too_many_requests');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(blocked.headers.get('access-control-allow-origin'), '*');
  reset(`pub:${ip}`);
});

test('HEAD 与 GET 同义：不再 405，并带边缘缓存标记（A7 探针就用 HEAD）', async () => {
  const ip = '203.0.113.70';
  reset(`pub:${ip}`);
  const { env } = publicEnv();
  const warm = await handle(new Request(`${URL_BASE}?limit=1`, { headers: { 'cf-connecting-ip': ip } }), env);
  assert.equal(warm.headers.get('x-folia-edge'), 'MISS');

  const head = await handle(new Request(`${URL_BASE}?limit=1`, { method: 'HEAD', headers: { 'cf-connecting-ip': ip } }), env);
  assert.equal(head.status, 200, 'HEAD 不该再被路由表判成 405');
  assert.equal(head.headers.get('x-folia-edge'), 'HIT');
  reset(`pub:${ip}`);
});

test('限速按 IP 隔离：另一个 IP 不受影响', async () => {
  const noisy = '203.0.113.44';
  const quiet = '203.0.113.45';
  reset(`pub:${noisy}`);
  reset(`pub:${quiet}`);
  const { env } = publicEnv();

  for (let i = 0; i < 121; i += 1) {
    await handle(new Request(`${URL_BASE}?limit=1`, { headers: { 'cf-connecting-ip': noisy } }), env);
  }
  const other = await handle(new Request(`${URL_BASE}?limit=1`, { headers: { 'cf-connecting-ip': quiet } }), env);
  assert.equal(other.status, 200);
  reset(`pub:${noisy}`);
  reset(`pub:${quiet}`);
});
