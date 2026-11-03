/**
 * 「喜欢」按账号存 D1（之前只在浏览器 localStorage，换设备就丢，后台也筛不出来）。
 *
 *   GET    /api/likes           我的喜欢（slug + 所属分类）
 *   PUT    /api/likes/:slug     喜欢
 *   DELETE /api/likes/:slug     取消喜欢
 *
 * 站点只对登录成员开放，这里不再加额外权限点：登录即代表「自己的喜欢」。
 */
import { Q } from '../queries.js';
import { all, first, run } from '../db.js';
import { nowMs } from '../db.js';
import { cleanText } from '../../core/validate.js';
import { json } from '../http.js';
import { notFound } from '../../core/errors.js';

async function wallpaperBySlug(env, rawSlug) {
  const slug = cleanText(String(rawSlug ?? ''), 'slug', { min: 1, max: 120 });
  const row = await first(env, Q.wallpaperBySlug, slug);
  if (!row) throw notFound('壁纸不存在');
  return row;
}

export async function list({ env, actor }) {
  const rows = await all(env, Q.likesForUser, actor.id);
  return json({
    likes: rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      categorySlug: row.category_slug ?? null,
      createdAt: Number(row.created_at ?? 0),
    })),
  });
}

export async function add({ env, actor, params }) {
  const row = await wallpaperBySlug(env, params.slug);
  await run(env, Q.insertLike, actor.id, row.id, nowMs());
  return json({ liked: true, slug: row.slug });
}

export async function remove({ env, actor, params }) {
  const row = await wallpaperBySlug(env, params.slug);
  await run(env, Q.deleteLike, actor.id, row.id);
  return json({ liked: false, slug: row.slug });
}
