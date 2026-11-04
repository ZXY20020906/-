import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ALLOWED_MIME, kindMatchesMime, limitForMime, readDurationMs, readMediaMeta, sniffMime,
  MAX_BUNDLE_BYTES, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES,
} from '../src/core/image-meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => new Uint8Array(readFileSync(resolve(here, 'fixtures', name)));

function asciiWrite(buf, offset, text) {
  for (let i = 0; i < text.length; i += 1) buf[offset + i] = text.charCodeAt(i);
}
function be32Write(buf, offset, value) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

for (const [file, mime, width, height] of [
  ['sample.png', 'image/png', 4, 3],
  ['sample.jpg', 'image/jpeg', 5, 2],
  ['sample.gif', 'image/gif', 7, 6],
  ['sample.webp', 'image/webp', 8, 9],
  ['lossless.webp', 'image/webp', 11, 13],
]) {
  test(`识别 ${file} 的类型与尺寸`, () => {
    const meta = readMediaMeta(fixture(file));
    assert.equal(meta.mime, mime);
    assert.equal(meta.width, width);
    assert.equal(meta.height, height);
  });
}

test('AVIF：通过 ispe box 读出尺寸', () => {
  const buf = new Uint8Array(64);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'avif');
  buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x18;
  asciiWrite(buf, 20, 'ispe');
  be32Write(buf, 24, 0); // version + flags
  be32Write(buf, 28, 1920);
  be32Write(buf, 32, 1080);

  const meta = readMediaMeta(buf);
  assert.equal(meta.mime, 'image/avif');
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
});

test('视频只做类型识别，不猜尺寸', () => {
  const mp4 = new Uint8Array(24);
  asciiWrite(mp4, 4, 'ftyp');
  asciiWrite(mp4, 8, 'mp42');
  assert.equal(sniffMime(mp4), 'video/mp4');
  const meta = readMediaMeta(mp4);
  assert.equal(meta.mime, 'video/mp4');
  assert.equal(meta.width, null);

  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffMime(webm), 'video/webm');
});

test('伪装成图片的文本被拒绝', () => {
  const text = new TextEncoder().encode('this is definitely not an image');
  const meta = readMediaMeta(text);
  assert.equal(meta.mime, null);
  assert.ok(meta.error);
  assert.ok(!ALLOWED_MIME.includes(meta.mime));
});

test('空文件与超短文件不崩', () => {
  assert.equal(readMediaMeta(new Uint8Array()).mime, null);
  assert.equal(readMediaMeta(Uint8Array.from([0x89, 0x50])).mime, null);
});

test('静态/动态 与 mime 的匹配规则', () => {
  assert.ok(kindMatchesMime('static', 'image/png'));
  assert.equal(kindMatchesMime('static', 'video/mp4'), false);
  assert.ok(kindMatchesMime('dynamic', 'video/webm'));
  assert.equal(kindMatchesMime('dynamic', 'image/webp'), false);
});

test('开机动画包：识别为 zip，不猜尺寸', () => {
  const zip = new Uint8Array(48);
  zip.set([0x50, 0x4b, 0x03, 0x04], 0);
  const meta = readMediaMeta(zip);
  assert.equal(meta.mime, 'application/zip');
  assert.equal(meta.width, null);
  assert.ok(ALLOWED_MIME.includes('application/zip'));

  // 空包（PK\x05\x06）同样是合法 zip
  const empty = new Uint8Array(24);
  empty.set([0x50, 0x4b, 0x05, 0x06], 0);
  assert.equal(sniffMime(empty), 'application/zip');
});

test('开机动画包归在「动态」下，且有独立的体积上限', () => {
  assert.ok(kindMatchesMime('dynamic', 'application/zip'));
  assert.equal(kindMatchesMime('static', 'application/zip'), false);
  assert.equal(limitForMime('application/zip'), MAX_BUNDLE_BYTES);
  assert.ok(MAX_BUNDLE_BYTES > MAX_VIDEO_BYTES);
  assert.equal(MAX_UPLOAD_BYTES, MAX_BUNDLE_BYTES);
});

test('识别 mp4 的宽高（tkhd，16.16 定点数）', () => {
  const buf = new Uint8Array(160);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  const tkhd = 32;
  asciiWrite(buf, tkhd, 'tkhd');
  buf[tkhd + 4] = 0; // version 0
  be32Write(buf, tkhd + 80, 1280 * 65536);
  be32Write(buf, tkhd + 84, 720 * 65536);

  const meta = readMediaMeta(buf);
  assert.equal(meta.mime, 'video/mp4');
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
});

