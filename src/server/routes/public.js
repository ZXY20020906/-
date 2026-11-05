/**
 * 旧路径 `/api/public/*` —— **v1 的兼容壳**。
 *
 * 第一期起，公开读接口只有一份实现（`src/server/public-api.js`），v1 路由在
 * `routes/public-v1.js`。本文件不再自己拼 SQL / DTO，只把旧路径**原样转发**给 v1
 * 同名 handler，所以：
 *   - 字段、分页、ETag、错误码、缓存头与 v1 完全一致（tests/api-v1.test.js 逐字节比对）；
 *   - 以后只改 v1 就不会出现「新版修了、旧版没修」的分叉；
 *   - 老客户端（插件 / 外链）不需要改一行代码。
 *
 * 只剩两个接口是旧路径独有的：`/api/plugin/feed`（插件精简清单）与 `/api/meta`（初始化探测）。
 */
import { Q } from '../queries.js';
import { PUBLIC_LIST_BY_SORT } from '../queries.js';
import { all, first, isD1Unavailable } from '../db.js';
import { json } from '../http.js';
import { mediaBaseFor, publicUrl } from '../storage.js';
import { sha256Hex } from '../util.js';
import { etagMatches } from '../../core/etag.js';
import { KINDS, STATUSES } from '../../core/validate.js';
import { snapshotPluginFeed } from '../public-api.js';
import * as v1 from './public-v1.js';

/** 以下五个是 v1 的兼容转发：签名与返回值完全不变。 */
export const listCategories = (ctx) => v1.listCategories(ctx);
export const listTags = (ctx) => v1.listTags(ctx);
export const listSubtags = (ctx) => v1.listSubtags(ctx);
export const listWallpapers = (ctx) => v1.listWallpapers(ctx);
export const getWallpaper = (ctx) => v1.getWallpaper(ctx);

/**
 * 插件专用清单：/api/plugin/feed
 *
 * 为什么单独做一个，而不是让插件调 /api/public/wallpapers：
 * - 插件只需要「能直接用的东西」；zip 资源包混在里面会被当成视频播，直接解码失败；
 * - 载荷只留必要字段，25 条约 4KB；
 * - 带 ETag，插件可 If-None-Match 轮询，没变化时 304，几乎不耗流量。
 */
export async function pluginFeed({ env, request, url }) {
  const wanted = url.searchParams.get('type') || 'all';
  let items;
  let snapshotMeta = null;
  try {
    const rows = await all(env, Q.pluginFeed);
    items = rows.map((row) => {
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
  } catch (error) {
    if (!isD1Unavailable(error) || env?.PUBLIC_SNAPSHOT_FALLBACK === '0') throw error;
    const fallback = snapshotPluginFeed({ url });
    items = fallback.items;
    snapshotMeta = { degraded: true, snapshotGeneratedAt: fallback.snapshotGeneratedAt };
    console.warn('[plugin-feed] D1 不可用，回落快照', error?.message ?? error);
  }

  const stamp = await sha256Hex(items.map((item) => `${item.id}:${item.updatedAt}`).join('|') || 'empty');
  const etag = `"${stamp.slice(0, 24)}"`;
  const headers = { etag, 'cache-control': 'public, max-age=300, stale-while-revalidate=3600' };

  // Cloudflare 会在边缘给 ETag 加 W/ 前缀，比较前必须归一化，否则永远 200
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
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
    ...(snapshotMeta ?? {}),
  }, { headers });
}

/** 供后台初始化时探测：是否已初始化、可用排序值等。 */
export async function meta({ env }) {
  let initialized = false;
  let degraded = false;
  try {
    const total = Number((await first(env, Q.countUsers))?.n ?? 0);
    initialized = total > 0;
  } catch (error) {
    if (!isD1Unavailable(error) || env?.PUBLIC_SNAPSHOT_FALLBACK === '0') throw error;
    // 快照来自已初始化的生产站。D1 不可用时仍按「已初始化」返回，前台才会继续走
    // 公开接口（它们自己有快照兜底），而不是回退到并不存在的静态 catalog。
    initialized = true;
    degraded = true;
    console.warn('[meta] D1 不可用，按已初始化返回', error?.message ?? error);
  }
  return json({
    initialized,
    statuses: STATUSES,
    kinds: KINDS,
    sorts: [...Object.keys(PUBLIC_LIST_BY_SORT)],
    ...(degraded ? { degraded: true } : {}),
  });
}
