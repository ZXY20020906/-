/**
 * mp4-remux.js — **纯 JS 的 faststart 转封装**（把 moov 从文件尾搬到文件头）。
 *
 * 为什么需要它：`not-faststart` 是合规体检里唯一**不需要解码器**就能修的违规。
 * 本地工具（tools/prepare-upload.mjs）用 ffmpeg `-c copy -movflags +faststart` 修它；
 * 但 Cloudflare Workers / 浏览器里都没有 ffmpeg，于是这类文件以前只能被 422 拒掉，
 * 用户必须回本机跑一遍工具。实际上「搬 moov」只是**改字节顺序**：
 *   ① 解析顶层 box（ftyp / mdat / moov / free…）；
 *   ② 把 moov 挪到第一个 mdat 之前；
 *   ③ moov 里的 stco / co64（chunk 偏移表）记的是 mdat 内部数据的**绝对文件偏移**，
 *      mdat 挪动了 delta 字节，这些偏移必须同加 delta。
 *
 * 不做的事（刻意的）：
 *   · **不重新编码**——像素数据一个字节都不动，画质与体积完全不变；
 *   · 认不出 / 会溢出的文件一律返回 `null`（调用方当「修不了」继续按违规处理），
 *     绝不产出半截文件——那比不修更糟（会变成 4.23.6 那类「长度对、内容错」）。
 *
 * 与 `sampleFingerprint` 的关系：转封装会改变字节 ⇒ 调用方必须在**修正之后**才算
 * sha256/key，见 `src/server/ingest.js` 的顺序（先修、再体检、最后算哈希）。
 */

const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex', 'moof', 'traf',
]);

/** 单条 box 头：返回 { type, start, end, header }；size=0（到文件尾）也认。 */
function boxAt(bytes, offset, limit) {
  if (offset < 0 || offset + 8 > limit) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  let size = size32;
  let header = 8;
  if (size32 === 1) {
    if (offset + 16 > limit) return null;
    const hi = view.getUint32(offset + 8);
    const lo = view.getUint32(offset + 12);
    size = hi * 4294967296 + lo;
    header = 16;
  } else if (size32 === 0) {
    size = limit - offset;
  }
  if (!Number.isFinite(size) || size < header) return null;
  const end = Math.min(limit, offset + size);
  if (end <= offset) return null;
  return { type, start: offset, end, header, size: end - offset };
}

/**
 * 同一层的 box 列表。**不完整就返回 null**：文件尾有半截 box 说明这份文件本身可疑，
 * 与其猜「剩下的算 mdat」，不如让调用方走 422。
 */
function siblings(bytes, from = 0, to = bytes.length) {
  const out = [];
  let offset = from;
  for (let guard = 0; guard < 4096 && offset < to; guard += 1) {
    const box = boxAt(bytes, offset, to);
    if (!box) return null;
    out.push(box);
    offset += box.size;
  }
  return offset === to ? out : null;
}

/** 在 [from,to) 里就地给 stco / co64 的每个条目加 delta。返回 { patched, overflow }。 */
function shiftChunkOffsets(bytes, from, to, delta, depth = 0) {
  if (depth > 8) return { patched: 0, overflow: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const list = siblings(bytes, from, to);
  if (!list) return { patched: 0, overflow: true };
  let patched = 0;
  for (const box of list) {
    if (box.type === 'stco' || box.type === 'co64') {
      const payload = box.start + box.header;
      const count = view.getUint32(payload + 4);
      const width = box.type === 'stco' ? 4 : 8;
      if (count > 2_000_000) return { patched, overflow: true };
      for (let i = 0; i < count; i += 1) {
        const at = payload + 8 + i * width;
        if (at + width > box.end) return { patched, overflow: true };
        const old = width === 4 ? view.getUint32(at) : view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
        const next = old + delta;
        if (!Number.isSafeInteger(next) || next < 0) return { patched, overflow: true };
        if (width === 4 && next > 0xffffffff) return { patched, overflow: true };
        if (width === 4) view.setUint32(at, next);
        else {
          view.setUint32(at, Math.floor(next / 4294967296));
          view.setUint32(at + 4, next % 4294967296);
        }
        patched += 1;
      }
    } else if (CONTAINER_BOXES.has(box.type)) {
      const inner = shiftChunkOffsets(bytes, box.start + box.header, box.end, delta, depth + 1);
      patched += inner.patched;
      if (inner.overflow) return { patched, overflow: true };
    }
  }
  return { patched, overflow: false };
}

/**
 * 把 moov 前置（faststart 化）。已经是 faststart / 没有 mdat ⇒ 返回 `null`（无需修复）。
 * 修不了（结构不认识、偏移会溢出）⇒ 也返回 `null`，调用方据此继续报 `not-faststart`。
 *
 * @param {Uint8Array} bytes 原始 mp4
 * @returns {Uint8Array|null} 新的 mp4 字节；无需/无法修复时为 null
 */
export function repairMp4Faststart(bytes) {
  if (!bytes || bytes.byteLength < 64) return null;
  const top = siblings(bytes);
  if (!top) return null;
  const mdatIndex = top.findIndex((box) => box.type === 'mdat');
  const moovIndex = top.findIndex((box) => box.type === 'moov');
  if (mdatIndex < 0 || moovIndex < 0) return null;
  // moov 已经在 mdat 前面 ⇒ 本来就是 faststart，不用动
  if (moovIndex < mdatIndex) return null;

  const moov = top[moovIndex];
  const mdat = top[mdatIndex];
  const rest = top.filter((_, index) => index !== moovIndex);
  const insertAt = rest.indexOf(mdat);
  const order = [...rest.slice(0, insertAt), moov, ...rest.slice(insertAt)];

  const out = new Uint8Array(bytes.byteLength);
  const newStart = new Map();
  let cursor = 0;
  for (const box of order) {
    newStart.set(box, cursor);
    cursor += box.size;
  }
  const delta = newStart.get(mdat) - mdat.start;
  if (!Number.isSafeInteger(delta)) return null;

  // 先在副本上改偏移，改不动就整单放弃（不产出半截文件）
  const patched = new Uint8Array(bytes);
  const result = shiftChunkOffsets(patched, moov.start + moov.header, moov.end, delta);
  if (result.overflow) return null;

  for (const box of order) {
    const src = box === moov ? patched : bytes;
    out.set(src.subarray(box.start, box.end), newStart.get(box));
  }
  return out;
}
