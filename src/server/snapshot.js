/**
 * 阶段三 · 公开读静态化：**动态快照**（R2）。
 *
 * 和 `public-snapshot.js`（仓库里那份 181KB 的只读 JSON）不是一回事，两条互不替代：
 *
 *   R2 `snapshots/<version>/…` + `current.json`  ← 本文件，**正常路径**
 *   仓库内嵌 `public-snapshot.js`                ← D1 彻底不可用时的最后兜底（降级路径）
 *
 * 读取顺序（`public-api.js`）：
 *   R2 快照 → D1（`degraded: true`）→ 内嵌快照（`degraded: true` + `snapshotGeneratedAt`）
 *
 * 设计要点（对应 `docs/PHASE3-EXECUTION.md` §2）：
 *   · **不写新 SQL**：构建只复用 `queries.js` 里已有的公开查询 + `dto.js` 的 DTO；
 *   · 快照只含「已发布 + 归属公开分类」的条目（A 方案，不给 wallpapers 加列）；
 *   · version = `utcCompact-sha256(wallpapers.json)[0..8]`，内容没变就**不写新对象**；
 *   · 写顺序：先写 `snapshots/<version>/…`，最后覆盖 `current.json`——
 *     任何一步失败，`current.json` 还指向旧版本，线上读到的仍是上一份完整快照。
 *
 * R2 对象的缓存策略：
 *   · `snapshots/**` → `public, max-age=31536000, immutable`（version 里带内容哈希）
 *   · `current.json` → `public, max-age=300`（可变指针，短缓存）
 */
import { all, first } from './db.js';
import { Q, PUBLIC_SUBTAGS } from './queries.js';
import { categoryDto, manifestItemDto, wallpaperDto } from './dto.js';
import { mediaBaseFor } from './storage.js';
import { sha256Hex } from './util.js';
import { ASPECTS } from '../core/aspects.js';
import { KINDS } from '../core/validate.js';
import { buildWallpapersPayload } from './public-filter.js';

/** R2 里的前缀。`snapshots/<version>/{manifest,wallpapers}.json` + 根上的 `current.json`。 */
export const SNAPSHOT_PREFIX = 'snapshots';
export const CURRENT_KEY = 'current.json';

/** 不可变对象的缓存头（版本号里有内容哈希，换内容必换 URL）。 */
export const SNAPSHOT_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** 可变指针的缓存头：5 分钟，与公开接口的既有 TTL 一致。 */
export const CURRENT_CACHE_CONTROL = 'public, max-age=300';

/** 快照里 manifest 条目的上限（与 `Q.publicManifest` 的 LIMIT 1000 对齐）。 */
export const SNAPSHOT_MANIFEST_LIMIT = 1000;

/**
 * 自动重建开关：`env.SNAPSHOT_AUTO === '0'` 关掉。
 *
 * 默认**开**——写操作（上传 / 变体 / 发布 / 编辑）之后自动重建，是「快照与 D1 不一致」
 * 这个最大风险的唯一解法。单测里显式设 `'0'`，避免每个用例都去打 R2。
 */
export function snapshotAutoEnabled(env) {
  return String(env?.SNAPSHOT_AUTO ?? '1') !== '0';
}

/** `20261106T131500Z`：紧凑 UTC 时间戳，用于人工辨认版本新旧。 */
export function utcCompact(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function bucketOf(env) {
  const bucket = env?.BUCKET;
  // 假桶（部分单测 / 老环境）没有 get：当作「没有快照」，回落到 D1，绝不 500。
  if (!bucket || typeof bucket.get !== 'function') return null;
  return bucket;
}

/**
 * 读一个 JSON 对象。真实 R2 对象有 `.json()`，测试里的假桶可能只有 `.text()` 或字节。
 * 三种形态都吃，读不到/坏 JSON 一律返回 null（降级，不抛）。
 */
async function readJsonObject(object) {
  if (!object) return null;
  try {
    if (typeof object.json === 'function') return await object.json();
    if (typeof object.text === 'function') {
      const text = await object.text();
      return text ? JSON.parse(text) : null;
    }
    if (typeof object.arrayBuffer === 'function') {
      const buffer = await object.arrayBuffer();
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
    }
    if (object.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(object.body));
  } catch (error) {
    console.warn('[snapshot] 读取快照对象失败（按缺失处理）', error?.message ?? error);
  }
  return null;
}

async function putJson(env, key, value) {
  const bucket = bucketOf(env);
  if (!bucket || typeof bucket.put !== 'function') throw new Error('缺少 R2 绑定 BUCKET');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  await bucket.put(key, body, {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: key === CURRENT_KEY ? CURRENT_CACHE_CONTROL : SNAPSHOT_CACHE_CONTROL,
    },
  });
  return body;
}

