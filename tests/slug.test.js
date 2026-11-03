import test from 'node:test';
import assert from 'node:assert/strict';

import { slugify, uniqueSlug, shortHash } from '../src/core/slug.js';

test('英文标题转成常规 slug', () => {
  assert.equal(slugify('Night Rain Neon'), 'night-rain-neon');
  assert.equal(slugify('  Hello--World__2024  '), 'hello-world-2024');
  assert.equal(slugify('A/B 测试!!'), 'a-b-测试');
});

test('中文标题保留汉字，不产生空 slug', () => {
  assert.equal(slugify('夜雨霓虹'), '夜雨霓虹');
  assert.equal(slugify('极简·白'), '极简-白');
  assert.notEqual(slugify('!!!'), '');
});

test('ascii 模式下中文退化为哈希后缀，且结果稳定', () => {
  const first = slugify('夜雨霓虹', { ascii: true });
  const second = slugify('夜雨霓虹', { ascii: true });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}$/);

  const mixed = slugify('Neon 夜雨', { ascii: true });
  assert.match(mixed, /^neon-[0-9a-f]{8}$/);
});

test('超长标题被截断且不以连字符结尾', () => {
  const out = slugify('a'.repeat(200), { max: 20 });
  assert.ok(out.length <= 20);
  assert.ok(!out.endsWith('-'));
});

test('uniqueSlug 依次追加 -2、-3', async () => {
  const taken = new Set(['demo', 'demo-2', 'demo-3']);
  const out = await uniqueSlug('demo', (candidate) => taken.has(candidate));
  assert.equal(out, 'demo-4');
});

test('uniqueSlug 支持异步 isTaken 且在空标题时用兜底值', async () => {
  const out = await uniqueSlug('   ', async () => false, { fallback: 'wallpaper' });
  assert.equal(out, 'wallpaper');
});

test('uniqueSlug 截断后仍保留后缀可读性', async () => {
  const out = await uniqueSlug('x'.repeat(60), (c) => c.length > 58);
  assert.ok(out.length <= 60);
});

test('shortHash 稳定且为 8 位十六进制', () => {
  assert.match(shortHash('abc'), /^[0-9a-f]{8}$/);
  assert.equal(shortHash('abc'), shortHash('abc'));
});
