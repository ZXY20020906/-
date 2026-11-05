/**
 * 媒体口径常量 —— **全站唯一的阈值来源**。
 *
 * 为什么单独抽一个文件：这些数字（3840 / 2160 / 1920 / 1080 / 30 / 40MB …）原本散在
 * `ingest.js`（VARIANT_*）、`media-compliance.js`（MEDIA_LIMITS）、`routes/wallpapers.js`
 * （缩略图 2MB）三处各写一遍。「1080p 变体」这件事在三个文件里各有一份口径，
 * 改一处忘另一处就会出现「工具说合规、站点说违规」或者「变体按 1080 生成、label 却写 960p」。
 *
 * 现在：**数字只写在这里**，其余文件一律 import，不再出现字面量。
 * 单位约定：`*_BYTES` 是字节数，`MB` 是乘数（1 MB = 1024×1024 B，与 D1/R2 的展示口径一致）。
 */

/** 1 MB 的字节数（全站统一用 1024 进制，避免「25MB」在两处差 4%）。 */
export const MB = 1024 * 1024;

// ------------------------------------------------------------------ 原画上限
/** 原画宽上限：4K 横屏标准。 */
export const ORIGINAL_MAX_WIDTH = 3840;
/** 原画高上限：4K 竖屏同理（3840×2160 的 2160）。 */
export const ORIGINAL_MAX_HEIGHT = 2160;
/** 原画像素总量上限（= 3840×2160 = 8,294,400），挡住「超宽 5916×2530」这类。 */
export const ORIGINAL_MAX_PIXELS = ORIGINAL_MAX_WIDTH * ORIGINAL_MAX_HEIGHT;

// -------------------------------------------------------------- 变体（降档）上限
/** 1080p 变体（降分辨率档）的宽上限。 */
export const VARIANT_MAX_WIDTH = 1920;
/** 1080p 变体（降分辨率档）的高上限。 */
export const VARIANT_MAX_HEIGHT = 1080;

// ------------------------------------------------------------------ 帧率口径
/** 站点目标帧率。超过即 422（原画）/ 需要降帧变体。 */
export const TARGET_FPS = 30;
/** 帧率容差：29.97 / 30.000 这类实测抖动不该被误判成「超限」。 */
export const FPS_TOLERANCE = 0.5;
/** 帧率探测的合理上限；超过说明文件头读坏了，按「探测不到」处理。 */
export const FPS_PROBE_CEILING = 1000;

// -------------------------------------------------- label 的画质档位（高度阈值）
/** ≥2160 高 ⇒ 标 `4K30`。 */
export const TIER_4K_MIN_HEIGHT = 2160;
/** ≥1440 高 ⇒ 标 `2K30`。 */
export const TIER_2K_MIN_HEIGHT = 1440;

// ------------------------------------------------------------------ 体积阈值
/** > 40MB 不算完整 sha256（Worker 128MB 内存会炸），改用采样指纹。 */
export const HASH_LIMIT_BYTES = 40 * MB;
/** 原画体积建议上限：超了只 warn，不拒绝。 */
export const ORIGINAL_SUGGESTED_BYTES = 25 * MB;
/** 1080p 变体体积建议上限：超了只 warn（弱网起播会变慢）。 */
export const VARIANT_SUGGESTED_BYTES = 8 * MB;

// ------------------------------------------------------------------ 缩略图
/** 缩略图目标宽度：插件卡片最多 640 宽，1280 给 2x 屏。 */
export const THUMB_WIDTH = 1280;
/** 手动上传缩略图的体积上限。 */
export const THUMB_MAX_BYTES = 2 * MB;

// ------------------------------------------------------------------ 配额
/** 每日上传配额默认值（1 GiB / 账号 / 天），env.UPLOAD_DAILY_BYTES 可覆盖。 */
export const UPLOAD_DAILY_BYTES = 1024 * MB;

/**
 * 数值归一：只接受有限正数，其余一律 `null`。
 *
 * 探测失败时 `width`/`height`/`fps` 常常是 `undefined`、`'0'`、`NaN`，
 * 直接比较会把「不知道」当成「合规」，所以统一收敛成一个可判定的 `null`。
 */
export function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
