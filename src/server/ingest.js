/**
 * ingest.js — **入库管线**：`ingestAsset()` 是「单条上传」与「批量入口（目录扫描 /
 * 本地文件批量导入）」**共用的唯一写路径**。
 *
 * 为什么必须只有一处：4.23.17 之前，批量入口各自拼「POST 建草稿 + PUT /asset」两枪，
 * 一旦有人在某条批量路径上「顺手」直接 `putAsset + UPDATE`，就会绕过合规体检与字段门，
 * 60fps / 超 4K / 非 faststart 的视频重新进库，插件那边立刻「浏览器无法解码这段视频」。
 * 所以现在：**任何会写 R2 + D1 的入口都必须经过本文件的 ingestAsset()**，
 * 它一件事不漏地按固定顺序做：
 *
 *   ① 探测（mime / 宽高 / 时长 / fps / codec / faststart，只读文件头）
 *   ② 自动修正（不需要解码器的那些，能做就先做）
 *      · moov 在尾部 ⇒ 纯 JS 转封装前置（mp4-remux.js，画质与体积不变）
 *      · 只有帧率超标 ⇒ 有转码器时同分辨率降到 30fps（降帧优先，画质不动）
 *   ③ 播放合规体检（`checkVideoCompliance`，与本地工具同一份规则）⇒ 违规 422，一个字节不落盘
 *   ④ 必填字段门（kind/category/url/bytes/width/height）⇒ 缺任一该条失败，绝不静默入库
 *   ⑤ 每日配额
 *   ⑥ sha256（≤40MB）或采样指纹（>40MB，登记在 content_fingerprint 且报告里写明）
 *   ⑦ 写 R2 → **HEAD 回读**校验长度
 *   ⑧ D1 三值成对写（storage_key / bytes / sha256，走 setMediaIdentity）
 *   ⑨ 缩略图（客户端 canvas 帧 > 转码器抽帧 > 图片用原图当缩略图）
 *   ⑩ 1080p 变体（width>1920 或 height>1080 或 fps>30 才需要；逐条按变体规格体检后入库）
 *
 * 关于「自动转码」的边界（写下来免得后来人误以为是漏写）：
 * Cloudflare Workers 里**没有 ffmpeg**，也没有视频编码器。所以 `transcodeOriginal` /
 * `transcodeVariant` / `extractThumb` 是**可注入的**能力（`options.mediaTools`）：
 *   · 浏览器入口注入 canvas 抽帧（WebP 1280 宽）——这条是真的在跑；
 *   · 更重的转码由本机 ffmpeg（tools/prepare-upload.mjs 的同一套参数）或测试替身注入；
 *   · 什么都没注入时，管线**只做纯 JS 能做的**（faststart 转封装、图片缩略图），
 *     其余违规老实 422 并进导入报告，绝不假装修好了。
 */
import { all, first, nowMs, run } from './db.js';
import { Q } from './queries.js';
import {
  ALLOWED_MIME, MAX_UPLOAD_BYTES, isBundleMime, isVideoMime, limitForMime,
  readDurationMs, readMediaMeta, readVideoInfo,
} from '../core/image-meta.js';
import {
  COMPLIANCE_HINT, checkVideoCompliance, complianceMessage, describeWarnings,
} from './media-compliance.js';
import {
  badRequest, conflict, HttpError, importIncomplete, mediaNonCompliant, payloadTooLarge,
  storageVerifyFailed, tooManyRequests, unsupportedMedia,
} from '../core/errors.js';
import { ACTION, assertCan } from '../core/permissions.js';
import { assetKey, deleteAsset, putAsset, thumbKey, variantKey, verifyAsset } from './storage.js';
import { newId, safeJsonParse, sampleFingerprint, sha256Bytes } from './util.js';
import { MEDIA_ACTOR, setMediaIdentity } from './media-audit.js';
import { repairMp4Faststart } from './mp4-remux.js';
import { nextSortOrder } from '../core/ordering.js';
import { uniqueSlug } from '../core/slug.js';
import { AUDIT_ACTION, writeAudit } from './audit.js';

/** 大文件跳过完整 sha256 的阈值；测试可用 env.UPLOAD_HASH_LIMIT 调小来覆盖大文件分支。 */
export const HASH_LIMIT = 40 * 1024 * 1024;

/** 缩略图目标宽度（客户端 canvas / 转码器抽帧共用）。插件卡片最多 640 宽，1280 给 2x 屏。 */
export const THUMB_WIDTH = 1280;

