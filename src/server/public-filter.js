/**
 * 公开读的**内存实现**（阶段三：快照路径）。
 *
 * 为什么单独一个文件：公开清单现在有两条实现——
 *   · SQL 路径（`queries.js` + D1）
 *   · 内存路径（本文件，跑在从 R2 读回来的静态快照上）
 * 两条路径必须**逐字段等价**，否则切快照那天全站列表会在没有报错的情况下错乱。
 * 对拍见 `tests/snapshot-parity.test.js`（16 块，不一致即红）；逐条对照见
 * `docs/PHASE3-PARITY-MAP.md`。
 *
 * 为什么不是放在 `public-api.js` 里：`snapshot.js`（构建快照、算 facets）也要用这里的
 * 排序/分桶规则，而 `public-api.js` 又要 import `snapshot.js` 去读快照。放进本文件，
 * 两边都只依赖它，不形成环。
 *
 * 本文件**不碰 D1 / R2**，只处理已经拿到内存里的数据对象
 * （结构见 `docs/PHASE3-EXECUTION.md` §2：items 是 `dto.js` 的公开 DTO）。
 */
import { ASPECT_TOLERANCE, ASPECTS, parseAspect } from '../core/aspects.js';
import { badRequest } from '../core/errors.js';
import { decodeCursor, encodeCursor, normalizeCursor } from '../core/pagination.js';
import { normalizeTag } from '../core/tag-vocabulary.js';
import { KINDS, cleanEnum, parseLimit, parsePage, parseSort } from '../core/validate.js';

/** 搜索词只保留普通字符，避免 % _ 被当成通配符。与 SQL 路径共用同一份清洗规则。 */
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
 * 每个值先过 `normalizeTag()`：`anime` → `动漫`，于是「筛 anime」和「筛 动漫」返回同一批
 * （SQL 那边再把库里的 alias 值映射到 canonical）。
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

/**
 * 快照里的 alias → canonical 映射（与 SQL 的 `LEFT JOIN tag_aliases` 同一份数据）。
 * 快照缺这张表时按「原样」处理，不会假装归一。
 */
function canonicalTag(aliases, tag) {
  return aliases?.[tag] ?? tag;
}

function itemTags(item) {
  return Array.isArray(item?.tags) ? item.tags : [];
}

/**
 * URL → 内存筛选条件。**参数解析与 SQL 路径共用同一批 `parse*`**，所以两边
 * 对「什么算非法、什么算缺省」不会各说一套。
 */
