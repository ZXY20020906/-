/**
 * 阶段三 · **对拍**：同一份数据，快照路径 vs D1 路径。
 *
 * 这是整个阶段三唯一真正重要的一组用例。快照接管公开读之后，同一组筛选参数会走
 * 两条实现（`public-filter.js` 的内存筛选 / `queries.js` 的 SQL）。任何一处语义漂移
 * 都会让线上列表「没有报错地错掉」，所以这里**不许放宽断言**：
 *   · 排序后的 ids 序列、items 全文、total、facets、分页字段、排序键全部逐字段相等；
 *   · 任何一条不等 ⇒ 红。
 *
 * 两个环境共用同一个 SQLite 库，区别只在桶：
 *   snapEnv：桶里发布过快照（`SNAPSHOT_AUTO=1`，响应**不应该**带 degraded）
 *   dbEnv  ：空桶（响应**必须**带 degraded:true —— 顺带证明这次真的是 D1 算的）
 *
 * 覆盖 16 块（派单口径；细则里连带 page+limit 与组合一共 17 条，全都做了）：
 *   S10a 无参（含 5 种排序） S10b category      S10c kind      S10d tag
 *   S10e subtag            S10f q             S10g aspect    S10h featured
 *   S10i minWidth+maxWidth S10j minHeight+maxHeight
 *   S10k 时长区间          S10l 体积区间       S10m fpsMax    S10n playable
 *   S10o audio             S10p page+limit+游标 S10q 组合筛选
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { call, makeBucket, openSite, snapshotEnv, sqliteSkip, NOW } from './sqlite-site.js';
import { publishSnapshot } from '../src/server/snapshot.js';

const VARIANT_1080 = JSON.stringify([{
  label: '1080p', width: 1920, height: 1080, fps: 30,
  key: 'wallpapers/wp_a1/v1080p.mp4', bytes: 6_000_000, sha256: 'a'.repeat(64),
}]);
const VARIANT_4K30 = JSON.stringify([{
  label: '4K30', width: 3840, height: 2160, fps: 30,
  key: 'wallpapers/wp_d1/v30fps.mp4', bytes: 20_000_000, sha256: 'b'.repeat(64),
}]);

/**
 * 9 条公开作品 + 4 条不该出现的（draft / hidden / 私密分类 / 待审核）。
 * 每条都刻意在某一两个维度上与别人不同，保证每块筛选都能筛出非空且非全集。
 */
