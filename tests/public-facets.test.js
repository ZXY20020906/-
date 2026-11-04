/**
 * 公开筛选（facets）+ 匿名可读白名单。
 *
 * 这里用**真 SQLite**（node:sqlite）跑 schema 与聚合 SQL，而不是 tests/harness.js 的假映射：
 * facets 的价值全在「计数」上（GROUP BY / json_each / UNION ALL / 已发布过滤），
 * 假映射只会把实现里的 JS 逻辑再抄一遍，测不出 SQL 算错。
 *
 * node:sqlite 需要 Node ≥ 22.5。拿不到时这些真实 SQL 用例会被 skip（不会把基线弄红），
 * 门禁（gate）用例不依赖数据库，任何 Node 都会跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from '../src/server/app.js';
import { gateMiddleware } from '../src/server/gate-middleware.js';
import { createEnv } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '..', 'schema');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();
const NOW = 1_760_000_000_000;

/**
 * 造 3 个分类、多标签、多子标签的已发布数据；另外 4 条「不该被公开接口看到」的：
 * 下线 / 未审核 / 未验证 / 没文件，外加 1 条未分类的（category 为 NULL）。
 */
const BASE_ROWS = [
  { id: 'wp_1', category_id: 'cat_wallpaper', kind: 'static', tags: ['动漫', '游戏'], subtag: '原神' },
  { id: 'wp_2', category_id: 'cat_wallpaper', kind: 'static', tags: ['动漫'], subtag: '崩铁' },
  { id: 'wp_3', category_id: 'cat_bootanim', kind: 'dynamic', tags: ['动漫', '自然风景'], subtag: '原神' },
  { id: 'wp_4', category_id: 'cat_assistant_skin', kind: 'static', tags: ['游戏'], subtag: '' },
  { id: 'wp_5', category_id: 'cat_assistant_skin', kind: 'static', tags: ['自然风景', '游戏'], subtag: '' },
  { id: 'wp_uncategorized', category_id: null, kind: 'static', tags: [], subtag: '孤儿' },
  // 以下都不该出现在公开接口里
  { id: 'wp_hidden', status: 'hidden', category_id: 'cat_wallpaper', tags: ['动漫'], subtag: '原神' },
  { id: 'wp_pending', review_status: 'pending', category_id: 'cat_wallpaper', tags: ['游戏'], subtag: '原神' },
  { id: 'wp_unverified', verified_at: null, category_id: 'cat_wallpaper', tags: ['游戏'], subtag: '原神' },
  { id: 'wp_nofile', storage_key: null, category_id: 'cat_wallpaper', tags: ['游戏'], subtag: '原神' },
];

