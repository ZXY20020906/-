/**
 * 第二期验收：标签治理（tag_aliases）。
 *
 * 三层都要测到，否则治理只是「文件里写了」：
 *   1. 词表文件 ↔ schema/017 种子**逐条一致**（改一处忘另一处立刻红）；
 *   2. 写入归一：`cleanFreeTags(['anime'])` 落库是 `动漫`；
 *   3. 检索 + facets：库里同时存在 `anime` 与 `动漫` 时，筛 alias 和筛 canonical 返回同一批，
 *      面板里也只有一行 `动漫`（count 合并）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { aliasRows, normalizeTag, normalizeTags, TAG_ALIASES } from '../src/core/tag-vocabulary.js';
import { cleanFreeTags } from '../src/core/validate.js';
import { SCHEMA_DIR, call, openSite, sqliteSkip } from './sqlite-site.js';

const counts = (list) => Object.fromEntries(list.map((item) => [item.name, item.count]));

test('词表：normalizeTag 覆盖中英/简繁/大小写，非 alias 原样返回', () => {
  assert.equal(normalizeTag('anime'), '动漫');
  assert.equal(normalizeTag('Anime'), '动漫');
  assert.equal(normalizeTag(' ANIME '), '动漫');
  assert.equal(normalizeTag('動漫'), '动漫');
  assert.equal(normalizeTag('动画'), '动漫');
  assert.equal(normalizeTag('game'), '游戏');
  assert.equal(normalizeTag('遊戲'), '游戏');
  assert.equal(normalizeTag('nature'), '自然风景');
  assert.equal(normalizeTag('ice-blue'), '冰蓝');
  // canonical 自身不再被映射（词表里没有 A→B→C 链）
  for (const canonical of Object.values(TAG_ALIASES)) {
    assert.equal(normalizeTag(canonical), canonical, `${canonical} 不能被二次映射`);
  }
  // 无关标签原样返回
  assert.equal(normalizeTag('夜景'), '夜景');
  assert.equal(normalizeTag(''), '');
  assert.equal(normalizeTag(null), '');
});

test('词表：normalizeTags 归一 + 去重保序', () => {
  assert.deepEqual(normalizeTags(['anime', '动漫', '游戏', 'game', '夜景']), ['动漫', '游戏', '夜景']);
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(null), []);
});

test('词表：schema/017 的种子与 TAG_ALIASES 逐条一致（防漂移）', () => {
  const sql = readFileSync(resolve(SCHEMA_DIR, '017_tag_aliases.sql'), 'utf8');
  const rows = [...sql.matchAll(/\('([^']+)',\s*'([^']+)',\s*0\)/g)]
    .map((match) => ({ alias: match[1], canonical: match[2] }))
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  const expected = aliasRows().sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  assert.deepEqual(rows, expected, 'schema/017 的 INSERT 必须与 src/core/tag-vocabulary.js 一致');
});

test('写入：cleanFreeTags 把 alias 落成 canonical（并去重）', () => {
  assert.deepEqual(cleanFreeTags(['anime', '动漫', 'Anime', '夜景']), ['动漫', '夜景']);
  assert.deepEqual(cleanFreeTags('anime,game,nature'), ['动漫', '游戏', '自然风景']);
  assert.deepEqual(cleanFreeTags([]), []);
  // 长度/数量上限的行为不变
  assert.throws(() => cleanFreeTags(['x'.repeat(25)]), /最多 24 个/);
  assert.throws(() => cleanFreeTags(Array.from({ length: 9 }, (_, i) => `标签${i}`)), /最多 8 个标签/);
});

test('库内：tag_aliases 种子数量与词表一致，alias 唯一', { skip: sqliteSkip }, () => {
  const site = openSite([]);
  try {
    const total = site.db.prepare('SELECT COUNT(*) AS n FROM tag_aliases').get().n;
    assert.equal(total, Object.keys(TAG_ALIASES).length);
    const rows = site.db.prepare('SELECT alias, canonical FROM tag_aliases ORDER BY alias').all();
    const map = Object.fromEntries(rows.map((row) => [row.alias, row.canonical]));
    for (const [alias, canonical] of Object.entries(TAG_ALIASES)) {
      assert.equal(map[alias], canonical, alias);
    }
  } finally {
    site.close();
  }
});

test('检索 + facets：alias 与 canonical 命中同一批，面板按 canonical 合并', { skip: sqliteSkip }, async () => {
  const site = openSite([
    { id: 'wp_anime', slug: 'anime-row', tags: ['anime'] },
    { id: 'wp_cn', slug: 'cn-row', tags: ['动漫'] },
    { id: 'wp_game_en', slug: 'game-en', tags: ['game'] },
    { id: 'wp_game_cn', slug: 'game-cn', tags: ['游戏'] },
    { id: 'wp_other', slug: 'other', tags: ['夜景'] },
  ]);
  try {
    const plain = await call(site.env, '/api/v1/public/wallpapers');
    assert.equal(plain.status, 200);
    assert.deepEqual(counts(plain.body.data.facets.tags), { 动漫: 2, 游戏: 2, 夜景: 1 });
    assert.equal(
      plain.body.data.facets.tags.reduce((sum, item) => sum + item.count, 0),
      5,
      'canonical 合并后总数不变（没有标签被吃掉）',
    );

    for (const tag of ['anime', '动漫']) {
      const res = await call(site.env, `/api/v1/public/wallpapers?tag=${encodeURIComponent(tag)}`);
      assert.equal(res.status, 200, tag);
      assert.equal(res.body.data.total, 2, `tag=${tag} 应命中 2 条`);
      assert.deepEqual(res.body.data.items.map((item) => item.id).sort(), ['wp_anime', 'wp_cn']);
      assert.deepEqual(counts(res.body.data.facets.tags), { 动漫: 2 });
      assert.equal(res.body.data.filters.tag, tag, 'filters.tag 仍回显原始输入');
    }

    // 多值 OR + alias：anime→动漫 命中 2、game→游戏 命中 2
    const multi = await call(site.env, `/api/v1/public/wallpapers?tag=${encodeURIComponent('anime,game')}`);
    assert.equal(multi.body.data.total, 4);
    // 旧路径与 v1 同源（同样的 alias 归一）
    const legacy = await call(site.env, `/api/public/wallpapers?tag=anime`);
    assert.equal(legacy.body.data.total, 2);
    assert.equal(legacy.text, (await call(site.env, '/api/v1/public/wallpapers?tag=anime')).text);

    // 标签云：/api/public/tags 的 count 也按 canonical 聚合
    const tags = await call(site.env, '/api/v1/public/tags');
    assert.equal(tags.status, 200);
    const countOf = Object.fromEntries(tags.body.data.tags.map((item) => [item.tag, item.count]));
    assert.equal(countOf['动漫'], 2, 'anime + 动漫 合并后是 2');
    assert.equal(countOf['游戏'], 2, 'game + 游戏 合并后是 2');
    assert.equal(countOf['自然风景'], 0, '词表里有但没人用 → 0');
    assert.equal(countOf['明星'], 0);

    // 子标签接口的 tag 参数同样走 alias 归一（这里没有 subtag，断言不报错即可）
    const subtags = await call(site.env, '/api/v1/public/subtags?tag=anime');
    assert.equal(subtags.status, 200);
    assert.deepEqual(subtags.body.data.subtags, []);
  } finally {
    site.close();
  }
});
