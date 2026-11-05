/**
 * 公开只读接口的**唯一实现**（v1 与旧路径共用）。
 *
 * 为什么拆出这个文件：第一期要求「新版加在 /api/v1/public/*，旧路径内部转发到 v1，
 * 字段与行为完全一致」。如果两个路由文件各写一份逻辑，「完全一致」就只是口头约定——
 * 改一处忘另一处立刻分叉。现在：
 *
 *   routes/public-v1.js  ──┐
 *   routes/public.js（旧） ──┴──► public-api.js（本文件，真正的 SQL / DTO / 分页）
 *
 * 于是兼容性验证可以退化成一条断言：同一请求分别打旧路径与 v1，响应体逐字节相同
 * （tests/api-v1.test.js 的「旧路径 == v1」用例）。
 *
 * 公开可见性门槛在 queries.js 的 PUBLIC_VISIBLE（已发布 + 有文件 + 已验证 + 已审核），
 * 清单 / 计数 / facets 三处同源，不在本文件里另算一遍。
 */
import { all, first, isD1QuotaError, isD1Unavailable } from './db.js';
import { PUBLIC_FACETS, PUBLIC_LIST_BY_SORT, PUBLIC_SUBTAGS, Q } from './queries.js';
import { cursorForSort, decodeCursor, encodeCursor, normalizeCursor } from '../core/pagination.js';
import { cleanEnum, parseLimit, parsePage, parseSort } from '../core/validate.js';
import { KINDS } from '../core/validate.js';
import { ASPECT_TOLERANCE, ASPECTS, parseAspect } from '../core/aspects.js';
import { badRequest, notFound } from '../core/errors.js';
import { normalizeTag } from '../core/tag-vocabulary.js';
import { mediaBaseFor, publicUrl } from './storage.js';
import { safeJsonArray } from './util.js';
import { categoryDto, variantsDto, wallpaperDto } from './dto.js';
import { SNAPSHOT } from './public-snapshot.js';

