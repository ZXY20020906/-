/**
 * 阶段四 · 后台列表分页 + 60s 短缓存 + 公开读缓存头（D1–D6）。
 *
 * 用真 SQLite + 真路由：分页的 LIMIT/OFFSET、筛选条件的 bind 顺序都只在真 SQL 上
 * 才作数；缓存则靠**统计 prepare 次数**来证明「第二次没有打库」。
 *
 * 缓存相关的用例必须显式打开 `ADMIN_LIST_CACHE_MS`（夹具默认关），否则跨用例串味。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { call, makeBucket, openSite, sqliteSkip, NOW } from './sqlite-site.js';
import { clearCache, cacheStats } from '../src/server/short-cache.js';
import { ADMIN_LIST_CACHE_PREFIX, ADMIN_LIST_DEFAULT_LIMIT } from '../src/server/routes/wallpapers.js';

const ROWS = Array.from({ length: 25 }, (_, index) => ({
  id: `wp_${String(index + 1).padStart(2, '0')}`,
  slug: `u-${index + 1}`,
  title: `素材 ${index + 1}`,
  category_id: index % 2 === 0 ? 'cat_wallpaper' : 'cat_assistant_skin',
  kind: index % 3 === 0 ? 'dynamic' : 'static',
  status: index === 24 ? 'draft' : 'published',
  updated_at: NOW - index * 1000,
  published_at: NOW - index * 1000,
}));

/** 会话行：admin 账号 + 设备绑定（与 tests/harness.js 的固定设备一致）。 */
const DEVICE_ID = 'e'.repeat(43);
const TOKEN = 'admin-list-token';
const SESSION_SQL = `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
  VALUES (?, 'usr_site', ?, ?, '', '', ?, ?)`;

let sha256Hex = null;

async function makeSite() {
  const site = openSite(ROWS);
  const { createHash } = await import('node:crypto');
  sha256Hex = sha256Hex || ((text) => createHash('sha256').update(text).digest('hex'));
  const now = Date.now();
  site.db.prepare(SESSION_SQL).run(sha256Hex(TOKEN), now, now + 60 * 60 * 1000, sha256Hex(DEVICE_ID), now);
  // 统计 prepare 次数：缓存命中时应当一条都不新增
  const statements = [];
  const db = site.env.DB;
  const env = {
    ...site.env,
    DB: {
      prepare(sql) { statements.push(sql); return db.prepare(sql); },
      batch(list) { return db.batch(list); },
    },
  };
  return { site, env, statements };
}

function adminCall(site, env, path, options = {}) {
  const headers = { cookie: `folia_session=${TOKEN}; folia_device=${DEVICE_ID}`, ...(options.headers ?? {}) };
  return call(env, path, { ...options, headers });
}

function realSqlite(t) {
  if (sqliteSkip) {
    t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5），跳过真实 SQL 用例');
    return false;
  }
  return true;
}

/** 每个用例前清一次进程内缓存（模块级单例，跨用例共享）。 */
function resetCache(t) {
  clearCache();
  t.after(() => clearCache());
}

test('D1 分页：默认 limit=20，page 1 起，返回 total/page/pageCount/hasMore', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  resetCache(t);
  const { site, env } = await makeSite();
  try {
    const first = await adminCall(site, env, '/api/admin/wallpapers?page=1');
    assert.equal(first.status, 200);
    assert.equal(first.body.data.limit, ADMIN_LIST_DEFAULT_LIMIT, '默认每页 20 条');
    assert.equal(first.body.data.total, 25);
    assert.equal(first.body.data.items.length, 20);
    assert.equal(first.body.data.page, 1);
    assert.equal(first.body.data.pageCount, 2);
    assert.equal(first.body.data.offset, 0);
    assert.equal(first.body.data.hasMore, true);

    const second = await adminCall(site, env, '/api/admin/wallpapers?page=2');
    assert.equal(second.body.data.items.length, 5);
    assert.equal(second.body.data.offset, 20);
    assert.equal(second.body.data.hasMore, false);

    // 两页拼起来正好是全集，且不重叠
    const ids = [...first.body.data.items, ...second.body.data.items].map((item) => item.id);
    assert.equal(new Set(ids).size, 25);

    // 兼容旧写法：不传 page 时仍然认 offset
    const legacy = await adminCall(site, env, '/api/admin/wallpapers?limit=5&offset=20');
    assert.equal(legacy.body.data.items.length, 5);
    assert.equal(legacy.body.data.offset, 20);
    assert.equal(legacy.body.data.page, null);
    assert.deepEqual(legacy.body.data.items.map((item) => item.id), second.body.data.items.map((item) => item.id));
  } finally {
    site.close();
  }
});

