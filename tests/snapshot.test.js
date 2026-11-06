/**
 * 阶段三 · 公开读静态化：`snapshot.js` 与读取链（S1–S9）。
 *
 * 用**真 SQLite + 真路由**（`tests/sqlite-site.js`），不是假映射：
 * 快照的价值全在「它和 D1 查出来的东西一模一样」，假数据只能把实现再抄一遍。
 *
 * 对拍（快照路径 vs D1 路径）在 `tests/snapshot-parity.test.js`，这里只守
 * 「构建 / 发布 / 读回 / 缓存头 / draft 不入境」这些快照自身的契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { call, makeBucket, openSite, snapshotEnv, sqliteSkip, NOW } from './sqlite-site.js';
import {
  CURRENT_CACHE_CONTROL, CURRENT_KEY, SNAPSHOT_CACHE_CONTROL, SNAPSHOT_PREFIX,
  buildSnapshot, computeVersion, publishSnapshot, readCurrent, readSnapshot,
} from '../src/server/snapshot.js';
import { SNAPSHOT } from '../src/server/public-snapshot.js';

/** 一条 4K@60 的作品：原画不可播，但有 1080p 变体。 */
const VARIANT_1080 = JSON.stringify([{
  label: '1080p', width: 1920, height: 1080, fps: 30,
  key: 'wallpapers/wp_4k/v.1080p.mp4', bytes: 6_000_000, sha256: 'a'.repeat(64),
}]);

const ROWS = [
  {
    id: 'wp_4k', slug: 'u4k', title: '四 K 动态', category_id: 'cat_wallpaper', kind: 'dynamic',
    width: 3840, height: 2160, fps: 60, bytes: 40_000_000, duration_ms: 12_000,
    tags: ['动漫'], subtag: '原神', variants: VARIANT_1080, featured: 1, license: 'cc0',
    has_audio: 1, updated_at: NOW - 100, published_at: NOW - 100,
  },
  {
    id: 'wp_hd', slug: 'uhd', title: '一千零八十', category_id: 'cat_wallpaper', kind: 'dynamic',
    width: 1920, height: 1080, fps: 30, bytes: 8_000_000, duration_ms: 6000,
    tags: ['动漫', '游戏'], subtag: '崩铁', featured: 0, license: 'cc0', has_audio: 0,
    updated_at: NOW - 200, published_at: NOW - 200,
  },
  {
    id: 'wp_skin', slug: 'uskin', title: '皮肤包', category_id: 'cat_assistant_skin', kind: 'static',
    width: 2560, height: 1440, fps: 30, bytes: 2_000_000, duration_ms: null,
    tags: ['自然风景'], subtag: '', featured: 0, license: null, has_audio: null,
    updated_at: NOW - 300, published_at: NOW - 300,
  },
  {
    id: 'wp_boot', slug: 'uboot', title: '开机动画', category_id: 'cat_bootanim', kind: 'dynamic',
    width: 1080, height: 1920, fps: 30, bytes: 3_000_000, duration_ms: 4000,
    tags: [], subtag: '竖屏', featured: 0, license: 'personal', has_audio: 1,
    updated_at: NOW - 400, published_at: NOW - 400,
  },
  // ---- 以下都不该出现在公开快照里 ----------------------------------------
  { id: 'wp_draft', slug: 'udraft', title: '草稿', category_id: 'cat_wallpaper', status: 'draft' },
  { id: 'wp_pending', slug: 'upending', title: '待审核', category_id: 'cat_wallpaper', review_status: 'pending' },
  { id: 'wp_unverified', slug: 'unverified', title: '未验证', category_id: 'cat_wallpaper', verified_at: null },
  { id: 'wp_nofile', slug: 'unofile', title: '无文件', category_id: 'cat_wallpaper', storage_key: null },
];

const PUBLIC_COUNT = 4;
const PUBLIC_IDS = ['wp_4k', 'wp_hd', 'wp_skin', 'wp_boot'];

