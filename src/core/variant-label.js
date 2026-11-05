/**
 * 变体 label / key 后缀 / 是否需要变体 —— **唯一口径**。
 *
 * 背景（2026-11 的事故）：变体 label 原来是「拿高度拼一个字符串」，
 *   · `ingest.js`       写 label = `${height}p`
 *   · `dto.js`          读不到 label 时也按 `${height}p` 兜底
 *   · `storage.js`      key 后缀 = `${height}p`
 *   · `routes/wallpapers.js` 从文件名 `xxx.1080p.mp4` 里抠出高度再拼 label
 * 四处各写一遍，于是 4320×2160 的源缩进 1920 框会变成 **1920×960**，
 * 三处一起把它写成 `960p`；而同分辨率降帧档（4K@60 → 4K@30，高度仍是 2160）
 * 又被写成 `2160p`，客户端拿到两个 2160 高的档分不清哪个「本机一定能播」。
 *
 * 现在：**只有本文件能决定 label 和 key 后缀**，其余模块一律调用：
 *   · `labelForVariant()`  —— 写 label（ingest）
 *   · `variantKeyTag()`    —— 定 key 后缀（storage.variantKey）
 *   · `needsVariant()`     —— 判断要不要出变体（ingest）
 *   · `specFromFileName()` —— 从上传文件名认出这一档是什么（routes）
 * 改口径只改这里，测试见 tests/variant-label.test.js。
 */
import {
  FPS_TOLERANCE, TARGET_FPS, TIER_2K_MIN_HEIGHT, TIER_4K_MIN_HEIGHT,
  VARIANT_MAX_HEIGHT, VARIANT_MAX_WIDTH, positiveNumber,
} from './media-limits.js';

/** 变体种类。key 后缀由种类决定（稳定为 `1080p` / `30fps`），不再随高度漂移。 */
export const VARIANT_KIND = Object.freeze({
  /** 降分辨率档：装进 1920×1080 框 */
  DOWNSCALE: '1080p',
  /** 同分辨率降帧档：分辨率不变，只把 fps 降到 30 */
  FPS: '30fps',
});

/** 对外展示的 label。客户端按它选档，改了等于改 API 契约（docs/SITE-DOWNLOAD-API.md）。 */
export const VARIANT_LABEL = Object.freeze({
  DOWNSCALE: '1080p',
  /** 4K（≥2160 高）的同分辨率降帧档 */
  FOUR_K30: '4K30',
  /** 2K（≥1440 高）的同分辨率降帧档 */
  TWO_K30: '2K30',
  /** 连高度都没有时的最终兜底（老库脏数据） */
  FALLBACK: 'alt',
});

/** R2 key 后缀。**必须稳定**：历史对象叫 `.1080p.mp4` / `.30fps.mp4`，不能换成 `.2160p.mp4`。 */
export const VARIANT_KEY_TAG = Object.freeze({
  DOWNSCALE: '1080p',
  FPS: '30fps',
  UNKNOWN: 'alt',
});

/** `{kind}` 的合法性：只认这两个种类。 */
function normalizeKind(kind) {
  return kind === VARIANT_KIND.DOWNSCALE || kind === VARIANT_KIND.FPS ? kind : null;
}

/**
 * 是不是「同分辨率降帧档」。
 *
 * 判据三件套：分辨率高于 1080p 框 + 帧率已知且 ≤ 30 + 与原片同分辨率。
 * 缺 fps 就**不猜**——「不知道」和「降过帧」必须区分开，否则老库脏数据会被误标成 4K30。
 */
function isSameResolutionFpsVariant({ width, height, fps, original }) {
  if (width === null || height === null) return false;
  if (fps === null || fps > TARGET_FPS + FPS_TOLERANCE) return false;

  const originalWidth = positiveNumber(original?.width);
  const originalHeight = positiveNumber(original?.height);
  if (originalWidth !== null && originalHeight !== null) {
    // 有原片尺寸：只有**完全同分辨率**才算降帧档；缩过尺寸的一律是降分辨率档
    return originalWidth === width && originalHeight === height;
  }
  // 没有原片尺寸：高于 1080p 框 + 只有 ≤30fps，只能解释为「同分辨率降帧」
  return height > VARIANT_MAX_HEIGHT;
}

/**
 * 尺寸是否落在 1080p 的选框里（1920×1080，**横竖都算**）。
 *
 * 壁纸站竖屏源很多（2160×3840），本地工具把它装进 1920×1080 框会得到 606×1080 —— 那也是
 * 「1080p 档」。所以判据取长边/短边：长边 ≤1920 且短边 ≤1080。
 * 只写「宽≤1920 且高≤1080」会把竖屏档判成别的档，然后回落成 `1920p` 这种假分辨率。
 */
function fitsVariantBox(width, height) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return long <= VARIANT_MAX_WIDTH && short <= VARIANT_MAX_HEIGHT;
}