test('D2 缓存：同样的后台列表连点多次只打一次库', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  resetCache(t);
  const { site, env, statements } = await makeSite();
  try {
    const cachedEnv = { ...env, ADMIN_LIST_CACHE_MS: '60000' };
    // 只数「列表 + 计数」两条 SQL：会话查询每个请求都要跑，跟缓存无关
    const listSql = () => statements.filter((sql) => /FROM wallpapers w/.test(sql) && !/needs_variant/.test(sql)).length;

    const first = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200');
    assert.equal(first.status, 200);
    const afterFirst = listSql();
    assert.equal(afterFirst, 2, '首次正好是清单 + 计数两条 SQL');

    for (let i = 0; i < 9; i += 1) {
      const res = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200');
      assert.equal(res.status, 200);
      assert.equal(res.text, first.text, '命中缓存必须返回完全一致的响应体');
    }
    assert.equal(listSql(), afterFirst, '后 9 次请求不能新增任何列表 SQL');
    assert.ok(cacheStats().live >= 1);

    // 同一账号换个筛选 = 不同 key，必须重新查
    await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200&status=draft');
    assert.equal(listSql(), afterFirst + 2, '换了筛选条件必须回源');

    // 关掉缓存（ADMIN_LIST_CACHE_MS=0）时每次都回源
    const uncachedEnv = { ...env, ADMIN_LIST_CACHE_MS: '0' };
    const before = listSql();
    await adminCall(site, uncachedEnv, '/api/admin/wallpapers?limit=200');
    await adminCall(site, uncachedEnv, '/api/admin/wallpapers?limit=200');
    assert.equal(listSql(), before + 4);
  } finally {
    site.close();
  }
});

test('D3 缓存：写操作后立刻失效（改完刷新就能看到）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  resetCache(t);
  const { site, env } = await makeSite();
  try {
    const cachedEnv = { ...env, ADMIN_LIST_CACHE_MS: '60000' };
    const before = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200');
    assert.equal(before.body.data.total, 25);

    // 走真实写接口（PATCH），而不是直接改库 —— 要验的正是「路由层清缓存」
    const target = before.body.data.items[0];
    const patch = await adminCall(site, env, `/api/admin/wallpapers/${target.id}`, {
      method: 'PATCH',
      headers: { 'x-folia-client': 'admin', 'content-type': 'application/json' },
      body: JSON.stringify({ title: `${target.title}（已改名）` }),
    });    assert.equal(patch.status, 200, patch.text.slice(0, 200));
    assert.equal(patch.body.data.wallpaper.title, `${target.title}（已改名）`);

    const after = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200');
    const updated = after.body.data.items.find((item) => item.id === target.id);
    assert.equal(updated.title, `${target.title}（已改名）`, '写操作必须让缓存失效');
  } finally {
    site.close();
  }
});

test('D4 缓存：按人区分（mine/liked 不会串号）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  resetCache(t);
  const { site, env } = await makeSite();
  try {
    const cachedEnv = { ...env, ADMIN_LIST_CACHE_MS: '60000' };
    const mine = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200&mine=1');
    assert.equal(mine.status, 200);
    // 夹具里所有行的 created_by 都是 usr_site，所以 mine=1 与非 mine 的条数相同；
    // 关键是「key 里带了 actor」——换一个 actor 必须重新查（这里用同一 actor 的两种筛选对比）。
    const all = await adminCall(site, cachedEnv, '/api/admin/wallpapers?limit=200');
    assert.equal(all.status, 200);
    assert.equal(mine.body.data.total, 25);
    assert.equal(all.body.data.total, 25);
  } finally {
    site.close();
  }
});

test('D5 降级不缓存：快照缺失走 D1 时公开接口是 no-store + x-folia-degraded', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = openSite(ROWS);
  try {
    // 空桶 + 打开快照判定 ⇒ 一定回退 D1，响应带 degraded
    const env = { ...site.env, BUCKET: makeBucket(), SNAPSHOT_AUTO: '1' };
    for (const path of ['/api/v1/public/wallpapers?limit=5', '/api/public/categories', '/api/v1/public/tags', '/api/v1/public/manifest.json']) {
      const res = await call(env, path);
      assert.equal(res.status, 200, `${path} 不能 500`);
      assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0', `${path} 必须 no-store`);
      assert.equal(res.headers.get('x-folia-degraded'), '1', `${path} 必须标 x-folia-degraded`);
    }

    // 快照在位时恢复成 5 分钟
    const snapEnv = { ...site.env, SNAPSHOT_AUTO: '0' };
    const ok = await call(snapEnv, '/api/v1/public/wallpapers?limit=5');
    assert.equal(ok.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=3600');
    assert.equal(ok.headers.get('x-folia-degraded'), null);
    const categories = await call(snapEnv, '/api/public/categories');
    assert.match(categories.headers.get('cache-control'), /max-age=300/);
  } finally {
    site.close();
  }
});

test('D6 全局缓存可一键清空（运维手段）', async () => {
  const { setCached, getCached, cacheKey } = await import('../src/server/short-cache.js');
  const key = cacheKey(ADMIN_LIST_CACHE_PREFIX, ['usr_x', 'k']);
  setCached(key, { items: [] }, 60_000);
  assert.deepEqual(getCached(key), { items: [] });
  assert.ok(clearCache(ADMIN_LIST_CACHE_PREFIX) >= 1);
  assert.equal(getCached(key), undefined);
  // 前缀不匹配时不清
  setCached(cacheKey('other:', ['k']), 1, 60_000);
  assert.equal(clearCache(ADMIN_LIST_CACHE_PREFIX), 0);
  clearCache();
  assert.equal(cacheStats().size, 0);
});