function realSqlite(t) {
  if (sqliteSkip) {
    t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5），跳过真实 SQL 用例');
    return false;
  }
  return true;
}

function listIds(body) {
  return body.data.items.map((item) => item.id).sort();
}

function sumCategories(facets) {
  return facets.categories.reduce((sum, item) => sum + item.count, 0);
}

/** 建站 + 发布一次快照，返回所有用到的东西。 */
async function publishedSite(t, rows = ROWS) {
  const site = openSite(rows);
  t.after(() => site.close());
  const env = snapshotEnv(site.env);
  const result = await publishSnapshot(env);
  return { site, env, result };
}

test('S1 buildSnapshot：只含公开条目，facets 三类合计 == total', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite(ROWS);
  try {
    const env = snapshotEnv(site.env);
    const snapshot = await buildSnapshot(env);
    // buildSnapshot 只读；要让 HTTP 层读到快照，还得真的发布一次
    await publishSnapshot(env);

    assert.equal(snapshot.core.total, PUBLIC_COUNT, '草稿/待审/未验证/无文件都不进快照');
    assert.deepEqual(snapshot.core.items.map((item) => item.id).sort(), [...PUBLIC_IDS].sort());
    assert.equal(snapshot.manifest.total, PUBLIC_COUNT);
    assert.equal(snapshot.manifest.items.length, PUBLIC_COUNT);

    const list = await call(env, '/api/v1/public/wallpapers?limit=100');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.total, PUBLIC_COUNT);
    assert.equal(list.body.data.degraded, undefined, '走了快照就不该有 degraded');
    assert.equal(sumCategories(list.body.data.facets), list.body.data.total, 'facets.categories 合计必须 == total');
    // 快照里的分类计数与清单同源（不再是 SQL 的另一套口径）
    assert.deepEqual(
      list.body.data.facets.categories.map((item) => [item.slug, item.count]),
      [['wallpaper', 2], ['assistant-skin', 1], ['boot-animation', 1]],
    );
    // 快照文件真的写到 R2：snapshots/<version>/{manifest,wallpapers}.json + current.json
    assert.ok(site.bucket.keys().includes(`${SNAPSHOT_PREFIX}/${snapshot.version}/manifest.json`));
    assert.ok(site.bucket.keys().includes(`${SNAPSHOT_PREFIX}/${snapshot.version}/wallpapers.json`));
    assert.ok(site.bucket.keys().includes(CURRENT_KEY));
  } finally {
    site.close();
  }
});

test('S2 内容不变 ⇒ 二次 publishSnapshot 不写新对象（wrote=false）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env, result } = await publishedSite(t);
  const before = site.bucket.keys();
  const second = await publishSnapshot(env);
  assert.equal(second.wrote, false);
  assert.equal(second.version, result.version);
  assert.deepEqual(site.bucket.keys(), before, '重复构建不能产生新对象');
  assert.equal(site.bucket.puts.length, 3, '首轮只写了 manifest/wallpapers/current 三个对象');
});

test('S3 内容变化 ⇒ version 变化、current.json 指向新版本', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env, result } = await publishedSite(t);
  const previous = result.version;

  site.db.prepare('UPDATE wallpapers SET title = ?, updated_at = ? WHERE id = ?')
    .run('四 K 动态（改名）', NOW + 5000, 'wp_4k');

  const third = await publishSnapshot(env);
  assert.equal(third.wrote, true);
  assert.notEqual(third.version, previous);

  const current = await readCurrent(env);
  assert.equal(current.version, third.version);
  assert.equal(current.generatedAt, NOW + 5000, 'generatedAt 取 D1 里最新的 updated_at');

  const snapshot = await readSnapshot(env);
  assert.equal(snapshot.version, third.version);
  assert.equal(snapshot.wallpapers.items.find((item) => item.id === 'wp_4k').title, '四 K 动态（改名）');
  // 旧版本对象不删：回滚 = 把 current.json 指回上一版
  assert.ok(site.bucket.keys().includes(`${SNAPSHOT_PREFIX}/${previous}/wallpapers.json`));
});

