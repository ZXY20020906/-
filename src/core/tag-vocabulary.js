/**
 * 标签受控词表 —— **唯一事实来源**（第二期标签治理）。
 *
 * 背景：库里的标签是自由文本，同一概念会并存多种写法（`动漫` / `anime` / `动画`），
 * 筛选栏里就变成三行、角标各算一半。治理分两层：
 *   1. 写入/检索时**归一**：`normalizeTag('anime') === '动漫'`（本文件）；
 *   2. facets 聚合时按 canonical 合并（`queries.js` 的 tag_aliases JOIN）。
 *
 * `schema/017_tag_aliases.sql` 会把 `TAG_ALIASES` 原样种进 D1 的 `tag_aliases` 表。
 * 两处必须一致 —— `tests/tag-alias.test.js` 会解析 SQL 逐条比对，改一处忘另一处会红。
 *
 * 判据：alias 必须是 canonical 的**同义写法**（中英/简繁/单复数），
 * 不是「相关标签」——把「夜景」并进「城市」会让筛选语义漂移，那种应该用 subtag。
 */
export const CANONICAL_TAGS = Object.freeze([
  '动漫',
  '游戏',
  '自然风景',
  '明星',
  '皮肤',
  '动态',
  '玻璃',
  '半透明',
  '天空',
  '气泡',
  '草地',
  '冰蓝',
]);

/** alias → canonical。key 可以是中文/英文/简繁；英文大小写由 normalizeTag() 兜住。 */
export const TAG_ALIASES = Object.freeze({
  anime: '动漫',
  动画: '动漫',
  動漫: '动漫',
  game: '游戏',
  games: '游戏',
  遊戲: '游戏',
  nature: '自然风景',
  自然: '自然风景',
  star: '明星',
  idol: '明星',
  偶像: '明星',
  glass: '玻璃',
  translucent: '半透明',
  dynamic: '动态',
  skin: '皮肤',
  skins: '皮肤',
  sky: '天空',
  bubble: '气泡',
  grass: '草地',
  'ice-blue': '冰蓝',
});

/** 仅 ASCII 的 alias 建小写索引；中文没有大小写，不重复建。 */
const LOWER_ALIASES = new Map(
  Object.entries(TAG_ALIASES)
    .filter(([alias]) => /^[\x20-\x7e]+$/.test(alias))
    .map(([alias, canonical]) => [alias.toLowerCase(), canonical]),
);

/**
 * 单个标签归一：精确命中 alias 优先，其次 ASCII 不区分大小写；都不是就原样返回。
 * 空值返回空串（调用方负责丢弃）。
 */
export function normalizeTag(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const exact = TAG_ALIASES[value];
  if (exact) return exact;
  const lower = LOWER_ALIASES.get(value.toLowerCase());
  return lower ?? value;
}

/** 列表归一 + 去重（保持首次出现的顺序）。 */
export function normalizeTags(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const tag = normalizeTag(item);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * `tag_aliases` 的种子行（schema/017 用同样顺序写 INSERT）。
 * 只导出不可变快照，避免调用方改到全局词表。
 */
export function aliasRows() {
  return Object.entries(TAG_ALIASES).map(([alias, canonical]) => ({ alias, canonical }));
}
