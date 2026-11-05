/**
 * 视频「播放合规」体检：**纯函数**，没有 IO、没有依赖，Worker 与本地工具共用同一份规则。
 *
 * 为什么需要它：Cloudflare Workers / Pages Functions 里**没有 ffmpeg**，
 * 服务端不可能把 5916×2530 的视频转成能播的规格。所以职责这样切：
 *   - 服务端（这里）：只做「体检 + 拒绝入库」—— 挡掉会播不了 / 播起来会卡死的文件；
 *   - 本地（tools/prepare-upload.mjs）：真正转码，产出合规文件 + 1080p 变体 + 封面。
 * 两边共用本文件的 MEDIA_LIMITS 与违规码，避免「工具说合规、站点说违规」。
 *
 * 目标规格（2026-11 定稿）：
 *   | 项 | 原画 | 1080p 变体 |
 *   | 宽 | ≤ 3840 | ≤ 1920 |
 *   | 高 | ≤ 2160 | — |
 *   | 像素总量 | ≤ 8,294,400（=3840×2160） | 同上 |
 *   | 帧率 | ≤ 30 fps | ≤ 30 fps |
 *   | 编码 | H.264（avc1） | H.264（avc1） |
 *   | 封装 | MP4 + faststart（moov 前置） | 同上（要求更严） |
 *   | 体积 | ≤ 25 MB（超了只 warn） | ≤ 8 MB（超了只 warn） |
 *
 * 违规（violations）⇒ 拒绝入库（HTTP 422）；警告（warnings）⇒ 入库但记录到 audit_log。
 *
 * 几处**刻意的取舍**（都写在这里，免得后来人当成 bug 改掉）：
 * 1. `fps-too-high` 判**违规**而不是警告。30fps 是站点的解码/体积预算，不是浏览器的
 *    硬上限——60fps 的文件「能播」，但会顶穿 1080p ≤8MB 与弱网起播的目标，而本地工具
 *    一条 `fps=30` 就能无损修好。所以这里硬拒，把「先跑一遍工具」变成唯一路径。
 * 2. WebM **不按 MP4 规则判**：VP8/VP9/AV1 在浏览器里本来就原生可播，也没有 moov
 *    概念，硬套 H.264/faststart 会误杀存量能力（api.md 一直声明动态壁纸收 webm）。
 *    对 WebM 只查分辨率/像素/帧率，并给一条 `container-webm` 警告说明「不在 1080p
 *    变体管线里」。
 * 3. 宽高探测不出来 = `probe-failed` **违规**。这类文件在库里只会留下 null 宽高，
 *    列表的宽高比筛选、变体生成、详情页全部失真，宁可拒。
 */
import {
  FPS_PROBE_CEILING, FPS_TOLERANCE, ORIGINAL_MAX_HEIGHT, ORIGINAL_MAX_PIXELS,
  ORIGINAL_MAX_WIDTH, ORIGINAL_SUGGESTED_BYTES, TARGET_FPS, VARIANT_MAX_WIDTH,
  VARIANT_SUGGESTED_BYTES, positiveNumber,
} from '../core/media-limits.js';

/** 目标规格上限。工具可用 options.limits 覆盖（比如 --max-pixels 传更小的值）。 */
export const MEDIA_LIMITS = Object.freeze({
  maxWidth: ORIGINAL_MAX_WIDTH,
  maxHeight: ORIGINAL_MAX_HEIGHT,
  maxPixels: ORIGINAL_MAX_PIXELS,
  maxFps: TARGET_FPS,
  /** 1080p 变体的宽度上限 */
  variantMaxWidth: VARIANT_MAX_WIDTH,
  /** 原画 / 变体的体积上限：超了只 warn，不拒绝 */
  originalMaxBytes: ORIGINAL_SUGGESTED_BYTES,
  variantMaxBytes: VARIANT_SUGGESTED_BYTES,
});

/** 违规码（拒绝入库）。改名字要同步 docs/UPLOAD-SOP.md 的对照表与 tests。 */
export const VIOLATION = Object.freeze({
  TOO_WIDE: 'too-wide',
  TOO_TALL: 'too-tall',
  TOO_MANY_PIXELS: 'too-many-pixels',
  FPS_TOO_HIGH: 'fps-too-high',
  CODEC_UNSUPPORTED: 'codec-unsupported',
  NOT_FASTSTART: 'not-faststart',
  PROBE_FAILED: 'probe-failed',
});