const ROWS = [
  {
    id: 'wp_a1', slug: 'u-a1', title: '星海漫游', category_id: 'cat_wallpaper', kind: 'dynamic',
    width: 3840, height: 2160, fps: 60, bytes: 40_000_000, duration_ms: 12_000,
    tags: ['动漫', '游戏'], subtag: '原神', variants: VARIANT_1080,
    featured: 1, license: 'cc0', has_audio: 1,
    created_at: NOW - 1100, updated_at: NOW - 100, published_at: NOW - 100,
  },
  {
    id: 'wp_a2', slug: 'u-a2', title: '星尘', category_id: 'cat_wallpaper', kind: 'static',
    width: 1920, height: 1080, fps: 30, bytes: 8_000_000, duration_ms: 6000,
    tags: ['动漫'], subtag: '崩铁', featured: 0, license: 'cc0', has_audio: 0,
    created_at: NOW - 1200, updated_at: NOW - 200, published_at: NOW - 200,
  },
  {
    id: 'wp_b1', slug: 'u-b1', title: '开机星轨', category_id: 'cat_bootanim', kind: 'dynamic',
    width: 1080, height: 1920, fps: 30, bytes: 3_000_000, duration_ms: 4000,
    tags: ['动漫'], subtag: '竖屏', featured: 0, license: null, has_audio: 1,
    created_at: NOW - 1300, updated_at: NOW - 300, published_at: NOW - 300,
  },
  {
    id: 'wp_c1', slug: 'u-c1', title: '皮肤·星夜', category_id: 'cat_assistant_skin', kind: 'static',
    width: 2560, height: 1440, fps: 30, bytes: 2_000_000, duration_ms: null,
    tags: ['自然风景'], subtag: '', featured: 0, license: 'personal', has_audio: null,
    created_at: NOW - 1400, updated_at: NOW - 400, published_at: NOW - 400,
  },
  {
    id: 'wp_c2', slug: 'u-c2', title: '皮肤·极简', category_id: 'cat_assistant_skin', kind: 'static',
    width: 1920, height: 1080, fps: 30, bytes: 500_000, duration_ms: null,
    tags: ['自然风景', '明星'], subtag: '', featured: 0, license: null, has_audio: null,
    created_at: NOW - 1500, updated_at: NOW - 500, published_at: NOW - 500,
  },
  {
    id: 'wp_d1', slug: 'u-d1', title: '4K30 动态', category_id: 'cat_wallpaper', kind: 'dynamic',
    width: 3840, height: 2160, fps: 30, bytes: 30_000_000, duration_ms: 8000,
    tags: ['游戏'], subtag: '原神', variants: VARIANT_4K30, featured: 0, license: null, has_audio: 0,
    created_at: NOW - 1600, updated_at: NOW - 600, published_at: NOW - 600,
  },
  {
    id: 'wp_d2', slug: 'u-d2', title: '超宽星图', category_id: 'cat_wallpaper', kind: 'static',
    width: 3440, height: 1440, fps: 30, bytes: 12_000_000, duration_ms: null,
    tags: ['自然风景'], subtag: '', featured: 0, license: null, has_audio: null,
    created_at: NOW - 1700, updated_at: NOW - 700, published_at: NOW - 700,
  },
  {
    id: 'wp_e1', slug: 'u-e1', title: '竖屏短片', category_id: 'cat_wallpaper', kind: 'dynamic',
    width: 1080, height: 1920, fps: 30, bytes: 6_000_000, duration_ms: 9000,
    tags: ['明星'], subtag: '竖屏', featured: 0, license: null, has_audio: 1,
    created_at: NOW - 1800, updated_at: NOW - 800, published_at: NOW - 800,
  },
  {
    id: 'wp_f1', slug: 'u-f1', title: '未知尺寸', category_id: 'cat_wallpaper', kind: 'static',
    width: null, height: null, fps: null, bytes: 100_000, duration_ms: null,
    tags: [], subtag: '', featured: 0, license: null, has_audio: null,
    created_at: NOW - 1900, updated_at: NOW - 900, published_at: NOW - 900,
  },
  // ---- 私有分类：A 方案（快照只收 is_public=1 的分类）两边都必须剔掉 -------------
  {
    id: 'wp_private', slug: 'u-private', title: '私有宠物', category_id: 'cat_desktop_pet', kind: 'static',
    width: 1000, height: 1000, fps: 30, bytes: 900_000, duration_ms: null,
    tags: ['游戏'], subtag: '', featured: 0, license: null, has_audio: null,
    created_at: NOW - 2000, updated_at: NOW - 1000, published_at: NOW - 1000,
  },
  // ---- 不该出现在任何公开响应里 ------------------------------------------------
  { id: 'wp_draft', slug: 'u-draft', title: '草稿', category_id: 'cat_wallpaper', status: 'draft' },
  { id: 'wp_hidden', slug: 'u-hidden', title: '已下架', category_id: 'cat_wallpaper', status: 'hidden' },
  { id: 'wp_pending', slug: 'u-pending', title: '待审核', category_id: 'cat_wallpaper', review_status: 'pending' },
];

const PUBLIC_COUNT = 9;

function realSqlite(t) {
  if (sqliteSkip) {
    t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5），跳过真实 SQL 用例');
    return false;
  }
  return true;
}

/**
 * 建一对环境：同一个库，snapEnv 的桶里发布过快照，dbEnv 是空桶（强制走 D1）。
 */
async function makePair(t) {
  const site = openSite(ROWS);
  t.after(() => site.close());
  // A 方案：把「桌宠」设为私有分类，里面的作品不该出现在公开集合里
  site.db.prepare("UPDATE categories SET is_public = 0 WHERE id = 'cat_desktop_pet'").run();
  site.db.prepare("UPDATE categories SET is_public = 1 WHERE id IN ('cat_wallpaper', 'cat_bootanim', 'cat_assistant_skin')").run();

  const snapEnv = snapshotEnv({ ...site.env, BUCKET: site.bucket });
  const dbEnv = snapshotEnv({ ...site.env, BUCKET: makeBucket() });
  const published = await publishSnapshot(snapEnv);
  return { site, snapEnv, dbEnv, published };
}