test('S4 列表：读快照时参数筛选正确（category/kind/tag/minWidth/playable）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { env } = await publishedSite(t);

  const cases = [
    ['?category=assistant-skin', ['wp_skin']],
    ['?kind=static', ['wp_skin']],
    ['?tag=动漫', ['wp_4k', 'wp_hd']],
    ['?tag=anime', ['wp_4k', 'wp_hd']], // alias 归一：anime → 动漫
    ['?minWidth=3000', ['wp_4k']],
    ['?playable=original', ['wp_hd']],
    ['?playable=1080p30', ['wp_4k', 'wp_hd']],
    ['?featured=1', ['wp_4k']],
    ['?subtag=崩铁', ['wp_hd']],
    ['?license=cc0', ['wp_4k', 'wp_hd']],
    ['?audio=false', ['wp_hd']],
    ['?fpsMax=29', []],
  ];
  for (const [query, expected] of cases) {
    const res = await call(env, `/api/v1/public/wallpapers${query}`);
    assert.equal(res.status, 200, query);
    assert.deepEqual(listIds(res.body), expected, query);
    assert.equal(sumCategories(res.body.data.facets), res.body.data.total, `facets 必须与 total 同源：${query}`);
  }
});

test('S5 详情：快照命中 / 未命中回源 / 都不存在 ⇒ 404', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env } = await publishedSite(t);

  const hit = await call(env, '/api/v1/public/wallpapers/uhd');
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.wallpaper.id, 'wp_hd');
  assert.equal(hit.body.data.degraded, undefined);

  // 快照构建之后才发布的条目：快照里没有 ⇒ 回源 D1 仍然 200（带 degraded）
  site.insert({
    id: 'wp_late', slug: 'ulate', title: '迟到的一条', category_id: 'cat_wallpaper',
    kind: 'static', width: 1920, height: 1080, updated_at: NOW + 9000,
  });
  const miss = await call(env, '/api/v1/public/wallpapers/ulate');
  assert.equal(miss.status, 200, '快照未命中要回源 D1，而不是 404');
  assert.equal(miss.body.data.wallpaper.id, 'wp_late');
  assert.equal(miss.body.data.degraded, true, '回源 D1 必须标 degraded');

  const missing = await call(env, '/api/v1/public/wallpapers/no-such-thing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'not_found');
});

test('S6 快照缺失 ⇒ 回退 D1 且响应带 degraded:true', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite(ROWS);
  t.after(() => site.close());

  // 同一个库、空桶（没有 current.json）⇒ 只能回 D1
  const env = snapshotEnv({ ...site.env, BUCKET: makeBucket() });
  assert.equal(await readSnapshot(env), null);

  const list = await call(env, '/api/v1/public/wallpapers?limit=100');
  assert.equal(list.status, 200, '快照缺失不能 500');
  assert.equal(list.body.data.total, PUBLIC_COUNT);
  assert.equal(list.body.data.degraded, true);
  assert.equal(list.body.data.snapshotGeneratedAt, undefined, 'degraded 只标「没走快照」，不假装是内嵌快照');

  const categories = await call(env, '/api/public/categories');
  assert.equal(categories.status, 200);
  assert.equal(categories.body.data.degraded, true);
  assert.ok(categories.body.data.categories.length > 0);

  const detail = await call(env, '/api/v1/public/wallpapers/uhd');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.degraded, true);
});

