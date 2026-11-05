/**
 * 第二期验收：筛选增强（尺寸 / 时长 / 体积 / 帧率 / playable / audio）+ facets 联动。
 *
 * 用真 SQLite 跑真 SQL：这些参数的价值全在「NULL 怎么算」「档位存在性」，
 * 假映射测不出来。每个筛选都同时断言清单 total 与 facets 的合计，防止两套口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheKeyUrl } from '../src/server/app.js';
import { call, openSite, sqliteSkip, NOW } from './sqlite-site.js';

const VARIANT_1080 = JSON.stringify([
  { label: '1080p', width: 1920, height: 1080, fps: 30, key: 'wallpapers/wp_4k/v.1080p.mp4', bytes: 6_000_000, sha256: 'a'.repeat(64) },
]);
const VARIANT_4K30 = JSON.stringify([
  { label: '4K30', width: 3840, height: 2160, fps: 30, key: 'wallpapers/wp_4k30/v.30fps.mp4', bytes: 20_000_000, sha256: 'b'.repeat(64) },
]);

const ROWS = [
  {
    id: 'wp_4k', slug: 'u4k', width: 3840, height: 2160, fps: 60, bytes: 40_000_000,
    duration_ms: 12_000, has_audio: 1, variants: VARIANT_1080, tags: ['动漫'], license: 'cc0',
  },
  {
    id: 'wp_hd', slug: 'uhd', width: 1920, height: 1080, fps: 30, bytes: 8_000_000,
    duration_ms: 6000, has_audio: 0, variants: null, tags: ['动漫'], license: 'cc0',
  },
  {
    id: 'wp_4k30', slug: 'u4k30', width: 3840, height: 2160, fps: 30, bytes: 30_000_000,
    duration_ms: 8000, has_audio: 0, variants: VARIANT_4K30, tags: ['游戏'],
  },
  {
    id: 'wp_unknown', slug: 'unknown', width: null, height: null, fps: null, bytes: 500_000,
    duration_ms: null, has_audio: null, variants: null, tags: ['夜景'],
  },
  {
    id: 'wp_portrait', slug: 'portrait', width: 1080, height: 1920, fps: 30, bytes: 5_000_000,
    duration_ms: 4000, has_audio: 1, variants: null, tags: ['动漫'],
  },
];

function idsOf(body) {
  return body.data.items.map((item) => item.id).sort();
}

const sumCategories = (facets) => facets.categories.reduce((sum, item) => sum + item.count, 0);

test('筛选：尺寸 / 时长 / 体积 / 帧率（NULL 不匹配，未知不伪装满足）', { skip: sqliteSkip }, async () => {
  const site = openSite(ROWS);
  try {
    const cases = [
      ['?minWidth=2000', ['wp_4k', 'wp_4k30']],
      ['?maxWidth=1920', ['wp_hd', 'wp_portrait']],
      ['?minHeight=2000', ['wp_4k', 'wp_4k30']],
      ['?maxHeight=1080', ['wp_hd']],
      ['?minDurationMs=7000', ['wp_4k', 'wp_4k30']],
      ['?maxDurationMs=7000', ['wp_hd', 'wp_portrait']],
      ['?minBytes=10000000', ['wp_4k', 'wp_4k30']],
      ['?maxBytes=6000000', ['wp_portrait', 'wp_unknown']],
      ['?fpsMax=30', ['wp_4k30', 'wp_hd', 'wp_portrait']],
      ['?license=CC0', ['wp_4k', 'wp_hd']],
      ['?license=cc0', ['wp_4k', 'wp_hd']],
      ['?minWidth=1000&maxWidth=2000&minBytes=1000000', ['wp_hd', 'wp_portrait']],
    ];
    for (const [query, expected] of cases) {
      const res = await call(site.env, `/api/v1/public/wallpapers${query}`);
      assert.equal(res.status, 200, query);
      assert.deepEqual(idsOf(res.body), expected, query);
      assert.equal(sumCategories(res.body.data.facets), res.body.data.total, `facets 必须与 total 同源：${query}`);
    }
  } finally {
    site.close();
  }
});

test('筛选：audio=true|false 只匹配已知音轨（UNKNOWN 不参与）', { skip: sqliteSkip }, async () => {
  const site = openSite(ROWS);
  try {
    const withAudio = await call(site.env, '/api/v1/public/wallpapers?audio=true');
    assert.deepEqual(idsOf(withAudio.body), ['wp_4k', 'wp_portrait']);
    const silent = await call(site.env, '/api/v1/public/wallpapers?audio=false');
    assert.deepEqual(idsOf(silent.body), ['wp_4k30', 'wp_hd']);
    // 1/0 也认；非法值 400
    assert.deepEqual(idsOf((await call(site.env, '/api/v1/public/wallpapers?audio=1')).body), ['wp_4k', 'wp_portrait']);
    const bad = await call(site.env, '/api/v1/public/wallpapers?audio=maybe');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
    assert.ok(bad.body.error.hint);
  } finally {
    site.close();
  }
});

test('筛选：playable=original|1080p30（档位存在且满足 1920×1080@30）', { skip: sqliteSkip }, async () => {
  const site = openSite(ROWS);
  try {
    // original：原画本身 ≤1920×1080 且 ≤30fps
    const original = await call(site.env, '/api/v1/public/wallpapers?playable=original');
    assert.deepEqual(idsOf(original.body), ['wp_hd']);

    // 1080p30：原画满足 或 存在一个 ≤1920×1080 且 ≤30fps 的变体
    const p1080 = await call(site.env, '/api/v1/public/wallpapers?playable=1080p30');
    assert.deepEqual(idsOf(p1080.body), ['wp_4k', 'wp_hd'], '4K 靠 1080p 变体入选；4K30 的变体仍是 4K，不入选');
    assert.equal(sumCategories(p1080.body.data.facets), p1080.body.data.total);

    // 与其它筛选取交集
    const combined = await call(site.env, '/api/v1/public/wallpapers?playable=1080p30&audio=false');
    assert.deepEqual(idsOf(combined.body), ['wp_hd']);

    const bad = await call(site.env, '/api/v1/public/wallpapers?playable=4k');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /playable/);
  } finally {
    site.close();
  }
});

test('筛选：参数非法一律 400（不静默忽略）', { skip: sqliteSkip }, async () => {
  const site = openSite(ROWS);
  try {
    for (const query of [
      '?minWidth=abc', '?maxWidth=-1', '?fpsMax=0', '?minDurationMs=1.5',
      '?minBytes=999999999999999999999', '?playable=1080', '?audio=yes',
    ]) {
      const res = await call(site.env, `/api/v1/public/wallpapers${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, 'bad_request', query);
    }
  } finally {
    site.close();
  }
});

test('缓存键：第二期参数全部进 key（顺序无关、未知参数丢弃）', () => {
  const all = 'minWidth=1920&maxWidth=3840&minHeight=1080&maxHeight=2160&minDurationMs=1000&maxDurationMs=9000&minBytes=1000&maxBytes=9000&fpsMax=30&playable=1080p30&audio=true';
  const a = cacheKeyUrl(new URL(`https://a.test/p?${all}&limit=2`));
  const b = cacheKeyUrl(new URL(`https://a.test/p?limit=2&${all.split('&').reverse().join('&')}`));
  assert.equal(a, b);
  for (const name of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'minDurationMs', 'maxDurationMs', 'minBytes', 'maxBytes', 'fpsMax', 'playable', 'audio']) {
    assert.ok(a.includes(`${name}=`), `${name} 应在缓存键里`);
  }
  const withUnknown = cacheKeyUrl(new URL('https://a.test/p?minWidth=1&zzz=2'));
  assert.equal(withUnknown, cacheKeyUrl(new URL('https://a.test/p?minWidth=1')));
});

test('manifest：generatedAt 与 D1 最新 updated_at 对齐（不是请求时间）', { skip: sqliteSkip }, async () => {
  const site = openSite([
    { id: 'wp_a', slug: 'a', updated_at: NOW - 5000 },
    { id: 'wp_b', slug: 'b', updated_at: NOW + 7000 },
  ]);
  try {
    const res = await call(site.env, '/api/v1/public/manifest.json');
    assert.equal(res.status, 200);
    assert.equal(res.body.generatedAt, NOW + 7000);
    assert.equal(res.body.total, 2);
    // 同一份数据两次请求：generatedAt 不变，ETag 不变
    const again = await call(site.env, '/api/v1/public/manifest.json');
    assert.equal(again.body.generatedAt, res.body.generatedAt);
    assert.equal(again.headers.get('etag'), res.headers.get('etag'));
    // 304
    const cached = await call(site.env, '/api/v1/public/manifest.json', {
      headers: { 'if-none-match': res.headers.get('etag') },
    });
    assert.equal(cached.status, 304);
  } finally {
    site.close();
  }
});
