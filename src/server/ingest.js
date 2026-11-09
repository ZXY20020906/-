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
  ALLOWED_MIME, MAX_UPLOAD_BYTES, detectFaststart, isBundleMime, isVideoMime, limitForMime,
  readDurationMs, readMediaMeta, readVideoAudio, readVideoFps, readVideoInfo,
} from '../core/image-meta.js';
import {
  COMPLIANCE_HINT, checkVideoCompliance, complianceMessage, describeWarnings,
} from './media-compliance.js';
import {
  badRequest, conflict, HttpError, importIncomplete, mediaNonCompliant, payloadTooLarge,
  petPackageInvalid, storageVerifyFailed, tooManyRequests, unsupportedMedia,
} from '../core/errors.js';
import { ACTION, assertCan } from '../core/permissions.js';
import { assetKey, deleteAsset, posterKey, putAsset, thumbKey, variantKey, verifyAsset } from './storage.js';
import { newId, safeJsonParse, sampleFingerprint, sha256Bytes } from './util.js';
import { MEDIA_ACTOR, setMediaIdentity } from './media-audit.js';
import { repairMp4Faststart } from './mp4-remux.js';
import {
  HASH_LIMIT_BYTES, ORIGINAL_MAX_HEIGHT, ORIGINAL_MAX_WIDTH, POSTER_WIDTH, TARGET_FPS, THUMB_WIDTH,
  UPLOAD_DAILY_BYTES, VARIANT_MAX_WIDTH,
} from '../core/media-limits.js';
import { VARIANT_KIND, labelForVariant, needsVariant, variantKind } from '../core/variant-label.js';
import { isPlayable, variantReasonFor } from '../core/variant-reason.js';
import { nextSortOrder } from '../core/ordering.js';
import { parsePetPackage, petMarker } from './pet-package.js';
import { uniqueSlug } from '../core/slug.js';
import { AUDIT_ACTION, writeAudit } from './audit.js';
import { rebuildSnapshotQuietly } from './snapshot.js';

/**
 * 大文件跳过完整 sha256 的阈值（40MB，见 core/media-limits.js）；
 * 测试可用 env.UPLOAD_HASH_LIMIT 调小来覆盖大文件分支。
 * 这里 re-export 是为了兼容 `routes/wallpapers.js` 的转发与 `tests/upload-limits.test.js` 的引用。
 */
export const HASH_LIMIT = HASH_LIMIT_BYTES;

/** 缩略图目标宽度（客户端 canvas / 转码器抽帧共用）。插件卡片最多 640 宽，1280 给 2x 屏。 */
export { THUMB_WIDTH };

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
  POSTER: 'poster',
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
  /**
   * 抽首帧生成 1280 宽 WebP 海报；Worker 里没有解码器（null）。
   * 浏览器/本地 ffmpeg 可以注入；不注入时由调用方直接传 `asset.poster`。
   * 两者都没有 → poster_key 保持 NULL，公开 DTO 的 posterUrl 也是 null（不假装有图）。
   */
  extractPoster: null,
  /**
   * 可选：更完整的技术探测（ffprobe 类工具可返回 `{ fps, codec, pixFmt, hasAudio }`）。
   * Worker 默认没有，ingest 只用纯 JS 能读到的 fps/codec/hasAudio；pix_fmt 留给回填/工具。
   */
  probeTech: null,
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

/** 每日字节配额（默认 1 GiB / 账号 / 天，env.UPLOAD_DAILY_BYTES 可调）。 */
export async function assertDailyQuota(env, actor, bytes) {
  if (!(await supportsUploadUsage(env))) return;
  const limit = Number(env.UPLOAD_DAILY_BYTES ?? UPLOAD_DAILY_BYTES) || UPLOAD_DAILY_BYTES;
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
  } catch (error) {
    // 刻意不抛：schema/013 没跑（或测试假环境缺这条查询）时，指纹去重只是「锦上添花」，
    // 不能让一次正常上传 500。但必须留痕 —— 否则线上「指纹去重静默失效」会查不出来。
    console.warn('[ingest] 探测 content_fingerprint 列失败，本轮跳过指纹去重', error?.message ?? error);
    return false;
  }
}

