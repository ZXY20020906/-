/**
 * 公开只读接口的**唯一实现**（v1 与旧路径共用）。
 *
 * 为什么拆出这个文件：第一期要求「新版加在 /api/v1/public/*，旧路径内部转发到 v1，
 * 字段与行为完全一致」。如果两个路由文件各写一份逻辑，「完全一致」就只是口头约定——
 * 改一处忘另一处立刻分叉。现在：
 *
 *   routes/public-v1.js  ──┐
 *   routes/public.js（旧） ──┴──► public-api.js（本文件：读取链 + SQL / DTO / 分页）
 *
 * 于是兼容性验证可以退化成一条断言：同一请求分别打旧路径与 v1，响应体逐字节相同
 * （tests/api-v1.test.js 的「旧路径 == v1」用例）。
 *
 * 公开可见性门槛在 queries.js 的 PUBLIC_VISIBLE + PUBLIC_CATEGORY（已发布 + 有文件 +
 * 已验证 + 已审核 + 分类公开），清单 / 计数 / facets 三处同源，不在本文件里另算一遍。
 *
 * ---------------------------------------------------------------------------
 * 阶段三（2026-11）：公开读静态化。读取顺序变成三层：
 *
 *   ① R2 动态快照   `snapshot.js` 的 readSnapshot()，**0 次 D1 行读**
 *        └ 命中：参数在内存里筛（`public-filter.js`，与 SQL 逐条等价）
 *   ② D1 实时查询   上线的老路径，原样保留；响应带 `degraded: true`
 *        └ 快照缺失 / 损坏 / 读失败时走这里
 *   ③ 仓库内嵌快照   `public-snapshot.js`（181KB 只读 JSON，2026-11-05 D1 额度事故的产物）
 *        └ D1 也报了可识别的错（额度耗尽 / 缺表 / 绑定失效）时兜底，带 degraded 标记
 *
 * 三条路径的字段、分页、排序、facets 必须完全一致 —— 对拍见
 * `tests/snapshot-parity.test.js`（16 块），逐条对照见 `docs/PHASE3-PARITY-MAP.md`。
 */
import { all, first, isD1QuotaError, isD1Unavailable } from './db.js';
import { PUBLIC_FACETS, PUBLIC_LIST_BY_SORT, PUBLIC_SUBTAGS, Q } from './queries.js';
import { cursorForSort, decodeCursor, normalizeCursor } from '../core/pagination.js';
import { cleanEnum, parseLimit, parsePage, parseSort } from '../core/validate.js';
import { KINDS } from '../core/validate.js';
import { parseAspect, ASPECTS } from '../core/aspects.js';
import { badRequest, notFound } from '../core/errors.js';
import { mediaBaseFor } from './storage.js';
import { categoryDto, manifestItemDto, wallpaperDto } from './dto.js';
import { SNAPSHOT } from './public-snapshot.js';
import {
  FACET_LIMIT, PLAYABLE, TAG_MAX_VALUES, TAG_VALUE_MAX,
  buildCategoriesPayload, buildSubtagsPayload, buildTagsPayload, buildWallpapersPayload, mergeUncategorized,
  findSnapshotItem, likePattern, parseAudio, parseLicense, parseOptionalInt, parsePlayable,
  parseTagFilter,
} from './public-filter.js';
import { readSnapshotSafe, scheduleSnapshotBootstrap, snapshotAutoEnabled } from './snapshot.js';

/* ------------------------------------------------------------------------- *
 * 参数解析的 re-export
 *
 * 这些函数在第三期搬到了 `public-filter.js`（快照路径与 SQL 路径共用同一份解析，
 * 才能保证「什么算非法、什么算缺省」两边一致）。文件位置变了，导出名一个没变，
 * 老引用（含 tools/ 里的脚本）不需要改。
 * ------------------------------------------------------------------------- */
export {
  FACET_LIMIT, PLAYABLE, TAG_MAX_VALUES, TAG_VALUE_MAX,
  likePattern, parseAudio, parseLicense, parseOptionalInt, parsePlayable, parseTagFilter,
};

/** manifest 条目构造器（第三期搬到 dto.js，供快照构建复用；导出名保持不变）。 */
export const manifestItem = manifestItemDto;

/* ------------------------------------------------------------------------- *
 * 第三层：内嵌快照回落（D1 不可用时）
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
 * 阶段三之后它是**第三层**（第一层是 R2 动态快照，第二层是 D1）。保留不改不删：
 * 它救过一次线上，而且「R2 也读不到」这种情况并非不可能。
 * ------------------------------------------------------------------------- */