/** 排序键（派单要求：updatedAt/publishedAt/featured 也要对拍）。 */
function sortKeySequence(items) {
  return items.map((item) => `${item.publishedAt ?? ''}|${item.createdAt ?? ''}|${item.updatedAt ?? ''}|${item.featured ? 1 : 0}|${item.id}`);
}

async function compare(pair, query, label = query) {
  const [snap, db] = await Promise.all([
    call(pair.snapEnv, `/api/v1/public/wallpapers${query}`),
    call(pair.dbEnv, `/api/v1/public/wallpapers${query}`),
  ]);
  assert.equal(snap.status, 200, `快照路径 HTTP 非 200：${label}`);
  assert.equal(db.status, 200, `D1 路径 HTTP 非 200：${label}`);
  assert.equal(snap.body.data.degraded, undefined, `快照路径不该带 degraded：${label}`);
  assert.equal(db.body.data.degraded, true, `D1 路径必须带 degraded（证明真的走了 D1）：${label}`);

  const s = snap.body.data;
  const d = db.body.data;
  assert.deepEqual(s.items, d.items, `items 全文不一致：${label}`);
  assert.deepEqual(s.facets, d.facets, `facets 不一致：${label}`);
  assert.deepEqual(sortKeySequence(s.items), sortKeySequence(d.items), `排序键序列不一致：${label}`);
  for (const key of ['total', 'hasMore', 'nextCursor', 'page', 'pageSize', 'pageCount', 'offset', 'sort']) {
    assert.deepEqual(s[key], d[key], `${key} 不一致：${label}`);
  }
  assert.deepEqual(s.filters, d.filters, `filters 回显不一致：${label}`);
  assert.equal(
    s.facets.categories.reduce((sum, item) => sum + item.count, 0),
    s.total,
    `facets.categories 合计必须 == total：${label}`,
  );
  return s;
}

test('S10a 对拍：无参清单（含 5 种排序）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);

  const base = await compare(pair, '?limit=100');
  assert.equal(base.total, PUBLIC_COUNT, '私有分类 / 草稿 / 下架 / 待审都不该进公开集合');
  assert.ok(!base.items.some((item) => item.id === 'wp_private'));
  assert.ok(!base.items.some((item) => item.id === 'wp_draft'));

  for (const sort of ['recent', 'oldest', 'name', 'size', 'resolution']) {
    const data = await compare(pair, `?limit=100&sort=${sort}`, `sort=${sort}`);
    assert.equal(data.sort, sort);
    assert.equal(data.total, PUBLIC_COUNT);
    // 顺序本身也要一致（compare 里的 items 全文已经覆盖，这里再明确一次 id 序列）
    assert.deepEqual(
      data.items.map((item) => item.id),
      (await call(pair.snapEnv, `/api/v1/public/wallpapers?limit=100&sort=${sort}`)).body.data.items.map((item) => item.id),
    );
  }
});

test('S10b 对拍：category', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&category=wallpaper');
  assert.equal(data.total, 6);
  assert.ok(data.items.every((item) => item.category.slug === 'wallpaper'));
  // 私有分类既不在清单里，也不在 facets 里
  assert.ok(!data.facets.categories.some((item) => item.slug === 'desktop-pet'));
});

test('S10c 对拍：kind', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const dynamic = await compare(pair, '?limit=100&kind=dynamic');
  assert.equal(dynamic.total, 4);
  const static_ = await compare(pair, '?limit=100&kind=static');
  assert.equal(static_.total, 5);
  assert.equal(dynamic.total + static_.total, PUBLIC_COUNT);
});

test('S10d 对拍：tag（多值 OR + alias 归一）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const single = await compare(pair, '?limit=100&tag=动漫');
  assert.equal(single.total, 3);
  const multi = await compare(pair, '?limit=100&tag=动漫,游戏');
  assert.equal(multi.total, 4, '多值是按 OR 匹配');
  const alias = await compare(pair, '?limit=100&tag=anime');
  assert.deepEqual(alias.items.map((item) => item.id), single.items.map((item) => item.id), 'anime 必须与 动漫 等价');
});

test('S10e 对拍：subtag', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&subtag=原神');
  assert.equal(data.total, 2);
  const empty = await compare(pair, '?limit=100&subtag=不存在的子标签');
  assert.equal(empty.total, 0);
});

