/**
 * 「能不能播」和「能不能入库」的唯一判定处。
 *
 * 软违规（允许入库，但强制 draft + needs_variant=1 + 原因）：
 *   fps-too-high / too-wide / too-tall / too-many-pixels / codec-unsupported
 * 硬失败（422，不写 R2、不留对象）：
 *   非 mp4/webm 容器 / faststart 重封装失败 / probe-failed / 0 字节 / >2GB
 *
 * 发布门槛只在这里定义一次：任何地方判断「能不能发布/能不能播」都必须调 isPlayable()。
 */

/** 软违规：可以入库待转码 */
export const SOFT_VIOLATIONS = Object.freeze([
  'fps-too-high',
  'too-wide',
  'too-tall',
  'too-many-pixels',
  'codec-unsupported',
]);

/** 硬失败：直接拒绝 */
export const HARD_VIOLATIONS = Object.freeze([
  'not-faststart',
  'probe-failed',
]);

/** 发布门槛（唯一一份） */
export const PLAYABLE_LIMITS = Object.freeze({
  maxFps: 30,
  maxWidth: 3840,
  maxHeight: 2160,
  maxPixels: 8_300_000,
  codecs: Object.freeze(['h264', 'avc1']),
});

/** fps 容差：29.97 / 30.000 这类抖动不算超 */
const FPS_TOLERANCE = 0.1;

const codeOf = (item) => (typeof item === 'string' ? item : item?.code);

/**
 * 根据违规列表给出「待转码原因」。
 * @returns {'fps-60'|'oversize'|'codec'|'probe-failed'|null} null 表示不许入库（硬失败）
 */
export function variantReasonFor(violations = []) {
  const codes = violations.map(codeOf).filter(Boolean);
  if (!codes.length) return null;
  if (codes.some((code) => HARD_VIOLATIONS.includes(code))) return null;
  if (codes.some((code) => !SOFT_VIOLATIONS.includes(code))) return null;
  if (codes.includes('fps-too-high')) return 'fps-60';
  if (codes.some((code) => ['too-wide', 'too-tall', 'too-many-pixels'].includes(code))) return 'oversize';
  return 'codec';
}

/** 该违规集合是否「软失败」（可入库待转码） */
export function isSoftOnly(violations = []) {
  return variantReasonFor(violations) !== null;
}

/**
 * 能不能直接发布 / 插件能不能播。
 * @param {{fps?:number|null, width?:number|null, height?:number|null, codec?:string|null}} input
 */
export function isPlayable(input = {}) {
  const fps = Number(input.fps);
  const width = Number(input.width);
  const height = Number(input.height);
  const codec = String(input.codec ?? '').toLowerCase();
  if (!Number.isFinite(fps) || fps <= 0) return false;
  if (fps > PLAYABLE_LIMITS.maxFps + FPS_TOLERANCE) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  if (width > PLAYABLE_LIMITS.maxWidth || height > PLAYABLE_LIMITS.maxHeight) return false;
  if (width * height > PLAYABLE_LIMITS.maxPixels) return false;
  return PLAYABLE_LIMITS.codecs.includes(codec);
}
