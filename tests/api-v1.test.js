/**
 * 第一期验收：`/api/v1/public/*` 与旧路径的兼容性、错误体、manifest、门禁白名单。
 *
 * 核心断言只有一条思路：**旧路径与 v1 打到同一份实现**（routes/public.js 直接转发
 * routes/public-v1.js），所以同一请求两边响应体必须逐字节相同。这条用例挂了，
 * 就说明有人又在旧路径里加了一份逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { gateMiddleware } from '../src/server/gate-middleware.js';
import { createEnv } from './harness.js';
import { PUBLIC_SUBTAGS, Q } from '../src/server/queries.js';

const NOW = 1_760_000_000_000;

function row(overrides = {}) {
  return {
    id: 'wp_2', slug: 'night-rain', title: '夜雨霓虹', description: '',
    subtag: '原神', category_id: 'cat_wallpaper', kind: 'dynamic', mime: 'video/mp4',
    bytes: 12_345_678, width: 3840, height: 2160, duration_ms: 12_000,
    tags: '["动漫","夜景"]', featured: 0, sort_order: 10,
    published_at: NOW, created_at: NOW - 1000, updated_at: NOW,
    sha256: 'a'.repeat(64), storage_key: 'wallpapers/wp_2/aaaaaaaaaaaaaaaa.mp4',
    thumb_key: 'thumbs/wp_2/bbbbbbbbbbbbbbbb.webp',
    variants: JSON.stringify([
      { label: '1080p', width: 1920, height: 1080, fps: 30, key: 'wallpapers/wp_2/cccccccccccccccc.1080p.mp4', bytes: 2_000_000, sha256: 'c'.repeat(64) },
    ]),
    fps: 30, codec: 'h264', pix_fmt: 'yuv420p', has_audio: 0,
    poster_key: 'posters/wp_2/dddddddddddddddd.webp',
    license: 'cc0', source: 'https://example.test/author', author: '画师甲',
    category_slug: 'wallpaper', category_name: '壁纸',
    ...overrides,
  };
}

function makeSite() {
  const rows = [row()];
  return createEnv({
    [Q.listPublicCategories]: () => ([
      { id: 'cat_wallpaper', slug: 'wallpaper', name: '壁纸', description: '', sort_order: 10, is_public: 1, created_at: 1, updated_at: 1, count: 1 },
    ]),
    [Q.listTags]: () => ([{ id: 'tag_anime', name: '动漫', sort_order: 10, category_id: null }]),
    [Q.listTagsForCategory]: () => ([{ id: 'tag_anime', name: '动漫', sort_order: 10, category_id: null }]),
    [Q.categoryBySlug]: () => ([{ id: 'cat_wallpaper', slug: 'wallpaper', name: '壁纸' }]),
    [Q.publicTags]: () => ([{ tag: '动漫', n: 1 }]),
    [Q.publicRecent]: () => rows,
    [Q.publicCount]: () => [{ n: rows.length }],
    [Q.publicBySlug]: () => rows,
    [Q.publicManifest]: () => rows,
    [PUBLIC_SUBTAGS]: () => [{ name: '原神', n: 1 }],
  });
}

/**
 * 关掉边缘缓存（只作用于当前 HTTP 调用）。
 * media-range.test.js 在模块级装了一个全局假 caches，不关的话第二次同 URL 请求会
 * 直接命中缓存、拿不到我们想验证的 304。
 */
async function call(env, path, { method = 'GET', headers = {}, useGate = false } = {}) {
  // 临时摘掉全局假 caches：media-range.test.js 在模块级装了一个，不摘的话同 URL
  // 的第二次请求会命中缓存，拿不到我们想验证的 304 / 回源行为。
  const saved = globalThis.caches;
  delete globalThis.caches;
  try {
    const request = new Request(`https://example.test${path}`, { method, headers });
    const response = useGate
      ? await gateMiddleware({ request, env, params: {}, next: () => handle(request, env) })
      : await handle(request, env);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, headers: response.headers, body, text };
  } finally {
    if (saved !== undefined) globalThis.caches = saved;
  }
}