/** 搜索词只保留普通字符，避免 % _ 被当成通配符。 */
export function likePattern(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[%_\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned ? `%${cleaned}%` : null;
}

/** 标签筛选：单个标签名最长 30 字；一次最多 20 个（再多就不像人点的了）。 */
export const TAG_VALUE_MAX = 30;
export const TAG_MAX_VALUES = 20;

/** facets 里 tags / subtags 最多给多少个（按 count 降序）。 */
export const FACET_LIMIT = 50;

/**
 * 解析 `tag` 参数：逗号分隔的多值，语义是 **OR**（命中任意一个标签即算匹配）。
 *
 * 第二期起每个值先过 `normalizeTag()`：`anime` → `动漫`，于是「筛 anime」和
 * 「筛 动漫」返回同一批（SQL 那边再把库里的 alias 值映射到 canonical）。
 *
 * 库里的 `wallpapers.tags` 是 JSON 数组文本，所以这里转成 JSON 数组字符串交给
 * `json_each`（见 queries.js 的 tagMatch），一个占位符搞定多值。
 * 单值输入与旧版完全一致：清洗规则（剔掉 `% _ \ "`）、长度上限、`filters.tag` 输出都不变。
 */
export function parseTagFilter(raw) {
  const text = String(raw ?? '').replace(/[%_\\"]/g, '').trim();
  if (!text) return { values: [], json: null };
  const values = [];
  for (const part of text.split(',')) {
    const value = part.trim();
    if (!value) continue;
    // 与旧版一致：单个标签过长是 400，而不是悄悄截断
    if (value.length > TAG_VALUE_MAX) throw badRequest('tag 参数过长');
    const canonical = normalizeTag(value);
    if (!values.includes(canonical)) values.push(canonical);
  }
  if (values.length > TAG_MAX_VALUES) throw badRequest(`tag 参数过多（最多 ${TAG_MAX_VALUES} 个）`);
  return { values, json: values.length ? JSON.stringify(values) : null };
}

/**
 * 许可证筛选：对外统一小写标识（`cc0` / `cc-by` / `personal` …）。
 * 空串/缺省 = 不过滤；格式非法是 400（而不是静默返回空列表）。
 */
export function parseLicense(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value.length > 40 || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw badRequest('license 参数不合法（小写字母、数字、点、下划线、短横线，≤40 字）');
  }
  return value;
}

/** 数值筛选参数：缺省 → null；非整数/越界 → 400（不静默忽略）。 */
export function parseOptionalInt(raw, name, { min = 0, max = 1e12 } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} 必须是 ${min}~${max} 之间的整数`);
  }
  return n;
}

/** `playable` 的两种档位语义见 queries.js 的 extraFilters 注释。 */
export const PLAYABLE = Object.freeze(['1080p30', 'original']);

/** `audio=true|false`（也接受 1/0）→ 1/0/null；其它值 400。 */
export function parseAudio(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true' || value === '1') return 1;
  if (value === 'false' || value === '0') return 0;
  throw badRequest('audio 只能是 true / false');
}

/** `playable` 参数校验。 */
export function parsePlayable(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = String(raw).trim();
  if (!PLAYABLE.includes(value)) throw badRequest(`playable 只能是 ${PLAYABLE.join(' / ')}`);
  return value;
}

/* ------------------------------------------------------------------------- *
 * 快照回落（D1 不可用时）
 *
 * 2026-11-05 线上事故：D1 免费额度（每天 5,000,000 行读取）耗尽后，所有公开
 * 接口的第一条 SQL 都返回错误码 7500，app.js 统一转成 500，插件因此看不到
 * 任何站点壁纸。数据没有坏，坏的是「D1 唯一读源」这个假设。
 *
 * 这里保留一份最近一次成功从 D1 导出的只读快照（`public-snapshot.js`，由
 * `tools/build-public-snapshot.mjs` 从生产 D1 导出文件生成）。只在**可识别的
 * D1 错误**（额度/缺表/缺列/绑定失效）时启用；业务代码的异常照旧抛出，不会
 * 被快照掩盖。响应里带 `degraded: true` 与 `snapshotGeneratedAt`，客户端和
 * 冒烟脚本能明确知道「这是降级副本，不是刚查的库」。
 *
 * 为什么不用 R2 存快照：多一次 R2 读、多一个可能坏的绑定；公开数据本来就在
 * 仓库里，静态导入最简单，也最容易在 CI 里校验。
 * ------------------------------------------------------------------------- */

let lastSnapshotLogAt = 0;

/** 快照是否可用（测试里可显式设 PUBLIC_SNAPSHOT_FALLBACK=0 关掉，避免掩盖 SQL bug）。 */
export function snapshotFallbackEnabled(env) {
  return env?.PUBLIC_SNAPSHOT_FALLBACK !== '0'
    && Array.isArray(SNAPSHOT?.items)
    && SNAPSHOT.items.length > 0;
}

function shouldFallback(error, env) {
  return snapshotFallbackEnabled(env) && isD1Unavailable(error);
}

function noteSnapshotFallback(error) {
  const now = Date.now();
  if (now - lastSnapshotLogAt < 60_000) return;
  lastSnapshotLogAt = now;
  const generatedAt = Number(SNAPSHOT?.generatedAt ?? 0);
  const reason = isD1QuotaError(error) ? 'D1 免费额度耗尽' : 'D1 不可用';
  console.error(
    `[public-api] ${reason}，回落到 ${generatedAt ? new Date(generatedAt).toISOString() : '未知时间'} 的快照`,
    error?.message ?? error,
  );
}

function snapshotMeta() {
  return { degraded: true, snapshotGeneratedAt: Number(SNAPSHOT?.generatedAt ?? 0) };
}

function canonicalSnapshotTag(tag) {
  return SNAPSHOT?.aliases?.[tag] ?? tag;
}

function snapshotItemTags(item) {
  return Array.isArray(item?.tags) ? item.tags : [];
}

function parseSnapshotFilters(url) {
  const params = url.searchParams;
  const sort = parseSort(params.get('sort'));
  const limit = parseLimit(params.get('limit'), { def: 24, max: 100 });
  const kind = params.get('kind') ? cleanEnum(params.get('kind'), 'kind', KINDS) : null;
  const category = params.get('category')?.trim() || null;
  if (category && category.length > 80) throw badRequest('category 参数过长');
  const featuredOnly = params.get('featured') === '1' || params.get('featured') === 'true';
  const like = likePattern(params.get('q'));
  const tagRaw = params.get('tag')?.trim().replace(/[%_\\"]/g, '') ?? '';
  const tagFilter = parseTagFilter(tagRaw);
  const aspect = parseAspect(params.get('aspect'));
  const license = parseLicense(params.get('license'));
  const subtag = String(params.get('subtag') ?? '').replace(/[%_\\]/g, '').trim().slice(0, 40) || null;
  const range = (name, extra = {}) => parseOptionalInt(params.get(name), name, extra);
  const pageParam = params.get('page');
  const paged = pageParam !== null && pageParam !== '';
  const page = paged ? parsePage(pageParam) : 1;
  return {
    params,
    sort,
    limit,
    kind,
    category,
    featuredOnly,
    like,
    tagRaw,
    tagFilter,
    aspect,
    license,
    subtag,
    paged,
    page,
    offset: paged ? (page - 1) * limit : 0,
    cursor: paged ? null : normalizeCursor(decodeCursor(params.get('cursor')), sort),
    minWidth: range('minWidth', { max: 100000 }),
    maxWidth: range('maxWidth', { max: 100000 }),
    minHeight: range('minHeight', { max: 100000 }),
    maxHeight: range('maxHeight', { max: 100000 }),
    minDurationMs: range('minDurationMs', { max: 86400000 }),
    maxDurationMs: range('maxDurationMs', { max: 86400000 }),
    minBytes: range('minBytes', { max: Number.MAX_SAFE_INTEGER }),
    maxBytes: range('maxBytes', { max: Number.MAX_SAFE_INTEGER }),
    fpsMax: parseOptionalInt(params.get('fpsMax'), 'fpsMax', { min: 1, max: 1000 }),
    playable: parsePlayable(params.get('playable')),
    audio: parseAudio(params.get('audio')),
  };
}

/** 原画本身是否在 1920×1080@30 内（与原 SQL 的 original 分支同义）。 */
function snapshotOriginalPlayable(item) {
  const width = Number(item?.width);
  const height = Number(item?.height);
  const fps = Number(item?.fps);
  return Number.isFinite(width) && Number.isFinite(height)
    && item?.fps !== null && item?.fps !== undefined
    && Number.isFinite(fps)
    && width <= 1920 && height <= 1080 && fps <= 30;
}

function snapshotPlayable(item, mode) {
  if (snapshotOriginalPlayable(item)) return true;
  if (mode !== '1080p30') return false;
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  return variants.some((variant) => {
    const width = Number(variant?.width);
    const height = Number(variant?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width > 1920 || height > 1080) return false;
    return variant?.fps === null || variant?.fps === undefined || Number(variant.fps) <= 30;
  });
}

function snapshotItemMatches(item, filters) {
  if (filters.category && item?.category?.slug !== filters.category) return false;
  if (filters.kind && item?.kind !== filters.kind) return false;
  if (filters.featuredOnly && item?.featured !== true) return false;

  if (filters.like) {
    const needle = String(filters.like).slice(1, -1).toLowerCase();
    if (!String(item?.title ?? '').toLowerCase().includes(needle)) return false;
  }

  if (filters.tagFilter.values.length) {
    const tags = snapshotItemTags(item).map(canonicalSnapshotTag);
    if (!filters.tagFilter.values.some((value) => tags.includes(value))) return false;
  }

  if (filters.subtag && item?.subtag !== filters.subtag) return false;

  if (filters.aspect !== null) {
    const width = Number(item?.width);
    const height = Number(item?.height);
    if (!(width > 0 && height > 0)) return false;
    if (Math.abs(width / height - filters.aspect) >= ASPECT_TOLERANCE) return false;
  }

  if (filters.license && String(item?.license ?? '').toLowerCase() !== filters.license) return false;

  // 数值筛选：列值为 NULL 的条目不匹配（与 SQL `w.width >= ?` 的 NULL 语义一致）。
  const within = (value, min, max) => {
    if (value === null || value === undefined) return false;
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (min !== null && n < min) return false;
    if (max !== null && n > max) return false;
    return true;
  };
  if (filters.minWidth !== null && !within(item?.width, filters.minWidth, null)) return false;
  if (filters.maxWidth !== null && !within(item?.width, null, filters.maxWidth)) return false;
  if (filters.minHeight !== null && !within(item?.height, filters.minHeight, null)) return false;
  if (filters.maxHeight !== null && !within(item?.height, null, filters.maxHeight)) return false;
  if (filters.minDurationMs !== null && !within(item?.durationMs, filters.minDurationMs, null)) return false;
  if (filters.maxDurationMs !== null && !within(item?.durationMs, null, filters.maxDurationMs)) return false;
  if (filters.minBytes !== null && !within(item?.bytes, filters.minBytes, null)) return false;
  if (filters.maxBytes !== null && !within(item?.bytes, null, filters.maxBytes)) return false;
  if (filters.fpsMax !== null) {
    if (item?.fps === null || item?.fps === undefined) return false;
    if (!Number.isFinite(Number(item.fps)) || Number(item.fps) > filters.fpsMax) return false;
  }
  if (filters.audio !== null && item?.hasAudio !== (filters.audio === 1)) return false;
  if (filters.playable && !snapshotPlayable(item, filters.playable)) return false;

  return true;
}

function snapshotCursorKey(sort, item) {
  switch (sort) {
    case 'name':
      return String(item?.title ?? '');
    case 'size':
      return Number(item?.bytes ?? 0);
    case 'resolution':
      return Number(item?.width ?? 0) * Number(item?.height ?? 0);
    case 'oldest':
    case 'recent':
    default:
      return Number(item?.publishedAt ?? item?.createdAt ?? 0);
  }
}

function snapshotCompare(a, b, sort) {
  const aId = String(a?.id ?? '');
  const bId = String(b?.id ?? '');
  const byIdAsc = aId < bId ? -1 : aId > bId ? 1 : 0;
  const byIdDesc = -byIdAsc;
  if (sort === 'name') {
    const an = String(a?.title ?? '').toLowerCase();
    const bn = String(b?.title ?? '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : byIdAsc;
  }
  if (sort === 'oldest') {
    const delta = snapshotCursorKey(sort, a) - snapshotCursorKey(sort, b);
    return delta || byIdAsc;
  }
  if (sort === 'size') {
    const delta = Number(b?.bytes ?? 0) - Number(a?.bytes ?? 0);
    return delta || byIdDesc;
  }
  if (sort === 'resolution') {
    const delta = snapshotCursorKey(sort, b) - snapshotCursorKey(sort, a);
    return delta || byIdDesc;
  }
  const delta = snapshotCursorKey('recent', b) - snapshotCursorKey('recent', a);
  return delta || byIdDesc;
}

function snapshotAfterCursor(item, sort, cursor) {
  const key = snapshotCursorKey(sort, item);
  if (sort === 'name') {
    const a = String(key).toLowerCase();
    const b = String(cursor.key ?? '').toLowerCase();
    return a > b || (a === b && String(item.id) > cursor.id);
  }
  if (sort === 'oldest') return key > cursor.key || (key === cursor.key && String(item.id) > cursor.id);
  return key < cursor.key || (key === cursor.key && String(item.id) < cursor.id);
}

function snapshotFacets(items) {
  const categories = new Map();
  const tags = new Map();
  const subtags = new Map();
  for (const item of items) {
    if (item?.category?.id) {
      const current = categories.get(item.category.id) ?? {
        id: item.category.id,
        slug: item.category.slug ?? null,
        name: item.category.name ?? null,
        count: 0,
      };
      current.count += 1;
      categories.set(item.category.id, current);
    }
    for (const raw of snapshotItemTags(item)) {
      const name = canonicalSnapshotTag(raw);
      if (typeof name === 'string' && name) tags.set(name, (tags.get(name) ?? 0) + 1);
    }
    if (typeof item?.subtag === 'string' && item.subtag) {
      subtags.set(item.subtag, (subtags.get(item.subtag) ?? 0) + 1);
    }
  }
  const byName = (a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  const byCount = (a, b) => b.count - a.count || byName(a, b);
  return {
    categories: [...categories.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tags: [...tags].map(([name, count]) => ({ name, count })).sort(byCount).slice(0, FACET_LIMIT),
    subtags: [...subtags].map(([name, count]) => ({ name, count })).sort(byCount).slice(0, FACET_LIMIT),
  };
}

function snapshotWallpapersPayload({ url }) {
  const filters = parseSnapshotFilters(url);
  const filtered = SNAPSHOT.items.filter((item) => snapshotItemMatches(item, filters));
  const total = filtered.length;
  const facets = snapshotFacets(filtered);
  const sorted = [...filtered].sort((a, b) => snapshotCompare(a, b, filters.sort));

  let items;
  let hasMore;
  let nextCursor = null;
  if (filters.paged) {
    items = sorted.slice(filters.offset, filters.offset + filters.limit);
    hasMore = filters.offset + items.length < total;
  } else {
    const remaining = filters.cursor ? sorted.filter((item) => snapshotAfterCursor(item, filters.sort, filters.cursor)) : sorted;
    items = remaining.slice(0, filters.limit);
    hasMore = remaining.length > filters.limit;
    if (items.length && hasMore) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor({ t: snapshotCursorKey(filters.sort, last), i: last.id });
    }
  }

  return {
    ok: true,
    data: {
      items,
      total,
      hasMore,
      nextCursor,
      page: filters.paged ? filters.page : null,
      pageSize: filters.limit,
      pageCount: Math.max(1, Math.ceil(total / filters.limit)),
      offset: filters.offset,
      sort: filters.sort,
      filters: {
        category: filters.category,
        kind: filters.kind,
        tag: filters.tagRaw || null,
        aspect: filters.params.get('aspect') ?? null,
      },
      facets,
      ...snapshotMeta(),
    },
  };
}

function snapshotCategoriesPayload() {
  return { categories: SNAPSHOT.categories, ...snapshotMeta() };
}

function snapshotTagsPayload({ url }) {
  const slug = String(url.searchParams.get('category') ?? '').trim().slice(0, 80);
  let tags = SNAPSHOT.tags?.tags ?? [];
  if (slug) {
    const category = (SNAPSHOT.categories ?? []).find((item) => item.slug === slug);
    tags = category ? tags.filter((item) => item.categoryId === null || item.categoryId === undefined || item.categoryId === category.id) : [];
  }
  return {
    tags,
    aspects: SNAPSHOT.tags?.aspects ?? ASPECTS.map((item) => item.key),
    kinds: SNAPSHOT.tags?.kinds ?? KINDS,
    ...snapshotMeta(),
  };
}

function snapshotSubtagsPayload({ url }) {
  const category = String(url.searchParams.get('category') ?? '').trim() || null;
  const tagFilter = parseTagFilter(String(url.searchParams.get('tag') ?? ''));
  // 无筛选时直接给 D1 导出的原始结果（含「已发布 + 有文件」的 118 条口径）；
  // 带筛选时才按快照条目重算，保证不把别的分类/标签的子标签混进来。
  if (!category && !tagFilter.values.length) {
    return { subtags: SNAPSHOT.subtags ?? [], ...snapshotMeta() };
  }
  const filtered = SNAPSHOT.items.filter((item) => {
    if (category && item?.category?.slug !== category) return false;
    if (tagFilter.values.length) {
      const tags = snapshotItemTags(item).map(canonicalSnapshotTag);
      if (!tagFilter.values.some((value) => tags.includes(value))) return false;
    }
    return true;
  });
  const counts = new Map();
  for (const item of filtered) {
    if (typeof item?.subtag === 'string' && item.subtag) counts.set(item.subtag, (counts.get(item.subtag) ?? 0) + 1);
  }
  const subtags = [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { subtags, ...snapshotMeta() };
}

function snapshotWallpaperPayload({ params }) {
  const item = (SNAPSHOT.items ?? []).find((row) => row.slug === params.slug);
  if (!item) throw notFound('壁纸不存在或尚未发布');
  return { wallpaper: item, ...snapshotMeta() };
}

function snapshotManifestPayload() {
  return { ...SNAPSHOT.manifest, ...snapshotMeta() };
}

function fallbackOrThrow(error, env, build) {
  if (!shouldFallback(error, env)) throw error;
  noteSnapshotFallback(error);
  return build();
}

/**
 * 聚合行 → facets。
 * 三种 facet 共用一条 SQL（UNION ALL），路由这里只做分桶、排序和 50 条上限，
 * 所以「按条件统计」的语义全在 SQL 里，JS 不会和 SQL 各算一套。
 */
export function facetsFromRows(rows) {
  const categories = [];
  const tags = [];
  const subtags = [];
  for (const row of rows) {
    const count = Number(row?.n ?? 0);
    if (!(count > 0)) continue;
    if (row.facet === 'category') {
      if (!row.id) continue;
      categories.push({ id: row.id, slug: row.slug ?? null, name: row.name ?? null, count });
    } else if (row.facet === 'tag') {
      if (typeof row.value === 'string' && row.value) tags.push({ name: row.value, count });
    } else if (row.facet === 'subtag') {
      if (typeof row.value === 'string' && row.value) subtags.push({ name: row.value, count });
    }
  }
  // 排序用码位比较（不依赖 ICU/locale），保证不同运行环境下同一份数据顺序一致
  const byName = (a, b) => (String(a.name ?? '') < String(b.name ?? '') ? -1 : String(a.name ?? '') > String(b.name ?? '') ? 1 : 0);
  const byCount = (a, b) => b.count - a.count || byName(a, b);
  // 分类按 count 降序，同数按 id 升序：面板计数是按 id 取的，顺序只需稳定
  categories.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  tags.sort(byCount);
  subtags.sort(byCount);
  return {
    categories,
    tags: tags.slice(0, FACET_LIMIT),
    subtags: subtags.slice(0, FACET_LIMIT),
  };
}

async function liveCategoriesPayload(env) {
  const rows = await all(env, Q.listPublicCategories);
  return { categories: rows.map(categoryDto) };
}

export async function categoriesPayload(env) {
  try {
    return await liveCategoriesPayload(env);
  } catch (error) {
    return fallbackOrThrow(error, env, snapshotCategoriesPayload);
  }
}

/**
 * 公开清单（v1 与旧路径共用）。
 *
 * 参数顺序 = SQL 占位符顺序，**前 11 个是历史位置，永远不能挪**：
 *   ?1 category、?2 kind、?3 q、?4 featured、?5/?6 游标、?7 limit、?8 tag、?9 aspect、
 *   ?10 offset、?11 subtag，之后才是新增筛选（?12 license …）。
 * tests/app.test.js 直接断言 args[6] / args[9] 的语义，所以这里追加而不是重排。
 */
async function liveWallpapersPayload({ env, url }) {
  const params = url.searchParams;
  const sort = parseSort(params.get('sort'));
  const limit = parseLimit(params.get('limit'), { def: 24, max: 100 });
  const kind = params.get('kind') ? cleanEnum(params.get('kind'), 'kind', KINDS) : null;
  const category = params.get('category')?.trim() || null;
  if (category && category.length > 80) throw badRequest('category 参数过长');
  const featuredOnly = params.get('featured') === '1' || params.get('featured') === 'true' ? 1 : 0;
  const like = likePattern(params.get('q'));
  // 标签：可多值（逗号分隔，OR）；`filters.tag` 仍然回显清洗后的原始字符串，字段语义不变。
  const tagRaw = params.get('tag')?.trim().replace(/[%_\\"]/g, '') ?? '';
  const tagFilter = parseTagFilter(tagRaw);
  const aspect = parseAspect(params.get('aspect'));
  const license = parseLicense(params.get('license'));

  // page 是给「1 2 3 4」这种页码翻页用的；cursor 继续服务无限滚动和插件。
  // 同时传时以 page 为准，免得两个分页模型各算各的 offset。
  const pageParam = params.get('page');
  const paged = pageParam !== null && pageParam !== '';
  const page = paged ? parsePage(pageParam) : 1;
  const offset = paged ? (page - 1) * limit : 0;

  const cursor = paged ? null : normalizeCursor(decodeCursor(params.get('cursor')), sort);
  const cursorKey = cursor ? cursor.key : null;
  const cursorId = cursor ? cursor.id : null;

  const sql = PUBLIC_LIST_BY_SORT[sort];
  if (!sql) throw badRequest('不支持的排序方式');

  const subtag = String(params.get('subtag') ?? '').replace(/[%_\\]/g, '').trim().slice(0, 40) || null;

  // ---- 第二期筛选：尺寸 / 时长 / 体积 / 帧率上限 / 可播档位 / 音轨 ----------------
  // 全部走 parseOptionalInt：非法值 400（不静默忽略），缺省 null（不过滤）。
  const range = (name, extra = {}) => parseOptionalInt(params.get(name), name, extra);
  const minWidth = range('minWidth', { max: 100000 });
  const maxWidth = range('maxWidth', { max: 100000 });
  const minHeight = range('minHeight', { max: 100000 });
  const maxHeight = range('maxHeight', { max: 100000 });
  const minDurationMs = range('minDurationMs', { max: 86400000 });
  const maxDurationMs = range('maxDurationMs', { max: 86400000 });
  const minBytes = range('minBytes', { max: Number.MAX_SAFE_INTEGER });
  const maxBytes = range('maxBytes', { max: Number.MAX_SAFE_INTEGER });
  const fpsMax = parseOptionalInt(params.get('fpsMax'), 'fpsMax', { min: 1, max: 1000 });
  const playable = parsePlayable(params.get('playable'));
  const audio = parseAudio(params.get('audio'));

  const rows = await all(
    env, sql,
    category, kind, like, featuredOnly, cursorKey, cursorId, limit + 1, tagFilter.json, aspect, offset, subtag,
    license, minWidth, maxWidth, minHeight, maxHeight, minDurationMs, maxDurationMs, minBytes, maxBytes,
    fpsMax, playable, audio,
  );
  const total = Number((await first(
    env, Q.publicCount,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag, license,
    minWidth, maxWidth, minHeight, maxHeight, minDurationMs, maxDurationMs, minBytes, maxBytes,
    fpsMax, playable, audio,
  ))?.n ?? 0);
  // 面板数据：一次聚合查询，条件与上面的清单完全一致（分页参数不参与，facets 永远针对整个筛选结果）。
  const facets = facetsFromRows(await all(
    env, PUBLIC_FACETS,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag, license,
    minWidth, maxWidth, minHeight, maxHeight, minDurationMs, maxDurationMs, minBytes, maxBytes,
    fpsMax, playable, audio,
  ));
  const items = rows.slice(0, limit);
  const hasMore = paged ? offset + items.length < total : rows.length > limit;

  return {
    ok: true,
    data: {
      items: items.map((row) => wallpaperDto(row, { mediaBase: mediaBaseFor(env) })),
      total,
      hasMore,
      nextCursor: !paged && items.length && hasMore ? cursorForSort(sort, items[items.length - 1]) : null,
      page: paged ? page : null,
      pageSize: limit,
      pageCount: Math.max(1, Math.ceil(total / limit)),
      offset,
      sort,
      // 老字段原样保留（只有这四个键）：新筛选参数不回显，避免老客户端 deepEqual 崩掉
      filters: { category, kind, tag: tagRaw || null, aspect: params.get('aspect') ?? null },
      // 纯增量字段：老客户端忽略即可。三个数组都只含 count > 0 的项。
      facets,
    },
  };
}

export async function wallpapersPayload(ctx) {
  try {
    return await liveWallpapersPayload(ctx);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => snapshotWallpapersPayload(ctx));
  }
}

async function liveSubtagsPayload({ env, url }) {
  const category = url.searchParams.get('category')?.trim() || null;
  const tagFilter = parseTagFilter(url.searchParams.get('tag') ?? '');
  const rows = await all(env, PUBLIC_SUBTAGS, category, tagFilter.json);
  return { subtags: rows.map((row) => ({ name: row.name, count: Number(row.n) })) };
}

export async function subtagsPayload(ctx) {
  try {
    return await liveSubtagsPayload(ctx);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => snapshotSubtagsPayload(ctx));
  }
}

/**
 * 标签列表。带上 ?category=<slug> 时只返回「全局标签 + 该分类专属标签」，
 * 前台筛选栏跟着当前模块走；不带就返回全部（后台选标签时用）。
 */
async function liveTagsPayload({ env, url }) {
  const slug = String(url.searchParams.get('category') ?? '').trim().slice(0, 80);
  let tagRows;
  if (slug) {
    const category = await first(env, Q.categoryBySlug, slug);
    tagRows = category ? await all(env, Q.listTagsForCategory, category.id) : [];
  } else {
    tagRows = await all(env, Q.listTags);
  }
  const countRows = await all(env, Q.publicTags);
  const counts = new Map(countRows.map((row) => [row.tag, Number(row.n ?? 0)]));
  return {
    tags: tagRows.map((row) => ({
      tag: row.name,
      count: counts.get(row.name) ?? 0,
      categoryId: row.category_id ?? null,
    })),
    aspects: ASPECTS.map((item) => item.key),
    kinds: KINDS,
  };
}

export async function tagsPayload(ctx) {
  try {
    return await liveTagsPayload(ctx);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => snapshotTagsPayload(ctx));
  }
}

async function liveWallpaperPayload({ env, params }) {
  const row = await first(env, Q.publicBySlug, params.slug);
  if (!row) throw notFound('壁纸不存在或尚未发布');
  return { wallpaper: wallpaperDto(row, { mediaBase: mediaBaseFor(env) }) };
}

export async function wallpaperPayload(ctx) {
  try {
    return await liveWallpaperPayload(ctx);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => snapshotWallpaperPayload(ctx));
  }
}

/**
 * manifest 条目：只放「客户端同步 + 校验」需要的字段。
 *
 * `variants` 复用公开 DTO 的 `variantsDto()`（同样的 label/width/fps/排序规则），
 * 所以同一档位在列表、详情、manifest 三处的描述永远一致。
 */
export function manifestItem(row, mediaBase = '') {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    url: publicUrl(row.storage_key, mediaBase),
    bytes: Number(row.bytes ?? 0),
    sha256: row.sha256 ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    fps: row.fps === null || row.fps === undefined || row.fps === '' ? null : Number(row.fps),
    variants: variantsDto(row, mediaBase),
    posterUrl: publicUrl(row.poster_key, mediaBase),
    tags: safeJsonArray(row.tags, []),
    license: row.license ?? null,
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * manifest 快照的数据部分（HTTP 层负责 ETag/304，见 routes/public-v1.js）。
 *
 * `generatedAt` 取 **D1 里公开集合最新的 `updated_at`**（单独一条 MAX 查询），
 * 而不是「这批 items 的最大值」或「请求时间」：
 *   - 与请求时间脱钩 ⇒ 同一份数据反复取 generatedAt 不变；
 *   - 与 LIMIT 1000 脱钩 ⇒ 条目数超限时仍然代表整库数据版本；
 *   - 空库时给 0（而不是 NaN / null）。
 * 客户端据此判断「有没有新内容」，配合 ETag 可以完全避免无变化时的全量传输。
 */
async function liveManifestPayload(env) {
  const rows = await all(env, Q.publicManifest);
  const maxUpdated = Number((await first(env, Q.publicMaxUpdatedAt))?.n ?? 0);
  const mediaBase = mediaBaseFor(env);
  const items = rows.map((row) => manifestItem(row, mediaBase));
  const fromRows = rows.reduce((max, row) => Math.max(max, Number(row.updated_at ?? 0)), 0);
  // 兜底：查询没给值（老库/假环境）时退回这批 items 的最大值，绝不返回 NaN
  const generatedAt = maxUpdated > 0 ? maxUpdated : fromRows;
  return { apiVersion: 'v1', generatedAt, total: items.length, items };
}

export async function manifestPayload(env) {
  try {
    return await liveManifestPayload(env);
  } catch (error) {
    return fallbackOrThrow(error, env, snapshotManifestPayload);
  }
}