/**
 * 这一档变体是什么种类。
 *
 * 优先级：**显式 kind > 尺寸推断 > 帧率推断**。
 * 写入方（本地转码工具 / 上传入口）比推断更懂这一档是什么，所以显式值最高。
 *
 * @param {object} spec
 * @param {string} [spec.kind] `'1080p' | '30fps'`（见 VARIANT_KIND）
 * @param {number|null} [spec.width]  变体自身宽度
 * @param {number|null} [spec.height] 变体自身高度
 * @param {number|null} [spec.fps]    变体自身帧率
 * @param {{width?: number, height?: number, fps?: number}} [spec.original] 原片尺寸/帧率
 * @returns {string|null} `'1080p' | '30fps' | null`（null = 信息不足）
 */
export function variantKind(spec = {}) {
  const declared = normalizeKind(spec.kind);
  if (declared) return declared;

  const width = positiveNumber(spec.width);
  const height = positiveNumber(spec.height);
  const fps = positiveNumber(spec.fps);

  // 装进 1920×1080 框里 ⇒ 降分辨率档（1920×960 这种「宽刚好、高更矮」也算）
  if (width !== null && height !== null && fitsVariantBox(width, height)) {
    return VARIANT_KIND.DOWNSCALE;
  }

  if (isSameResolutionFpsVariant({ width, height, fps, original: spec.original })) {
    return VARIANT_KIND.FPS;
  }

  return null;
}

/**
 * 变体的 label。**写 label 的地方只许调这个函数。**
 *
 * 规则表（与 docs/UPLOAD-SOP.md §5 一致）：
 * | 情况 | label |
 * |---|---|
 * | 1080p 档（装进 1920×1080 框，横竖都算；4320×2160 源的 1920×960 也算） | `1080p` |
 * | 同分辨率降帧档，高 ≥2160（4K） | `4K30` |
 * | 同分辨率降帧档，高 ≥1440（2K） | `2K30` |
 * | 同分辨率降帧档，其它高度 | `<height>p30`（如 `1200p30`） |
 * | 缺 fps / 缺尺寸（信息不足） | `<height>p` 回落；连高度都没有 ⇒ `alt` |
 *
 * @param {object} spec 同 variantKind()
 * @returns {string}
 */
export function labelForVariant(spec = {}) {
  const kind = variantKind(spec);
  const height = positiveNumber(spec.height);

  if (kind === VARIANT_KIND.DOWNSCALE) return VARIANT_LABEL.DOWNSCALE;

  if (kind === VARIANT_KIND.FPS) {
    if (height === null) return VARIANT_LABEL.FALLBACK;
    if (height >= TIER_4K_MIN_HEIGHT) return VARIANT_LABEL.FOUR_K30;
    if (height >= TIER_2K_MIN_HEIGHT) return VARIANT_LABEL.TWO_K30;
    return `${Math.round(height)}p${TARGET_FPS}`;
  }

  // 信息不足 ⇒ 回落 `${height}p`（与升级前逐字节一致，老库形状不变）
  if (height !== null) return `${Math.round(height)}p`;
  return VARIANT_LABEL.FALLBACK;
}

/**
 * R2 key 里的后缀。**必须稳定为 `1080p` / `30fps`**（历史对象都是这个形状）。
 * 认不出种类时用 `alt`——宁可让人一眼看出「这档没标注」，也不要编一个假分辨率。
 *
 * @param {object} spec 同 variantKind()
 * @returns {string}
 */
export function variantKeyTag(spec = {}) {
  const kind = variantKind(spec);
  if (kind === VARIANT_KIND.DOWNSCALE) return VARIANT_KEY_TAG.DOWNSCALE;
  if (kind === VARIANT_KIND.FPS) return VARIANT_KEY_TAG.FPS;
  return VARIANT_KEY_TAG.UNKNOWN;
}

/**
 * 视频是否需要出变体（用户口径：宽 >1920 或 高 >1080 或 fps >30）。
 *
 * 注意 `?? 0`：这里「探测不到」按「不超」处理，因为紧接着的合规体检会把
 * probe-failed 单独判成违规，不需要这里再猜一次。
 */
export function needsVariant({ width, height, fps } = {}) {
  const w = positiveNumber(width) ?? 0;
  const h = positiveNumber(height) ?? 0;
  const f = positiveNumber(fps) ?? 0;
  return w > VARIANT_MAX_WIDTH || h > VARIANT_MAX_HEIGHT || f > TARGET_FPS;
}

/**
 * 从上传文件名认这一档变体是什么（后台把 `xxx.1080p.mp4` / `xxx.30fps.mp4`
 * 与源文件一起多选时用）。
 *
 * 只用来标注「预期种类」；真实尺寸仍然以文件头探测为准，
 * 所以文件名撒谎不会让 label 撒谎（ingest 会用探测结果重新算）。
 *
 * @param {string} name 例如 `星野.1080p.mp4` / `星野.30fps.mp4`
 * @returns {{kind: string|null, height: number|null}}
 */
export function specFromFileName(name) {
  const text = String(name ?? '');

  const fpsHit = /\.(\d{2,3})fps\b/i.exec(text);
  if (fpsHit) {
    return {
      kind: Number(fpsHit[1]) === TARGET_FPS ? VARIANT_KIND.FPS : null,
      height: null,
    };
  }

  const heightHit = /\.(\d{3,4})p\b/i.exec(text);
  if (heightHit) {
    return { kind: VARIANT_KIND.DOWNSCALE, height: Number(heightHit[1]) };
  }

  return { kind: null, height: null };
}