test('兼容性：旧路径与 v1 对同一请求返回逐字节相同的响应体', async () => {
  const { env } = makeSite();
  const paths = [
    '/public/wallpapers?limit=2&license=cc0',
    '/public/wallpapers?category=wallpaper&kind=dynamic',
    '/public/wallpapers?page=1&limit=1',
    '/public/categories',
    '/public/tags?category=wallpaper',
    '/public/subtags?category=wallpaper&tag=%E5%8A%A8%E6%BC%AB',
  ];
  for (const suffix of paths) {
    const legacy = await call(env, `/api${suffix}`);
    const v1 = await call(env, `/api/v1${suffix}`);
    assert.equal(legacy.status, 200, suffix);
    assert.equal(v1.status, 200, suffix);
    assert.equal(v1.text, legacy.text, `响应体必须逐字节相同：${suffix}`);
    assert.equal(v1.headers.get('etag'), legacy.headers.get('etag'), `ETag 必须相同：${suffix}`);
    assert.equal(v1.headers.get('access-control-allow-origin'), '*', `CORS 必须相同：${suffix}`);
  }
});

test('详情：v1 与旧路径响应相同（旧路径匿名访问仍受门禁，v1 公开）', async () => {
  const { env } = makeSite();
  const v1 = await call(env, '/api/v1/public/wallpapers/night-rain', { useGate: true });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.data.wallpaper.id, 'wp_2');
  // v1 详情匿名可读：这是「素材网」客户端的硬需求
  const legacy = await call(env, '/api/public/wallpapers/night-rain');
  assert.equal(legacy.status, 200, '旧路径 handler 仍然可用（门禁策略不变）');
  assert.equal(legacy.text, v1.text, '详情字段必须逐字节相同');
});

test('错误体：v1 的 404 带统一 code/message/hint', async () => {
  const { env } = createEnv({ [Q.publicBySlug]: () => [] });
  const res = await call(env, '/api/v1/public/wallpapers/nope', { useGate: true });
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'not_found');
  assert.equal(typeof res.body.error.message, 'string');
  assert.equal(typeof res.body.error.hint, 'string', '错误码表必须给出 hint');
});

test('错误体：参数不合法 → 400 bad_request（不静默忽略）', async () => {
  const { env } = makeSite();
  for (const query of ['?license=BAD KEY', '?page=0', '?limit=abc', '?kind=nope']) {
    const res = await call(env, `/api/v1/public/wallpapers${query}`, { useGate: true });
    assert.equal(res.status, 400, query);
    assert.equal(res.body.error.code, 'bad_request', query);
    assert.ok(res.body.error.hint, query);
  }
});

test('ETag：v1 清单带 ETag，If-None-Match 命中返回 304 且无 body', async () => {
  const { env } = makeSite();
  const first = await call(env, '/api/v1/public/wallpapers?limit=2');
  const etag = first.headers.get('etag');
  assert.ok(etag && etag.startsWith('"'), '必须带强 ETag');
  const second = await call(env, '/api/v1/public/wallpapers?limit=2', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(second.text, '');
  // 弱校验前缀（边缘会加 W/）也要能命中
  const weak = await call(env, '/api/v1/public/wallpapers?limit=2', { headers: { 'if-none-match': `W/${etag}` } });
  assert.equal(weak.status, 304);
});

test('边缘缓存：条件请求也走缓存，304 不再回源 D1', async (t) => {
  const { env, calls } = makeSite();
  const store = new Map();
  const saved = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? new Response(hit.text, { status: hit.status, headers: new Headers(hit.headers) }) : undefined;
      },
      async put(request, response) {
        const text = await response.text();
        store.set(request.url, { status: response.status, headers: new Headers(response.headers), text });
      },
    },
  };
  t.after(() => {
    if (saved === undefined) delete globalThis.caches;
    else globalThis.caches = saved;
  });

  const url = 'https://example.test/api/v1/public/wallpapers?limit=2';
  const first = await handle(new Request(url), env);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  await first.text();
  const queriesAfterFirst = calls.length;

  const warm = await handle(new Request(url), env);
  assert.equal(warm.headers.get('x-folia-edge'), 'HIT', '普通请求应命中缓存');
  await warm.text();

  const conditional = await handle(new Request(url, { headers: { 'if-none-match': etag } }), env);
  assert.equal(conditional.status, 304, '缓存里的 ETag 命中应直接回 304');
  assert.equal(conditional.headers.get('x-folia-edge'), 'HIT', '304 也必须由边缘缓存返回');
  assert.equal(await conditional.text(), '');
  assert.equal(calls.length, queriesAfterFirst, '条件请求不得再查 D1（2026-11-05 额度事故的回归点）');

  // 冷缓存 + 条件请求：也要先拿到完整 200 写缓存，再回 304；不能把 304 写进缓存。
  store.clear();
  const cold = await handle(new Request(url, { headers: { 'if-none-match': etag } }), env);
  assert.equal(cold.status, 304, '冷缓存条件请求仍应回 304');
  assert.equal(store.size, 1, '冷缓存条件请求必须把 200 实体写进缓存');
});

