/**
 * 前台壁纸库的纯逻辑：不碰 DOM、不碰网络，所以 Node 里能直接单测。
 * 轮换列表、收藏、排序/格式化的规则都在这里，页面只负责画。
 */

export const MAX_ROTATION = 20;
export const FAVORITES_KEY = 'folia:favorites';
export const ROTATION_KEY = 'folia:rotation';

/** 逗号分隔的 id/slug 列表：去空、去重、截断到上限。 */
export function parseIdList(raw, max = MAX_ROTATION) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const out = [];
  for (const part of parts) {
    const value = String(part ?? '').trim();
    if (!value) continue;
    if (out.includes(value)) continue;
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function serializeIdList(ids) {
  return parseIdList(ids).join(',');
}

/**
 * 加入轮换。返回新数组 + 状态，方便页面提示「已满」而不是静默失败。
 * @returns {{ids: string[], added: boolean, full: boolean}}
 */
export function addToRotation(ids, id, max = MAX_ROTATION) {
  const list = parseIdList(ids, max);
  const value = String(id ?? '').trim();
  if (!value) return { ids: list, added: false, full: false };
  if (list.includes(value)) return { ids: list, added: false, full: false };
  if (list.length >= max) return { ids: list, added: false, full: true };
  return { ids: [...list, value], added: true, full: false };
}

export function removeFromRotation(ids, id) {
  return parseIdList(ids).filter((item) => item !== id);
}

/** 收藏：再点一次取消。返回新数组，不改原数组。 */
export function toggleFavorite(list, slug) {
  const current = parseIdList(list, 1000);
  const value = String(slug ?? '').trim();
  if (!value) return { list: current, added: false, full: false };
  if (current.includes(value)) {
    return { list: current.filter((item) => item !== value), added: false, full: false };
  }
  return { list: [value, ...current], added: true, full: false };
}

export function parseFavoriteList(raw, max = 1000) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parseIdList(parsed, max) : [];
  } catch {
    return [];
  }
}

/** 详情里按 ← → 切换：越界时回绕，不抛错。 */
export function stepIndex(length, current, delta) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  const base = Number.isInteger(current) && current >= 0 ? current : 0;
  return ((base + delta) % length + length) % length;
}

export function formatBytes(value) {
  const n = Number(value || 0);
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 分辨率档位（Wallpaper Engine 筛选里那一栏）。
 * 与 src/core/aspects.js 保持同一套比例与容差——那边给 SQL 用，这边给浏览器用，
 * 故意各自独立，免得为一行常量把服务端代码打进前端包里。
 */
export const ASPECT_KEYS = Object.freeze(['16:9', '21:9', '32:9', '9:16', '4:3', '1:1']);

const ASPECT_RATIOS = Object.freeze({
  '16:9': 16 / 9,
  '21:9': 21 / 9,
  '32:9': 32 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '1:1': 1,
});

export function aspectKeyFor(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const ratio = w / h;
  let best = null;
  let bestDiff = Infinity;
  for (const key of ASPECT_KEYS) {
    const diff = Math.abs(ratio - ASPECT_RATIOS[key]);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return bestDiff <= 0.06 ? best : null;
}

/** 静态模式下自己过滤用；服务端模式下交给 SQL。 */
export function matchesAspect(item, key) {
  if (!key) return true;
  return aspectKeyFor(item.width, item.height) === key;
}

/** 6.5s / 1:15 —— 开机动画的循环时长，比体积更能说明问题。 */
export function formatDuration(ms) {  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const EXT_BY_MIME = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

export function extensionForMime(mime) {
  return EXT_BY_MIME[String(mime ?? '')] ?? '';
}

/**
 * 下载地址：让文件以附件形式落盘，而不是在浏览器里播放。
 * 走自定义域名（MEDIA_BASE）时，把路径还原成站内 /media/——那条路由才能加
 * Content-Disposition；拿不到就直接在地址后加 ?download=1 兜底。
 */
export function downloadUrl(url, origin, filename = '') {
  const value = String(url ?? '');
  if (!value) return '';
  const query = filename ? `?download=${encodeURIComponent(filename)}` : '?download=1';
  if (!/^https?:\/\//i.test(value)) return `${value}${query}`;
  try {
    const parsed = new URL(value);
    const marker = '/wallpapers/';
    const index = parsed.pathname.indexOf(marker);
    if (index >= 0) {
      const key = parsed.pathname.slice(index + 1);
      return `${String(origin ?? '').replace(/\/+$/, '')}/media/${key}${query}`;
    }
    return `${value}${query}`;
  } catch {
    return `${value}${query}`;
  }
}

export function formatDimensions(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '—';
  return `${Math.round(w)}×${Math.round(h)}`;
}

/** 按像素总量给个档位标签，竖屏 2160×3840 也算 4K。 */
export function qualityLabel(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '';
  const pixels = w * h;
  if (pixels >= 7680 * 4320 * 0.9) return '8K';
  if (pixels >= 3840 * 2160 * 0.9) return '4K';
  if (pixels >= 2560 * 1440 * 0.9) return '2K';
  if (pixels >= 1920 * 1080 * 0.9) return '1080P';
  return '';
}

/** R2 里既有图片、视频，也有开机动画包（zip），判断靠 mime 不靠扩展名。 */
export function mediaKind(item) {
  const mime = String(item?.mime ?? '');
  if (mime === 'application/zip') return 'bundle';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return item?.kind === 'dynamic' ? 'video' : 'image';
}

/**
 * 是不是桌宠包。
 *
 * 认两个来源：`kind === 'pet'`（020 迁移后新数据都有）或 `pet` 对象存在
 * （历史数据只有 variant 标记、kind 还是 static）。任一成立就算桌宠。
 */
export function isPetItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'pet') return true;
  return Boolean(item.pet && typeof item.pet === 'object');
}

/**
 * 卡片左上角徽标。桌宠优先于「资源包」——它是最具体的类型。
 * 返回 null 表示交给调用方按视频/清晰度决定。
 */
export function cardBadge(item) {
  if (isPetItem(item)) return '桌宠';
  if (mediaKind(item) === 'bundle') return '资源包';
  return null;
}

/** 直链可能是 /media/... 也可能是 R2 自定义域名的绝对地址。 */
export function absoluteUrl(path, origin) {
  const value = String(path ?? '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${String(origin ?? '').replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

/** 轮换分享链接：把 slug 列表放进 hash，服务端完全不用知道。 */
export function buildShareUrl(origin, pathname, ids) {
  const list = parseIdList(ids);
  if (!list.length) return `${String(origin).replace(/\/+$/, '')}${pathname}`;
  const encoded = list.map((item) => encodeURIComponent(item)).join(',');
  return `${String(origin).replace(/\/+$/, '')}${pathname}#r=${encoded}`;
}

export function readSharedRotation(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return [];
  const params = new URLSearchParams(raw);
  const value = params.get('r');
  if (!value) return [];
  return parseIdList(value.split(',').map((item) => {
    try {
      return decodeURIComponent(item);
    } catch {
      return item;
    }
  }));
}