/** 当前指针：`{version, generatedAt}`；没有快照时 null。 */
export async function readCurrent(env) {
  const bucket = bucketOf(env);
  if (!bucket) return null;
  const current = await readJsonObject(await bucket.get(CURRENT_KEY));
  if (!current || typeof current.version !== 'string' || !current.version) return null;
  return { version: current.version, generatedAt: Number(current.generatedAt ?? 0) };
}

/**
 * 计算版本号：`<utcCompact>-<sha256(wallpapers.json) 前 8 位>`。
 *
 * **内容不变则版本不变**：先看 `current.json` 指的那一版是不是同一个内容哈希，
 * 是就直接返回原版本号 —— 这样重复重建（定时兜底 / 批量上传）不会产生无意义的新对象，
 * 也不会让客户端白白换一次 ETag。
 *
 * @param {object} env
 * @param {object|string} payload 快照的 `wallpapers.json`（对象或已序列化文本）
 */
export async function computeVersion(env, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hash = (await sha256Hex(body)).slice(0, 8);
  const current = await readCurrent(env);
  if (current && current.version.endsWith(`-${hash}`)) return current.version;
  return `${utcCompact()}-${hash}`;
}

/**
 * 构建快照体。**只读 D1，不写 R2**（`publishSnapshot` 才写）。
 *
 * 产出：
 *   · `wallpapers`：`{version, generatedAt, total, items, categories, tags, subtags, aliases}`
 *     —— items 是 `dto.js` 的公开 DTO，与 `/api/v1/public/wallpapers` 完全同形；
 *   · `manifest`：`{apiVersion, generatedAt, total, items}`，与 `/api/v1/public/manifest.json` 同形；
 *   · `version`：见 `computeVersion()`。
 *
 * 复用关系（**不要在这里新写 SQL**）：
 *   条目      `Q.publicManifest`（PUBLIC_VISIBLE + 公开分类，LIMIT 1000）
 *   generatedAt `Q.publicMaxUpdatedAt`（与 D1 路径同一条查询，所以两边永远相等）
 *   分类      `Q.listPublicCategories` + `categoryDto`
 *   标签      `Q.listTags` / `Q.publicTags`（canonical 计数）
 *   子标签    `PUBLIC_SUBTAGS`（无参口径）
 *   归一表    `Q.listTagAliases`
 */