export function parseSnapshotFilters(url) {
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

/**
 * 原画本身是否在 1920×1080@30 内（与 SQL 的 original 分支同义）。
 *
 * `IS NOT NULL` 必须显式判：`Number(null)` 是 0，只看 `Number.isFinite` 会把
 * 「宽高未知」当成「0×0 可播」——SQL 那边 `w.width IS NOT NULL` 是不放行的。
 */
function originalPlayable(item) {
  if (item?.width === null || item?.width === undefined) return false;
  if (item?.height === null || item?.height === undefined) return false;
  if (item?.fps === null || item?.fps === undefined) return false;
  const width = Number(item.width);
  const height = Number(item.height);
  const fps = Number(item.fps);
  return Number.isFinite(width) && Number.isFinite(height) && Number.isFinite(fps)
    && width <= 1920 && height <= 1080 && fps <= 30;
}

/**
 * 是否存在一个「≤1920×1080 且 ≤30fps（或 fps 未知）」的变体。
 * 同样显式判 NULL：SQL 是 `json_extract(...,'$.width') IS NOT NULL`。
 */
function variantPlayable(item) {
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  return variants.some((variant) => {
    if (!variant) return false;
    if (variant.width === null || variant.width === undefined) return false;
    if (variant.height === null || variant.height === undefined) return false;
    const width = Number(variant.width);
    const height = Number(variant.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width > 1920 || height > 1080) return false;
    return variant.fps === null || variant.fps === undefined || Number(variant.fps) <= 30;
  });
}

function playableMatches(item, mode) {
  if (originalPlayable(item)) return true;
  if (mode !== '1080p30') return false;
  return variantPlayable(item);
}

/**
 * 单条是否命中筛选条件。逐条对应 `queries.js` 的 `PUBLIC_FILTERS` + `PUBLIC_EXTRA`。
 *
 * 数值筛选的 NULL 语义与 SQL 一致：列值为 NULL（未知）时**不匹配**，不能证明满足就别放行。
 */
export function snapshotItemMatches(item, filters, { aliases = {} } = {}) {
  if (filters.category && item?.category?.slug !== filters.category) return false;
  if (filters.kind && item?.kind !== filters.kind) return false;
  if (filters.featuredOnly && item?.featured !== true) return false;

  if (filters.like) {
    const needle = String(filters.like).slice(1, -1).toLowerCase();
    if (!String(item?.title ?? '').toLowerCase().includes(needle)) return false;
  }

  if (filters.tagFilter.values.length) {
    const tags = itemTags(item).map((tag) => canonicalTag(aliases, tag));
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
  if (filters.playable && !playableMatches(item, filters.playable)) return false;

  return true;
}

/** 排序键：与 `cursorForSort()` / 各条 SQL 的 ORDER BY 逐一对应。 */
export function snapshotCursorKey(sort, item) {
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

/** 比较器：主键升/降 + `id` tie-break，与 SQL 的 `ORDER BY ..., w.id ...` 同向。 */
export function snapshotCompare(a, b, sort) {
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

/** 游标之后：与 SQL 的 `(key < ?5 OR (key = ?5 AND id < ?6))` 同义。 */
export function snapshotAfterCursor(item, sort, cursor) {
  const key = snapshotCursorKey(sort, item);
  if (sort === 'name') {
    const a = String(key).toLowerCase();
    const b = String(cursor.key ?? '').toLowerCase();
    return a > b || (a === b && String(item.id) > cursor.id);
  }
  if (sort === 'oldest') return key > cursor.key || (key === cursor.key && String(item.id) > cursor.id);
  return key < cursor.key || (key === cursor.key && String(item.id) < cursor.id);
}

/**
 * facets：按当前**筛选结果**分桶，与 `PUBLIC_FACETS` 的 CTE 同口径。
 *
 * 三种 facet 都只统计 count ≥ 1 的项；tags 按 canonical 合并；排序规则与
 * `facetsFromRows()` 逐字相同（分类按 count 降序、同数按 id 升序；标签/子标签按
 * count 降序、同数按码位升序），所以两条路径连**数组顺序**都一样。
 */
export function snapshotFacets(items, { aliases = {} } = {}) {
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
    for (const raw of itemTags(item)) {
      const name = canonicalTag(aliases, raw);
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

/**
 * 公开清单的完整响应体（`{ok, data}`）。
 *
 * @param {object} params
 * @param {URL} params.url
 * @param {{items: object[], aliases?: Record<string,string>}} params.data 快照体（R2 或内嵌）
 * @param {object|null} [params.meta] 追加到 data 的降级信息（`degraded` / `snapshotGeneratedAt`）
 */
export function buildWallpapersPayload({ url, data, meta = null }) {
  const aliases = data?.aliases ?? {};
  const filters = parseSnapshotFilters(url);
  const filtered = (data?.items ?? []).filter((item) => snapshotItemMatches(item, filters, { aliases }));
  const total = filtered.length;
  const facets = snapshotFacets(filtered, { aliases });
  const sorted = [...filtered].sort((a, b) => snapshotCompare(a, b, filters.sort));

  let items;
  let hasMore;
  let nextCursor = null;
  if (filters.paged) {
    items = sorted.slice(filters.offset, filters.offset + filters.limit);
    hasMore = filters.offset + items.length < total;
  } else {
    const remaining = filters.cursor
      ? sorted.filter((item) => snapshotAfterCursor(item, filters.sort, filters.cursor))
      : sorted;
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
      ...(meta ?? {}),
    },
  };
}

/**
 * 分类计数补齐「未分类」桶。
 *
 * 公开列表允许 `category_id IS NULL`（见 queries.js 的 PUBLIC_CATEGORY），
 * 这类条目不属于任何分类。如果分类列表不加这一桶，就会出现
 * 「各分类计数之和 < 列表 total」——正是线上那个 122 vs 113 的错觉来源之一。
 *
 * 只有在差额 > 0 时才追加，分类覆盖完整时输出与以前逐字节相同。
 */
export function mergeUncategorized(categories, total) {
  const list = Array.isArray(categories) ? categories : [];
  const countOf = (item) => Number(item?.publishedCount ?? item?.count ?? 0);
  const sum = list.reduce((acc, item) => acc + countOf(item), 0);
  const gap = Number(total) - sum;
  if (!Number.isFinite(gap) || gap <= 0) return list;
  // 形状与 categoryDto 一致（客户端不用为这一项写特例）
  return [...list, {
    id: null,
    slug: 'uncategorized',
    name: '未分类',
    description: '没有归到任何公开分类的条目',
    sortOrder: 9999,
    isPublic: true,
    wallpaperCount: gap,
    publishedCount: gap,
    createdAt: 0,
    updatedAt: 0,
  }];
}

/** 快照里的分类列表（`categoriesPayload` 的内存版）。 */
export function buildCategoriesPayload({ data, meta = null }) {
  const categories = mergeUncategorized(data?.categories, data?.total);
  return { categories, ...(meta ?? {}) };
}

/**
 * 标签列表（`tagsPayload` 的内存版）。
 *
 * 带 `?category=<slug>` 时只返回「全局标签 + 该分类专属标签」；不带就返回全部。
 * 计数一律取快照里的全局 canonical 计数（与 SQL 版一致：计数不分分类）。
 */
export function buildTagsPayload({ url, data, meta = null, aspects = ASPECTS.map((item) => item.key), kinds = KINDS }) {
  const slug = String(url.searchParams.get('category') ?? '').trim().slice(0, 80);
  let tags = data?.tags?.tags ?? [];
  if (slug) {
    const category = (data?.categories ?? []).find((item) => item.slug === slug);
    tags = category
      ? tags.filter((item) => item.categoryId === null || item.categoryId === undefined || item.categoryId === category.id)
      : [];
  }
  return {
    tags,
    aspects: data?.tags?.aspects ?? aspects,
    kinds: data?.tags?.kinds ?? kinds,
    ...(meta ?? {}),
  };
}

/**
 * 子标签列表（`subtagsPayload` 的内存版）。
 *
 * 无筛选时直接给快照里那份 D1 导出的原始结果（`PUBLIC_SUBTAGS` 的口径）；
 * 带筛选时才按快照条目重算，保证不把别的分类/标签的子标签混进来。
 */
export function buildSubtagsPayload({ url, data, meta = null }) {
  const category = String(url.searchParams.get('category') ?? '').trim() || null;
  const tagFilter = parseTagFilter(String(url.searchParams.get('tag') ?? ''));
  if (!category && !tagFilter.values.length) {
    return { subtags: data?.subtags ?? [], ...(meta ?? {}) };
  }
  const aliases = data?.aliases ?? {};
  const filtered = (data?.items ?? []).filter((item) => {
    if (category && item?.category?.slug !== category) return false;
    if (tagFilter.values.length) {
      const tags = itemTags(item).map((tag) => canonicalTag(aliases, tag));
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
  return { subtags, ...(meta ?? {}) };
}

/** 详情（`wallpaperPayload` 的内存版）：快照内按 slug 查。 */
export function findSnapshotItem(data, slug) {
  return (data?.items ?? []).find((row) => row.slug === slug) ?? null;
}

/** 复用给测试/工具：把 facets 里的条目拍平成 `{name: count}`。 */
export function facetCountMap(list) {
  return Object.fromEntries(list.map((item) => [item.name ?? item.id, item.count]));
}
