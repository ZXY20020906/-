import test from 'node:test';
import assert from 'node:assert/strict';

import { variantsDto, wallpaperDto } from '../src/server/dto.js';

const KEY = 'wallpapers/wp_1/ab1a59bb37b3.1080p.mp4';

function rowWith(variants) {
  return {
    id: 'wp_1', slug: 'demo', title: '示例', kind: 'dynamic',
    mime: 'video/mp4', bytes: 47231464, storage_key: 'wallpapers/wp_1/orig.mp4',
    tags: '[]', variants,
  };
}

test('variants：正常 JSON → 同域 url + 由高度推出的 label', () => {
  const out = variantsDto({
    variants: JSON.stringify([{ height: 1080, key: KEY, bytes: 7861004, sha256: 'ab1a' }]),
  }, 'https://cdn.test');
  assert.deepEqual(out, [{
    label: '1080p', height: 1080, bytes: 7861004, sha256: 'ab1a',
    url: `https://cdn.test/${KEY}`,
  }]);
});

test('variants：坏数据一律降级成空数组，绝不抛错', () => {
  // 脏 JSON / 不是数组 / 空值 / 缺 key / bytes 非正 —— 全是「老库」可能出现的形状
  for (const bad of ['{坏掉的', '{}', null, undefined, '', '[1,2]',
    JSON.stringify([{ height: 1080, bytes: 7861004 }]),
    JSON.stringify([{ height: 1080, key: KEY, bytes: 0 }])]) {
    assert.deepEqual(variantsDto({ variants: bad }), [], `bad=${String(bad)}`);
  }
  // 行本身都没有也不能崩（老 D1 没有这列时 row.variants 是 undefined）
  assert.deepEqual(variantsDto({}), []);
  assert.deepEqual(variantsDto(undefined), []);
});

test('variants：按 bytes 升序（契约要求），没有 mediaBase 时回落到 /media', () => {
  const out = variantsDto({
    variants: JSON.stringify([
      { height: 2160, key: 'wallpapers/wp_1/big.2160p.mp4', bytes: 47231464 },
      { height: 1080, key: KEY, bytes: 7861004 },
    ]),
  });
  assert.deepEqual(out.map((item) => item.label), ['1080p', '2160p']);
  assert.equal(out[0].url, `/media/${KEY}`);
});

test('公开 DTO：没有变体时字段存在且为空数组（老客户端读不到也不会崩）', () => {
  assert.deepEqual(wallpaperDto(rowWith(undefined)).variants, []);
  assert.deepEqual(wallpaperDto(rowWith(null)).variants, []);
  const withVariant = wallpaperDto(rowWith(JSON.stringify([
    { height: 1080, key: KEY, bytes: 7861004 },
  ])));
  assert.equal(withVariant.variants.length, 1);
  assert.equal(withVariant.url, '/media/wallpapers/wp_1/orig.mp4');
});
