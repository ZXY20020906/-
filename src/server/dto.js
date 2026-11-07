/**
 * 输出给前端的形状。DB 行 → DTO。
 * storage_key 是内部字段不暴露；sha256 对外输出（插件用它做增量下载判断）。
 */
import { safeJsonArray, safeJsonParse } from './util.js';
import { petFromVariants } from './pet-package.js';
import { publicUrl } from './storage.js';
import { capabilitiesFor, ROLE_LABELS } from '../core/permissions.js';
import { labelForVariant } from '../core/variant-label.js';

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
 * 变体 label：**存的 label 优先，缺失时交给唯一口径 `labelForVariant()`**。
 *
 * 为什么不能再用 `height` 反算：从 2026-11 起变体不再只有「降分辨率」一档，还有
 * **同分辨率降帧**（4K@60 → 4K@30）。两者的 height 都是 2160，用 `height + 'p'` 反算
 * 会把 `4K30` 说成 `2160p` —— 客户端拿到两个 2160 高的档（一个 60fps 原画、一个 30fps
 * 变体）就分不清哪一档是「本机一定能播」的那份，选档只能退回本地转码。
 * 老库里的记录没有 label 字段（`batch.py` 只写了 height/key/bytes/sha256），
 * 这时由 `labelForVariant()` 按同一张规则表兜底（缺 fps ⇒ `${height}p`），
 * 与 ingest 写 label 时**调的是同一个函数**，所以两边不可能再各说一套。
 *
 * @param {any} item variants 列里的一项（可能带 label / kind / width / fps）
 * @param {number|null} height 已归一的高度
 * @returns {string}
 */
function variantLabel(item, height) {
  const raw = item?.label;
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (label) return label;
  }
  return labelForVariant({
    kind: item?.kind,
    height,
    width: item?.width,
    fps: item?.fps,
  });
}

/**
 * 同一条壁纸的降档变体（1080p / 同分辨率 30fps）。弱网用户靠它 5 秒出画面：
 * 4K 原画 40–50 MB，1080p 只有 5–8 MB；4K@60 的解码失败靠 4K@30 变体兜住。
 *
 * DB 里 variants 是一列 JSON 文本（D1 迁移见 schema/014）。坏数据一律降级成
 * 空数组 —— 变体是「锦上添花」，绝不能因为一行脏 JSON 让整条壁纸 500。
 * 契约（docs/SITE-DOWNLOAD-API.md §1.1）要求按 bytes 升序、URL 同域，
 * 所以这里统一用 publicUrl 生成，前缀跟着站点配置走。
 */
export function variantsDto(row, mediaBase = '') {
  // D1 里是 JSON 字符串；但调用方也可能直接传数组（例如刚刚 attachVariant 的返回值）。
  // 两种形态都要能吃，否则会出现「后台有、公开没有」。
  let raw = row?.variants;
  if (typeof raw === 'string') raw = safeJsonParse(raw, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object' && item.key && Number(item.bytes) > 0)
    .map((item) => {
      const height = Number(item.height) || null;
      const bytes = Number(item.bytes);
      return {
        label: variantLabel(item, height),
        // 宽度/帧率是 v1 新增：客户端按「档位」选片时不用自己从 label 里猜
        width: Number(item.width) || null,
        height,
        fps: Number(item.fps) || null,
        bytes,
        sha256: item.sha256 ?? null,
        url: publicUrl(item.key, mediaBase),
      };
    })
    .sort((a, b) => a.bytes - b.bytes);
}

/** `nullableNumber`：D1 的 REAL 列可能给 null / undefined / 空串，统一收敛成 number|null。 */
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `has_audio` 三态：1 → true、0 → false、NULL/缺列 → null（未知，不假装成 false）。 */
function nullableBool(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 1 || value === '1') return true;
  return false;
}