export async function buildSnapshot(env) {
  const startedAt = Date.now();
  const mediaBase = mediaBaseFor(env);

  const rows = await all(env, Q.publicManifest);
  const maxUpdated = Number((await first(env, Q.publicMaxUpdatedAt))?.n ?? 0);
  const categories = (await all(env, Q.listPublicCategories)).map(categoryDto);
  const tagRows = await all(env, Q.listTags);
  const countRows = await all(env, Q.publicTags);
  const aliasRows = await all(env, Q.listTagAliases);
  const subtagRows = await all(env, PUBLIC_SUBTAGS, null, null);

  const items = rows.map((row) => wallpaperDto(row, { mediaBase }));
  const manifestItems = rows.map((row) => manifestItemDto(row, mediaBase));

  const fromRows = rows.reduce((max, row) => Math.max(max, Number(row.updated_at ?? 0)), 0);
  const generatedAt = maxUpdated > 0 ? maxUpdated : fromRows;

  const counts = new Map(countRows.map((row) => [row.tag, Number(row.n ?? 0)]));
  const tags = {
    tags: tagRows.map((row) => ({
      tag: row.name,
      count: counts.get(row.name) ?? 0,
      categoryId: row.category_id ?? null,
    })),
    aspects: ASPECTS.map((item) => item.key),
    kinds: KINDS,
  };

  const aliases = Object.fromEntries(aliasRows.map((row) => [row.alias, row.canonical]));

  // `core` 才是版本号的哈希对象：version 本身不能参与哈希（否则自我指涉，每次都变）。
  const core = {
    generatedAt,
    total: items.length,
    items,
    categories,
    tags,
    subtags: subtagRows.map((row) => ({ name: row.name, count: Number(row.n ?? 0) })),
    aliases,
  };

  const manifest = {
    apiVersion: 'v1',
    generatedAt,
    total: manifestItems.length,
    items: manifestItems,
  };

  const version = await computeVersion(env, core);

  return {
    version,
    core,
    manifest,
    wallpapers: { version, ...core },
    ms: Date.now() - startedAt,
  };
}

/**
 * 构建 + 发布：写 `snapshots/<version>/{manifest,wallpapers}.json`，最后覆盖 `current.json`。
 *
 * **失败语义**：任何一步抛错，`current.json` 都不会被改写 —— 线上继续读上一版完整快照。
 * 调用方（`ingest.js` 的触发点 / 工具 / 定时任务）只记日志，不阻断主流程。
 *
 * @param {object} env
 * @param {{force?: boolean}} [options] `force: true` 时即使内容没变也写一个新版本（排障用）
 * @returns {Promise<{version: string, wrote: boolean, ms: number, total: number}>}
 */
export async function publishSnapshot(env, { force = false } = {}) {
  const startedAt = Date.now();
  const snapshot = await buildSnapshot(env);
  const current = await readCurrent(env);
  const unchanged = Boolean(current && current.version === snapshot.version);

  if (unchanged && !force) {
    return { version: snapshot.version, wrote: false, ms: Date.now() - startedAt, total: snapshot.core.total };
  }

  // force 且内容没变：保留内容哈希、换一个时间戳前缀 —— 用来验证「切 current.json」这条
  // 链路本身，而不动任何内容（回滚时把 current.json 指回上一版同样只需要一次 put）。
  const hash = snapshot.version.split('-').pop();
  const version = unchanged && force ? `${utcCompact()}-${hash}` : snapshot.version;
  const wallpapers = { ...snapshot.core, version };
  const manifest = { ...snapshot.manifest };
  const generatedAt = Number(wallpapers.generatedAt ?? 0);

  await putJson(env, `${SNAPSHOT_PREFIX}/${version}/manifest.json`, manifest);
  await putJson(env, `${SNAPSHOT_PREFIX}/${version}/wallpapers.json`, wallpapers);
  // 原子切换：只有上面两个对象都写成功，才动这个指针。
  await putJson(env, CURRENT_KEY, { version, generatedAt });

  return { version, wrote: true, ms: Date.now() - startedAt, total: wallpapers.total };
}

/**
 * 读取当前快照：先 `current.json`，再对应版本的两个文件。
 *
 * 任一环节缺失/坏 JSON ⇒ 返回 null（调用方回落到 D1 并标 `degraded`）。
 * 返回 `source: 'snapshot'`，让调用方能区分「静态快照」与「D1 实时」。
 */
export async function readSnapshot(env) {
  const bucket = bucketOf(env);
  if (!bucket) return null;
  const current = await readCurrent(env);
  if (!current) return null;

  const base = `${SNAPSHOT_PREFIX}/${current.version}`;
  const [manifest, wallpapers] = await Promise.all([
    readJsonObject(await bucket.get(`${base}/manifest.json`)),
    readJsonObject(await bucket.get(`${base}/wallpapers.json`)),
  ]);
  // 两个都必须读得到：只有 manifest 或只有 wallpapers 都算「快照坏了」，
  // 老老实实回 D1（⑥ 的验收场景就是手删其中一个对象）。
  if (!manifest || !Array.isArray(wallpapers?.items)) return null;

  return {
    version: current.version,
    generatedAt: Number(wallpapers.generatedAt ?? current.generatedAt ?? 0),
    manifest,
    wallpapers,
    source: 'snapshot',
  };
}

