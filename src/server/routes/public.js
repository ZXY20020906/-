/**
 * 公开只读接口（给前台壁纸库用，无需登录）：
 *   GET /api/public/categories
 *   GET /api/public/tags?category=
 *   GET /api/public/subtags?category=&tag=
 *   GET /api/public/wallpapers?category=&kind=&q=&sort=&featured=1&tag=&aspect=&subtag=&page=&cursor=&limit=
 *   GET /api/public/wallpapers/:slug
 */
import { Q } from '../queries.js';
import { PUBLIC_FACETS, PUBLIC_LIST_BY_SORT, PUBLIC_SUBTAGS } from '../queries.js';
import { all, first } from '../db.js';
import { cursorForSort, decodeCursor, normalizeCursor } from '../../core/pagination.js';
import { cleanEnum, parseLimit, parsePage, parseSort } from '../../core/validate.js';
import { KINDS, STATUSES } from '../../core/validate.js';
import { ASPECTS, parseAspect } from '../../core/aspects.js';
import { badRequest, notFound } from '../../core/errors.js';
import { json } from '../http.js';
import { mediaBaseFor, publicUrl } from '../storage.js';
import { sha256Hex } from '../util.js';
import { categoryDto, wallpaperDto } from '../dto.js';

/** 搜索词只保留普通字符，避免 % _ 被当成通配符。 */
function likePattern(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[%_\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return cleaned ? `%${cleaned}%` : null;
}

/** 标签筛选：单个标签名最长 30 字；一次最多 20 个（再多就不像人点的了）。 */
const TAG_VALUE_MAX = 30;
const TAG_MAX_VALUES = 20;

/** facets 里 tags / subtags 最多给多少个（按 count 降序）。 */
const FACET_LIMIT = 50;

/**
 * 解析 `tag` 参数：逗号分隔的多值，语义是 **OR**（命中任意一个标签即算匹配）。
 *
 * 库里的 `wallpapers.tags` 是 JSON 数组文本，所以这里转成 JSON 数组字符串交给
 * `json_each`（见 queries.js 的 tagMatch），一个占位符搞定多值。
 * 单值输入与旧版完全一致：清洗规则（剔掉 `% _ \ "`）、长度上限、`filters.tag` 输出都不变。
 */
function parseTagFilter(raw) {
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
 * 聚合行 → facets。
 * 三种 facet 共用一条 SQL（UNION ALL），路由这里只做分桶、排序和 50 条上限，
 * 所以「按条件统计」的语义全在 SQL 里，JS 不会和 SQL 各算一套。
 */
function facetsFromRows(rows) {
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

export async function listCategories({ env }) {
  const rows = await all(env, Q.listPublicCategories);
  return json({ categories: rows.map(categoryDto) });
}

export async function listWallpapers({ env, url, request }) {
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
  const rows = await all(env, sql, category, kind, like, featuredOnly, cursorKey, cursorId, limit + 1, tagFilter.json, aspect, offset, subtag);
  const total = Number((await first(
    env, Q.publicCount,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag,
  ))?.n ?? 0);
  // 面板数据：一次聚合查询，条件与上面的清单完全一致（分页参数不参与，facets 永远针对整个筛选结果）。
  const facets = facetsFromRows(await all(
    env, PUBLIC_FACETS,
    category, kind, like, featuredOnly, tagFilter.json, aspect, subtag,
  ));
  const items = rows.slice(0, limit);
  const hasMore = paged ? offset + items.length < total : rows.length > limit;

  const payload = {
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
      filters: { category, kind, tag: tagRaw || null, aspect: params.get('aspect') ?? null },
      // 纯增量字段：老客户端忽略即可。三个数组都只含 count > 0 的项。
      facets,
    },
  };

  // 站内和插件都会反复拉这份清单：给 ETag + 短缓存，第二次打开直接 304 / 命中缓存。
  // 只缓存 30 秒，发布/删除最多延迟这么久，比每次重新查库划算。
  const body = JSON.stringify(payload);
  const etag = `"${(await sha256Hex(body)).slice(0, 24)}"`;
  const cacheControl = 'public, max-age=30, stale-while-revalidate=60';
  const normalizeTag = (value) => String(value ?? '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  if (normalizeTag(request.headers.get('if-none-match')) === normalizeTag(etag)) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } });
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      etag,
      'cache-control': cacheControl,
    },
  });
}