/** 1080p 变体规格（与 media-compliance 的 variant 口径一致）。 */
export const VARIANT_MAX_WIDTH = 1920;
export const VARIANT_MAX_HEIGHT = 1080;
export const VARIANT_MAX_FPS = 30;

/** 必填字段：批量入口缺任一 ⇒ 该条失败（见 docs/UPLOAD-SOP.md「批量导入」）。 */
export const REQUIRED_FIELDS = Object.freeze(['kind', 'category', 'url', 'bytes', 'width', 'height']);

/** 自动修正项（报告里的 autoFixes）。名称是接口契约，不要随便改。 */
export const AUTO_FIX = Object.freeze({
  FASTSTART: 'faststart',
  FPS_DECIMATE: 'fps30',
  VARIANT_1080: 'variant1080p',
  THUMB: 'thumb',
  THUMB_FROM_ORIGINAL: 'thumbFromOriginal',
  SAMPLE_FINGERPRINT: 'sampleFingerprint',
});

/** 报告里的告警码（不算失败，但人要看见）。 */
export const IMPORT_WARNING = Object.freeze({
  THUMB_MISSING: 'thumb-missing',
  VARIANT_MISSING: 'variant-missing',
  VARIANT_REJECTED: 'variant-rejected',
  SHA_SAMPLED: 'sha256-sampled',
  COMPLIANCE: 'compliance-warning',
});

/** 失败码（报告里的 code）。 */
export const IMPORT_FAILURE = Object.freeze({
  MISSING_FIELD: 'missing-field',
  PROBE_FAILED: 'probe-failed',
  NOT_COMPLIANT: 'media_non_compliant',
  UNSUPPORTED: 'unsupported_media_type',
  TOO_LARGE: 'payload_too_large',
  STORAGE: 'storage-verify-failed',
  DUPLICATE: 'duplicate',
});

/**
 * 默认媒体工具集：**纯 JS 能做的都做，需要编解码器的一律缺省（null）**。
 * 调用方（浏览器 / 本地 ffmpeg / 测试替身）通过 `options.mediaTools` 或 `env.MEDIA_TOOLS` 补齐。
 * Workers 上 `env.MEDIA_TOOLS` 永远是空的（部署里没有 ffmpeg），于是走「能修则修、修不了 422」。
 */
export const DEFAULT_MEDIA_TOOLS = Object.freeze({
  /** moov 前移转封装（不需要解码器，Worker 里也能跑） */
  repackFaststart: repairMp4Faststart,
  /** 同分辨率降帧到 30fps；无编码器时为 null */
  transcodeOriginal: null,
  /** 生成 1080p@30 变体；无编码器时为 null */
  transcodeVariant: null,
  /** 抽帧生成 WebP 缩略图；无解码器时为 null（浏览器用 canvas 注入） */
  extractThumb: null,
});

/** 工具集解析：默认值 ← env.MEDIA_TOOLS ← 调用方 options.mediaTools。 */
function resolveMediaTools(env, options) {
  return {
    ...DEFAULT_MEDIA_TOOLS,
    ...(env && env.MEDIA_TOOLS ? env.MEDIA_TOOLS : {}),
    ...(options && options.mediaTools ? options.mediaTools : {}),
  };
}

// ---------------------------------------------------------------- 配额记账
let uploadUsageReady = null;
let warnedNoUsageTable = false;
async function supportsUploadUsage(env) {
  if (uploadUsageReady === true) return true;
  try {
    const rows = await all(env, Q.tableExists, 'upload_usage');
    if (rows.length > 0) {
      uploadUsageReady = true;
      return true;
    }
    if (!warnedNoUsageTable) {
      warnedNoUsageTable = true;
      console.warn('[upload] 没有 upload_usage 表（schema/013 未执行），跳过每日配额记账');
    }
    return false;
  } catch (error) {
    if (!warnedNoUsageTable) {
      warnedNoUsageTable = true;
      console.warn('[upload] 探测 upload_usage 表失败，跳过每日配额记账', error?.message ?? error);
    }
    return false;
  }
}

function usageDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

const DEFAULT_DAILY_BYTES = 1024 * 1024 * 1024;