test('S7 manifest：ETag 稳定；If-None-Match ⇒ 304', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { env } = await publishedSite(t);

  const first = await call(env, '/api/v1/public/manifest.json');
  assert.equal(first.status, 200);
  assert.equal(first.body.apiVersion, 'v1');
  assert.equal(first.body.total, PUBLIC_COUNT);
  assert.equal(first.body.items.length, PUBLIC_COUNT);
  assert.equal(first.body.generatedAt, NOW - 100);
  assert.equal(first.body.degraded, undefined);
  assert.ok(first.headers.get('etag'));

  const again = await call(env, '/api/v1/public/manifest.json');
  assert.equal(again.headers.get('etag'), first.headers.get('etag'), '同一份快照 ETag 必须稳定');

  const cached = await call(env, '/api/v1/public/manifest.json', {
    headers: { 'if-none-match': first.headers.get('etag') },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
  assert.equal(cached.headers.get('etag'), first.headers.get('etag'));
});

test('S8 draft 条目不出现在快照与公开接口里', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { env } = await publishedSite(t);

  const snapshot = await readSnapshot(env);
  const ids = snapshot.wallpapers.items.map((item) => item.id);
  assert.ok(!ids.includes('wp_draft'), 'draft 绝不能进快照');
  assert.ok(!ids.includes('wp_pending'));
  assert.ok(!ids.includes('wp_unverified'));
  assert.ok(!ids.includes('wp_nofile'));

  const manifestIds = snapshot.manifest.items.map((item) => item.id);
  assert.ok(!manifestIds.includes('wp_draft'));

  const list = await call(env, '/api/v1/public/wallpapers?limit=100');
  assert.ok(!listIds(list.body).includes('wp_draft'));

  const detail = await call(env, '/api/v1/public/wallpapers/udraft');
  assert.equal(detail.status, 404);
});

test('S9 缓存头：current.json 300s / snapshots immutable', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env, result } = await publishedSite(t);

  // ① current.json：200 + {version, generatedAt} + 5 分钟缓存
  const current = await call(env, '/api/v1/public/current.json');
  assert.equal(current.status, 200);
  assert.equal(current.body.version, result.version);
  assert.equal(typeof current.body.generatedAt, 'number');
  assert.equal(current.body.generatedAt, NOW - 100);
  assert.equal(current.headers.get('cache-control'), CURRENT_CACHE_CONTROL);
  assert.match(current.headers.get('cache-control'), /max-age=300/);

  // 条件请求也认（指针没变就不用重传）
  const cached = await call(env, '/api/v1/public/current.json', {
    headers: { 'if-none-match': current.headers.get('etag') },
  });
  assert.equal(cached.status, 304);

  // ② 快照对象写 R2 时就带 immutable（version 里已含内容哈希）
  const wallpapersPut = site.bucket.puts.find((entry) => entry.key.endsWith('/wallpapers.json'));
  const manifestPut = site.bucket.puts.find((entry) => entry.key.endsWith('/manifest.json'));
  const currentPut = site.bucket.puts.find((entry) => entry.key === CURRENT_KEY);
  assert.equal(wallpapersPut.options.httpMetadata.cacheControl, SNAPSHOT_CACHE_CONTROL);
  assert.equal(manifestPut.options.httpMetadata.cacheControl, SNAPSHOT_CACHE_CONTROL);
  assert.match(wallpapersPut.options.httpMetadata.cacheControl, /immutable/);
  assert.equal(currentPut.options.httpMetadata.cacheControl, CURRENT_CACHE_CONTROL);

  // ③ 三个公开端点仍然按既有 TTL 缓存
  const list = await call(env, '/api/v1/public/wallpapers');
  assert.match(list.headers.get('cache-control'), /max-age=300/);
});

test('附加：computeVersion —— 内容相同 ⇒ 版本不变；内容不同 ⇒ 变', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite(ROWS);
  t.after(() => site.close());
  const env = snapshotEnv(site.env);

  const a = await computeVersion(env, { items: [1, 2, 3] });
  const b = await computeVersion(env, { items: [1, 2, 3] });
  const c = await computeVersion(env, { items: [1, 2, 4] });
  assert.match(a, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  // 没有 current.json 时不会「复用」一个不存在的版本
  assert.equal(await readCurrent(env), null);
});

