/**
 * 测试用的最小 MP4 工厂。
 *
 * 为什么需要它：上传接口现在要过「播放合规体检」（src/server/media-compliance.js），
 * 一个 32 字节的伪 mp4（只有 ftyp）探测不到宽高，会被 422 拒掉——那是**正确行为**。
 * 所以发布相关的用例必须喂「结构完整到能被解析」的文件：ftyp + moov(mvhd/trak/tkhd/
 * mdia/hdlr/mdhd/minf/stbl/stts/stsd) + mdat，box 头与字段偏移都按真实 MP4 写。
 *
 * 只用于测试：不追求可播放，只追求 src/core/image-meta.js 的只读解析器能读出
 * 宽/高/帧率/编码/faststart/时长。
 */

function u32(out, at, value) {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

function ascii(out, at, text) {
  for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i) & 0xff;
}

function bytes(length) {
  return new Uint8Array(length);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** [size:4][type:4][payload] */
function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  u32(out, 0, out.length);
  ascii(out, 4, type);
  out.set(payload, 8);
  return out;
}

/** mvhd v0：100 字节 payload，timescale 在 +16、duration 在 +20。 */
function mvhd({ timescale, duration }) {
  const payload = bytes(100);
  u32(payload, 12, timescale);
  u32(payload, 16, duration);
  u32(payload, 20, 0x00010000); // rate 1.0
  payload[28] = 0x01;           // volume 1.0（高字节）
  u32(payload, 96, 2);          // next_track_ID
  return box('mvhd', payload);
}

/** tkhd v0：84 字节 payload，width 在 +76、height 在 +80（都是 16.16 定点）。 */
function tkhd({ width, height, duration }) {
  const payload = bytes(84);
  u32(payload, 8, 1);  // track_ID
  u32(payload, 16, duration);
  u32(payload, 32, 0x00010000); // matrix 首项 1.0
  u32(payload, 76, width * 65536);
  u32(payload, 80, height * 65536);
  return box('tkhd', payload);
}

/** mdhd v0：timescale 在 payload+12。 */
function mdhd({ timescale, duration }) {
  const payload = bytes(24);
  u32(payload, 12, timescale);
  u32(payload, 16, duration);
  return box('mdhd', payload);
}

/** hdlr：handler_type 在 payload+8。 */
function hdlr(type = 'vide') {
  const payload = bytes(24);
  ascii(payload, 8, type);
  return box('hdlr', payload);
}

/** stts：单条 (count, delta)，帧率 = count × timescale ÷ (count × delta)。 */
function stts({ samples, delta }) {
  const payload = bytes(16);
  u32(payload, 4, 1); // entry_count
  u32(payload, 8, samples);
  u32(payload, 12, delta);
  return box('stts', payload);
}

/** stsd 里挂一个 sample entry（fourcc 就是编码标识：avc1 / hvc1 …）。 */
function stsd(codec) {
  const entry = box(codec, bytes(8));
  const payload = concat([bytes(8), entry]);
  u32(payload, 4, 1); // entry_count
  return box('stsd', payload);
}

/**
 * 造一个结构完整的 mp4。
 *
 * @param {object} [options]
 * @param {number} [options.width=1920]
 * @param {number} [options.height=1080]
 * @param {number} [options.fps=30]
 * @param {string} [options.codec='avc1'] avc1=H.264 / hvc1=HEVC
 * @param {boolean} [options.faststart=true] false 时把 moov 放到 mdat 之后
 * @param {number} [options.durationMs=6000]
 * @param {number} [options.timescale=30000]
 * @param {number} [options.padding=1024] mdat payload 字节数
 * @returns {Uint8Array}
 */
export function makeMp4(options = {}) {
  const {
    width = 1920,
    height = 1080,
    fps = 30,
    codec = 'avc1',
    faststart = true,
    durationMs = 6000,
    timescale = 30000,
    padding = 1024,
  } = options;

  const samples = Math.max(1, Math.round((durationMs / 1000) * fps));
  const delta = Math.max(1, Math.round(timescale / fps));
  const duration = samples * delta;

  const ftyp = box('ftyp', concat([ASCII('mp42'), bytes(4), ASCII('mp42'), ASCII('isom')]));
  const moov = box('moov', concat([
    mvhd({ timescale, duration }),
    box('trak', concat([
      tkhd({ width, height, duration }),
      box('mdia', concat([
        hdlr('vide'),
        mdhd({ timescale, duration }),
        box('minf', box('stbl', concat([
          stsd(codec),
          stts({ samples, delta }),
        ]))),
      ])),
    ])),
  ]));
  const mdat = box('mdat', bytes(padding));

  return faststart ? concat([ftyp, moov, mdat]) : concat([ftyp, mdat, moov]);
}

function ASCII(text) {
  const out = bytes(text.length);
  ascii(out, 0, text);
  return out;
}

/**
 * 造一个最小 WebM：EBML 头 + Segment(Tracks(TrackEntry(Video(PixelWidth/PixelHeight,
 * DefaultDuration) + CodecID))) + Segment 的长度未知（0x01FFFFFFFFFFFFFF）。
 * 只够 snifMime / webmSize / webmFps 用。
 */
export function makeWebm({ width = 1920, height = 1080, codec = 'V_VP9', fps = 30 } = {}) {
  const el = (id, payload) => {
    const idBytes = ebmlIdBytes(id);
    const sizeBytes = ebmlSizeBytes(payload.length);
    return concat([idBytes, sizeBytes, payload]);
  };
  const uint32 = (value) => {
    const out = bytes(4);
    u32(out, 0, value);
    return out;
  };
  const video = el(0xe0, concat([
    el(0xb0, uint32(width)),
    el(0xba, uint32(height)),
    el(0x23e383, uint32(Math.round(1_000_000_000 / fps))),
  ]));
  const trackEntry = el(0xae, concat([
    el(0x86, ASCII(codec)),      // CodecID
    video,
  ]));
  const tracks = el(0x1654ae6b, trackEntry);
  const segment = concat([
    ebmlIdBytes(0x18538067),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // 长度未知
    tracks,
  ]);
  return concat([
    el(0x1a45dfa3, concat([el(0x4286, new Uint8Array([0x01]))])), // EBMLVersion
    segment,
  ]);
}

function ebmlIdBytes(id) {
  const out = [];
  let value = id;
  while (value > 0) {
    out.unshift(value & 0xff);
    value = Math.floor(value / 256);
  }
  return new Uint8Array(out);
}

function ebmlSizeBytes(size) {
  // 只用 4 字节写法：0x10 | 长度前缀，足够测试用
  const out = new Uint8Array(4);
  out[0] = 0x10 | ((size >>> 24) & 0x0f);
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  return out;
}