test('识别 mp4 的宽高（tkhd version 1，字段后移）', () => {
  const buf = new Uint8Array(200);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  const tkhd = 32;
  asciiWrite(buf, tkhd, 'tkhd');
  buf[tkhd + 4] = 1;
  be32Write(buf, tkhd + 92, 2160 * 65536);
  be32Write(buf, tkhd + 96, 3840 * 65536);

  const meta = readMediaMeta(buf);
  assert.equal(meta.width, 2160);
  assert.equal(meta.height, 3840);
});

test('音量轨的 tkhd 是 0×0，不该被当成尺寸', () => {
  const buf = new Uint8Array(240);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  asciiWrite(buf, 32, 'tkhd');
  buf[36] = 0;
  be32Write(buf, 32 + 80, 0);
  be32Write(buf, 32 + 84, 0);
  // 真正的视频轨在后面，尺寸更大
  asciiWrite(buf, 120, 'tkhd');
  buf[124] = 0;
  be32Write(buf, 120 + 80, 1920 * 65536);
  be32Write(buf, 120 + 84, 1080 * 65536);

  const meta = readMediaMeta(buf);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
});

test('体积上限按类型区分', () => {
  assert.equal(limitForMime('image/png'), MAX_IMAGE_BYTES);
  assert.equal(limitForMime('video/mp4'), MAX_VIDEO_BYTES);
  assert.ok(MAX_VIDEO_BYTES > MAX_IMAGE_BYTES);
});

// ---------------------------------------------------------------- EBML / webm

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** 造一个 EBML element：id 原样给（含长度前缀位），payload < 127 字节时用单字节 size。 */
function ebml(idBytes, ...children) {
  const payload = concatBytes(children);
  assert.ok(payload.length < 127, 'fixture payload 过大');
  return concatBytes([Uint8Array.from(idBytes), Uint8Array.from([0x80 | payload.length]), payload]);
}

function uintBytes(value, width) {
  const out = new Uint8Array(width);
  let left = value;
  for (let i = width - 1; i >= 0; i -= 1) { out[i] = left & 0xff; left = Math.floor(left / 256); }
  return out;
}

function float64Bytes(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

const EBML_HEADER = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);

/** 最小 webm：EBML 头 + Segment(Info(Duration), Tracks(TrackEntry(Video(w,h)))) */
function fakeWebm({ width = 2560, height = 1440, duration = 12000, timecodeScale = null } = {}) {
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    ...(timecodeScale === null ? [] : [ebml([0x2a, 0xd7, 0xb1], uintBytes(timecodeScale, 3))]),
    ebml([0x44, 0x89], float64Bytes(duration)),
  );
  const video = ebml([0xe0], ebml([0xb0], uintBytes(width, 2)), ebml([0xba], uintBytes(height, 2)));
  const trackEntry = ebml([0xae], video);
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const segment = ebml([0x18, 0x53, 0x80, 0x67], info, tracks);
  return concatBytes([EBML_HEADER, segment]);
}

test('识别 webm 的宽高（EBML PixelWidth/PixelHeight）', () => {
  const meta = readMediaMeta(fakeWebm());
  assert.equal(meta.mime, 'video/webm');
  assert.equal(meta.width, 2560);
  assert.equal(meta.height, 1440);
});

test('webm 的宽高不是写死的：换一组数字照样读对', () => {
  const meta = readMediaMeta(fakeWebm({ width: 3840, height: 2160 }));
  assert.equal(meta.width, 3840);
  assert.equal(meta.height, 2160);
});

test('从 EBML Info/Duration 读 webm 时长（默认 TimecodeScale=1ms）', () => {
  assert.equal(readDurationMs(fakeWebm({ duration: 12000 }), 'video/webm'), 12000);
  assert.equal(readDurationMs(fakeWebm({ duration: 30500 }), 'video/webm'), 30500);
  // TimecodeScale 100000ns = 0.1ms 时，同样的 Duration 值对应更短的时间
  assert.equal(readDurationMs(fakeWebm({ duration: 12000, timecodeScale: 100000 }), 'video/webm'), 1200);
});

