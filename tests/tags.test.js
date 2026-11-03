import test from 'node:test';
import assert from 'node:assert/strict';

import { TAGS } from '../src/core/tags.js';

test('标签词表固定为四类', () => {
  assert.deepEqual([...TAGS], ['自然风景', '明星', '动漫', '游戏']);
  assert.equal(new Set(TAGS).size, TAGS.length);
});
