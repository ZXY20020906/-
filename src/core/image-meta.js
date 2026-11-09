/**
 * 只靠文件头判断类型与尺寸，不引入任何依赖，Worker 里可直接跑。
 * 目的：拒绝「改扩展名伪装成图片」的上传，并在入库前记下宽高，
 * 让前端不用加载完大图才知道尺寸（壁纸站最需要这个）。
 */

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
/** 资源包（bootanimation.zip / WE 工程包）体积较大，给到 90MB——Cloudflare 单请求上限 100MB。 */
// 90MB 会整块读进内存，Worker 只有 128MB，和其余开销叠在一起容易 OOM；64MB 留足余量
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
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
function scanTkhd(b, start, end) {
  let best = null;
  const scanEnd = Math.min(b.length, end) - 8;
  for (let i = Math.max(0, start); i < scanEnd; i += 1) {
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
 * moov 写在文件尾部（没做 faststart）时，前 2MB 里根本没有 tkhd —— 以前这种情况
 * 一律读不到宽高，库里就留了 null。这里在头部扫不到时再扫尾部同样大小的窗口。
 */
function mp4Size(b) {
  const headEnd = Math.min(b.length, 2 * 1024 * 1024);
  const fromHead = scanTkhd(b, 0, headEnd);
  if (fromHead || b.length <= headEnd) return fromHead;
  return scanTkhd(b, Math.max(0, b.length - 2 * 1024 * 1024), b.length);
}

/**
 * WebM（EBML）里没有 tkhd/mvhd，宽高在 Segment → Tracks → TrackEntry → Video 的
 * PixelWidth/PixelHeight，时长在 Segment → Info 的 Duration × TimecodeScale。
 * 以前 webm 直接落到 switch 的 default 分支，宽高永远是 null——动态壁纸里 webm
 * 占了一大块，入库后详情页只能显示「—」。
 *
 * 这里只做「按 element 头跳着走」的轻量遍历：Cluster 是叶子节点，靠 size 一次跳过，
 * 所以几百 MB 的 webm 也只会走几十步。EBML 的 size 允许写成「未知」，这时按容器
 * 剩余长度处理。
 */
const EBML_IDS = Object.freeze({
  segment: 0x18538067,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  /** 每帧纳秒数：有它就能算出帧率（很多 WebM 不写，读不到就返回 null） */
  defaultDuration: 0x23e383,
});

const EBML_CONTAINERS = new Set([
  EBML_IDS.segment, EBML_IDS.info, EBML_IDS.tracks, EBML_IDS.trackEntry, EBML_IDS.video,
]);

/** EBML 变长整数：keepMarker 时保留长度前缀位（ID 的写法就是这么定义的）。 */
function ebmlVint(b, i, keepMarker) {
  if (i < 0 || i >= b.length) return null;
  const first = b[i];
  if (first === 0) return null;               // 长度前缀最多 8 字节，首字节不可能是 0
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || i + length > b.length) return null;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let allOnes = (first & mask) === mask;
  for (let k = 1; k < length; k += 1) {
    value = value * 256 + b[i + k];
    allOnes = allOnes && b[i + k] === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** 收集目标 element 的 payload 区间（同名只留第一个）。 */
function ebmlWalk(b, from, to, hits, depth = 0) {
  let i = Math.max(0, from);
  const end = Math.min(b.length, to);
  for (let guard = 0; i < end && guard < 20000; guard += 1) {
    const id = ebmlVint(b, i, true);
    if (!id) return;
    const size = ebmlVint(b, i + id.length, false);
    if (!size) return;
    const body = i + id.length + size.length;
    if (body > end) return;
    const bodyEnd = size.unknown ? end : Math.min(end, body + size.value);
    if (!hits.has(id.value)) hits.set(id.value, { start: body, end: bodyEnd });
    if (EBML_CONTAINERS.has(id.value) && depth < 6) {
      ebmlWalk(b, body, bodyEnd, hits, depth + 1);
    }
    if (size.unknown) return;
    i = bodyEnd;
  }
}

function ebmlHits(bytes) {
  const hits = new Map();
  try {
    ebmlWalk(bytes, 0, bytes.length, hits);
  } catch { /* 半截文件/脏数据：当作读不出来 */ }
  return hits;
}

function ebmlUint(bytes, span) {
  if (!span) return null;
  const n = span.end - span.start;
  if (n < 1 || n > 8) return null;
  let value = 0;
  for (let k = 0; k < n; k += 1) value = value * 256 + bytes[span.start + k];
  return Number.isFinite(value) ? value : null;
}

function ebmlFloat(bytes, span) {
  if (!span) return null;
  const n = span.end - span.start;
  if (n !== 4 && n !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + span.start, n);
  return n === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

function webmSize(bytes) {
  const hits = ebmlHits(bytes);
  const width = ebmlUint(bytes, hits.get(EBML_IDS.pixelWidth));
  const height = ebmlUint(bytes, hits.get(EBML_IDS.pixelHeight));
  if (!(width > 0 && height > 0) || width > 100_000 || height > 100_000) return null;
  return { width, height };
}

/** Duration 的单位是 TimecodeScale（默认 1ms），换算成毫秒。 */
function webmDurationMs(bytes) {
  const hits = ebmlHits(bytes);
  const raw = ebmlFloat(bytes, hits.get(EBML_IDS.duration));
  const scale = ebmlUint(bytes, hits.get(EBML_IDS.timecodeScale)) ?? 1_000_000;
  if (!raw || !(raw > 0) || !(scale > 0)) return null;
  const ms = Math.round((raw * scale) / 1_000_000);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 24 * 60 * 60 * 1000) return null;
  return ms;
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
    case 'video/webm': size = webmSize(bytes); break;
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
 * 分片 MP4（fMP4）的 mvhd duration 是 0，WebM 走 EBML 的 Info/Duration——
 * 这两类读不到时返回 null，前端会显示「—」而不是瞎猜。
 *
 * mvhd 布局（type 之后）：version+flags(4) → 时间戳(4 或 8) → timescale(4) → duration(4 或 8)
 */

/**
 * 扫 mp4 顶层 box 判断 faststart：先遇到 moov ⇒ true；先遇到 mdat ⇒ false；读不到 ⇒ null。
 * moov 很小（几 MB 内），所以只需要文件头部。
 */
export function detectFaststart(bytes) {
  if (!bytes || bytes.length < 16) return null;
  let offset = 0;
  for (let guard = 0; guard < 64 && offset + 8 <= bytes.length; guard += 1) {
    const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;
    if (!size || size < 8) break;
    offset += size;
  }
  return null;
}
export function readDurationMs(bytes, mime) {
  if (mime === 'video/webm') {
    if (!bytes || bytes.length < 24) return null;
    return webmDurationMs(bytes);
  }
  if (mime !== 'video/mp4') return null;
  if (!bytes || bytes.length < 24) return null;
  const headEnd = Math.min(bytes.length, 2 * 1024 * 1024);
  const fromHead = scanMvhd(bytes, 0, headEnd);
  if (fromHead !== null || bytes.length <= headEnd) return fromHead;
  // 非 faststart 的 mp4：moov/mvhd 在文件尾部
  return scanMvhd(bytes, Math.max(0, bytes.length - 2 * 1024 * 1024), bytes.length);
}

function scanMvhd(bytes, start, end) {
  const scanEnd = Math.min(bytes.length, end) - 8;
  for (let i = Math.max(0, start); i < scanEnd; i += 1) {
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
 * 读一个 MP4 box 头（只读头，不进 payload）。
 * size 的三种写法都要认：32 位、`size=1` 之后 64 位、`size=0` 表示「到文件尾」。
 * limit 是扫描上界，默认整份文件——嵌在父 box 里时传父 box 的 end。
 */
function mp4BoxAt(bytes, offset, limit = bytes.length) {
  if (offset < 0 || offset + 8 > limit) return null;
  const size32 = be32(bytes, offset);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let size = size32;
  let header = 8;
  if (size32 === 1) {
    if (offset + 16 > limit) return null;
    size = be64(bytes, offset + 8);
    header = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (!Number.isFinite(size) || size < header) return null;
  return { type, size, start: offset + header, end: Math.min(limit, offset + size) };
}

/** 遍历 [start, end) 里的同级 box；给 type 就只挑那一种。 */
function childBoxes(bytes, start, end, type) {
  const out = [];
  let offset = start;
  for (let guard = 0; guard < 256 && offset + 8 <= end; guard += 1) {
    const box = mp4BoxAt(bytes, offset, end);
    if (!box) break;
    if (!type || box.type === type) out.push(box);
    if (box.size < 8) break;
    offset += box.size;
  }
  return out;
}

/**
 * 顶层布局：moov / mdat 各自在哪。
 * 以前在遇到 mdat 时直接 break，导致「moov 在尾部」的文件 moovAt 永远是 -1、
 * faststart 永远是 null。跳过一个 box 只是 offset 加法，不读内容，没必要提前收工。
 */
function mp4Layout(bytes) {
  const layout = { moov: null, moovAt: -1, mdatAt: -1 };
  let offset = 0;
  for (let guard = 0; guard < 64 && offset + 8 <= bytes.length; guard += 1) {
    const box = mp4BoxAt(bytes, offset);
    if (!box) break;
    if (box.type === 'moov' && !layout.moov) {
      layout.moov = box;
      layout.moovAt = offset;
    }
    if (box.type === 'mdat' && layout.mdatAt < 0) layout.mdatAt = offset;
    offset += box.size;
  }
  return layout;
}

/** mdhd：v0 的 timescale 在 payload+12，v1（64 位时间戳）在 payload+20。 */
function mdhdTimescale(bytes, mdhd) {
  const version = bytes[mdhd.start];
  const at = mdhd.start + (version === 1 ? 20 : 12);
  if (at + 4 > mdhd.end) return null;
  const timescale = be32(bytes, at);
  return timescale > 0 && timescale <= 1_000_000_000 ? timescale : null;
}

/** stts 汇总：样本总数 + 时长单位总和（帧率 = samples × timescale ÷ delta 总和）。 */
function sttsTotals(bytes, stts) {
  if (stts.start + 8 > stts.end) return null;
  const entries = be32(bytes, stts.start + 4);
  if (!(entries > 0) || entries > 100_000) return null;
  let samples = 0;
  let delta = 0;
  for (let i = 0; i < entries; i += 1) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) break;
    const count = be32(bytes, at);
    const step = be32(bytes, at + 4);
    samples += count;
    delta += count * step;
  }
  return samples > 0 && delta > 0 ? { samples, delta } : null;
}

/**
 * 从 moov 里算帧率：找 handler_type = 'vide' 的那条 trak，用 mdhd.timescale 与 stts 算。
 * 用 stts 而不是「总帧数 ÷ mvhd 时长」：mvhd 是整条文件（含音轨空隙）的时长，
 * 有音频、有空镜头的片子会算偏。
 */
function fpsFromMoov(bytes, moov) {
  for (const trak of childBoxes(bytes, moov.start, moov.end, 'trak')) {
    for (const mdia of childBoxes(bytes, trak.start, trak.end, 'mdia')) {
      const hdlr = childBoxes(bytes, mdia.start, mdia.end, 'hdlr')[0];
      if (!hdlr || ascii(bytes, hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
      const mdhd = childBoxes(bytes, mdia.start, mdia.end, 'mdhd')[0];
      const minf = childBoxes(bytes, mdia.start, mdia.end, 'minf')[0];
      if (!mdhd || !minf) continue;
      const stbl = childBoxes(bytes, minf.start, minf.end, 'stbl')[0];
      if (!stbl) continue;
      const stts = childBoxes(bytes, stbl.start, stbl.end, 'stts')[0];
      if (!stts) continue;
      const timescale = mdhdTimescale(bytes, mdhd);
      const totals = sttsTotals(bytes, stts);
      if (!timescale || !totals) continue;
      const fps = (totals.samples * timescale) / totals.delta;
      if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) continue;
      return Math.round(fps * 100) / 100;
    }
  }
  return null;
}

/** WebM：Tracks → TrackEntry → DefaultDuration（每帧纳秒），倒数就是帧率。 */
function webmFps(bytes) {
  const hits = ebmlHits(bytes);
  const ns = ebmlUint(bytes, hits.get(EBML_IDS.defaultDuration));
  if (!ns || ns < 1000 || ns > 1_000_000_000) return null;
  const fps = 1_000_000_000 / ns;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return null;
  return Math.round(fps * 100) / 100;
}

/**
 * 帧率探测（只读文件头，不解码）。
 * 读不到返回 null —— 调用方（media-compliance）会把它当「无法确认」而不是「合规」。
 * 音轨/字幕轨的 stts 不是帧率，所以只认 handler_type 为 vide 的 trak。
 */
export function readVideoFps(bytes, mime) {
  if (!bytes || bytes.length < 16) return null;
  if (mime === 'video/webm') return webmFps(bytes);
  if (mime !== 'video/mp4') return null;
  const { moov } = mp4Layout(bytes);
  return moov ? fpsFromMoov(bytes, moov) : null;
}

/**
 * 视频编码 + faststart + 帧率检测（只读判断，不拒绝上传；拒绝在 media-compliance.js）。
 * - codec：扫 moov 里的 sample entry fourcc，hvc1/hev1 = H.265（浏览器多数解不了）
 * - faststart：moov 是否出现在 mdat 之前；否则要下完整个文件才能起播
 * - fps：见 readVideoFps()
 * 用 box 头逐个跳，不做完整解析，几百 MB 的文件也只走几十步。
 */
export function readVideoInfo(bytes, mime) {
  if (!isVideoMime(mime) || !bytes || bytes.length < 16) {
    return { codec: null, faststart: null, fps: null };
  }
  if (mime === 'video/webm') {
    return { codec: sniffWebmCodec(bytes), faststart: null, fps: webmFps(bytes) };
  }

  const { moov, moovAt, mdatAt } = mp4Layout(bytes);
  const codec = moov ? sniffMp4Codec(bytes, moovAt) : null;
  const faststart = moovAt < 0 || mdatAt < 0 ? null : moovAt < mdatAt;
  return { codec, faststart, fps: moov ? fpsFromMoov(bytes, moov) : null };
}

/**
 * 音轨探测（只读 moov / EBML 头，不解码）。
 *
 * 返回三态：`true` 有音轨、`false` 确认没有、`null` 读不出来（未知）。
 * **为什么不能把「读不出来」当 false**：v1 的 `hasAudio` 要用来回答
 * 「这个素材静音吗」，猜错会让静音类筛选漏掉真·无声文件；未知就老实给 null。
 *
 * - MP4：找 moov 里 handler_type = 'soun' 的 trak（和 fpsFromMoov 同一套盒遍历）；
 * - WebM：TrackEntry 的 CodecID 在头部明文里（A_OPUS / A_VORBIS …），扫到就算有；
 *   扫不到返回 null —— WebM 的 Tracks 段可能不在前 4KB，不能据此断言「没有」。
 */
export function readVideoAudio(bytes, mime) {
  if (!isVideoMime(mime) || !bytes || bytes.length < 16) return null;
  if (mime === 'video/webm') {
    const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 8192)));
    return /A_OPUS|A_VORBIS|A_AAC|A_MPEG\/L3|A_FLAC|A_PCM/.test(text) ? true : null;
  }
  const { moov } = mp4Layout(bytes);
  if (!moov) return null;
  let sawTrack = false;
  for (const trak of childBoxes(bytes, moov.start, moov.end, 'trak')) {
    for (const mdia of childBoxes(bytes, trak.start, trak.end, 'mdia')) {
      sawTrack = true;
      const hdlr = childBoxes(bytes, mdia.start, mdia.end, 'hdlr')[0];
      if (hdlr && ascii(bytes, hdlr.start + 8, hdlr.start + 12) === 'soun') return true;
    }
  }
  return sawTrack ? false : null;
}

function sniffMp4Codec(bytes, start) {  const known = ['avc1', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v'];
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
 *
 * `pet`（桌宠包）只接受 zip：它是另一个分发形态（zip 里带 pet.json + 雪碧图），
 * 既不是图片也不是视频，所以单列一条分支，而不是塞进 dynamic。
 */
export function kindMatchesMime(kind, mime) {
  if (kind === 'pet') return isBundleMime(mime);
  const motion = isVideoMime(mime) || isBundleMime(mime);
  return kind === 'dynamic' ? motion : !motion;
}