test('附加：--force 等价路径 —— 内容没变也换一个版本，旧对象保留', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env, result } = await publishedSite(t);
  const forced = await publishSnapshot(env, { force: true });
  assert.equal(forced.wrote, true);
  assert.equal(forced.version.split('-').pop(), result.version.split('-').pop(), 'force 只换时间戳，内容哈希不变');
  assert.ok(site.bucket.keys().includes(`${SNAPSHOT_PREFIX}/${forced.version}/wallpapers.json`));
  assert.ok(site.bucket.keys().includes(`${SNAPSHOT_PREFIX}/${result.version}/wallpapers.json`), '旧版本不删（回滚用）');
  assert.equal((await readCurrent(env)).version, forced.version);
});

/**
 * 兜底链的最后一层仍然在：R2 快照缺失 + D1 报可识别错误 ⇒ 内嵌 `public-snapshot.js`。
 * （第三期没有动它，这条用例守的是「别在重构里把它弄丢」。）
 */
test('附加：快照对象被删 ⇒ 重建会补回来（内容没变也要重写）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { site, env, result } = await publishedSite(t);

  // 模拟「手删一个快照对象」：current.json 还在，但 wallpapers.json 没了
  await site.bucket.delete(`${SNAPSHOT_PREFIX}/${result.version}/wallpapers.json`);
  assert.equal(await readSnapshot(env), null, '缺文件必须判定为「没有快照」，回退 D1');

  const repaired = await publishSnapshot(env);
  assert.equal(repaired.wrote, true, '对象缺失时即使内容没变也必须重写');
  assert.equal(repaired.version, result.version, '修复现场沿用原版本号，不制造新版本');
  const snapshot = await readSnapshot(env);
  assert.ok(snapshot, '补写之后快照又能读到了');
  assert.equal(snapshot.wallpapers.total, PUBLIC_COUNT);
});

test('附加：快照对象本身可公开读取（immutable），其余路径一律 404', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const { env, result } = await publishedSite(t);

  // ① 当前版本的两个文件都能直接 GET（CDN 上 immutable 的那两个对象）
  for (const file of ['wallpapers.json', 'manifest.json']) {
    const res = await call(env, `/api/v1/public/snapshots/${result.version}/${file}`);
    assert.equal(res.status, 200, `${file} 应可直接读取`);
    assert.match(res.headers.get('cache-control'), /max-age=31536000, immutable/);
    const body = JSON.parse(res.text);
    assert.equal(body.total, PUBLIC_COUNT);
  }

  // ② 白名单之外的东西一律 404（不能拿它当 R2 读取器）
  const cases = [
    `/api/v1/public/snapshots/${result.version}/secret.txt`,
    `/api/v1/public/snapshots/${result.version}/..%2Fcurrent.json`,
    '/api/v1/public/snapshots/not-a-version/wallpapers.json',
    '/api/v1/public/snapshots/20260101T000000Z-deadbeef/wallpapers.json',
  ];
  for (const path of cases) {
    const res = await call(env, path);
    assert.equal(res.status, 404, `${path} 必须 404`);
  }
});

test('附加：兜底链 —— 无快照 + D1 不可用 ⇒ 内嵌快照（degraded + snapshotGeneratedAt）', async () => {
  const env = {
    DB: { prepare() { throw new Error('D1_ERROR: no such table: wallpapers'); } },
    BUCKET: makeBucket(),
    PUBLIC_ORIGIN: 'https://example.test',
    PUBLIC_SNAPSHOT_FALLBACK: '1',
    SNAPSHOT_AUTO: '1',
  };
  const res = await call(env, '/api/v1/public/wallpapers?limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.degraded, true);
  assert.equal(res.body.data.snapshotGeneratedAt, SNAPSHOT.generatedAt);
  assert.equal(res.body.data.total, SNAPSHOT.items.length);
});
