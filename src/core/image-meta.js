/**
 * 只靠文件头判断类型与尺寸，不引入任何依赖，Worker 里可直接跑。
 * 目的：拒绝「改扩展名伪装成图片」的上传，并在入库前记下宽高，
 * 让前端不用加载完大图才知道尺寸（壁纸站最需要这个）。
 */

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
/** 资源包（bootanimation.zip / WE 工程包）体积较大，给到 90MB——Cloudflare 单请求上限 100MB。 */
export const MAX_BUNDLE_BYTES = 90 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_BUNDLE_BYTES);

export const ALLOWED_MIME = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'video/mp4',
  'video/webm',
  'application/zip',
]);

export const EXT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/zip': 'zip',
});

export const isVideoMime = (mime) => mime === 'video/mp4' || mime === 'video/webm';
/** 开机动画包：本质是 zip，浏览器不能直接预览，只能下载。 */
export const isBundleMime = (mime) => mime === 'application/zip';

const SCAN = 64 * 1024;

function ascii(bytes, start, end) {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function be16(b, i) {
  return (b[i] << 8) | b[i + 1];
}
function be24(b, i) {
  return (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
}
function be32(b, i) {
  return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}
function be64(b, i) {
  const hi = be32(b, i);
  const lo = be32(b, i + 4);
  const value = hi * 4294967296 + lo;
  return Number.isFinite(value) ? value : 0;
}
function le16(b, i) {
  return b[i] | (b[i + 1] << 8);
}
function le24(b, i) {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

/** @returns {string|null} */
export function sniffMime(bytes) {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const gif = ascii(b, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/avif'; // 交给浏览器判断，仍按 avif 处理
    if (['isom', 'iso2', 'mp41', 'mp42', 'M4V ', 'M4VP', 'dash', 'avc1'].includes(brand)) return 'video/mp4';
    return null;
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  // zip：本地文件头 PK\3\4，空包 PK\5\6，分卷 PK\7\8
  if (b[0] === 0x50 && b[1] === 0x4b) {
    if ((b[2] === 0x03 && b[3] === 0x04)
      || (b[2] === 0x05 && b[3] === 0x06)
      || (b[2] === 0x07 && b[3] === 0x08)) return 'application/zip';
  }
  return null;
}

function pngSize(b) {
  if (ascii(b, 12, 16) !== 'IHDR') return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

function gifSize(b) {
  return { width: le16(b, 6), height: le16(b, 8) };
}

function jpegSize(b) {
  let i = 2;
  const limit = Math.min(b.length, SCAN);
  while (i + 9 < limit) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) return null;
    const len = be16(b, i + 2);
    if (len < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { width: be16(b, i + 7), height: be16(b, i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b) {
  const fourcc = ascii(b, 12, 16);
  if (fourcc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const b1 = b[21]; const b2 = b[22]; const b3 = b[23]; const b4 = b[24];
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (fourcc === 'VP8X') {
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  return null;
}

/**
 * AVIF/HEIC：在文件头里找 ispe box。
 * box = [size:4][type:'ispe'][version+flags:4][width:4][height:4]
 */
function avifSize(b) {
  const limit = Math.min(b.length, SCAN) - 4;
  for (let i = 0; i < limit; i += 1) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      const w = be32(b, i + 8);
      const h = be32(b, i + 12);
      if (w > 0 && h > 0 && w < 100000 && h < 100000) return { width: w, height: h };
    }
  }
  return null;
}

/**
 * MP4 的宽高在 track header（tkhd）里，16.16 定点数。
 * 一个文件有多条轨道（视频 + 音频），音频轨的宽高是 0，所以取面积最大的那条。
 * 版本 1 的时间戳是 64 位，字段整体后移 12 字节。
 */
function mp4Size(b) {
  let best = null;
  const scanEnd = Math.min(b.length, 2 * 1024 * 1024) - 8;
  for (let i = 0; i < scanEnd; i += 1) {
    if (b[i] !== 0x74 || b[i + 1] !== 0x6b || b[i + 2] !== 0x68 || b[i + 3] !== 0x64) continue; // 'tkhd'
    const offset = b[i + 4] === 1 ? i + 92 : i + 80;
    if (offset + 8 > b.length) continue;
    const width = be32(b, offset) / 65536;
    const height = be32(b, offset + 4) / 65536;
    if (!(width > 0 && height > 0) || width > 100_000 || height > 100_000) continue;
    if (!best || width * height > best.width * best.height) {
      best = { width: Math.round(width), height: Math.round(height) };
    }
  }
  return best;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{mime: string|null, width: number|null, height: number|null, error?: string}}
 */
export function readMediaMeta(bytes) {
  if (!bytes || bytes.length < 12) {
    return { mime: null, width: null, height: null, error: '文件太小，无法识别' };
  }
  const mime = sniffMime(bytes);
  if (!mime) return { mime: null, width: null, height: null, error: '无法识别的文件类型' };

  let size = null;
  switch (mime) {
    case 'image/png': size = pngSize(bytes); break;
    case 'image/gif': size = gifSize(bytes); break;
    case 'image/jpeg': size = jpegSize(bytes); break;
    case 'image/webp': size = webpSize(bytes); break;
    case 'image/avif': size = avifSize(bytes); break;
    case 'video/mp4': size = mp4Size(bytes); break;
    default: size = null;
  }
  return {
    mime,
    width: size && size.width > 0 ? size.width : null,
    height: size && size.height > 0 ? size.height : null,
  };
}

/**
 * 从 MP4 的 moov/mvhd 里读时长。
 * 开机动画是按秒循环的，告诉用户「这段 6 秒一循环」比只给体积有用。
 * 分片 MP4（fMP4）的 mvhd duration 是 0，WebM 需要解析 EBML——这两类返回 null，
 * 前端会显示「—」而不是瞎猜。
 *
 * mvhd 布局（type 之后）：version+flags(4) → 时间戳(4 或 8) → timescale(4) → duration(4 或 8)
 */
export function readDurationMs(bytes, mime) {
  if (mime !== 'video/mp4') return null;
  if (!bytes || bytes.length < 24) return null;
  const scanEnd = Math.min(bytes.length, 2 * 1024 * 1024) - 8;

  for (let i = 0; i < scanEnd; i += 1) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue;
    const version = bytes[i + 4];
    const need = version === 1 ? 36 : 24;
    if (i + need > bytes.length) return null;
    let timescale;
    let duration;
    if (version === 1) {
      timescale = be32(bytes, i + 24);
      duration = be64(bytes, i + 28);
    } else {
      timescale = be32(bytes, i + 16);
      duration = be32(bytes, i + 20);
    }
    if (!timescale || timescale > 1_000_000 || !duration) return null;
    const ms = Math.round((duration / timescale) * 1000);
    // 超过 24 小时的肯定不是开机动画，说明读到了假 mvhd
    if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) return null;
    return ms;
  }
  return null;
}

/**
 * 视频编码 + faststart 检测（只读判断，不拒绝上传）。
 * - codec：扫 moov 里的 sample entry fourcc，hvc1/hev1 = H.265（浏览器多数解不了）
 * - faststart：moov 是否出现在 mdat 之前；否则要下完整个文件才能起播
 * 用 box 头逐个跳，不做完整解析，几 MB 的文件几十毫秒内出结果。
 */
export function readVideoInfo(bytes, mime) {
  if (!isVideoMime(mime) || !bytes || bytes.length < 16) return { codec: null, faststart: null };
  if (mime === 'video/webm') return { codec: sniffWebmCodec(bytes), faststart: null };

  let offset = 0;
  let moovAt = -1;
  let mdatAt = -1;
  const limit = bytes.length;
  for (let guard = 0; guard < 64 && offset + 8 <= limit; guard += 1) {
    const size = be32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'moov' && moovAt < 0) moovAt = offset;
    if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
    if (type === 'moov' || type === 'mdat') break;
    if (!size || size < 8) break;
    offset += size;
  }

  const codec = moovAt >= 0 ? sniffMp4Codec(bytes, moovAt) : null;
  const faststart = moovAt < 0 || mdatAt < 0 ? null : moovAt < mdatAt;
  return { codec, faststart };
}

function sniffMp4Codec(bytes, start) {
  const known = ['avc1', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v'];
  const end = Math.min(bytes.length - 4, start + 4 * 1024 * 1024);
  for (let i = start; i < end; i += 1) {
    for (const code of known) {
      if (bytes[i] === code.charCodeAt(0)
        && bytes[i + 1] === code.charCodeAt(1)
        && bytes[i + 2] === code.charCodeAt(2)
        && bytes[i + 3] === code.charCodeAt(3)) {
        return code === 'avc1' ? 'h264' : code === 'av01' ? 'av1' : code === 'hvc1' || code === 'hev1' ? 'hevc' : code;
      }
    }
  }
  return null;
}

function sniffWebmCodec(bytes) {
  const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (text.includes('V_MPEG4/ISO/AVC')) return 'h264';
  if (text.includes('V_MPEGH/ISO/HEVC')) return 'hevc';
  if (text.includes('V_VP9')) return 'vp9';
  if (text.includes('V_VP8')) return 'vp8';
  if (text.includes('V_AV1')) return 'av1';
  return null;
}

export function limitForMime(mime) {
  if (isBundleMime(mime)) return MAX_BUNDLE_BYTES;
  return isVideoMime(mime) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

/**
 * 静态只收图片；动态收视频或开机动画包。
 * 开机动画包归在「动态」下面，因为它本来就是逐帧动画，只是以 zip 分发。
 */
export function kindMatchesMime(kind, mime) {
  const motion = isVideoMime(mime) || isBundleMime(mime);
  return kind === 'dynamic' ? motion : !motion;
}