/** 每日字节配额（默认 1 GiB / 账号 / 天，env.UPLOAD_DAILY_BYTES 可调）。 */
export async function assertDailyQuota(env, actor, bytes) {
  if (!(await supportsUploadUsage(env))) return;
  const limit = Number(env.UPLOAD_DAILY_BYTES ?? DEFAULT_DAILY_BYTES) || DEFAULT_DAILY_BYTES;
  try {
    const used = Number((await first(env, Q.uploadUsageGet, usageDay(), actor.id))?.bytes ?? 0);
    if (used + bytes > limit) {
      throw tooManyRequests('今天的上传容量已经用完，请明天再试');
    }
  } catch (error) {
    // 429 必须原样抛出去；其余（查库失败）只降级，不能让容量统计把上传卡死
    if (error instanceof HttpError) throw error;
    console.warn('[upload] 读取上传用量失败，跳过配额校验', error?.message ?? error);
  }
}

/** 记账失败不阻断上传：容量统计是审计用途，不能反过来把文件卡住。 */
export async function recordDailyUsage(env, actor, bytes) {
  if (!(await supportsUploadUsage(env))) return;
  try {
    await run(env, Q.uploadUsageAdd, usageDay(), actor.id, bytes);
  } catch (error) {
    console.warn('[upload] 记录上传用量失败', error?.message ?? error);
  }
}

/**
 * content_fingerprint 列来自 schema/013。列不在就跳过指纹去重（老库照常能传）。
 * 只缓存「有」这个结果：缺列时保持每次探测，避免测试/灰度环境切换后被永久写死。
 */