test('S10f 对拍：q 标题搜索', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&q=星');
  assert.equal(data.total, 5);
  const none = await compare(pair, '?limit=100&q=没有这个词');
  assert.equal(none.total, 0);
});

test('S10g 对拍：aspect', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const wide = await compare(pair, '?limit=100&aspect=16:9');
  assert.equal(wide.total, 5);
  const portrait = await compare(pair, '?limit=100&aspect=9:16');
  assert.equal(portrait.total, 2);
  const square = await compare(pair, '?limit=100&aspect=1:1');
  assert.equal(square.total, 0, '1:1 的作品在私有分类里，不该被看到');
});

test('S10h 对拍：featured', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&featured=1');
  assert.equal(data.total, 1);
  assert.equal(data.items[0].id, 'wp_a1');
  const off = await compare(pair, '?limit=100&featured=0');
  assert.equal(off.total, PUBLIC_COUNT, 'featured=0 等于不过滤');
});

test('S10i 对拍：minWidth + maxWidth', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&minWidth=1900&maxWidth=3900');
  assert.equal(data.total, 6);
  assert.ok(data.items.every((item) => item.width !== null && item.width >= 1900 && item.width <= 3900));
  const zero = await compare(pair, '?limit=100&minWidth=0', 'minWidth=0（假值也必须生效）');
  assert.equal(zero.total, 8, 'minWidth=0 仍会排除宽为 NULL 的那条');
});

test('S10j 对拍：minHeight + maxHeight', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&minHeight=1000&maxHeight=2200');
  assert.equal(data.total, 8);
  assert.ok(data.items.every((item) => item.height !== null && item.height >= 1000 && item.height <= 2200));
});

test('S10k 对拍：minDurationMs + maxDurationMs', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&minDurationMs=5000&maxDurationMs=15000');
  assert.equal(data.total, 4);
  const long = await compare(pair, '?limit=100&minDurationMs=10000');
  assert.equal(long.total, 1);
});

test('S10l 对拍：minBytes + maxBytes', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&minBytes=1000000&maxBytes=20000000');
  assert.equal(data.total, 5);
  const big = await compare(pair, '?limit=100&minBytes=29000000');
  assert.equal(big.total, 2);
});

test('S10m 对拍：fpsMax', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const data = await compare(pair, '?limit=100&fpsMax=30');
  assert.equal(data.total, 7, '60fps 与 fps 未知的两条都不匹配');
  const narrow = await compare(pair, '?limit=100&fpsMax=30&kind=static');
  assert.equal(narrow.total, 4);
});

test('S10n 对拍：playable（original / 1080p30）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const original = await compare(pair, '?limit=100&playable=original');
  assert.equal(original.total, 2, '1920×1080@30 的两条');
  const variant = await compare(pair, '?limit=100&playable=1080p30');
  assert.equal(variant.total, 3, '原画满足的两条 + 靠 1080p 变体入选的一条');
  assert.ok(variant.items.some((item) => item.id === 'wp_a1'));
  assert.ok(!variant.items.some((item) => item.id === 'wp_d1'), '4K30 变体仍是 4K，不算 1080p30');
});

test('S10o 对拍：audio', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);
  const withAudio = await compare(pair, '?limit=100&audio=true');
  assert.equal(withAudio.total, 3);
  const silent = await compare(pair, '?limit=100&audio=false');
  assert.equal(silent.total, 2, '只有明确 has_audio=0 的两条；未知音轨不参与');
  const one = await compare(pair, '?limit=100&audio=1');
  assert.deepEqual(one.items.map((item) => item.id), withAudio.items.map((item) => item.id));
});

