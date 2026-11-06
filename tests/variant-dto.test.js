/**
 * 回归：variantsDto 必须同时吃「JSON 字符串」和「已经是数组」两种形态。
 * 现场踩过：D1 里存的是字符串，某些路径传进来的却可能是对象数组。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { variantsDto } from '../src/server/dto.js';

const VARIANTS = [
  { label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 2_000_000, key: 'wallpapers/wp_1/aaaa.1080p.mp4' },
  { label: '720p', width: 1280, height: 720, fps: 30, bytes: 900_000, key: 'wallpapers/wp_1/bbbb.720p.mp4' },
];

test('variantsDto：JSON 字符串形态', () => {
  const out = variantsDto({ variants: JSON.stringify(VARIANTS) });
  assert.equal(out.length, 2);
  assert.equal(out[0].label, '720p', '按 bytes 升序');
  assert.equal(out[1].fps, 30);
  assert.match(out[1].url, /\/media\//);
});

test('variantsDto：对象数组形态', () => {
  const out = variantsDto({ variants: VARIANTS });
  assert.equal(out.length, 2);
  assert.equal(out[1].width, 1920);
});

test('variantsDto：坏数据 / 空值降级成空数组', () => {
  assert.deepEqual(variantsDto({}), []);
  assert.deepEqual(variantsDto({ variants: null }), []);
  assert.deepEqual(variantsDto({ variants: 'not-json' }), []);
  assert.deepEqual(variantsDto({ variants: [{ label: 'x', bytes: 0, key: 'k' }] }), [], '缺 bytes 的条目丢弃');
});

test('variantsDto：mediaBase 前缀生效', () => {
  const out = variantsDto({ variants: [VARIANTS[0]] }, 'https://img.example.com');
  assert.match(out[0].url, /^https:\/\/img\.example\.com\/wallpapers\//);
});