/** 警告码（入库但留痕）。 */
export const WARNING = Object.freeze({
  ORIGINAL_TOO_LARGE: 'original-too-large',
  VARIANT_TOO_LARGE: 'variant-too-large',
  CONTAINER_WEBM: 'container-webm',
  FPS_UNKNOWN: 'fps-unknown',
  CODEC_UNKNOWN: 'codec-unknown',
});

/** 违规码的中文短名：给后台 toast、工具输出、文档对照表共用。 */
export const VIOLATION_LABEL = Object.freeze({
  [VIOLATION.TOO_WIDE]: '宽度超限',
  [VIOLATION.TOO_TALL]: '高度超限',
  [VIOLATION.TOO_MANY_PIXELS]: '像素总量超限',
  [VIOLATION.FPS_TOO_HIGH]: '帧率过高',
  [VIOLATION.CODEC_UNSUPPORTED]: '编码不受支持',
  [VIOLATION.NOT_FASTSTART]: 'moov 未前置',
  [VIOLATION.PROBE_FAILED]: '探测失败',
});

/** 422 时拼进 message 的处理建议。 */
export const COMPLIANCE_HINT = '请先用 tools/prepare-upload.mjs 处理后再上传';

const WEBM_CODECS = ['vp8', 'vp9', 'av1'];
const MP4_CODECS = ['h264'];

/** 'avc1' / 'V_MPEG4/ISO/AVC' / 'H264' 都归一到 h264；未知原样小写返回。 */
function normalizeCodec(codec) {
  if (!codec) return null;
  const raw = String(codec).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'avc1' || raw === 'h264' || raw === 'avc') return 'h264';
  if (raw === 'hev1' || raw === 'hvc1' || raw === 'hevc' || raw === 'h265') return 'hevc';
  if (raw === 'av01' || raw === 'av1') return 'av1';
  if (raw === 'vp09' || raw === 'vp9') return 'vp9';
  if (raw === 'vp08' || raw === 'vp8') return 'vp8';
  return raw;
}

/**
 * 视频合规体检。
 *
 * @param {object} input
 * @param {string} [input.mime] 容器类型（video/mp4 走 H.264 规则；video/webm 走原生规则）
 * @param {number|null} [input.width]
 * @param {number|null} [input.height]
 * @param {number|null} [input.fps] 探测不到就传 null（会留一条 fps-unknown 警告）
 * @param {string|null} [input.codec] h264 / hevc / av1 / vp9 …（avc1 也行）
 * @param {boolean|null} [input.faststart] moov 是否在 mdat 之前；WebM 忽略
 * @param {number|null} [input.bytes] 文件字节数（只影响警告）
 * @param {object} [options]
 * @param {'original'|'variant'} [options.role='original'] 原画还是 1080p 变体
 * @param {object} [options.limits] 覆盖 MEDIA_LIMITS 的部分字段（工具 --max-pixels 用）
 * @returns {{ok: boolean, violations: {code: string, message: string}[], warnings: {code: string, message: string}[]}}
 */