/** 前台子标签筛选：按当前分类/标签给出可选子标签（tag 同样支持逗号分隔多值，OR） */
export async function listSubtags({ env, url }) {
  const category = url.searchParams.get('category')?.trim() || null;
  const tagFilter = parseTagFilter(url.searchParams.get('tag') ?? '');
  const rows = await all(env, PUBLIC_SUBTAGS, category, tagFilter.json);
  return json({ subtags: rows.map((row) => ({ name: row.name, count: Number(row.n) })) });
}

/**
 * 标签列表。带上 ?category=<slug> 时只返回「全局标签 + 该分类专属标签」，
 * 前台筛选栏跟着当前模块走；不带就返回全部（后台选标签时用）。
 */
export async function listTags({ env, url }) {
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
  return json({
    tags: tagRows.map((row) => ({
      tag: row.name,
      count: counts.get(row.name) ?? 0,
      categoryId: row.category_id ?? null,
    })),
    aspects: ASPECTS.map((item) => item.key),
    kinds: KINDS,
  });
}

export async function getWallpaper({ env, params }) {
  const row = await first(env, Q.publicBySlug, params.slug);
  if (!row) throw notFound('壁纸不存在或尚未发布');
  return json({ wallpaper: wallpaperDto(row, { mediaBase: mediaBaseFor(env) }) });
}

/**
 * 插件专用清单：/api/plugin/feed
 *
 * 为什么单独做一个，而不是让插件调 /api/public/wallpapers：
 * - 插件只需要「能直接用的东西」；zip 资源包混在里面会被当成视频播，直接解码失败；
 * - 载荷只留必要字段，25 条约 4KB；
 * - 带 ETag，插件可 If-None-Match 轮询，没变化时 304，几乎不耗流量。
 */
export async function pluginFeed({ env, request, url }) {
  const rows = await all(env, Q.pluginFeed);
  const wanted = url.searchParams.get('type') || 'all';

  const items = rows.map((row) => {
    const mime = row.mime ?? '';
    const type = mime.startsWith('video/') ? 'video'
      : mime.startsWith('image/') ? 'image'
        : mime === 'application/zip' ? 'bundle' : 'other';
    const url_ = publicUrl(row.storage_key, mediaBaseFor(env));
    return {
      id: row.id,
      title: row.title,
      type,
      // video / image 可以直接用；bundle 只能下载，得靠 Wallpaper Engine 才能用
      playable: type === 'video' || type === 'image',
      url: url_,
      thumbUrl: publicUrl(row.thumb_key, mediaBaseFor(env)) ?? url_,
      mime,
      bytes: Number(row.bytes ?? 0),
      width: row.width ?? null,
      height: row.height ?? null,
      durationMs: row.duration_ms ?? null,
      updatedAt: Number(row.updated_at ?? 0),
    };
  }).filter((item) => (wanted === 'all' ? true : item.type === wanted));

  const stamp = await sha256Hex(items.map((item) => `${item.id}:${item.updatedAt}`).join('|') || 'empty');
  const etag = `"${stamp.slice(0, 24)}"`;
  const headers = { etag, 'cache-control': 'public, max-age=30' };

  // Cloudflare 会在边缘给 ETag 加 W/ 前缀，比较前必须归一化，否则永远 200
  const normalizeTag = (value) => String(value ?? '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  if (normalizeTag(request.headers.get('if-none-match')) === normalizeTag(etag)) {
    return new Response(null, { status: 304, headers });
  }

  return json({
    version: 1,
    count: items.length,
    counts: {
      video: items.filter((item) => item.type === 'video').length,
      image: items.filter((item) => item.type === 'image').length,
      bundle: items.filter((item) => item.type === 'bundle').length,
    },
    items,
  }, { headers });
}

/** 供后台初始化时探测：是否已初始化、可用排序值等。 */
export async function meta({ env }) {
  const total = Number((await first(env, Q.countUsers))?.n ?? 0);
  return json({
    initialized: total > 0,
    statuses: STATUSES,
    kinds: KINDS,
    sorts: [...Object.keys(PUBLIC_LIST_BY_SORT)],
  });
}