test('webm 读不出元数据时返回 null，不瞎猜、不抛错', () => {
  // 只有 EBML magic，后面啥都没有
  const bare = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(sniffMime(bare), 'video/webm');
  const meta = readMediaMeta(bare);
  assert.equal(meta.mime, 'video/webm');
  assert.equal(meta.width, null);
  assert.equal(meta.height, null);
  assert.equal(readDurationMs(bare, 'video/webm'), null);

  // Duration 为 0 / 负数当没读到
  assert.equal(readDurationMs(fakeWebm({ duration: 0 }), 'video/webm'), null);
  assert.equal(readDurationMs(fakeWebm({ duration: -5 }), 'video/webm'), null);
  assert.equal(readDurationMs(null, 'video/webm'), null);
});

test('moov 在文件尾部（非 faststart）的 mp4 也能读到宽高与时长', () => {
  // 3MB 文件：前 2MB 只有 mdat，tkhd/mvhd 被推到尾部——以前这种一律读成 null
  const size = 3 * 1024 * 1024;
  const buf = new Uint8Array(size);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  asciiWrite(buf, 32, 'mdat');

  const tail = size - 1024;
  asciiWrite(buf, tail, 'moov');
  asciiWrite(buf, tail + 16, 'tkhd');
  buf[tail + 16 + 4] = 0;
  be32Write(buf, tail + 16 + 80, 3840 * 65536);
  be32Write(buf, tail + 16 + 84, 2160 * 65536);
  asciiWrite(buf, tail + 256, 'mvhd');
  buf[tail + 256 + 4] = 0;
  be32Write(buf, tail + 256 + 16, 1000);
  be32Write(buf, tail + 256 + 20, 5350);

  const meta = readMediaMeta(buf);
  assert.equal(meta.mime, 'video/mp4');
  assert.equal(meta.width, 3840);
  assert.equal(meta.height, 2160);
  assert.equal(readDurationMs(buf, 'video/mp4'), 5350);
});

test('faststart 的 mp4 仍然只读头部，行为不变', () => {
  const size = 3 * 1024 * 1024;
  const buf = new Uint8Array(size);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  asciiWrite(buf, 32, 'moov');
  asciiWrite(buf, 48, 'tkhd');
  buf[52] = 0;
  be32Write(buf, 48 + 80, 1920 * 65536);
  be32Write(buf, 48 + 84, 1080 * 65536);

  const meta = readMediaMeta(buf);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
});

/** 造一个只带 ftyp + mvhd 的最小 mp4 头，够解析器用 */
function fakeMp4({ version = 0, timescale = 1000, duration = 5000 } = {}) {
  const buf = new Uint8Array(96);
  asciiWrite(buf, 4, 'ftyp');
  asciiWrite(buf, 8, 'mp42');
  const mvhd = 32;
  asciiWrite(buf, mvhd, 'mvhd');
  buf[mvhd + 4] = version;
  if (version === 1) {
    be32Write(buf, mvhd + 24, timescale);
    be32Write(buf, mvhd + 28, 0); // duration 高 32 位
    be32Write(buf, mvhd + 32, duration); // 低 32 位
  } else {
    be32Write(buf, mvhd + 16, timescale);
    be32Write(buf, mvhd + 20, duration);
  }
  return buf;
}

test('从 mvhd 读视频时长（version 0）', () => {
  assert.equal(readDurationMs(fakeMp4(), 'video/mp4'), 5000);
  assert.equal(readDurationMs(fakeMp4({ timescale: 1000, duration: 6500 }), 'video/mp4'), 6500);
  assert.equal(readDurationMs(fakeMp4({ timescale: 30000, duration: 90000 }), 'video/mp4'), 3000);
});

test('从 mvhd 读视频时长（version 1，64 位时长）', () => {
  assert.equal(readDurationMs(fakeMp4({ version: 1, timescale: 1000, duration: 12500 }), 'video/mp4'), 12500);
});

test('时长读不出来就返回 null，不瞎猜', () => {
  assert.equal(readDurationMs(fakeMp4({ duration: 0 }), 'video/mp4'), null);
  assert.equal(readDurationMs(fakeMp4({ timescale: 0 }), 'video/mp4'), null);
  assert.equal(readDurationMs(fakeMp4({ timescale: 1000, duration: 0x7fffffff }), 'video/mp4'), null);
  // 非 mp4 / 没有 mvhd
  assert.equal(readDurationMs(fixture('sample.png'), 'image/png'), null);
  assert.equal(readDurationMs(new Uint8Array(96), 'video/mp4'), null);
  assert.equal(readDurationMs(null, 'video/mp4'), null);
});