let lastSnapshotLogAt = 0;

/** 内嵌快照是否可用（测试里可显式设 PUBLIC_SNAPSHOT_FALLBACK=0 关掉，避免掩盖 SQL bug）。 */
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

/** 内嵌快照的降级标记（与 R2 快照的 `degraded` 区分：这个还带快照生成时间）。 */
function snapshotMeta() {
  return { degraded: true, snapshotGeneratedAt: Number(SNAPSHOT?.generatedAt ?? 0) };
}

/**
 * 走 D1 时给响应打 `degraded: true`。
 *
 * 语义是「这次回答没有走静态快照」。生产环境永远应该走快照，所以出现这个标记就
 * 说明快照缺失/损坏 —— 冒烟脚本据此报警（`--allow-degraded` 才放行）。
 * 单测环境 `SNAPSHOT_AUTO=0`（没打算用快照）时不打这个标记，免得每个用例都被它污染。
 */
function withDegraded(payload, env) {
  if (!snapshotAutoEnabled(env)) return payload;
  if (payload && payload.ok === true && payload.data) {
    return { ...payload, data: { ...payload.data, degraded: true } };
  }
  return { ...payload, degraded: true };
}

function fallbackOrThrow(error, env, build) {
  if (!shouldFallback(error, env)) throw error;
  noteSnapshotFallback(error);
  return build();
}

/** 内嵌快照的四个内存响应（参数、排序、facets 全部复用同一份实现）。 */
function embeddedWallpapersPayload({ url }) {
  return buildWallpapersPayload({ url, data: SNAPSHOT, meta: snapshotMeta() });
}

function embeddedCategoriesPayload() {
  return buildCategoriesPayload({ data: SNAPSHOT, meta: snapshotMeta() });
}

function embeddedTagsPayload({ url }) {
  return buildTagsPayload({ url, data: SNAPSHOT, meta: snapshotMeta() });
}

function embeddedSubtagsPayload({ url }) {
  return buildSubtagsPayload({ url, data: SNAPSHOT, meta: snapshotMeta() });
}

function embeddedWallpaperPayload({ params }) {
  const item = findSnapshotItem(SNAPSHOT, params.slug);
  if (!item) throw notFound('壁纸不存在或尚未发布');
  return { wallpaper: item, ...snapshotMeta() };
}

function embeddedManifestPayload() {
  return { ...SNAPSHOT.manifest, ...snapshotMeta() };
}

/**
 * `/api/plugin/feed` 的快照版本（插件精简清单）。
 *
 * 这个接口不是 v1 契约的一部分，但历史插件版本可能还在用；D1 不可用时同样不能 500。
 * 字段映射与 `routes/public.js` 的 live 版本保持一致（type/playable/thumbUrl/updatedAt）。
 */
export function snapshotPluginFeed({ url }) {
  const wanted = url.searchParams.get('type') || 'all';
  const items = (SNAPSHOT.items ?? []).map((item) => {
    const mime = item.mime ?? '';
    const type = mime.startsWith('video/') ? 'video'
      : mime.startsWith('image/') ? 'image'
        : mime === 'application/zip' ? 'bundle' : 'other';
    return {
      id: item.id,
      title: item.title,
      type,
      playable: type === 'video' || type === 'image',
      url: item.url,
      thumbUrl: item.thumbUrl ?? item.url,
      mime,
      bytes: Number(item.bytes ?? 0),
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.durationMs ?? null,
      updatedAt: Number(item.updatedAt ?? 0),
    };
  }).filter((item) => (wanted === 'all' ? true : item.type === wanted));
  return {
    version: 1,
    count: items.length,
    items,
    counts: {
      video: items.filter((item) => item.type === 'video').length,
      image: items.filter((item) => item.type === 'image').length,
      bundle: items.filter((item) => item.type === 'bundle').length,
    },
    ...snapshotMeta(),
  };
}

/* ------------------------------------------------------------------------- *
 * facets（SQL 路径）
 * ------------------------------------------------------------------------- */

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

/* ------------------------------------------------------------------------- *
 * 分类
 * ------------------------------------------------------------------------- */

async function liveCategoriesPayload(env) {
  const rows = await all(env, Q.listPublicCategories);
  // 与公开列表同源的 total：分类计数对不上时用它补「未分类」桶（见 mergeUncategorized）
  const total = Number((await first(env, Q.countPublicVisible))?.n ?? 0);
  return { categories: mergeUncategorized(rows.map(categoryDto), total) };
}