const INSERT_WALLPAPER = `INSERT INTO wallpapers
  (id, slug, title, description, subtag, review_status, category_id, kind, status, storage_key, mime, bytes,
   width, height, sha256, tags, featured, sort_order, created_by, created_at, updated_at, published_at, verified_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function withDefaults(row) {
  const pick = (key, fallback) => (row[key] === undefined ? fallback : row[key]);
  return [
    row.id,
    pick('slug', row.id),
    pick('title', `壁纸 ${row.id}`),
    pick('description', ''),
    pick('subtag', ''),
    pick('review_status', 'approved'),
    pick('category_id', 'cat_wallpaper'),
    pick('kind', 'static'),
    pick('status', 'published'),
    pick('storage_key', `wallpapers/${row.id}/9f3c1a2b3c4d.png`),
    pick('mime', 'image/png'),
    pick('bytes', 1_000_000),
    pick('width', 1920),
    pick('height', 1080),
    pick('sha256', null),
    JSON.stringify(pick('tags', [])),
    pick('featured', 0),
    pick('sort_order', 0),
    null,
    pick('created_at', NOW),
    pick('updated_at', NOW),
    pick('published_at', NOW),
    pick('verified_at', NOW),
  ];
}

/** D1 → node:sqlite 的最小适配层；顺带记录每条被 prepare 的 SQL（用来证明「不是 N+1」）。 */
function makeD1(db, log) {
  return {
    prepare(sql) {
      log.push(sql);
      const stmt = db.prepare(sql);
      const state = { args: [] };
      const api = {
        bind(...args) {
          state.args = args;
          return api;
        },
        async all() {
          return { results: stmt.all(...state.args) };
        },
        async first() {
          return stmt.get(...state.args) ?? null;
        },
        async run() {
          stmt.run(...state.args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
}

const FAKE_BUCKET = {
  async put() {},
  async get() {
    return null;
  },
  async delete() {},
};

/** 建一个真库：跑完 schema（分类/标签种子也在里面）再灌数据。 */
function makeSite(rows = BASE_ROWS) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  const insert = db.prepare(INSERT_WALLPAPER);
  for (const row of rows) insert.run(...withDefaults(row));

  const queries = [];
  const env = {
    DB: makeD1(db, queries),
    BUCKET: FAKE_BUCKET,
    PUBLIC_ORIGIN: 'https://example.test',
  };
  return {
    env,
    queries,
    resetQueries() {
      queries.length = 0;
    },
    close() {
      db.close();
    },
  };
}

let ipSeq = 10;

/**
 * 走完整链路：站点门 → 路由。插件就是这么访问的（匿名、无 Cookie）。
 * 返回体同时给原始文本，方便断言 ETag / 304。
 */
async function anonymous(site, path, { method = 'GET', headers = {} } = {}) {
  ipSeq += 1;
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: { 'cf-connecting-ip': `198.18.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`, ...headers },
  });
  const response = await gateMiddleware({
    request,
    env: site.env,
    params: {},
    next: () => handle(request, site.env),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, headers: response.headers, body, text };
}

const counts = (list) => Object.fromEntries(list.map((item) => [item.name ?? item.id, item.count]));

/** 一组 facet 条目的计数合计（用来守「面板合计 == 清单 total」）。 */
const sumCounts = (list) => list.reduce((sum, item) => sum + item.count, 0);

/**
 * 关掉边缘缓存（只作用于当前用例）。
 * 为什么不用模块级 beforeEach：run-tests.mjs 把所有测试 import 进同一个进程，
 * 顶层 hook 会作用到别的文件（media-range.test.js 依赖一个全局假 caches）。
 * 这里用 t.after 精确还原，既不影响别人，也不让缓存把「查了几条 SQL」的断言搅乱。
 */
function detachEdgeCache(t) {
  const saved = globalThis.caches;
  delete globalThis.caches;
  t.after(() => {
    if (saved === undefined) delete globalThis.caches;
    else globalThis.caches = saved;
  });
}

function realSqlite(t) {
  if (!DatabaseSync) {
    t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5），跳过真实 SQL 用例');
    return false;
  }
  return true;
}

test('facets：三类计数正确（只统计已发布 + 已审核 + 有文件），tags/subtags 按 count 降序', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    const res = await anonymous(site, '/api/public/wallpapers?limit=24');
    assert.equal(res.status, 200);
    const { data } = res.body;

    // 旧字段一个没少
    assert.equal(data.total, 6, '只有已发布 + 已审核 + 已验证 + 有文件的才计入');
    assert.equal(data.items.length, 6);
    assert.equal(data.hasMore, false);
    assert.equal(data.page, null);
    assert.equal(data.pageSize, 24);
    assert.equal(data.filters.tag, null);

    // 新增字段
    assert.ok(data.facets, 'data.facets 必须存在');
    assert.deepEqual(Object.keys(data.facets).sort(), ['categories', 'subtags', 'tags']);

    // categories：只有真的有内容的分类（未分类/零条不出现在面板上），带 id/slug/name/count
    assert.deepEqual(data.facets.categories, [
      { id: 'cat_assistant_skin', slug: 'assistant-skin', name: '助手皮肤', count: 2 },
      { id: 'cat_wallpaper', slug: 'wallpaper', name: '壁纸', count: 2 },
      { id: 'cat_bootanim', slug: 'boot-animation', name: '开机动画', count: 1 },
    ]);

    // tags：动漫 3（wp1/wp2/wp3）、游戏 3（wp1/wp4/wp5）、自然风景 2（wp3/wp5）
    assert.deepEqual(counts(data.facets.tags), { 动漫: 3, 游戏: 3, 自然风景: 2 });
    assert.ok(
      data.facets.tags.every((item, index, list) => index === 0 || list[index - 1].count >= item.count),
      'tags 必须按 count 降序',
    );
    assert.ok(data.facets.tags.every((item) => item.count > 0), '只返回 count > 0 的标签');

    // subtags：原神 2、崩铁 1、孤儿 1（wp4/wp5 没有子标签，不产生空名项）
    assert.deepEqual(counts(data.facets.subtags), { 原神: 2, 崩铁: 1, 孤儿: 1 });
    assert.ok(data.facets.subtags.every((item) => item.name && item.count > 0));

    // 一致性：categories 分组合计 == total - 未分类条目。
    // 这份数据里 wp_uncategorized 的 category_id 为 NULL，它进清单、也进 tags/subtags，
    // 但没有「分类」可归，所以 categories 的合计比 total 正好少 1（这是唯一的例外，写死在这里防回归）。
    assert.equal(sumCounts(data.facets.categories), data.total - 1);
    // tags 是「一个作品多个标签」的多对多，合计只会 ≥ total
    assert.ok(sumCounts(data.facets.tags) >= data.total, 'tags 合计不应少于 total');
  } finally {
    site.close();
  }
});

test('facets：带 category 过滤时只统计该分类（tags/subtags 也跟着收窄）', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    const res = await anonymous(site, '/api/public/wallpapers?category=boot-animation');
    assert.equal(res.status, 200);
    const { data } = res.body;

    assert.equal(data.total, 1);
    assert.deepEqual(data.items.map((item) => item.id), ['wp_3']);
    assert.deepEqual(data.facets.categories, [
      { id: 'cat_bootanim', slug: 'boot-animation', name: '开机动画', count: 1 },
    ], '带 category 时 facets 只应统计该分类');
    assert.deepEqual(counts(data.facets.tags), { 动漫: 1, 自然风景: 1 });
    assert.deepEqual(counts(data.facets.subtags), { 原神: 1 });
    assert.equal(data.filters.category, 'boot-animation');
    assert.equal(sumCounts(data.facets.categories), data.total, '同一筛选条件下 facets 分类合计应等于 total');

    // kind 过滤同样进 facets
    const kindRes = await anonymous(site, '/api/public/wallpapers?kind=dynamic');
    assert.equal(kindRes.body.data.total, 1);
    assert.deepEqual(counts(kindRes.body.data.facets.tags), { 动漫: 1, 自然风景: 1 });
    assert.equal(sumCounts(kindRes.body.data.facets.categories), kindRes.body.data.total);
  } finally {
    site.close();
  }
});

test('一致性：facets.categories 合计 == 清单 total（approved 计入、pending 不计入，多组筛选下都成立）', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  // 两条都已发布且有文件、同分类，唯一区别是审核状态 —— 专治「清单有 N 条、面板计数却不是 N」
  const site = makeSite([
    { id: 'wp_approved', category_id: 'cat_wallpaper', tags: ['动漫'], subtag: '原神' },
    { id: 'wp_pending_only', review_status: 'pending', category_id: 'cat_wallpaper', tags: ['游戏'], subtag: '崩铁' },
  ]);
  try {
    const queries = [
      '',
      '?kind=static',
      '?kind=dynamic',
      '?tag=%E5%8A%A8%E6%BC%AB',
      '?tag=%E6%B8%B8%E6%88%8F',
      `?tag=${encodeURIComponent('动漫,游戏')}`,
      '?subtag=%E5%8E%9F%E7%A5%9E',
      '?featured=1',
      '?q=%E5%A3%81%E7%BA%B8',
      '?aspect=16:9',
      '?category=wallpaper',
    ];
    for (const query of queries) {
      const res = await anonymous(site, `/api/public/wallpapers${query}`);
      assert.equal(res.status, 200, query);
      const { total, items, facets } = res.body.data;
      assert.ok(items.length <= total, query);
      assert.equal(sumCounts(facets.categories), total, `facets.categories 合计应等于 total：${query}`);
      assert.ok(sumCounts(facets.tags) >= total, `tags 合计不应少于 total：${query}`);
    }

    // 只有 approved 的那条可见：pending 条目的分类/标签/子标签一个都不该出现
    const plain = await anonymous(site, '/api/public/wallpapers');
    assert.equal(plain.body.data.total, 1);
    assert.deepEqual(plain.body.data.items.map((item) => item.id), ['wp_approved']);
    assert.deepEqual(plain.body.data.facets, {
      categories: [{ id: 'cat_wallpaper', slug: 'wallpaper', name: '壁纸', count: 1 }],
      tags: [{ name: '动漫', count: 1 }],
      subtags: [{ name: '原神', count: 1 }],
    }, 'pending 条目的分类/标签/子标签都不计入 facets');

    // 只属于 pending 条目的标签：清单 0 条 + facets 空 → 仍然自洽
    const pendingTag = await anonymous(site, '/api/public/wallpapers?tag=%E6%B8%B8%E6%88%8F');
    assert.equal(pendingTag.body.data.total, 0);
    assert.deepEqual(pendingTag.body.data.facets, { categories: [], tags: [], subtags: [] });
  } finally {
    site.close();
  }
});

test('tag 多值：逗号分隔按 OR 匹配，结果与 facets 一致', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    // 基准：不带 tag 的全量（下面要拿它比对「空 tag = 不过滤」）
    const unfiltered = await anonymous(site, '/api/public/wallpapers');
    assert.equal(unfiltered.body.data.total, 6);

    // 单值：与旧版行为一致（精确命中数组里的一项）
    const single = await anonymous(site, '/api/public/wallpapers?tag=%E5%8A%A8%E6%BC%AB');
    assert.equal(single.body.data.total, 3);
    assert.deepEqual(single.body.data.items.map((item) => item.id).sort(), ['wp_1', 'wp_2', 'wp_3']);
    assert.equal(single.body.data.filters.tag, '动漫', '旧的 filters.tag 字段原样保留');

    // 多值 OR：动漫 ∪ 自然风景 = wp1 wp2 wp3 wp5
    const multi = await anonymous(
      site,
      `/api/public/wallpapers?tag=${encodeURIComponent('动漫,自然风景')}`,
    );
    assert.equal(multi.status, 200);
    assert.equal(multi.body.data.total, 4, 'OR 语义：命中任一标签即可');
    assert.deepEqual(multi.body.data.items.map((item) => item.id).sort(), ['wp_1', 'wp_2', 'wp_3', 'wp_5']);
    // facets 与清单同条件：游戏只剩 wp1/wp5
    assert.deepEqual(counts(multi.body.data.facets.tags), { 动漫: 3, 自然风景: 2, 游戏: 2 });
    assert.equal(sumCounts(multi.body.data.facets.categories), multi.body.data.total);
    // 回显保持原样（仍是清洗后的原始字符串，字段语义没变）
    assert.equal(multi.body.data.filters.tag, '动漫,自然风景');

    // 多值 + 分类：壁纸分类下命中 动漫/自然风景 的是 wp1、wp2
    const scoped = await anonymous(
      site,
      `/api/public/wallpapers?category=wallpaper&tag=${encodeURIComponent('动漫,自然风景')}`,
    );
    assert.equal(scoped.body.data.total, 2);
    assert.deepEqual(scoped.body.data.items.map((item) => item.id).sort(), ['wp_1', 'wp_2']);
    assert.deepEqual(counts(scoped.body.data.facets.tags), { 动漫: 2, 游戏: 1 });
    assert.deepEqual(scoped.body.data.facets.categories, [
      { id: 'cat_wallpaper', slug: 'wallpaper', name: '壁纸', count: 2 },
    ]);
    assert.equal(sumCounts(scoped.body.data.facets.categories), scoped.body.data.total);

    // 一个都不存在的标签：空结果，不报错
    const none = await anonymous(site, '/api/public/wallpapers?tag=%E4%B8%8D%E5%AD%98%E5%9C%A8');
    assert.equal(none.status, 200);
    assert.equal(none.body.data.total, 0);
    assert.deepEqual(none.body.data.facets, { categories: [], tags: [], subtags: [] });

    // 空 tag 分支：`tag=` 与 `tag=,,,` 清洗后都没有有效标签 → 不过滤，
    // 清单与 facets 都回到全量（与 JSON 数组为空时走 ?N IS NULL 的分支一致）。
    for (const emptyQuery of ['tag=', 'tag=,,,', 'tag=%20,']) {
      const empty = await anonymous(site, `/api/public/wallpapers?${emptyQuery}`);
      assert.equal(empty.status, 200, emptyQuery);
      assert.equal(empty.body.data.total, unfiltered.body.data.total, `${emptyQuery} 应当不过滤`);
      assert.deepEqual(
        empty.body.data.facets,
        unfiltered.body.data.facets,
        `${emptyQuery} 的 facets 应与全量一致`,
      );
      assert.equal(sumCounts(empty.body.data.facets.categories), empty.body.data.total - 1);
    }
  } finally {
    site.close();
  }
});

test('facets 用一条聚合查询出结果（不是 N+1，也不额外打三次）', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    site.resetQueries();
    const res = await anonymous(site, '/api/public/wallpapers?category=wallpaper&limit=2');
    assert.equal(res.status, 200);

    const statements = site.queries;
    assert.equal(statements.length, 3, `一次清单请求只该有 3 条 SQL（list/count/facets），实际：\n${statements.join('\n---\n')}`);
    const facetStatements = statements.filter((sql) => sql.trimStart().startsWith('WITH base'));
    assert.equal(facetStatements.length, 1, 'facets 必须由一条聚合查询算完');
    const facetSql = facetStatements[0];
    assert.equal((facetSql.match(/GROUP BY/g) ?? []).length, 3, '三条分支各自 GROUP BY，但仍是同一条 SQL');
    for (const marker of ["'category'", "'tag'", "'subtag'", 'json_each']) {
      assert.ok(facetSql.includes(marker), `facets SQL 少了 ${marker}`);
    }
  } finally {
    site.close();
  }
});

test('facets：tags/subtags 最多 50 个，全部 count > 0', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const rows = Array.from({ length: 55 }, (_, index) => {
    const suffix = String(index).padStart(2, '0');
    return { id: `wp_many_${suffix}`, category_id: 'cat_wallpaper', tags: [`标签${suffix}`], subtag: `子${suffix}` };
  });
  const site = makeSite(rows);
  try {
    const res = await anonymous(site, '/api/public/wallpapers?limit=1');
    assert.equal(res.status, 200);
    const { facets } = res.body.data;
    assert.equal(facets.tags.length, 50, 'tags 上限 50');
    assert.equal(facets.subtags.length, 50, 'subtags 上限 50');
    assert.equal(new Set(facets.tags.map((item) => item.name)).size, 50);
    assert.ok(facets.tags.every((item) => item.count === 1));
  } finally {
    site.close();
  }
});

test('回归：旧字段、旧参数与分页/游标语义都没变（facets 只是新增字段）', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    // 旧的 DTO 形状
    const res = await anonymous(site, '/api/public/wallpapers?category=wallpaper&kind=static&limit=1');
    assert.equal(res.status, 200);
    const { data } = res.body;
    assert.equal(data.total, 2);
    assert.equal(data.hasMore, true);
    assert.equal(data.page, null);
    assert.equal(data.pageCount, 2);
    assert.equal(data.offset, 0);
    assert.equal(data.sort, 'recent');
    assert.ok(data.nextCursor, '游标模式仍要返回 nextCursor');
    assert.deepEqual(data.filters, { category: 'wallpaper', kind: 'static', tag: null, aspect: null });

    const item = data.items[0];
    for (const key of [
      'id', 'slug', 'title', 'description', 'subtag', 'kind', 'mime', 'bytes', 'width', 'height',
      'durationMs', 'tags', 'featured', 'category', 'url', 'thumbUrl', 'variants', 'sha256',
      'updatedAt', 'publishedAt', 'createdAt',
    ]) {
      assert.ok(key in item, `DTO 少了字段 ${key}`);
    }
    assert.equal(item.category.slug, 'wallpaper');
    assert.match(item.url, /\/media\/wallpapers\/wp_/);
    // 排在最前的是 id 大的那条（wp_2），标签按库里存的数组原样给出
    assert.equal(item.id, 'wp_2');
    assert.deepEqual(item.tags, ['动漫']);
    assert.equal('status' in item, false, '公开 DTO 不暴露后台字段');

    // 页码语义
    const paged = await anonymous(site, '/api/public/wallpapers?page=2&limit=1');
    assert.equal(paged.body.data.page, 2);
    assert.equal(paged.body.data.offset, 1);
    assert.equal(paged.body.data.pageSize, 1);
    assert.equal(paged.body.data.nextCursor, null);

    // 游标翻页仍然能往下走
    const first = await anonymous(site, '/api/public/wallpapers?limit=2');
    const next = await anonymous(
      site,
      `/api/public/wallpapers?limit=2&cursor=${encodeURIComponent(first.body.data.nextCursor)}`,
    );
    assert.equal(next.status, 200);
    assert.equal(next.body.data.offset, 0);
    const firstIds = first.body.data.items.map((entry) => entry.id);
    assert.ok(next.body.data.items.every((entry) => !firstIds.includes(entry.id)), '游标不能重复返回上一页');

    // sort / aspect / subtag / featured 这些老参数照旧
    const byName = await anonymous(site, '/api/public/wallpapers?sort=name&limit=2');
    assert.equal(byName.body.data.sort, 'name');
    const featured = await anonymous(site, '/api/public/wallpapers?featured=1');
    assert.equal(featured.body.data.total, 0);
    const bySubtag = await anonymous(site, '/api/public/wallpapers?subtag=%E5%8E%9F%E7%A5%9E');
    assert.equal(bySubtag.body.data.total, 2);
    const byAspect = await anonymous(site, '/api/public/wallpapers?aspect=16:9');
    assert.ok(byAspect.body.data.total >= 1, 'aspect 过滤仍然生效');

    // ETag / 304 仍然工作（facets 进了 body，所以 hash 也覆盖它）
    const etagged = await anonymous(site, '/api/public/wallpapers?limit=2');
    const etag = etagged.headers.get('etag');
    assert.ok(etag);
    const cached = await anonymous(site, '/api/public/wallpapers?limit=2', {
      headers: { 'if-none-match': etag },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, '');
  } finally {
    site.close();
  }
});

test('匿名可读：未登录请求 categories/tags/subtags/wallpapers 都是 200（白名单生效）', async (t) => {
  if (!realSqlite(t)) return;
  detachEdgeCache(t);
  const site = makeSite();
  try {
    const categories = await anonymous(site, '/api/public/categories');
    assert.equal(categories.status, 200);
    assert.ok(Array.isArray(categories.body.data.categories));
    assert.equal(categories.headers.get('access-control-allow-origin'), '*');

    const tags = await anonymous(site, '/api/public/tags?category=wallpaper');
    assert.equal(tags.status, 200);
    assert.ok(Array.isArray(tags.body.data.tags));
    assert.ok(tags.body.data.tags.length > 0, '标签下拉要有数据');

    const subtags = await anonymous(site, '/api/public/subtags?category=wallpaper&tag=%E5%8A%A8%E6%BC%AB');
    assert.equal(subtags.status, 200);
    assert.deepEqual(
      subtags.body.data.subtags.map((item) => item.name).sort(),
      ['原神', '崩铁'],
      'tag 参数在子标签接口上同样是精确匹配',
    );

    const wallpapers = await anonymous(site, '/api/public/wallpapers');
    assert.equal(wallpapers.status, 200);

    // 写方法与未放行的路径照旧被门挡住
    for (const path of ['/api/public/categories', '/api/public/tags', '/api/public/subtags']) {
      const write = await anonymous(site, path, { method: 'POST' });
      assert.equal(write.status, 401, `POST ${path}`);
      assert.equal(write.body.error.code, 'site_locked', `POST ${path}`);
    }
    for (const path of ['/api/plugin/feed', '/api/admin/wallpapers', '/api/public/wallpapers/demo']) {
      const denied = await anonymous(site, path);
      assert.equal(denied.status, 401, path);
      assert.equal(denied.body.error.code, 'site_locked', path);
    }
  } finally {
    site.close();
  }
});

test('门禁：三份白名单路径只认 GET/HEAD，OPTIONS 供跨域预检', async () => {
  const { env } = createEnv({});
  const hitWith = async (path, method) => {
    let nextCalls = 0;
    const request = new Request(`https://example.test${path}`, { method });
    const response = await gateMiddleware({
      request,
      env,
      params: {},
      next: async () => {
        nextCalls += 1;
        return new Response('REAL-CONTENT', { status: 200 });
      },
    });
    return { response, nextCalls };
  };

  for (const path of ['/api/public/categories', '/api/public/tags', '/api/public/subtags']) {
    for (const method of ['GET', 'HEAD']) {
      const { response, nextCalls } = await hitWith(path, method);
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.equal(nextCalls, 1, `${method} ${path}`);
    }
    const options = await hitWith(path, 'OPTIONS');
    assert.equal(options.response.status, 200, `OPTIONS ${path}`);
    assert.equal(options.nextCalls, 1, `OPTIONS ${path}`);
  }
});