test('S10p 对拍：page + limit + 游标', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);

  const first = await compare(pair, '?page=1&limit=3');
  assert.equal(first.items.length, 3);
  assert.equal(first.page, 1);
  assert.equal(first.pageCount, 3);
  const second = await compare(pair, '?page=2&limit=3');
  assert.equal(second.items.length, 3);
  assert.equal(second.offset, 3);
  const third = await compare(pair, '?page=3&limit=3');
  assert.equal(third.items.length, 3);
  const fourth = await compare(pair, '?page=4&limit=3');
  assert.equal(fourth.items.length, 0);
  assert.equal(fourth.hasMore, false);
  // 分页三页拼起来 == 一次取全（顺序也一致）
  assert.deepEqual(
    [...first.items, ...second.items, ...third.items].map((item) => item.id),
    (await compare(pair, '?limit=100')).items.map((item) => item.id),
  );

  // 游标：两条路径给出的 nextCursor 必须一致，且拿它翻页结果也一致
  const cursorPage = await compare(pair, '?limit=4');
  assert.ok(cursorPage.nextCursor, '还有更多时必须给 nextCursor');
  const next = await compare(pair, `?limit=4&cursor=${encodeURIComponent(cursorPage.nextCursor)}`);
  assert.equal(next.offset, 0);
  assert.ok(next.items.length > 0);
});

test('S10q 对拍：组合筛选（3–4 个参数 + 非默认排序）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const pair = await makePair(t);

  const combo = await compare(pair, '?limit=3&category=wallpaper&tag=动漫&minWidth=1000&sort=name');
  assert.ok(combo.total > 0);
  assert.ok(combo.items.every((item) => item.category.slug === 'wallpaper'));

  const combo2 = await compare(pair, '?limit=100&kind=dynamic&playable=1080p30&audio=true&sort=size');
  assert.ok(combo2.total > 0);

  const combo3 = await compare(pair, '?limit=100&aspect=16:9&minBytes=1000000&maxBytes=40000000&fpsMax=60&sort=resolution');
  assert.ok(combo3.total > 0);

  const none = await compare(pair, '?category=boot-animation&kind=static&minWidth=3000');
  assert.equal(none.total, 0, '空结果两边也必须一致（facets 为空数组而不是报错）');

  // manifest 也要对拍：快照里的 manifest 与 D1 现算的内容逐字段一致。
  // （ETag 不能直接比：D1 路径的响应体多了 degraded 标记，hash 自然会变；
  //   线上正常状态是快照命中、没有 degraded，所以这里比对「去掉标记后的内容」。）
  const [snapManifest, dbManifest] = await Promise.all([
    call(pair.snapEnv, '/api/v1/public/manifest.json'),
    call(pair.dbEnv, '/api/v1/public/manifest.json'),
  ]);
  assert.equal(snapManifest.body.degraded, undefined);
  assert.equal(dbManifest.body.degraded, true);
  const { etag: snapEtag, ...snapManifestRest } = snapManifest.body;
  const { etag: dbEtag, degraded: dbDegraded, ...dbManifestRest } = dbManifest.body;
  assert.ok(snapEtag && dbEtag);
  assert.deepEqual(snapManifestRest, dbManifestRest, 'manifest 内容必须一致');
  assert.equal(snapManifestRest.total, PUBLIC_COUNT);
  assert.equal(snapManifestRest.items.length, PUBLIC_COUNT);
  // ETag 稳定：同一份快照重复取不变
  const snapAgain = await call(pair.snapEnv, '/api/v1/public/manifest.json');
  assert.equal(snapAgain.headers.get('etag'), snapManifest.headers.get('etag'));

  // categories / tags / subtags 三个端点也要对拍
  for (const path of ['/api/v1/public/categories', '/api/v1/public/tags', '/api/v1/public/subtags', '/api/v1/public/tags?category=wallpaper']) {
    const [snap, db] = await Promise.all([call(pair.snapEnv, path), call(pair.dbEnv, path)]);
    assert.equal(snap.status, 200, path);
    assert.equal(db.status, 200, path);
    const { degraded: dbDegradedOnEndpoint, ...dbData } = db.body.data;
    assert.equal(dbDegradedOnEndpoint, true, `D1 路径必须带 degraded：${path}`);
    assert.deepEqual(snap.body.data, dbData, `端点数据不一致：${path}`);
  }

  // 详情也要对拍（列表里的任意一条）
  const anySlug = combo.items[0].slug;
  const [snapDetail, dbDetail] = await Promise.all([
    call(pair.snapEnv, `/api/v1/public/wallpapers/${encodeURIComponent(anySlug)}`),
    call(pair.dbEnv, `/api/v1/public/wallpapers/${encodeURIComponent(anySlug)}`),
  ]);
  assert.deepEqual(snapDetail.body.data.wallpaper, dbDetail.body.data.wallpaper);
});