export function checkVideoCompliance(input = {}, options = {}) {
  const limits = { ...MEDIA_LIMITS, ...(options.limits ?? {}) };
  const role = options.role === 'variant' ? 'variant' : 'original';
  const isVariant = role === 'variant';

  const violations = [];
  const warnings = [];
  const fail = (code, message) => violations.push({ code, message });
  const warn = (code, message) => warnings.push({ code, message });

  const mime = typeof input.mime === 'string' ? input.mime.toLowerCase() : '';
  const isWebm = mime === 'video/webm';

  const width = positiveNumber(input.width);
  const height = positiveNumber(input.height);
  const bytes = positiveNumber(input.bytes);
  const rawFps = positiveNumber(input.fps);
  const fps = rawFps && rawFps <= FPS_PROBE_CEILING ? rawFps : null;
  const codec = normalizeCodec(input.codec);

  // ---------------------------------------------------------------- 容器/编码
  if (!isWebm && codec === null) {
    // moov 读不到时编码必然读不到：这条和 not-faststart 通常一起出现，
    // 分开报是为了让人一眼看出「不是编码错，是根本探测不到」。
    fail(VIOLATION.PROBE_FAILED, '探测不到视频编码（moov 缺失或文件损坏）');
  } else if (isWebm && codec === null) {
    warn(WARNING.CODEC_UNKNOWN, '探测不到 WebM 的编码（CodecID 不在文件头），无法确认能否播放');
  } else if (isWebm && !WEBM_CODECS.includes(codec)) {
    fail(VIOLATION.CODEC_UNSUPPORTED, `编码 ${codec} 浏览器播不了，WebM 只接受 ${WEBM_CODECS.join(' / ')}`);
  } else if (!isWebm && !MP4_CODECS.includes(codec)) {
    fail(VIOLATION.CODEC_UNSUPPORTED, `编码 ${codec} 不受支持，必须是 H.264（avc1）`);
  }

  if (isWebm) {
    warn(WARNING.CONTAINER_WEBM, 'WebM 不是目标规格（H.264 MP4）：能直接播，但进不了 1080p 变体管线');
  }

  // ---------------------------------------------------------------- 宽高/像素
  if (width === null || height === null) {
    fail(VIOLATION.PROBE_FAILED, '探测不到视频宽高（moov/tkhd 缺失或不在前 2MB），无法判断能否播放');
  } else {
    const maxWidth = isVariant ? limits.variantMaxWidth : limits.maxWidth;
    if (width > maxWidth) {
      fail(VIOLATION.TOO_WIDE, isVariant
        ? `1080p 变体宽度 ${width}px 超过上限 ${maxWidth}px`
        : `宽度 ${width}px 超过上限 ${maxWidth}px`);
    }
    // 变体规格只约束宽度（1080 是生成时锁定的高度），原画才查高度
    if (!isVariant && height > limits.maxHeight) {
      fail(VIOLATION.TOO_TALL, `高度 ${height}px 超过上限 ${limits.maxHeight}px`);
    }
    const pixels = width * height;
    if (pixels > limits.maxPixels) {
      fail(
        VIOLATION.TOO_MANY_PIXELS,
        `像素总量 ${width}×${height}=${pixels} 超过上限 ${limits.maxPixels}（=${ORIGINAL_MAX_WIDTH}×${ORIGINAL_MAX_HEIGHT}）`,
      );
    }
  }

  // ---------------------------------------------------------------- 帧率
  if (fps === null) {
    warn(WARNING.FPS_UNKNOWN, '探测不到帧率（没有 stts / DefaultDuration），超过 30fps 的情况可能漏放');
  } else if (fps > limits.maxFps + FPS_TOLERANCE) {
    // +FPS_TOLERANCE 容差：29.97 / 30.000 这类实测抖动不该被误判
    fail(VIOLATION.FPS_TOO_HIGH, `帧率 ${Number(fps.toFixed(2))}fps 超过上限 ${limits.maxFps}fps`);
  }

  // ---------------------------------------------------------------- faststart
  if (!isWebm) {
    const faststart = input.faststart;
    if (faststart !== true) {
      const reason = faststart === false
        ? 'moov 在文件尾部（没做 faststart），浏览器要下完整个文件才能起播'
        : '无法确认 moov 是否前置（探测失败）';
      fail(VIOLATION.NOT_FASTSTART, isVariant ? `1080p 变体${reason}` : reason);
    }
  }

  // ---------------------------------------------------------------- 体积（只 warn）
  if (bytes !== null) {
    const maxBytes = isVariant ? limits.variantMaxBytes : limits.originalMaxBytes;
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > maxBytes) {
      warn(
        isVariant ? WARNING.VARIANT_TOO_LARGE : WARNING.ORIGINAL_TOO_LARGE,
        `${isVariant ? '1080p 变体' : '原画'} ${mb(bytes)} 超过建议上限 ${mb(maxBytes)}（不拒绝，但弱网用户会等很久）`,
      );
    }
  }

  return { ok: violations.length === 0, violations, warnings };
}

/** 把违规拼成一句中文，给 422 的 message 用。 */
export function describeViolations(violations = []) {
  return violations.map((item) => item.message).filter(Boolean).join('；');
}

/** 422 的 message：违规明细 + 处理建议。 */
export function complianceMessage(result) {
  const detail = describeViolations(result?.violations ?? []);
  return detail ? `视频不符合播放规格：${detail}。${COMPLIANCE_HINT}` : `视频不符合播放规格。${COMPLIANCE_HINT}`;
}

/** 写 audit_log 的 detail：一行代码 + 一行中文，方便后台检索。 */
export function describeWarnings(warnings = []) {
  return warnings.map((item) => `${item.code}: ${item.message}`).join(' / ');
}
