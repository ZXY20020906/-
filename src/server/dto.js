/**
 * 输出给前端的形状。DB 行 → DTO。
 * storage_key 是内部字段不暴露；sha256 对外输出（插件用它做增量下载判断）。
 */
import { safeJsonParse } from './util.js';
import { publicUrl } from './storage.js';
import { capabilitiesFor, ROLE_LABELS } from '../core/permissions.js';

export function categoryDto(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    sortOrder: Number(row.sort_order ?? 0),
    isPublic: row.is_public === 1 || row.is_public === true,
    wallpaperCount: Number(row.wallpaper_count ?? row.count ?? 0),
    publishedCount: Number(row.published_count ?? row.count ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * 同一条壁纸的降档变体（目前是 1080p）。弱网用户靠它 5 秒出画面：
 * 4K 原画 40–50 MB，1080p 只有 5–8 MB。
 *
 * DB 里 variants 是一列 JSON 文本（D1 迁移见 schema/014）。坏数据一律降级成
 * 空数组 —— 变体是「锦上添花」，绝不能因为一行脏 JSON 让整条壁纸 500。
 * 契约（docs/SITE-DOWNLOAD-API.md §1.1）要求按 bytes 升序、URL 同域，
 * 所以这里统一用 publicUrl 生成，前缀跟着站点配置走。
 */
export function variantsDto(row, mediaBase = '') {
  const raw = safeJsonParse(row?.variants, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && item.key && Number(item.bytes) > 0)
    .map((item) => {
      const height = Number(item.height) || null;
      const bytes = Number(item.bytes);
      return {
        label: height ? `${height}p` : 'alt',
        height,
        bytes,
        sha256: item.sha256 ?? null,
        url: publicUrl(item.key, mediaBase),
      };
    })
    .sort((a, b) => a.bytes - b.bytes);
}

export function wallpaperDto(row, { admin = false, mediaBase = '' } = {}) {
  const fullUrl = publicUrl(row.storage_key, mediaBase);
  // 没有缩略图时，只有原文件本身是图片才拿它顶替；
  // 视频 / zip 绝不能当缩略图返回，否则客户端会把 40MB 的 mp4 当图片去下。
  const assetIsImage = typeof row.mime === 'string' && row.mime.startsWith('image/');
  const thumbUrl = publicUrl(row.thumb_key, mediaBase) ?? (assetIsImage ? fullUrl : null);
  const base = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? '',
    subtag: row.subtag ?? '',
    kind: row.kind,
    mime: row.mime ?? null,
    bytes: Number(row.bytes ?? 0),
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    tags: safeJsonParse(row.tags, []),
    featured: row.featured === 1 || row.featured === true,
    category: row.category_id
      ? { id: row.category_id, slug: row.category_slug ?? null, name: row.category_name ?? null }
      : null,
    url: fullUrl,
    thumbUrl,
    // 降档变体：没有就是空数组，老客户端读不到也不会崩
    variants: variantsDto(row, mediaBase),
    // 给插件做增量同步用：内容哈希 + 更新时间，没变就不用重新下载
    sha256: row.sha256 ?? null,
    updatedAt: Number(row.updated_at ?? 0),
    publishedAt: row.published_at ?? null,
    createdAt: Number(row.created_at ?? 0),
  };
  if (!admin) return base;

  return {
    ...base,
    status: row.status,
    reviewStatus: row.review_status ?? 'pending',
    hasAsset: Boolean(row.storage_key),
    sortOrder: Number(row.sort_order ?? 0),
    createdBy: row.created_by ?? null,
    creatorEmail: row.creator_email ?? null,
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function userDto(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
    active: row.active === 1 || row.active === true,
    createdAt: Number(row.created_at ?? 0),
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function sessionUserDto(user) {
  return {
    ...userDto(user),
    capabilities: capabilitiesFor(user.role),
  };
}

export function auditDto(row) {
  return {
    id: Number(row.id),
    at: Number(row.at),
    actorId: row.actor_id ?? '',
    actorEmail: row.actor_email ?? '',
    actorRole: row.actor_role ?? '',
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id ?? '',
    detail: row.detail ?? '',
  };
}