export async function categoriesPayload(env) {
  const snapshot = await readSnapshotSafe(env);
  if (snapshot) return buildCategoriesPayload({ data: snapshot.wallpapers });
  try {
    return withDegraded(await liveCategoriesPayload(env), env);
  } catch (error) {
    return fallbackOrThrow(error, env, embeddedCategoriesPayload);
  }
}

/* ------------------------------------------------------------------------- *
 * 清单
 * ------------------------------------------------------------------------- */

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

/**
 * 清单：快照优先 → D1 → 内嵌快照。
 *
 * 快照命中时 0 次 D1 行读；只有快照缺失/损坏才回 D1（带 `degraded: true`），
 * 顺手用 `ctx.waitUntil` 在后台补一份快照（自愈，节流 60s）。
 */
export async function wallpapersPayload(ctx) {
  const snapshot = await readSnapshotSafe(ctx.env);
  if (snapshot) return buildWallpapersPayload({ url: ctx.url, data: snapshot.wallpapers });
  scheduleSnapshotBootstrap(ctx.env, ctx.waitUntil);
  try {
    return withDegraded(await liveWallpapersPayload(ctx), ctx.env);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => embeddedWallpapersPayload(ctx));
  }
}

/* ------------------------------------------------------------------------- *
 * 子标签 / 标签
 * ------------------------------------------------------------------------- */

async function liveSubtagsPayload({ env, url }) {
  const category = url.searchParams.get('category')?.trim() || null;
  const tagFilter = parseTagFilter(url.searchParams.get('tag') ?? '');
  const rows = await all(env, PUBLIC_SUBTAGS, category, tagFilter.json);
  return { subtags: rows.map((row) => ({ name: row.name, count: Number(row.n) })) };
}

export async function subtagsPayload(ctx) {
  const snapshot = await readSnapshotSafe(ctx.env);
  if (snapshot) return buildSubtagsPayload({ url: ctx.url, data: snapshot.wallpapers });
  try {
    return withDegraded(await liveSubtagsPayload(ctx), ctx.env);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => embeddedSubtagsPayload(ctx));
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
  const snapshot = await readSnapshotSafe(ctx.env);
  if (snapshot) return buildTagsPayload({ url: ctx.url, data: snapshot.wallpapers });
  try {
    return withDegraded(await liveTagsPayload(ctx), ctx.env);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => embeddedTagsPayload(ctx));
  }
}

/* ------------------------------------------------------------------------- *
 * 详情
 * ------------------------------------------------------------------------- */

async function liveWallpaperPayload({ env, params }) {
  const row = await first(env, Q.publicBySlug, params.slug);
  if (!row) throw notFound('壁纸不存在或尚未发布');
  return { wallpaper: wallpaperDto(row, { mediaBase: mediaBaseFor(env) }) };
}

/**
 * 详情：快照内按 slug 查；未命中才查 D1；都没有 ⇒ 404 not_found。
 *
 * 注意 D1 这条分支同时承担两件事：快照里没有但库里有的条目（快照还没重建），
 * 以及真的不存在的 slug（`publicBySlug` 返回空 ⇒ notFound ⇒ 不触发内嵌快照兜底）。
 */
export async function wallpaperPayload(ctx) {
  const snapshot = await readSnapshotSafe(ctx.env);
  if (snapshot) {
    const item = findSnapshotItem(snapshot.wallpapers, ctx.params.slug);
    if (item) return { wallpaper: item };
  }
  try {
    return withDegraded(await liveWallpaperPayload(ctx), ctx.env);
  } catch (error) {
    return fallbackOrThrow(error, ctx.env, () => embeddedWallpaperPayload(ctx));
  }
}

/* ------------------------------------------------------------------------- *
 * manifest
 * ------------------------------------------------------------------------- */

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
  const items = rows.map((row) => manifestItemDto(row, mediaBase));
  const fromRows = rows.reduce((max, row) => Math.max(max, Number(row.updated_at ?? 0)), 0);
  // 兜底：查询没给值（老库/假环境）时退回这批 items 的最大值，绝不返回 NaN
  const generatedAt = maxUpdated > 0 ? maxUpdated : fromRows;
  return { apiVersion: 'v1', generatedAt, total: items.length, items };
}

export async function manifestPayload(env) {
  const snapshot = await readSnapshotSafe(env);
  if (snapshot?.manifest) return snapshot.manifest;
  try {
    return withDegraded(await liveManifestPayload(env), env);
  } catch (error) {
    return fallbackOrThrow(error, env, embeddedManifestPayload);
  }
}