/**
 * 读取快照但**绝不抛**：R2 绑定缺失、对象损坏、权限错都当成「没有快照」。
 * 公开接口在线上不能因为一个快照读失败就 500。
 */
export async function readSnapshotSafe(env) {
  try {
    return await readSnapshot(env);
  } catch (error) {
    console.warn('[snapshot] 读取快照失败，回落 D1', error?.message ?? error);
    return null;
  }
}

/**
 * 便捷包装：快照体 → 公开清单响应（供 `public-api.js` 与测试共用）。
 * 与 `buildWallpapersPayload({url, data})` 是同一份内存实现。
 */
export function snapshotListPayload({ url, snapshot, meta = null }) {
  return buildWallpapersPayload({ url, data: snapshot.wallpapers ?? snapshot, meta });
}

/**
 * **写操作之后的重建入口**：`ingest.js` 的四个触发点与后台编辑/删除都调它。
 *
 * 三条铁律：
 *   1. 默认开（`env.SNAPSHOT_AUTO === '0'` 才关）；
 *   2. 失败只记日志、**绝不向外抛** —— 上传/发布不能因为快照挂了而失败；
 *   3. 内容没变时 `publishSnapshot` 自己会短路（不写 R2、不切 current.json）。
 *
 * @param {object} env
 * @param {string} reason 触发原因（日志里能看出是哪条路径重建的）
 * @param {{force?: boolean}} [options]
 */
export async function rebuildSnapshotQuietly(env, reason = '变更', options = {}) {
  if (!snapshotAutoEnabled(env)) return null;
  try {
    const result = await publishSnapshot(env, options);
    if (result.wrote) {
      console.log(`[snapshot] ${reason} ⇒ 新版本 ${result.version}（${result.total} 条，${result.ms}ms）`);
    }
    return result;
  } catch (error) {
    // 快照构建失败：current.json 仍是旧版本，公开读继续可用（只是内容旧一点）。
    console.error(`[snapshot] ${reason} 后重建快照失败（保留旧 current.json）`, error?.message ?? error);
    return null;
  }
}

let lastBootstrapAt = 0;
const BOOTSTRAP_INTERVAL_MS = 60_000;/**
 * 首次/丢失后的**自愈**：公开读发现没有快照时，借 `ctx.waitUntil` 在后台补一份。
 *
 * 为什么必须挂在 `waitUntil` 上：Workers 在响应返回后可能立刻回收 isolate，
 * fire-and-forget 的异步任务会被静默丢弃。拿不到 `waitUntil`（本地脚本 / 单测）就
 * 什么都不做，由 `tools/build-snapshot.mjs` 或写操作触发兜住。
 *
 * 节流 60s：避免一个坏掉的 R2 在每次请求都触发一轮构建。
 */
export function scheduleSnapshotBootstrap(env, waitUntil) {
  if (typeof waitUntil !== 'function') return false;
  if (!snapshotAutoEnabled(env)) return false;
  const now = Date.now();
  if (now - lastBootstrapAt < BOOTSTRAP_INTERVAL_MS) return false;
  lastBootstrapAt = now;
  const task = publishSnapshot(env)
    .then((result) => {
      console.log('[snapshot] 后台补齐快照', result.version, result.wrote ? 'new' : 'unchanged');
      return result;
    })
    .catch((error) => {
      console.error('[snapshot] 后台补齐快照失败（保留旧 current.json）', error?.message ?? error);
      return null;
    });
  waitUntil(task);
  return true;
}

/** 测试用：清掉自愈节流，避免用例之间互相影响。 */
export function resetSnapshotBootstrapThrottle() {
  lastBootstrapAt = 0;
}