/** 视频是否需要 1080p/30fps 变体（规则见 core/variant-label.js）。 */
export { needsVariant };

/**
 * schema/016 的元数据列是否已迁移（fps / pix_fmt / has_audio / poster_key）。
 * 只缓存「探测成功」的结果：老库（或测试假环境）缺列时每次都会重新探测，
 * 这样迁移一执行就自动生效，不用改代码或重启。
 */
let techColumnsCache = null;
export async function supportsTechColumns(env) {
  if (techColumnsCache) return techColumnsCache;
  try {
    const rows = await all(env, Q.wallpaperTechColumns);
    const names = new Set(rows.map((row) => row.name));
    techColumnsCache = {
      fps: names.has('fps'),
      pixFmt: names.has('pix_fmt'),
      hasAudio: names.has('has_audio'),
      poster: names.has('poster_key'),
    };
    return techColumnsCache;
  } catch (error) {
    // 探测失败不抛：元数据是「锦上添花」，不能反过来把上传卡死。
    console.warn('[ingest] 探测 schema/016 元数据列失败，本轮跳过技术元数据写入', error?.message ?? error);
    return null;
  }
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
      maxWidth: ORIGINAL_MAX_WIDTH, maxHeight: ORIGINAL_MAX_HEIGHT, maxFps: TARGET_FPS, mime: meta.mime,
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
          message: `帧率降到 ${TARGET_FPS}fps（同分辨率重编码，画质不变）`,
        });
      }
    }
  }

  let softReason = null;
  if (compliance && !compliance.ok) {
    softReason = variantReasonFor(compliance.violations);
    if (!softReason) {
      throw mediaNonCompliant(complianceMessage(compliance), {
        ...complianceInput(meta.mime, meta, bytes, videoInfo),
        violations: compliance.violations,
        warnings: compliance.warnings,
        hint: COMPLIANCE_HINT,
      });
    }
    warnings.push({
      code: IMPORT_WARNING.COMPLIANCE,
      message: `软违规，先入库为待转码草稿（${softReason}）：${complianceMessage(compliance)}`,
    });
    compliance = { ok: true, violations: [], warnings: compliance.warnings, soft: true };
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

  /**
   * ⑤b 桌宠包识别（门 1）。**在写 R2 之前判定**，坏包一个字节都不落盘：
   *   · 包里没有 pet.json ⇒ 普通 zip 资源包，走原通道；
   *   · 有 pet.json 但不合法 ⇒ 422 + 具体原因（工单要求"不许静默通过"）。
   * 元数据不新增数据库列，落进现有 `variants` JSON 列（见 petMarker 的注释）。
   */
  let petPackage = null;
  if (mime === 'application/zip') {
    petPackage = await parsePetPackage(bytes);
    if (petPackage.isPet && !petPackage.ok) {
      throw petPackageInvalid(`桌宠包不合法：${petPackage.reason}`, { reason: petPackage.reason });
    }
    // 「缺 pet.json 的 zip ⇒ 422」只在**目标是桌宠分类**时成立：
    // 普通分类里的 zip 仍然是资源包（助手皮肤 / 开机动画都靠它），不能被这条规则误伤。
    if (!petPackage.isPet && row.category_id) {
      // 查分类失败就按"不是桌宠分类"处理：一次 DB 抖动不能把普通 zip 上传变成 422
      const category = await first(env, Q.categoryById, row.category_id).catch(() => null);
      if (category?.slug === 'desktop-pet') {
        throw petPackageInvalid(
          '桌宠分类下的 zip 必须包含 pet.json（桌宠包）；普通资源包请上传到「助手皮肤」分类',
          { reason: 'missing-pet-json', category: 'desktop-pet' },
        );
      }
    }
  }

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
  let nextKind = isVideoMime(mime)
    ? 'dynamic'
    : mime.startsWith('image/') ? 'static' : row.kind;
  /**
   * 桌宠包**强制**归到 `kind='pet'`（问题 2）。
   *
   * 导入表单默认「壁纸」，用户不会为了一只桌宠专门改下拉；只靠表单会让
   * `kind=static` 和 `mime=application/zip` 长期自相矛盾（公开 DTO 靠 variant 蒙对，
   * 但所有按 kind 列过滤的地方都会漏）。这里以**包内容**为准，忽略表单选择，
   * 并在 fixes 里明确告诉用户"已按桌宠包归档"。
   */
  if (petPackage?.ok && nextKind !== 'pet') {
    fixes.push({
      code: 'petKind',
      message: `检测到桌宠包，已按桌宠归档（kind=pet），忽略表单选择的「${nextKind}」`,
    });
    nextKind = 'pet';
  }
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
  if (softReason) {
    await run(env, Q.setWallpaperVariantQueue, 1, softReason, 'draft', now, row.id);
  }

  // ⑧b schema/016 技术元数据（fps / pix_fmt / has_audio）。
  //     纯 JS 探测：fps/codec 由 readVideoInfo 给，hasAudio 由 readVideoAudio 给；
  //     pix_fmt 浏览器端读不出来（要解 SPS），只有注入的 probeTech（ffprobe 类）能给。
  //     拿不到就写 NULL —— 绝不因为「没有元数据」让入库失败。
  let pixFmt = null;
  let hasAudio = null;
  if (isVideoMime(mime)) {
    if (typeof tools.probeTech === 'function') {
      try {
        const probed = await tools.probeTech(bytes, { mime });
        if (probed && typeof probed === 'object') {
          pixFmt = typeof probed.pixFmt === 'string' && probed.pixFmt ? probed.pixFmt : null;
        }
      } catch (error) {
        warnings.push({ code: 'tech-probe-failed', message: `技术探测失败（元数据留空）：${error?.message ?? error}` });
      }
    }
    const detected = readVideoAudio(bytes, mime);
    hasAudio = detected === null ? null : (detected ? 1 : 0);
    const tech = await supportsTechColumns(env);
    if (tech) {
      try {
        await run(env, Q.updateWallpaperTech, videoInfo.fps ?? null, pixFmt, hasAudio, row.id);
      } catch (error) {
        // 列在、但 UPDATE 失败（极少见）：只告警，媒体本身已落盘成功
        console.warn('[ingest] 写入技术元数据失败', error?.message ?? error);
      }
    }
  }

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
  // 桌宠包：previews/ 第一张就是它的封面（工单：thumbUrl = previews 第一张）。
  // 走同一条缩略图通道（落 R2 → HEAD 回读 → 写 thumb_key），不额外发明一套存储。
  if (!thumbBytes && petPackage?.ok) {
    thumbBytes = petPackage.preview.bytes;
    thumbSource = 'pet-preview';
  }
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

  // ⑨b 首帧海报（v1 `posterUrl`）：调用方给 `asset.poster`，或注入 extractPoster 生成。
  //      Worker 里没有解码器，两者都没有就留 NULL —— 公开 DTO 的 posterUrl 也是 null，
  //      客户端回落到 thumbUrl；不拿缩略图冒充首帧（缩略图可能是 0.5s 处的封面帧）。
  let posterStored = null;
  const posterColumns = await supportsTechColumns(env);
  if (posterColumns?.poster) {
    let posterBytes = asset.poster && asset.poster.byteLength ? asset.poster : null;
    if (!posterBytes && typeof tools.extractPoster === 'function') {
      try {
        posterBytes = await tools.extractPoster(bytes, { width: POSTER_WIDTH, mime, videoInfo });
      } catch (error) {
        console.warn('[ingest] 抽首帧失败', error?.message ?? error);
        warnings.push({ code: 'poster-failed', message: `首帧海报生成失败：${error?.message ?? error}` });
      }
    }
    if (posterBytes) {
      const posterMeta = readMediaMeta(posterBytes);
      if (!posterMeta.mime || !posterMeta.mime.startsWith('image/')) {
        warnings.push({ code: 'poster-invalid', message: '首帧海报不是图片，已忽略' });
      } else {
        const posterSha = await sha256Bytes(posterBytes);
        const key = posterKey(row.id, posterSha, posterMeta.mime);
        await putAsset(env, key, posterBytes, posterMeta.mime);
        const posterCheck = await verifyAsset(env, key, posterBytes.byteLength);
        if (!posterCheck.ok) {
          await deleteAsset(env, key);
          warnings.push({ code: 'poster-verify-failed', message: '首帧海报回读校验失败，已丢弃' });
        } else {
          await run(env, Q.updateWallpaperPoster, key, row.id);
          posterStored = key;
          fixes.push({
            code: AUTO_FIX.POSTER,
            message: `首帧海报 ${posterMeta.width || '?'}×${posterMeta.height || '?'} ${posterMeta.mime}`,
          });
        }
      }
    }
  }

  // ⑩ 变体（1080p 降分辨率档 / 同分辨率 30fps 档）
  const variants = [];
  if (isVideoMime(mime) && needsVariant({ width, height, fps: videoInfo.fps })) {
    const supplied = Array.isArray(asset.variants) ? asset.variants : [];
    const candidates = [...supplied];
    if (!candidates.length && typeof tools.transcodeVariant === 'function') {
      try {
        const generated = await tools.transcodeVariant(bytes, {
          maxWidth: VARIANT_MAX_WIDTH, maxFps: TARGET_FPS, mime,
        });
        if (generated && generated.byteLength) {
          candidates.push({ bytes: generated, kind: VARIANT_KIND.DOWNSCALE });
        }
      } catch (error) {
        console.warn('[ingest] 生成 1080p 变体失败', error?.message ?? error);
      }
    }
    // label 与 key 后缀只用 core/variant-label.js 这一处口径（原片尺寸/帧率一并传进去，
    // 它才能分清「降分辨率」和「同分辨率降帧」——两者高度可能一样）。
    const original = { width, height, fps: videoInfo.fps };
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
      // 先定档位（降分辨率 / 同分辨率降帧），label、key 后缀、合规口径三处都从这一个 spec 走。
      const spec = {
        kind: candidate.kind,
        width: vMeta.width ?? null,
        height: vMeta.height ?? null,
        fps: vInfo.fps ?? null,
        original,
      };
      const kind = variantKind(spec);
      // 变体的宽度上限随档位走：1080p 档 ≤1920；同分辨率降帧档的上限就是**原画宽度**
      // （否则 4K@30 会被 1080p 那条 1920 上限误杀 —— 存量 4K30 档就是这么来的）。
      const variantLimits = kind === VARIANT_KIND.FPS && Number(width) > 0
        ? { variantMaxWidth: width }
        : {};
      const verdict = checkVideoCompliance(
        complianceInput(vMeta.mime, vMeta, candidate.bytes, vInfo),
        { role: 'variant', limits: variantLimits },
      );
      if (!verdict.ok) {
        warnings.push({
          code: IMPORT_WARNING.VARIANT_REJECTED,
          message: `变体不合规：${describeWarnings(verdict.violations)}`,
        });
        continue;
      }
      const vSha = await sha256Bytes(candidate.bytes);
      const vKey = variantKey(row.id, vSha, spec, vMeta.mime);
      await putAsset(env, vKey, candidate.bytes, vMeta.mime);
      const vCheck = await verifyAsset(env, vKey, candidate.bytes.byteLength);
      if (!vCheck.ok) {
        await deleteAsset(env, vKey);
        warnings.push({ code: IMPORT_WARNING.VARIANT_REJECTED, message: '变体回读校验失败，已丢弃' });
        continue;
      }
      variants.push({
        label: labelForVariant(spec),
        kind,
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
    // 首帧海报：没有就是 null（客户端回落到 thumbUrl）
    posterUrl: posterStored ? `/media/${posterStored}` : null,
    fps: videoInfo.fps ?? null,
    codec: videoInfo.codec ?? null,
    pixFmt,
    hasAudio: hasAudio === null ? null : hasAudio === 1,
    variants: variants.length,
    tags: safeJsonParse(row.tags, []),
    review_status: row.review_status ?? 'pending',
    status: softReason ? 'draft' : (row.status ?? 'draft'),
    needsVariant: Boolean(softReason),
    variantReason: softReason,
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

  /**
   * ⑪ 桌宠元数据落库（门 1）。
   *
   * 写进 `variants` 列的**保留项**（不是新列，也不是新表）：
   * `variantsDto()` 只挑「有 key 且 bytes>0」的变体项，所以公开的 `variants` 字段
   * 一个字节都不会变；`playable` 的 SQL 也只会看 width/height 非空的变体项。
   * 读取见 `dto.js` 的 `pet` 字段。
   */
  let petInfo = null;
  if (petPackage?.ok) {
    petInfo = { ...petPackage.pet, previewKey: finalThumbKey };
    try {
      const current = await first(env, Q.wallpaperById, row.id);
      const list = safeJsonParse(current?.variants, [])
        .filter((item) => !(item && item.kind === 'pet'));
      list.push(petMarker(petPackage.pet, finalThumbKey));
      await run(env, Q.updateWallpaperVariants, JSON.stringify(list), now, row.id);
      fixes.push({
        code: 'petPackage',
        message: `桌宠包 ${petPackage.pet.id ?? row.slug}：${petPackage.pet.frames.length} 行 × ${petPackage.pet.columns} 列，`
          + `${petPackage.pet.tracks.length} 个状态（${petPackage.pet.tracks.join('/')}），预览 ${petPackage.previewCount} 张`,
      });
    } catch (error) {
      // 元数据写不进去不该让整次上传失败：包已经在库里，补一次重建即可
      console.warn('[ingest] 桌宠元数据写入失败', error?.message ?? error);
      warnings.push({ code: 'pet-meta-failed', message: '桌宠元数据写入失败，条目已入库但列表缺少 pet 字段' });
    }
  }

  // ---- 阶段三触发点 ①：上传完成 ---------------------------------------------------
  // ingestAsset() 是「单条上传 / 换文件 / 批量导入」唯一的写路径，所以这一处就覆盖了
  // 所有「素材落盘」的入口。失败只记日志，不影响这次上传的返回值（见 snapshot.js）。
  await rebuildSnapshotQuietly(env, '上传完成');

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
 * 分片上传超过内存阈值时的**流式入库**。
 *
 * 和 ingestAsset 同一套规则（探测/合规/指纹/HEAD 回读/媒体三值成对写/配额），
 * 唯一区别是不把整文件读进内存：只读首尾各 4MB 做探测与采样指纹，
 * 再用 `BUCKET.put(finalKey, source.body)` 流复制。
 *
 * 这样「写 R2 / 写 D1」仍然只发生在 ingest.js 里，路由层不直接碰存储。
 */
export const MULTIPART_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const STREAM_PROBE_BYTES = 4 * 1024 * 1024;

async function readRangeBytes(env, key, offset, length) {
  const object = await env.BUCKET.get(key, { range: { offset, length } });
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

export async function ingestStreamedAsset(env, actor, row, source) {
  if (!row || !row.id) throw badRequest('缺少壁纸记录');
  if (!source || !source.key) throw badRequest('缺少临时对象');
  const size = Number(source.size ?? 0);
  if (!(size > 0)) throw badRequest('临时对象为空');
  if (size > MULTIPART_MAX_BYTES) throw payloadTooLarge('文件不能超过 2GB');

  const head = await readRangeBytes(env, source.key, 0, Math.min(STREAM_PROBE_BYTES, size));
  if (!head) throw badRequest('临时对象不存在');
  const tail = size > STREAM_PROBE_BYTES
    ? await readRangeBytes(env, source.key, Math.max(0, size - STREAM_PROBE_BYTES), Math.min(STREAM_PROBE_BYTES, size))
    : new Uint8Array(0);

  const meta = readMediaMeta(head);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的文件类型');
  if (!ALLOWED_MIME.includes(meta.mime)) throw unsupportedMedia(`不支持的类型：${meta.mime}`);
  const mime = meta.mime;

  const videoInfo = isVideoMime(mime) ? readVideoInfo(head, mime) : { fps: null, codec: null, faststart: null };
  const faststart = isVideoMime(mime) && mime === 'video/mp4' ? detectFaststart(head) : videoInfo.faststart;
  const fps = isVideoMime(mime) ? (readVideoFps(head, mime) ?? videoInfo.fps ?? null) : null;

  let compliance = null;
  let softReason = null;
  if (isVideoMime(mime)) {
    compliance = checkVideoCompliance({
      mime, width: meta.width, height: meta.height, fps, codec: videoInfo.codec, faststart, bytes: size,
    });
    if (!compliance.ok) {
      softReason = variantReasonFor(compliance.violations);
      if (!softReason) {
        throw mediaNonCompliant(complianceMessage(compliance), {
          ...complianceInput(mime, meta, { byteLength: size }, { ...videoInfo, fps, faststart }),
          violations: compliance.violations,
          warnings: compliance.warnings,
          hint: COMPLIANCE_HINT,
        });
      }
      compliance = { ok: true, violations: [], warnings: compliance.warnings, soft: true };
    }
  }

  await assertDailyQuota(env, actor, size);

  const merged = new Uint8Array(head.byteLength + tail.byteLength);
  merged.set(head, 0);
  merged.set(tail, head.byteLength);
  const fingerprint = await sampleFingerprint(merged);

  const key = assetKey(row.id, fingerprint, mime);
  const sourceObject = await env.BUCKET.get(source.key);
  if (!sourceObject) throw badRequest('临时对象不存在');
  await env.BUCKET.put(key, sourceObject.body, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const check = await verifyAsset(env, key, size);
  if (!check.ok) {
    await deleteAsset(env, key);
    throw storageVerifyFailed('流式写入校验失败（对象缺失或大小不符），请重试');
  }
  if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);

  const durationMs = isVideoMime(mime) ? readDurationMs(head, mime) : null;
  const nextKind = isVideoMime(mime) ? 'dynamic' : mime.startsWith('image/') ? 'static' : row.kind;
  const now = nowMs();

  await setMediaIdentity(env, row.id, {
    storageKey: key,
    mime,
    bytes: check.size,
    width: meta.width ?? null,
    height: meta.height ?? null,
    durationMs,
    sha256: null,
    kind: nextKind,
    actor: row.storage_key ? MEDIA_ACTOR.REPLACE : MEDIA_ACTOR.UPLOAD,
    updatedAt: now,
  });
  await run(env, Q.markWallpaperVerified, now, videoInfo.codec ?? null, faststart ?? null, row.id);
  if (softReason) {
    await run(env, Q.setWallpaperVariantQueue, 1, softReason, 'draft', now, row.id);
  }

  if (await supportsFingerprintColumn(env)) {
    try {
      await run(env, Q.updateWallpaperFingerprint, fingerprint, now, row.id);
    } catch (error) {
      console.warn('[ingest] 流式入库写 content_fingerprint 失败', error?.message ?? error);
    }
  }
  if (isVideoMime(mime) && await supportsTechColumns(env)) {
    const hasAudio = readVideoAudio(head, mime);
    try {
      await run(env, Q.updateWallpaperTech, fps, null, hasAudio === null ? null : (hasAudio ? 1 : 0), row.id);
    } catch (error) {
      console.warn('[ingest] 流式入库写技术元数据失败', error?.message ?? error);
    }
  }

  await recordDailyUsage(env, actor, check.size);

  const warnings = [{
    code: IMPORT_WARNING.THUMB_MISSING,
    message: '大文件流式入库：未生成缩略图/海报；可用后台「换文件」补，或跑 tools/backfill-metadata.mjs',
  }];
  if (compliance && compliance.warnings.length) {
    warnings.push({ code: IMPORT_WARNING.COMPLIANCE, message: describeWarnings(compliance.warnings) });
  }

  // ---- 阶段三触发点 ②：大文件流式入库完成 -----------------------------------------
  // 分片上传（>48MB）走这条路，和 ingestAsset 是同一套规则、同一份快照触发。
  await rebuildSnapshotQuietly(env, '流式入库完成');

  return {
    key,
    storageKey: key,
    mime,
    bytes: check.size,
    width: meta.width ?? null,
    height: meta.height ?? null,
    durationMs,
    fps,
    codec: videoInfo.codec ?? null,
    faststart,
    fingerprint,
    fingerprintMode: 'sampled',
    kind: nextKind,
    category: row.category_id,
    status: softReason ? 'draft' : (row.status ?? 'draft'),
    needsVariant: Boolean(softReason),
    variantReason: softReason,
    compliance: compliance ? { warnings: compliance.warnings } : null,
    fixes: [],
    warnings,
    autoFixes: [],
  };
}


/** 变体记录追加/替换（同一 label 覆盖）。只写 D1 的 variants 列。 */
export async function attachVariant(env, actor, row, variant, { now = nowMs() } = {}) {
  if (!variant || !variant.label) throw badRequest('缺少变体 label');
  const list = safeJsonParse(row.variants, []).filter((item) => item && item.label !== variant.label);
  list.push({
    label: String(variant.label),
    width: Number(variant.width) || null,
    height: Number(variant.height) || null,
    fps: Number(variant.fps) || null,
    codec: variant.codec ?? 'h264',
    bytes: Number(variant.bytes) || 0,
    sha256: variant.sha256 ?? null,
    key: variant.key ?? null,
    url: variant.key ? `/media/${variant.key}` : (variant.url ?? null),
  });
  await run(env, Q.updateWallpaperVariants, JSON.stringify(list), now, row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_UPDATE,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: `变体 ${variant.label}`,
  });
  // ---- 阶段三触发点 ③：变体写入 ---------------------------------------------------
  // 变体会改变列表/详情里的 `variants` 与 `playable` 判定，公开快照必须跟着换。
  await rebuildSnapshotQuietly(env, `变体 ${variant.label}`);
  return list;
}

/** 上传变体文件（走 ingest.js 写 R2，路由不直接碰存储） */
export async function ingestVariantAsset(env, actor, row, { bytes, label, fps }, { now = nowMs() } = {}) {
  if (!bytes || !bytes.byteLength) throw badRequest('变体文件为空');
  const meta = readMediaMeta(bytes);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的变体文件');
  const mime = meta.mime;
  const sha = await sha256Bytes(bytes);
  const key = variantKey(row.id, sha, { label }, mime);
  await putAsset(env, key, bytes, mime);
  const check = await verifyAsset(env, key, bytes.byteLength);
  if (!check.ok) {
    await deleteAsset(env, key);
    throw storageVerifyFailed('变体写入校验失败，请重试');
  }
  const info = readVideoInfo(bytes, mime);
  const list = await attachVariant(env, actor, row, {
    label,
    width: meta.width,
    height: meta.height,
    fps: Number(fps) || info.fps || null,
    codec: info.codec ?? 'h264',
    bytes: check.size,
    sha256: sha,
    key,
  }, { now });
  return { key, variants: list };
}


/** 删除一个变体（发布失败回滚用） */
export async function removeVariant(env, actor, row, label, { now = nowMs() } = {}) {
  const list = safeJsonParse(row.variants, []).filter((item) => item && item.label !== label);
  await run(env, Q.updateWallpaperVariants, JSON.stringify(list), now, row.id);
  return list;
}

/**
 * 用已上传到 `_tmp/` 的对象生成变体（>100MB 的变体走分片后走这里）。
 * 与 ingestVariantAsset 同一套校验，只是不再把整段文件读进内存。
 */
export async function ingestVariantFromObject(env, actor, row, { key, size, label, fps }, { now = nowMs() } = {}) {
  if (!key || !String(key).startsWith('_tmp/')) throw badRequest('临时对象 key 不合法');
  const total = Number(size) || 0;
  if (!(total > 0)) throw badRequest('临时对象为空');
  if (total > 400 * 1024 * 1024) throw payloadTooLarge('单个变体不能超过 400MB（请降低 crf 或分辨率后重试）');

  const head = await readRangeBytes(env, key, 0, Math.min(STREAM_PROBE_BYTES, total));
  if (!head) throw badRequest('临时对象不存在');
  const tail = total > STREAM_PROBE_BYTES
    ? await readRangeBytes(env, key, Math.max(0, total - STREAM_PROBE_BYTES), Math.min(STREAM_PROBE_BYTES, total))
    : new Uint8Array(0);
  const meta = readMediaMeta(head);
  if (!meta.mime) throw unsupportedMedia(meta.error ?? '无法识别的变体文件');

  const merged = new Uint8Array(head.byteLength + tail.byteLength);
  merged.set(head, 0);
  merged.set(tail, head.byteLength);
  const sha = await sha256Bytes(merged);
  const mime = meta.mime;
  const vkey = variantKey(row.id, sha, { label }, mime);

  const source = await env.BUCKET.get(key);
  if (!source) throw badRequest('临时对象不存在');
  await env.BUCKET.put(vkey, source.body, {
    httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const check = await verifyAsset(env, vkey, total);
  if (!check.ok) {
    await deleteAsset(env, vkey);
    throw storageVerifyFailed('变体写入校验失败，请重试');
  }
  const info = readVideoInfo(head, mime);
  const list = await attachVariant(env, actor, row, {
    label,
    width: meta.width,
    height: meta.height,
    fps: Number(fps) || info.fps || null,
    codec: info.codec ?? 'h264',
    bytes: check.size,
    sha256: sha,
    key: vkey,
  }, { now });
  return { key: vkey, variants: list };
}

/** 发布：原片可播 或 已有可播变体；成功后清 needs_variant */
export async function publishWallpaper(env, actor, row, { now = nowMs() } = {}) {
  // 测试开关：验证「发布失败 ⇒ 变体回滚」链路，默认关闭；上线环境保持 0
  if (String(env.FOLIA_FAIL_PUBLISH ?? '') === '1') {
    throw conflict('发布被测试开关 FOLIA_FAIL_PUBLISH 拦下（用于验证回滚）');
  }
  const variants = safeJsonParse(row.variants, []);
  const variantPlayable = variants.some((item) => isPlayable({
    fps: item?.fps, width: item?.width, height: item?.height, codec: item?.codec ?? 'h264',
  }));
  const originalPlayable = isPlayable({
    fps: row.fps, width: row.width, height: row.height, codec: row.codec,
  });
  if (!originalPlayable && !variantPlayable) {
    throw conflict('没有可播放的版本：原片与变体都超过 fps/分辨率/编码限制', {
      needsVariant: true,
      variants: variants.map((item) => item.label),
    });
  }
  await run(env, Q.publishWallpaperClearQueue, now, now, row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.WALLPAPER_UPDATE,
    targetType: 'wallpaper',
    targetId: row.id,
    detail: originalPlayable ? '发布（原片可播）' : '发布（用变体）',
  });
  // ---- 阶段三触发点 ④：发布 -------------------------------------------------------
  // 发布是「条目第一次出现在公开接口」的时刻，早于下一次定时重建就晚了 —— 必须同步重建。
  await rebuildSnapshotQuietly(env, '发布');
  return { published: true, via: originalPlayable ? 'original' : 'variant' };
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
    input.license ?? null, input.source ?? null, input.author ?? null,
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
      license: item.license ?? null,
      source: item.source ?? null,
      author: item.author ?? null,
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
      poster: item.poster,
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
        height: result.height, thumbUrl: result.thumbUrl, posterUrl: result.posterUrl,
        variants: result.variants, durationMs: result.durationMs, kind: result.kind, mime: result.mime,
        fps: result.fps, pixFmt: result.pixFmt, hasAudio: result.hasAudio,
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
