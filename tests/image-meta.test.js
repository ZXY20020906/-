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