/**
 * 桌宠包标记（门 1）。元数据存在 `variants` 列的保留项里（**不新增数据库列**），
 * 这里取出来拼成契约要求的 `pet` 对象：
 *   `{ id, displayName, frames, columns, tracks, previewUrl }`
 *
 * 只新增 `kind:'pet'` 与 `pet` 两个字段；url / bytes / thumbUrl / variants 的生成方式
 * 一个字都没改（工单 §2 ④）。previewUrl 与 thumbUrl 指向同一个对象（previews 第一张）。
 */
function petDto(row, mediaBase) {
  const pet = petFromVariants(row?.variants, safeJsonParse);
  if (!pet) return null;
  return {
    id: pet.id ?? null,
    displayName: pet.displayName ?? null,
    frames: Array.isArray(pet.frames) ? pet.frames : [],
    columns: Number(pet.columns) || 8,
    tracks: Array.isArray(pet.tracks) ? pet.tracks : [],
    previewUrl: publicUrl(pet.previewKey, mediaBase),
  };
}

export function wallpaperDto(row, { admin = false, mediaBase = '' } = {}) {
  const fullUrl = publicUrl(row.storage_key, mediaBase);
  // 没有缩略图时，只有原文件本身是图片才拿它顶替；
  // 视频 / zip 绝不能当缩略图返回，否则客户端会把 40MB 的 mp4 当图片去下。
  const assetIsImage = typeof row.mime === 'string' && row.mime.startsWith('image/');
  const thumbUrl = publicUrl(row.thumb_key, mediaBase) ?? (assetIsImage ? fullUrl : null);
  const posterUrl = publicUrl(row.poster_key, mediaBase);
  const pet = petDto(row, mediaBase);
  const base = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? '',
    subtag: row.subtag ?? '',
    // 桌宠包对外 kind='pet'（新值）；其余条目仍是 static/dynamic，取值不变
    kind: pet ? 'pet' : row.kind,
    mime: row.mime ?? null,
    bytes: Number(row.bytes ?? 0),
    width: row.width ?? null,
    height: row.height ?? null,
    durationMs: row.duration_ms ?? null,
    // v1 技术元数据（schema/016）：拿不到一律 null，不猜、不补默认值
    fps: nullableNumber(row.fps),
    codec: row.codec ?? null,
    pixFmt: row.pix_fmt ?? null,
    hasAudio: nullableBool(row.has_audio),
    tags: safeJsonParse(row.tags, []),
    featured: row.featured === 1 || row.featured === true,
    category: row.category_id
      ? { id: row.category_id, slug: row.category_slug ?? null, name: row.category_name ?? null }
      : null,
    url: fullUrl,
    thumbUrl,
    // 首帧海报（视频才可能有）：1280 宽 WebP；没有时保持 null，客户端回落到 thumbUrl
    posterUrl,
    // 授权信息：列表就能筛选/展示，客户端不用再调详情
    license: row.license ?? null,
    source: row.source ?? null,
    author: row.author ?? null,
    // 降档变体：没有就是空数组，老客户端读不到也不会崩
    variants: variantsDto(row, mediaBase),
    // 桌宠包（门 1）：普通条目没有这个键，老客户端读不到也不受影响
    ...(pet ? { pet } : {}),
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
    needsVariant: Number(row.needs_variant ?? 0) === 1,
    variantReason: row.variant_reason ?? null,
    hasAsset: Boolean(row.storage_key),
    sortOrder: Number(row.sort_order ?? 0),
    createdBy: row.created_by ?? null,
    creatorEmail: row.creator_email ?? null,
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * manifest 条目：只放「客户端同步 + 校验」需要的字段。
 *
 * `variants` 复用公开 DTO 的 `variantsDto()`（同样的 label/width/fps/排序规则），
 * 所以同一档位在列表、详情、manifest 三处的描述永远一致。
 *
 * 放在 dto.js 而不是 public-api.js：阶段三的快照构建（`snapshot.js`）也要用它，
 * 而 `snapshot.js` 又被 `public-api.js` import —— 放这里才不会形成 import 环。
 */
export function manifestItemDto(row, mediaBase = '') {
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
