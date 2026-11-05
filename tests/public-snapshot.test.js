/**
 * 快照回落：D1 不可用（额度耗尽 / 缺表 / 绑定失效）时，公开接口不能 500。
 *
 * 2026-11-05 线上事故的回归用例：
 *   · D1 抛 7500（免费额度耗尽）时，6 个公开端点必须 200，且返回 110 条公开素材；
 *   · 响应必须明确标 `degraded: true` / `snapshotGeneratedAt`，不能假装是实时库；
 *   · 非 D1 错误的业务异常（这里用普通 Error）仍应 500，不能被快照掩盖；
 *   · `PUBLIC_SNAPSHOT_FALLBACK=0` 时关闭回落，方便单测/排查。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { SNAPSHOT } from '../src/server/public-snapshot.js';

const D1_QUOTA = "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. (code 7500)";

function envWithDbError(message = D1_QUOTA, extra = {}) {
  return {
    DB: {
      prepare() {
        throw new Error(message);
      },
    },
    PUBLIC_ORIGIN: 'https://example.test',
    PUBLIC_SNAPSHOT_FALLBACK: '1',
    ...extra,
  };
}

async function call(env, path, { headers = {} } = {}) {
  const saved = globalThis.caches;
  delete globalThis.caches;
  try {
    const response = await handle(new Request(`https://example.test${path}`, { headers }), env);
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

test('快照回落：D1 额度耗尽时清单仍 200，wallpaper 分类 46 条', async () => {
  const env = envWithDbError();
  const res = await call(env, '/api/public/wallpapers?category=wallpaper&limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.total, 46);
  assert.equal(res.body.data.items.length, 5);
  assert.ok(res.body.data.items.every((item) => item.category?.slug === 'wallpaper'));
  assert.equal(res.body.data.degraded, true);
  assert.equal(res.body.data.snapshotGeneratedAt, SNAPSHOT.generatedAt);
  assert.equal(res.body.data.facets.categories.reduce((sum, item) => sum + item.count, 0), 46);
});

test('快照回落：v1 清单分页 + facets 合计 == total', async () => {
  const env = envWithDbError();
  const first = await call(env, '/api/v1/public/wallpapers?limit=100');
  assert.equal(first.status, 200);
  assert.equal(first.body.data.total, 110);
  assert.equal(first.body.data.items.length, 100);
  assert.equal(first.body.data.facets.categories.reduce((sum, item) => sum + item.count, 0), 110);

  const second = await call(env, '/api/v1/public/wallpapers?limit=100&page=2');
  assert.equal(second.status, 200);
  assert.equal(second.body.data.items.length, 10);
});

test('快照回落：categories / tags / subtags / 详情 / manifest 全部 200', async () => {
  const env = envWithDbError();

  const categories = await call(env, '/api/public/categories');
  assert.equal(categories.status, 200);
  assert.equal(categories.body.ok, true);
  assert.equal(categories.body.data.categories.length, SNAPSHOT.categories.length);
  assert.equal(categories.body.data.degraded, true);

  const tags = await call(env, '/api/public/tags');
  assert.equal(tags.status, 200);
  assert.ok(Array.isArray(tags.body.data.tags));
  assert.equal(tags.body.data.degraded, true);

  const subtags = await call(env, '/api/public/subtags');
  assert.equal(subtags.status, 200);
  assert.ok(Array.isArray(subtags.body.data.subtags));

  const first = SNAPSHOT.items[0];
  const detail = await call(env, `/api/v1/public/wallpapers/${encodeURIComponent(first.slug)}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.wallpaper.slug, first.slug);
  assert.equal(detail.body.data.degraded, true);

  const missing = await call(env, '/api/v1/public/wallpapers/no-such-wallpaper');
  assert.equal(missing.status, 404);

  // 前台 detectMode 会先问 /api/meta；D1 不可用时不能 500，否则会回退到不存在的静态 catalog。
  const meta = await call(env, '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.data.initialized, true);
  assert.equal(meta.body.data.degraded, true);

  // 历史插件版本可能还在用 /api/plugin/feed；同样要有快照兜底。
  const feed = await call(env, '/api/plugin/feed?type=video');
  assert.equal(feed.status, 200);
  assert.ok(feed.body.data.count > 0);
  assert.ok(feed.body.data.items.every((item) => item.type === 'video'));
  assert.equal(feed.body.data.degraded, true);

  const manifest = await call(env, '/api/v1/public/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.total, 110);
  assert.equal(manifest.body.items.length, 110);
  assert.equal(manifest.body.degraded, true);

  const etag = manifest.headers.get('etag');
  const cached = await call(env, '/api/v1/public/manifest.json', { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
});

test('快照回落：只兜 D1 错误；普通异常仍 500', async () => {
  const broken = await call(envWithDbError('boom: 业务代码 bug'), '/api/public/wallpapers');
  assert.equal(broken.status, 500);
  assert.equal(broken.body.error.code, 'internal_error');

  const disabled = await call(envWithDbError(D1_QUOTA, { PUBLIC_SNAPSHOT_FALLBACK: '0' }), '/api/public/wallpapers');
  assert.equal(disabled.status, 500);
});
