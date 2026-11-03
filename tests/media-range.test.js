/**
 * TODO-01：/media 的 Range 三态。
 *
 * 语法合法但不可满足（start >= size、0 字节对象）必须 416 + `content-range: bytes * /size`；
 * 语法不合法（bytes=abc、start > end）仍然忽略 Range 回 200 全量。
 * 修复前：越界也返回 null → 落到 200 全量，44MB 视频白传一遍。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequest, onRequestGet, parseRange } from '../functions/media/[[path]].js';

const SIZE = 1000;
const MEDIA_URL = 'https://example.test/media/wallpapers/wp_1/abc123def456.mp4';

/** 假边缘缓存：记录 put，方便断言「416 不进缓存」。 */
const cacheStore = new Map();
const cachePuts = [];

globalThis.caches = {
  default: {
    async match(request) {
      return cacheStore.get(String(request.url)) ?? undefined;
    },
    async put(request, response) {
      cachePuts.push(String(request.url));
      cacheStore.set(String(request.url), response);
    },
  },
};

beforeEach(() => {
  cacheStore.clear();
  cachePuts.length = 0;
});

function fakeEnv({ size = SIZE, found = true } = {}) {
  const reads = [];
  return {
    reads,
    BUCKET: {
      async get(key, options) {
        reads.push({ key, options });
        if (!found) return null;
        return {
          size,
          body: null,
          httpEtag: '"etag-demo"',
          httpMetadata: { contentType: 'video/mp4' },
        };
      },
      async head(key) {
        return found ? { key, size } : null;
      },
    },
  };
}

function makeContext(env, { range, method = 'GET' } = {}) {
  const headers = {};
  if (range) headers.range = range;
  const state = { waited: [] };
  return {
    state,
    ready: {
      request: new Request(MEDIA_URL, { method, headers }),
      env,
      params: { path: ['wallpapers', 'wp_1', 'abc123def456.mp4'] },
      waitUntil: (promise) => {
        state.waited.push(promise);
        return promise;
      },
    },
  };
}

test('Range 0-99 → 206 + content-range/content-length', async () => {
  const { ready } = makeContext(fakeEnv(), { range: 'bytes=0-99' });
  const res = await onRequestGet(ready);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-99/${SIZE}`);
  assert.equal(res.headers.get('content-length'), '100');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('Range 越界（start >= size）→ 416 + content-range: bytes 斜杠星号 size，且不进缓存', async () => {
  const { ready } = makeContext(fakeEnv(), { range: 'bytes=999999999-' });
  const res = await onRequestGet(ready);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${SIZE}`);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(await res.text(), '', '416 的 body 必须为空');
  assert.equal(cachePuts.length, 0, '416 不允许写进 caches.default');
});

test('Range 语法不合法（bytes=abc / start > end）→ 忽略，回 200 全量', async () => {
  for (const range of ['bytes=abc', 'bytes=500-100', 'bytes=-0', 'items=0-1']) {
    const { ready } = makeContext(fakeEnv(), { range });
    const res = await onRequestGet(ready);
    assert.equal(res.status, 200, range);
    assert.equal(res.headers.get('content-length'), String(SIZE), range);
  }
});

test('0 字节对象 + 任意 Range → 416（语法合法但不可满足）', async () => {
  const { ready } = makeContext(fakeEnv({ size: 0 }), { range: 'bytes=0-' });
  const res = await onRequestGet(ready);
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */0');
});

test('无 Range → 200 且 x-folia-cache: MISS，并把结果回填边缘缓存', async () => {
  const { ready, state } = makeContext(fakeEnv());
  const res = await onRequestGet(ready);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-folia-cache'), 'MISS');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(res.headers.get('etag'), '"etag-demo"');
  assert.equal(state.waited.length, 1, '整段请求应当回填缓存');
});

test('对象不存在仍然是 404 JSON（不因 416 改动被破坏）', async () => {
  const { ready } = makeContext(fakeEnv({ found: false }));
  const res = await onRequestGet(ready);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');
});

test('HEAD 与 GET 行为一致；parseRange 三态可单测', async () => {
  const { ready } = makeContext(fakeEnv(), { range: 'bytes=999999999-', method: 'HEAD' });
  const res = await onRequest(ready);
  assert.equal(res.status, 416);

  assert.deepEqual(parseRange('bytes=0-99', 1000), { range: { start: 0, end: 99 } });
  assert.deepEqual(parseRange('bytes=999999999-', 1000), { unsatisfiable: true });
  assert.equal(parseRange('bytes=abc', 1000), null);
  assert.equal(parseRange('bytes=5-2', 1000), null);
  assert.deepEqual(parseRange('bytes=-10', 1000), { range: { start: 990, end: 999 } });
});
