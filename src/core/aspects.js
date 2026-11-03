/**
 * 分辨率档位：Wallpaper Engine 的筛选里最实用的一栏。
 * 用宽高比而不是绝对像素，因为 2560×1080 和 3440×1440 都该归进 21:9。
 */
export const ASPECT_TOLERANCE = 0.06;

export const ASPECTS = Object.freeze([
  { key: '16:9', ratio: 16 / 9 },
  { key: '21:9', ratio: 21 / 9 },
  { key: '32:9', ratio: 32 / 9 },
  { key: '9:16', ratio: 9 / 16 },
  { key: '4:3', ratio: 4 / 3 },
  { key: '1:1', ratio: 1 },
]);

const BY_KEY = new Map(ASPECTS.map((item) => [item.key, item.ratio]));

/** 把查询参数变成比例值；不认识的值返回 null（等于不过滤）。 */
export function parseAspect(value) {
  if (value === undefined || value === null || value === '') return null;
  return BY_KEY.get(String(value).trim()) ?? null;
}

/** 给定宽高，判断它属于哪个档位（用于给卡片打标）。 */
export function aspectKeyFor(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const ratio = w / h;
  let best = null;
  let bestDiff = Infinity;
  for (const item of ASPECTS) {
    const diff = Math.abs(ratio - item.ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = item.key;
    }
  }
  return bestDiff <= ASPECT_TOLERANCE ? best : null;
}