test('manifest：形状完整（apiVersion/generatedAt/etag/total/items），且与清单同口径', async () => {
  const { env } = makeSite();
  const res = await call(env, '/api/v1/public/manifest.json', { useGate: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  // manifest 是**文档**形状（不是 {ok,data} 包装），与 docs/API-V1.md 一致
  const doc = res.body;
  assert.equal(doc.apiVersion, 'v1');
  assert.equal(doc.generatedAt, NOW, 'generatedAt 必须取数据里最新的 updated_at');
  assert.equal(doc.total, 1);
  assert.equal(typeof doc.etag, 'string');
  assert.equal(res.headers.get('etag'), `"${doc.etag}"`, 'body.etag 与响应头是同一个值');
  const item = doc.items[0];
  for (const key of [
    'id', 'slug', 'kind', 'url', 'bytes', 'sha256', 'width', 'height', 'fps',
    'variants', 'posterUrl', 'tags', 'license', 'updatedAt',
  ]) {
    assert.ok(key in item, `manifest item 缺字段 ${key}`);
  }
  assert.equal(item.url, 'https://example.test/media/wallpapers/wp_2/aaaaaaaaaaaaaaaa.mp4');
  assert.equal(item.posterUrl, 'https://example.test/media/posters/wp_2/dddddddddddddddd.webp');
  assert.equal(item.license, 'cc0');
  assert.equal(item.variants[0].label, '1080p');
  assert.equal(item.variants[0].width, 1920, '变体必须带 width');
  assert.equal(item.variants[0].fps, 30, '变体必须带 fps');
});

test('manifest：带 ETag + If-None-Match 304', async () => {
  const { env } = makeSite();
  const first = await call(env, '/api/v1/public/manifest.json');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const cached = await call(env, '/api/v1/public/manifest.json', { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
});

test('门禁：/api/v1/public/* 匿名只读放行，写方法仍被挡', async () => {
  const { env } = makeSite();
  const hitWith = async (path, method) => {
    let nextCalls = 0;
    const request = new Request(`https://example.test${path}`, { method });
    const response = await gateMiddleware({
      request,
      env,
      params: {},
      next: async () => {
        nextCalls += 1;
        return new Response('REAL', { status: 200 });
      },
    });
    return { response, nextCalls };
  };

  for (const path of [
    '/api/v1/public/wallpapers',
    '/api/v1/public/wallpapers/night-rain',
    '/api/v1/public/categories',
    '/api/v1/public/tags',
    '/api/v1/public/subtags',
    '/api/v1/public/manifest.json',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const { response, nextCalls } = await hitWith(path, method);
      assert.equal(response.status, 200, `${method} ${path} 应匿名放行`);
      assert.equal(nextCalls, 1, `${method} ${path}`);
    }
    const options = await hitWith(path, 'OPTIONS');
    assert.equal(options.response.status, 200, `OPTIONS ${path}`);
  }

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { response, nextCalls } = await hitWith('/api/v1/public/wallpapers', method);
    assert.equal(response.status, 401, `${method} 必须被门挡住`);
    assert.equal(nextCalls, 0);
  }
});

test('OPTIONS 预检：v1 与旧路径都回 CORS（供跨域客户端）', async () => {
  const { env } = makeSite();
  for (const path of ['/api/v1/public/wallpapers', '/api/public/wallpapers']) {
    const res = await call(env, path, { method: 'OPTIONS' });
    assert.equal(res.status, 204, path);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', path);
    assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  }
});

test('缓存键：v1 的 license 参数进缓存 key，且不影响旧参数顺序', async () => {
  const { cacheKeyUrl } = await import('../src/server/app.js');
  const a = cacheKeyUrl(new URL('https://a.test/api/v1/public/wallpapers?license=cc0&limit=2'));
  const b = cacheKeyUrl(new URL('https://a.test/api/v1/public/wallpapers?limit=2&license=cc0'));
  assert.equal(a, b);
  assert.match(a, /license=cc0/);
});

