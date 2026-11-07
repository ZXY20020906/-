/**
 * 公开口径一致性：**分类计数之和必须等于列表 total**，且 `kind=pet` 可筛。
 *
 * 这两条都是线上实测出来的坑：
 *   ① /api/public/categories 各分类计数之和 122，列表 total 113（差 9 条），
 *      根因是分类计数只按 status='published' 数，没带公开门槛（verified + approved）；
 *   ② `kind=pet` 返回 400 —— 接口自己会返回 kind='pet'，却查不了它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { call, openSite, snapshotEnv, sqliteSkip } from './sqlite-site.js';
import { makePetZip } from './pet-zip.js';

function realSqlite(t) {
  if (sqliteSkip) { t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5）'); return false; }
  return true;
}

/** 一条「看起来发布、其实没过公开门槛」的条目。 */
function publishable(site, id, overrides = {}) {
  const row = {
    id,
    slug: id,
    title: id,
    category_id: 'cat_wallpaper',
    status: 'published',
    review_status: 'approved',
    verified_at: 1,
    storage_key: `wallpapers/${id}/a.png`,
    mime: 'image/png',
    bytes: 100,
    width: 1920,
    height: 1080,
    ...overrides,
  };
  site.insert(row);
  return row;
}

async function categoriesAndTotal(env) {
  const list = await call(env, '/api/v1/public/wallpapers?limit=1');
  assert.equal(list.status, 200, list.text.slice(0, 200));
  const categories = await call(env, '/api/v1/public/categories');
  assert.equal(categories.status, 200, categories.text.slice(0, 200));
  const counts = categories.body.data.categories;
  return { total: list.body.data.total, counts, sum: counts.reduce((sum, item) => sum + Number(item.publishedCount ?? item.count ?? 0), 0) };
}

test('C1 分类计数之和 == 列表 total（pending / 未验证 都不计入）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close()); 
  publishable(site, 'wp_ok_1');
  publishable(site, 'wp_ok_2');
  // 已发布但没审核 → 不进公开列表，也不该计入分类
  publishable(site, 'wp_pending', { review_status: 'pending' });
  // 已发布已审核但没验证过 → 同上
  publishable(site, 'wp_unverified', { verified_at: null });

  const env = snapshotEnv(site.env);
  const { publishSnapshot } = await import('../src/server/snapshot.js');
  await publishSnapshot(env);

  const { total, counts, sum } = await categoriesAndTotal(env);
  assert.equal(total, 2, '只有两条真正公开');
  assert.equal(sum, total, `分类计数之和 ${sum} 必须等于 total ${total}（明细 ${JSON.stringify(counts.map((c) => [c.slug, c.publishedCount]))}）`);
});

test('C2 无分类条目进「未分类」桶，仍然算进合计', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close());
  publishable(site, 'wp_cat');
  publishable(site, 'wp_nocat', { category_id: null });

  const env = snapshotEnv(site.env);
  const { publishSnapshot } = await import('../src/server/snapshot.js');
  await publishSnapshot(env);

  const { total, counts, sum } = await categoriesAndTotal(env);
  assert.equal(total, 2);
  assert.equal(sum, total, `合计 ${sum} != total ${total}`);
  const bucket = counts.find((item) => item.slug === 'uncategorized');
  assert.ok(bucket, `应出现未分类桶，实际 ${JSON.stringify(counts.map((c) => c.slug))}`);
  assert.equal(bucket.publishedCount, 1);
  assert.equal(bucket.name, '未分类');
});

test('C3 D1 兜底路径（无快照）口径一致', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close());
  publishable(site, 'wp_live_1');
  publishable(site, 'wp_live_pending', { review_status: 'pending' });

  // 不建快照 ⇒ 走 D1
  const { total, counts, sum } = await categoriesAndTotal(site.env);
  assert.equal(total, 1);
  assert.equal(sum, total, `D1 路径合计 ${sum} != total ${total}（明细 ${JSON.stringify(counts.map((c) => [c.slug, c.publishedCount]))}）`);
});

test('K1 ?kind=pet 返回 200 且只返回桌宠包', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close());
  // 一条普通图片 + 一条桌宠包（都公开）
  publishable(site, 'wp_plain');
  site.insert({
    id: 'wp_pet1',
    slug: 'whale',
    title: '鲸鱼娘',
    category_id: 'cat_desktop_pet',
    status: 'published',
    review_status: 'approved',
    verified_at: 1,
    storage_key: 'wallpapers/wp_pet1/a.zip',
    mime: 'application/zip',
    bytes: 1000,
    kind: 'static',
    variants: JSON.stringify([{ kind: 'pet', pet: { id: 'whale-girl', displayName: '鲸鱼娘', frames: [8], columns: 8, tracks: ['idle'], previewKey: 'thumbs/wp_pet1/p.webp' } }]),
  });

  const res = await call(site.env, '/api/v1/public/wallpapers?kind=pet&limit=10');
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.body.data.total, 1, res.text.slice(0, 300));
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].kind, 'pet');
  assert.equal(res.body.data.items[0].id, 'wp_pet1');
});

test('K2 ?kind=bogus 仍然 400', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close());
  const res = await call(site.env, '/api/v1/public/wallpapers?kind=bogus');
  assert.equal(res.status, 400, res.text.slice(0, 200));
  assert.equal(res.body.error.code, 'bad_request');
});

test('K3 ?kind=static 不会把桌宠包混进来', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite();
  t.after(() => site.close());
  publishable(site, 'wp_plain2', { kind: 'static' });
  site.insert({
    id: 'wp_pet2', slug: 'whale2', title: '鲸鱼娘2', category_id: 'cat_desktop_pet',
    status: 'published', review_status: 'approved', verified_at: 1,
    storage_key: 'wallpapers/wp_pet2/a.zip', mime: 'application/zip', bytes: 1000, kind: 'static',
    variants: JSON.stringify([{ kind: 'pet', pet: { id: 'whale-girl', displayName: '鲸鱼娘', frames: [8], columns: 8, tracks: ['idle'], previewKey: 'thumbs/wp_pet2/p.webp' } }]),
  });
  const res = await call(site.env, '/api/v1/public/wallpapers?kind=static&limit=10');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 1, 'static 只该有那条图片');
  assert.equal(res.body.data.items[0].id, 'wp_plain2');
});

void makePetZip;