let fingerprintColumnReady = null;
export async function supportsFingerprintColumn(env) {
  if (fingerprintColumnReady === true) return true;
  try {
    const rows = await all(env, Q.wallpaperColumnExists, 'content_fingerprint');
    if (rows.length > 0) {
      fingerprintColumnReady = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 视频是否需要 1080p 变体（用户口径：宽>1920 或 高>1080 或 fps>30）。 */
export function needsVariant({ width, height, fps } = {}) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const f = Number(fps) || 0;
  return w > VARIANT_MAX_WIDTH || h > VARIANT_MAX_HEIGHT || f > VARIANT_MAX_FPS;
}

function hashLimitFor(env, options) {
  const raw = options?.hashLimit ?? env?.UPLOAD_HASH_LIMIT ?? HASH_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : HASH_LIMIT;
}

/** 一轮体检需要的输入。 */
function complianceInput(mime, meta, bytes, videoInfo) {
  return {
    mime,
    width: meta.width,
    height: meta.height,
    fps: videoInfo.fps,
    codec: videoInfo.codec,
    faststart: videoInfo.faststart,
    bytes: bytes.byteLength,
  };
}

function violationCodes(result) {
  return (result?.violations ?? []).map((item) => item.code);
}

/**
 * 只有 fps-too-high 一种违规 ⇒ 允许「降帧」自动修正（同分辨率重编码，画质不动）。
 * 分辨率/像素/编码/faststart 超出的一律**不自动修**：那需要真正的转码（工具侧），
 * 服务端硬猜会让「工具没跑」成为隐性路径。
 */
function onlyFpsViolation(result) {
  const codes = violationCodes(result);
  return codes.length > 0 && codes.every((code) => code === 'fps-too-high');
}

/**
 * 入库一条媒体。**这是唯一允许写 R2 + 媒体列的地方**。
 *
 * @param {object} env Cloudflare env（DB + BUCKET）
 * @param {object} actor 当前操作者（配额记账用）
 * @param {object} row 已存在的 wallpapers 行（id/slug/kind/category_id/tags/review_status/status/storage_key）
 * @param {object} asset `{ bytes, thumb?, variants? }`
 * @param {object} [options]
 * @param {object} [options.mediaTools] 覆盖 DEFAULT_MEDIA_TOOLS（转码器/抽帧器）
 * @param {number} [options.now]
 * @param {boolean} [options.strict] true 时必填字段缺失抛错（批量入口在报告里用 false）
 * @returns {Promise<object>} 入库结果（字段 + fixes/warnings + compliance）
 */
export async function ingestAsset(env, actor, row, asset, options = {}) {
  if (!row || !row.id) throw badRequest('缺少壁纸记录');
  if (!asset || !asset.bytes || !asset.bytes.byteLength) throw badRequest('文件为空');

  const tools = resolveMediaTools(env, options);
  const now = options.now ?? nowMs();
  const hashLimit = hashLimitFor(env, options);
  const fixes = [];
  const warnings = [];

  let bytes = asset.bytes;
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(`文件不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  }

  // ① 探测
  let meta = readMediaMeta(bytes);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的文件类型');
  if (!ALLOWED_MIME.includes(meta.mime)) throw unsupportedMedia(`不支持的类型：${meta.mime}`);
  if (bytes.byteLength > limitForMime(meta.mime)) {
    throw payloadTooLarge(`${meta.mime} 最大 ${Math.round(limitForMime(meta.mime) / 1024 / 1024)} MB`);
  }

  // ②a 自动修正：moov 在尾部 ⇒ 纯 JS 转封装（不重新编码）
  if (meta.mime === 'video/mp4' && typeof tools.repackFaststart === 'function') {
    const before = readVideoInfo(bytes, meta.mime);
    if (before.faststart === false) {
      const repaired = await tools.repackFaststart(bytes);
      if (repaired && repaired.byteLength) {
        const afterMeta = readMediaMeta(repaired);
        const afterInfo = readVideoInfo(repaired, afterMeta.mime ?? meta.mime);
        if (afterMeta.mime === 'video/mp4' && afterInfo.faststart === true) {
          bytes = repaired;
          meta = afterMeta;
          fixes.push({ code: AUTO_FIX.FASTSTART, message: 'moov 前置转封装（不重新编码，画质不变）' });
        }
      }
    }
  }

  // ③ 体检（+ ②b 只降帧的自动修正）
  let videoInfo = readVideoInfo(bytes, meta.mime);
  let compliance = isVideoMime(meta.mime)
    ? checkVideoCompliance(complianceInput(meta.mime, meta, bytes, videoInfo))
    : null;

  if (compliance && !compliance.ok && onlyFpsViolation(compliance) && typeof tools.transcodeOriginal === 'function') {
    const transcoded = await tools.transcodeOriginal(bytes, {
      maxWidth: 3840, maxHeight: 2160, maxFps: VARIANT_MAX_FPS, mime: meta.mime,
    });
    if (transcoded && transcoded.byteLength) {
      const nextMeta = readMediaMeta(transcoded);
      const nextInfo = readVideoInfo(transcoded, nextMeta.mime ?? meta.mime);
      const nextCheck = isVideoMime(nextMeta.mime)
        ? checkVideoCompliance(complianceInput(nextMeta.mime, nextMeta, transcoded, nextInfo))
        : null;
      if (nextMeta.mime && nextCheck && nextCheck.ok) {
        bytes = transcoded;
        meta = nextMeta;
        videoInfo = nextInfo;
        compliance = nextCheck;
        fixes.push({
          code: AUTO_FIX.FPS_DECIMATE,
          message: `帧率降到 ${VARIANT_MAX_FPS}fps（同分辨率重编码，画质不变）`,
        });
      }
    }
  }

  if (compliance && !compliance.ok) {
    throw mediaNonCompliant(complianceMessage(compliance), {
      ...complianceInput(meta.mime, meta, bytes, videoInfo),
      violations: compliance.violations,
      warnings: compliance.warnings,
      hint: COMPLIANCE_HINT,
    });
  }

  const mime = meta.mime;
  const width = meta.width;
  const height = meta.height;
  const bundle = isBundleMime(mime);

  // ④ 必填字段门：kind / category / url / bytes / width / height
  //    url 由 storage_key 派生，所以先算出候选 key 再一起判；zip 资源包没有宽高，豁免。
  //    category 只在**批量入口**强制（A/B 一定带分类，缺了就是导入逻辑出错）；
  //    单条上传沿用「可以先存草稿、稍后再归类」的老行为，不强加分类。
  const requireCategory = options.requireCategory === true;
  const missing = [];
  if (!row.kind) missing.push('kind');
  if (requireCategory && !row.category_id) missing.push('category');
  if (!(bytes.byteLength > 0)) missing.push('bytes');
  if (!bundle) {
    if (!(Number(width) > 0)) missing.push('width');
    if (!(Number(height) > 0)) missing.push('height');
  }
  if (missing.length) {
    throw importIncomplete(
      `缺少必填字段：${missing.join(' / ')}`
        + (missing.includes('width') || missing.includes('height')
          ? '（文件头里探测不到宽高，插件会按「未知尺寸」处理，先修好再传）'
          : ''),
      { code: IMPORT_FAILURE.MISSING_FIELD, missing, mime, hint: COMPLIANCE_HINT },
    );
  }

  // ⑤ 配额（先校验再写盘：超了直接 429，别等 50MB 传完才拒）
  await assertDailyQuota(env, actor, bytes.byteLength);

  // ⑥ 内容哈希：≤40MB 算完整 sha256；>40MB 采样指纹（写 content_fingerprint，不伪造 sha256）
  let sha = null;
  let fingerprint = null;
  if (bytes.byteLength <= hashLimit) {
    sha = await sha256Bytes(bytes);
    const duplicate = await first(env, Q.wallpaperShaTaken, sha);
    if (duplicate && duplicate.id !== row.id) {
      throw conflict('这个文件已经在库里了', {
        code: IMPORT_FAILURE.DUPLICATE, wallpaperId: duplicate.id, title: duplicate.title,
      });
    }
  } else {
    fingerprint = await sampleFingerprint(bytes);
    warnings.push({
      code: IMPORT_WARNING.SHA_SAMPLED,
      message: `>${Math.round(hashLimit / 1024 / 1024)}MB 不算完整 sha256，改记采样指纹 content_fingerprint（${fingerprint.slice(0, 16)}…）`,
    });
    if (await supportsFingerprintColumn(env)) {
      // 查库失败只降级（老库/测试假环境缺这条查询时不能让一次正常上传 500）
      let duplicate = null;
      try {
        duplicate = await first(env, Q.wallpaperFingerprintTaken, fingerprint);
      } catch (error) {
        console.warn('[ingest] 指纹去重查询失败，跳过', error?.message ?? error);
      }
      if (duplicate && duplicate.id !== row.id) {
        throw conflict('这个文件已经在库里了', {
          code: IMPORT_FAILURE.DUPLICATE, wallpaperId: duplicate.id, title: duplicate.title,
        });
      }
    }
  }

  const keySeed = sha ?? fingerprint;
  const key = assetKey(row.id, keySeed, mime);

  // ⑦ 写 R2 + HEAD 回读
  await putAsset(env, key, bytes, mime);
  const check = await verifyAsset(env, key, bytes.byteLength);
  if (!check.ok) {
    await deleteAsset(env, key);
    throw storageVerifyFailed(check.reason === 'size'
      ? `上传校验失败：R2 里的对象大小不一致（写入 ${bytes.byteLength}，实际 ${check.size}）`
      : '上传校验失败：R2 里找不到刚写入的对象，请重试');
  }
  if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);

  // ⑧ D1 三值成对写（storage_key / bytes / sha256 必须来自同一份已校验对象）
  const durationMs = readDurationMs(bytes, mime);
  const nextKind = isVideoMime(mime)
    ? 'dynamic'
    : mime.startsWith('image/') ? 'static' : row.kind;
  await setMediaIdentity(env, row.id, {
    storageKey: key,
    mime,
    bytes: check.size,
    width: bundle ? null : width,
    height: bundle ? null : height,
    durationMs,
    sha256: sha,
    kind: nextKind,
    actor: row.storage_key ? MEDIA_ACTOR.REPLACE : MEDIA_ACTOR.UPLOAD,
    updatedAt: now,
  });
  await run(env, Q.markWallpaperVerified, now, videoInfo.codec, videoInfo.faststart, row.id);

  if (!sha && fingerprint && (await supportsFingerprintColumn(env))) {
    try {
      await run(env, Q.updateWallpaperFingerprint, fingerprint, now, row.id);
    } catch (error) {
      console.warn('[ingest] 写入 content_fingerprint 失败', error?.message ?? error);
    }
  }

  // ⑨ 缩略图
  let thumbBytes = asset.thumb && asset.thumb.byteLength ? asset.thumb : null;
  let thumbSource = 'client';
  if (!thumbBytes && typeof tools.extractThumb === 'function') {
    try {
      thumbBytes = await tools.extractThumb(bytes, { width: THUMB_WIDTH, mime, videoInfo });
      thumbSource = 'extract';
    } catch (error) {
      console.warn('[ingest] 抽帧失败', error?.message ?? error);
    }
  }
  let finalThumbKey = null;
  if (thumbBytes) {
    const thumbMeta = readMediaMeta(thumbBytes);
    if (!thumbMeta.mime || !thumbMeta.mime.startsWith('image/')) {
      warnings.push({ code: 'thumb-invalid', message: '缩略图不是图片，已忽略' });
      thumbBytes = null;
    } else {
      const thumbSha = await sha256Bytes(thumbBytes);
      finalThumbKey = thumbKey(row.id, thumbSha, thumbMeta.mime);
      await putAsset(env, finalThumbKey, thumbBytes, thumbMeta.mime);
      const thumbCheck = await verifyAsset(env, finalThumbKey, thumbBytes.byteLength);
      if (!thumbCheck.ok) {
        await deleteAsset(env, finalThumbKey);
        finalThumbKey = null;
        warnings.push({ code: 'thumb-verify-failed', message: '缩略图回读校验失败，已丢弃' });
      } else {
        await run(env, Q.updateWallpaperThumb, finalThumbKey, now, row.id);
        fixes.push({
          code: AUTO_FIX.THUMB,
          message: `缩略图 ${thumbMeta.width || '?'}×${thumbMeta.height || '?'} ${thumbMeta.mime}（${thumbSource === 'client' ? '浏览器 canvas' : '解码器抽帧'}）`,
        });
      }
    }
  }
  if (!finalThumbKey) {
    if (mime.startsWith('image/')) {
      // 图片：原图本身就是可用的缩略图（dto 的兜底），但这里显式落 thumb_key，
      // 免得「有没有缩略图」在两处各算一遍。
      finalThumbKey = key;
      await run(env, Q.updateWallpaperThumb, finalThumbKey, now, row.id);
      fixes.push({ code: AUTO_FIX.THUMB_FROM_ORIGINAL, message: '没有独立缩略图，用原图当缩略图' });
    } else {
      warnings.push({
        code: IMPORT_WARNING.THUMB_MISSING,
        message: '没有生成缩略图（本运行时没有解码器），插件卡片会没有封面',
      });
    }
  }

  // ⑩ 1080p 变体
  const variants = [];
  if (isVideoMime(mime) && needsVariant({ width, height, fps: videoInfo.fps })) {
    const supplied = Array.isArray(asset.variants) ? asset.variants : [];
    const candidates = [...supplied];
    if (!candidates.length && typeof tools.transcodeVariant === 'function') {
      try {
        const generated = await tools.transcodeVariant(bytes, {
          maxWidth: VARIANT_MAX_WIDTH, maxFps: VARIANT_MAX_FPS, mime,
        });
        if (generated && generated.byteLength) candidates.push({ bytes: generated, height: 1080, label: '1080p' });
      } catch (error) {
        console.warn('[ingest] 生成 1080p 变体失败', error?.message ?? error);
      }
    }
    for (const candidate of candidates) {
      if (!candidate || !candidate.bytes || !candidate.bytes.byteLength) continue;
      const vMeta = readMediaMeta(candidate.bytes);
      if (vMeta.mime !== 'video/mp4') {
        warnings.push({
          code: IMPORT_WARNING.VARIANT_REJECTED,
          message: `变体必须是 H.264 MP4（收到 ${vMeta.mime ?? '无法识别'}），已跳过`,
        });
        continue;
      }
      const vInfo = readVideoInfo(candidate.bytes, vMeta.mime);
      const verdict = checkVideoCompliance(
        complianceInput(vMeta.mime, vMeta, candidate.bytes, vInfo),
        { role: 'variant' },
      );
      if (!verdict.ok) {
        warnings.push({
          code: IMPORT_WARNING.VARIANT_REJECTED,
          message: `变体不合规：${describeWarnings(verdict.violations)}`,
        });
        continue;
      }
      const vSha = await sha256Bytes(candidate.bytes);
      const vKey = variantKey(row.id, vSha, vMeta.height ?? candidate.height ?? 1080, vMeta.mime);
      await putAsset(env, vKey, candidate.bytes, vMeta.mime);
      const vCheck = await verifyAsset(env, vKey, candidate.bytes.byteLength);
      if (!vCheck.ok) {
        await deleteAsset(env, vKey);
        warnings.push({ code: IMPORT_WARNING.VARIANT_REJECTED, message: '变体回读校验失败，已丢弃' });
        continue;
      }
      variants.push({
        label: vMeta.height ? `${vMeta.height}p` : '1080p',
        height: vMeta.height ?? null,
        width: vMeta.width ?? null,
        key: vKey,
        bytes: vCheck.size,
        sha256: vSha,
      });
    }
    if (variants.length) {
      variants.sort((a, b) => a.bytes - b.bytes);
      await run(env, Q.updateWallpaperVariants, JSON.stringify(variants), now, row.id);
      fixes.push({
        code: AUTO_FIX.VARIANT_1080,
        message: `生成 1080p 变体 ${variants.length} 档（${Math.round(variants[0].bytes / 1024)}KB）`,
      });
    } else {
      warnings.push({
        code: IMPORT_WARNING.VARIANT_MISSING,
        message: `源 ${width}×${height}@${videoInfo.fps ?? '?'}fps 超出 1080p 上限，但没有可用变体：`
          + '本运行时没有视频编码器（Worker 无 ffmpeg）。插件会退化为「现场转码」；'
          + '要生成变体请用 tools/prepare-upload.mjs，或把 xxx.1080p.mp4 与源文件一起导入（自动配对）',
      });
    }
  }

  // 配额记账放在落盘校验通过之后：失败的上传不该占用户当天的额度
  await recordDailyUsage(env, actor, check.size);

  if (compliance && compliance.warnings.length) {
    warnings.push({
      code: IMPORT_WARNING.COMPLIANCE,
      message: describeWarnings(compliance.warnings),
    });
  }

  const fields = {
    slug: row.slug,
    kind: nextKind,
    category: row.category_id,
    url: `/media/${key}`,
    bytes: check.size,
    sha256: sha,
    width: bundle ? null : width,
    height: bundle ? null : height,
    durationMs,
    thumbUrl: finalThumbKey ? `/media/${finalThumbKey}` : null,
    variants: variants.length,
    tags: safeJsonParse(row.tags, []),
    review_status: row.review_status ?? 'pending',
    status: row.status ?? 'draft',
    mime,
  };

  // 兜底自检：字段门在落盘前已经判过，这里再对一遍**写完之后的事实**——
  // 任何一项空掉都说明管线内部错了，宁可让这条进失败报告，也不要静默入库。
  const postMissing = REQUIRED_FIELDS.filter((field) => {
    if (field === 'category') return requireCategory && !fields.category;
    if (field === 'width' || field === 'height') return !bundle && !(Number(fields[field]) > 0);
    return fields[field] === null || fields[field] === undefined || fields[field] === '';
  });
  if (postMissing.length) {
    throw importIncomplete(`入库后字段自检失败：${postMissing.join(' / ')}`, {
      code: IMPORT_FAILURE.MISSING_FIELD, missing: postMissing, fields,
    });
  }

  return {
    ...fields,
    key,
    storageKey: key,
    fingerprint,
    fingerprintMode: sha ? 'sha256' : 'sampled',
    fps: videoInfo.fps,
    codec: videoInfo.codec,
    faststart: videoInfo.faststart,
    compliance: compliance ? { warnings: compliance.warnings } : null,
    fixes,
    warnings,
    autoFixes: [...new Set(fixes.map((item) => item.code))],
  };
}

/**
 * 新建一条壁纸草稿（单条 create 与批量导入共用）。
 * 只写「内容字段」，媒体列留给 ingestAsset()——这样任何入口都不可能带着
 * 一半的媒体信息进库（storage_key 有、sha256 没有那种）。
 */
export async function createWallpaperRow(env, actor, input, { now = nowMs() } = {}) {
  const slug = await uniqueSlug(
    input.slug || input.title,
    async (candidate) => Boolean(await first(env, Q.wallpaperSlugTaken, candidate)),
    { fallback: 'wallpaper' },
  );
  const sortOrder = nextSortOrder([{ sort_order: Number((await first(env, Q.maxWallpaperSort))?.m ?? 0) }]);
  const id = newId('wp');
  await run(
    env,
    Q.insertWallpaper,
    id, slug, input.title, input.description ?? '', input.subtag ?? '',
    input.reviewStatus ?? 'pending', input.categoryId ?? null, input.kind, 'draft',
    null, null, 0, null, null, null,
    JSON.stringify(input.tags ?? []), input.featured ? 1 : 0, sortOrder, actor.id, now, now, null,
  );
  return { id, slug, sortOrder };
}

/**
 * 批量入口的单条导入：**建草稿 + 入库**在一次调用里完成。
 *
 * 与「先 POST 建草稿、再 PUT /asset」的差别只有一处，但很关键：
 * 失败时把刚建的草稿**删掉**，于是「库里有一条没文件的僵尸记录」不会发生
 * （旧批量入口的每条失败都会留下一条空草稿）。
 *
 * @param {object} params
 * @param {object} params.env
 * @param {object} params.actor
 * @param {object} params.item `{ title, kind?, categoryId, tags?, description?, thumb?, variants?, publish?, reportId? }`
 * @param {object} [params.options] 透传给 ingestAsset（mediaTools / hashLimit / now）
 * @returns {Promise<object>} 报告条目（status: imported | reused | failed）
 */
export async function importMedia({ env, actor, item, options = {} }) {
  const title = String(item?.title ?? '').trim();
  const base = { title: title || String(item?.fileName ?? ''), reportId: item?.reportId ?? null };
  let created = null;

  try {
    if (!item || !item.bytes || !item.bytes.byteLength) throw badRequest('文件为空');
    if (!title) throw importIncomplete('缺少标题（批量导入用文件名去掉扩展名兜底）', {
      code: IMPORT_FAILURE.MISSING_FIELD, missing: ['title'],
    });

    const now = options.now ?? nowMs();
    const hashLimit = hashLimitFor(env, options);

    // 幂等①：能算 sha256 的先查重（同一文件重复导入 ⇒ 复用，不建新行）
    if (item.bytes.byteLength <= hashLimit) {
      const sha = await sha256Bytes(item.bytes);
      const existing = await first(env, Q.wallpaperShaTaken, sha);
      if (existing) return { ...base, status: 'reused', wallpaperId: existing.id, reusedTitle: existing.title, reason: null, autoFixes: [] };
    } else {
      // >40MB 没有完整 sha256：退到「同名 + 同大小」这一层（报告里说明依据）
      const sameName = await first(env, Q.wallpaperTitleBytesTaken, title, item.bytes.byteLength);
      if (sameName) {
        return {
          ...base, status: 'reused', wallpaperId: sameName.id, reusedTitle: sameName.title,
          reason: null, autoFixes: [],
        };
      }
    }

    if (item.publish) assertCan(actor, ACTION.WALLPAPER_PUBLISH);

    created = await createWallpaperRow(env, actor, {
      title,
      description: item.description ?? '',
      subtag: item.subtag ?? '',
      reviewStatus: item.reviewStatus ?? 'pending',
      kind: item.kind ?? 'static',
      categoryId: item.categoryId ?? null,
      tags: item.tags ?? [],
      slug: item.slug ?? '',
      featured: false,
    }, { now });

    await writeAudit(env, {
      actor,
      action: AUDIT_ACTION.WALLPAPER_CREATE,
      targetType: 'wallpaper',
      targetId: created.id,
      detail: `${title}（批量导入 · 草稿）`,
    });

    const row = await first(env, Q.wallpaperById, created.id);
    if (!row) throw new Error('新建的壁纸记录读不回来');

    const result = await ingestAsset(env, actor, row, {
      bytes: item.bytes,
      thumb: item.thumb,
      variants: item.variants,
    }, { ...options, now, requireCategory: true });

    if (item.publish) {
      await run(env, Q.publishWallpaper, now, now, created.id);
    }

    await writeAudit(env, {
      actor,
      action: AUDIT_ACTION.WALLPAPER_ASSET,
      targetType: 'wallpaper',
      targetId: created.id,
      detail: `${result.mime} ${result.width ?? '?'}x${result.height ?? '?'} `
        + `${Math.round(result.bytes / 1024)}KB${result.durationMs ? ` ${(result.durationMs / 1000).toFixed(1)}s` : ''}`
        + `（批量导入 · ${item.reportId ?? 'no-report'}）`,
    });

    return {
      ...base,
      status: 'imported',
      wallpaperId: created.id,
      reason: null,
      autoFixes: result.autoFixes,
      fixes: result.fixes,
      warnings: result.warnings,
      fields: {
        url: result.url, bytes: result.bytes, sha256: result.sha256, width: result.width,
        height: result.height, thumbUrl: result.thumbUrl, variants: result.variants,
        durationMs: result.durationMs, kind: result.kind, mime: result.mime,
      },
    };
  } catch (error) {
    // 失败 ⇒ 把刚建的草稿删掉：失败条目绝不能以空记录的形式留在库里
    if (created) {
      try {
        await run(env, Q.deleteWallpaper, created.id);
      } catch (rollbackError) {
        console.error('[ingest] 回滚草稿失败', created.id, rollbackError?.message ?? rollbackError);
      }
    }
    const status = error instanceof HttpError ? error.status : 500;
    return {
      ...base,
      status: 'failed',
      wallpaperId: null,
      code: (error instanceof HttpError ? error.code : 'internal_error')
        ?? (status === 422 ? IMPORT_FAILURE.NOT_COMPLIANT : null),
      httpStatus: status,
      reason: error?.message ?? '导入失败',
      details: error instanceof HttpError ? error.details : null,
      autoFixes: [],
      fixes: [],
      warnings: [],
    };
  }
}

/** 批量报告汇总（接口与界面共用同一形状）。 */
export function buildImportReport(reportId, items) {
  const list = Array.isArray(items) ? items : [];
  return {
    ok: list.every((item) => item.status !== 'failed'),
    reportId: reportId ?? newId('report'),
    imported: list.filter((item) => item.status === 'imported').length,
    reused: list.filter((item) => item.status === 'reused').length,
    failed: list.filter((item) => item.status === 'failed').length,
    skipped: list.filter((item) => item.status === 'skipped').length,
    items: list,
  };
}
