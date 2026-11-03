import test from 'node:test';
import assert from 'node:assert/strict';

import { ASPECTS, aspectKeyFor as serverAspectKey, parseAspect } from '../src/core/aspects.js';
import { ASPECT_KEYS, aspectKeyFor, matchesAspect } from '../public/assets/gallery-core.js';

test('服务端与浏览器的档位表必须一致', () => {
  assert.deepEqual(ASPECTS.map((item) => item.key), [...ASPECT_KEYS]);
});

test('常见分辨率归到正确的档位', () => {
  assert.equal(serverAspectKey(1920, 1080), '16:9');
  assert.equal(serverAspectKey(2560, 1440), '16:9');
  assert.equal(serverAspectKey(3840, 2160), '16:9');
  assert.equal(serverAspectKey(2560, 1080), '21:9');
  assert.equal(serverAspectKey(3440, 1440), '21:9');
  assert.equal(serverAspectKey(5120, 1440), '32:9');
  assert.equal(serverAspectKey(1080, 1920), '9:16');
  assert.equal(serverAspectKey(1600, 1200), '4:3');
  assert.equal(serverAspectKey(1000, 1000), '1:1');
});

test('离谱的比例不归到任何档位', () => {
  assert.equal(serverAspectKey(1000, 100), null);
  assert.equal(serverAspectKey(0, 1080), null);
  assert.equal(serverAspectKey(null, null), null);
});

test('parseAspect 只认已知键，其它一律不过滤', () => {
  assert.equal(parseAspect('16:9'), 16 / 9);
  assert.equal(parseAspect('21:9'), 21 / 9);
  assert.equal(parseAspect(''), null);
  assert.equal(parseAspect('13:7'), null);
  assert.equal(parseAspect(null), null);
});

test('浏览器侧判断与服务端结果一致', () => {
  const cases = [[1920, 1080], [2560, 1080], [1080, 1920], [1440, 1080], [800, 800]];
  for (const [w, h] of cases) {
    assert.equal(aspectKeyFor(w, h), serverAspectKey(w, h));
  }
});

test('matchesAspect：空筛选一律通过', () => {
  assert.equal(matchesAspect({ width: 1920, height: 1080 }, ''), true);
  assert.equal(matchesAspect({ width: 1920, height: 1080 }, '16:9'), true);
  assert.equal(matchesAspect({ width: 1920, height: 1080 }, '9:16'), false);
  assert.equal(matchesAspect({ width: null, height: null }, '16:9'), false);
});
