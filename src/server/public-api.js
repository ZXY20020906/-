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
import { all, first } from './db.js';
import { PUBLIC_FACETS, PUBLIC_LIST_BY_SORT, PUBLIC_SUBTAGS, Q } from './queries.js';
import { cursorForSort, decodeCursor, normalizeCursor } from '../core/pagination.js';
import { cleanEnum, parseLimit, parsePage, parseSort } from '../core/validate.js';
import { KINDS } from '../core/validate.js';
import { ASPECTS, parseAspect } from '../core/aspects.js';
import { badRequest, notFound } from '../core/errors.js';
import { mediaBaseFor, publicUrl } from './storage.js';
import { safeJsonArray } from './util.js';
import { categoryDto, variantsDto, wallpaperDto } from './dto.js';

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
    if (!values.includes(value)) values.push(value);
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

/** 数值筛选参数：缺省 → null；非数字/越界 → 400（不静默忽略）。 */
export function parseOptionalInt(raw, name, { min = 0, max = 1e12 } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${name} 必须是 ${min}~${max} 之间的数字`);
  }
  return Math.trunc(n);
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

export async function categoriesPayload(env) {
  const rows = await all(env, Q.listPublicCategories);
  return { categories: rows.map(categoryDto) };
}

/**
 * 公开清单（v1 与旧路径共用）。
 *
 * 参数顺序 = SQL 占位符顺序，**前 11 个是历史位置，永远不能挪**：
 *   ?1 category、?2 kind、?3 q、?4 featured、?5/?6 游标、?7 limit、?8 tag、?9 aspect、
 *   ?10 offset、?11 subtag，之后才是新增筛选（?12 license …）。
 * tests/app.test.js 直接断言 args[6] / args[9] 的语义，所以这里追加而不是重排。
 */
export async function wallpapersPayload({ env, url }) {
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
  const rows = await all(
    env, sql,
    category, kind, like, featuredOnly, cursorKey, cursorId, limit + 1, tagFilter.json, aspect, offset, subtag,
    license,
  );
  const total = Number((await first(
    env, Q.publicCount,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag, license,
  ))?.n ?? 0);
  // 面板数据：一次聚合查询，条件与上面的清单完全一致（分页参数不参与，facets 永远针对整个筛选结果）。
  const facets = facetsFromRows(await all(
    env, PUBLIC_FACETS,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag, license,
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

export async function subtagsPayload({ env, url }) {
  const category = url.searchParams.get('category')?.trim() || null;
  const tagFilter = parseTagFilter(url.searchParams.get('tag') ?? '');
  const rows = await all(env, PUBLIC_SUBTAGS, category, tagFilter.json);
  return { subtags: rows.map((row) => ({ name: row.name, count: Number(row.n) })) };
}

/**
 * 标签列表。带上 ?category=<slug> 时只返回「全局标签 + 该分类专属标签」，
 * 前台筛选栏跟着当前模块走；不带就返回全部（后台选标签时用）。
 */
export async function tagsPayload({ env, url }) {
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

export async function wallpaperPayload({ env, params }) {
  const row = await first(env, Q.publicBySlug, params.slug);
  if (!row) throw notFound('壁纸不存在或尚未发布');
  return { wallpaper: wallpaperDto(row, { mediaBase: mediaBaseFor(env) }) };
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
 * `generatedAt` 取**这批条目里最新的 updated_at**：它是数据自身的版本号，
 * 不是「这次请求的时间」。这样同一份数据无论什么时候取，generatedAt 都不变，
 * 客户端可以放心地拿它判断「有没有新内容」。
 */
export async function manifestPayload(env) {
  const rows = await all(env, Q.publicManifest);
  const mediaBase = mediaBaseFor(env);
  const items = rows.map((row) => manifestItem(row, mediaBase));
  const generatedAt = rows.reduce((max, row) => Math.max(max, Number(row.updated_at ?? 0)), 0);
  return { apiVersion: 'v1', generatedAt, total: items.length, items };
}
