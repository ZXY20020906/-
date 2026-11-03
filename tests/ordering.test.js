import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReorderPlan, nextSortOrder, SORT_STEP } from '../src/core/ordering.js';
import { cursorForSort, decodeCursor, encodeCursor, normalizeCursor } from '../src/core/pagination.js';

test('重排：id 集合必须完全一致', () => {
  const plan = buildReorderPlan(['a', 'b', 'c'], ['c', 'a', 'b']);
  assert.deepEqual(plan, [
    { id: 'c', sortOrder: SORT_STEP },
    { id: 'a', sortOrder: SORT_STEP * 2 },
    { id: 'b', sortOrder: SORT_STEP * 3 },
  ]);
});

test('重排：拒绝缺项、多项、重复、未知 id', () => {
  assert.throws(() => buildReorderPlan(['a', 'b'], ['a']), /全部 2 项/);
  assert.throws(() => buildReorderPlan(['a', 'b'], ['a', 'b', 'c']), /全部 2 项/);
  assert.throws(() => buildReorderPlan(['a', 'b'], ['a', 'a']), /重复/);
  assert.throws(() => buildReorderPlan(['a', 'b'], ['a', 'z']), /未知的 id/);
  assert.throws(() => buildReorderPlan(['a'], []), /非空数组/);
});

test('下一个 sortOrder 总是大于现有最大值', () => {
  assert.equal(nextSortOrder([]), SORT_STEP);
  assert.equal(nextSortOrder([{ sort_order: 0 }]), SORT_STEP);
  assert.equal(nextSortOrder([{ sort_order: 10 }, { sort_order: 30 }]), 40);
  assert.equal(nextSortOrder([{ sortOrder: 55 }]), 65);
});

test('游标编解码保持 Unicode 标题完整', () => {
  const token = encodeCursor({ t: '夜雨·霓虹', i: 'wp_1' });
  const decoded = decodeCursor(token);
  assert.equal(decoded.t, '夜雨·霓虹');
  assert.equal(decoded.i, 'wp_1');
});

test('游标只允许 URL 安全字符', () => {
  const token = encodeCursor({ t: 123, i: 'abc' });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test('非法游标被拒绝而不是崩掉', () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(''), null);
  assert.throws(() => decodeCursor('!!!not-base64!!!'), /cursor/);
});

test('游标与排序方式不匹配时报错', () => {
  assert.throws(() => normalizeCursor({ t: 123, i: 'a' }, 'name'), /不匹配/);
  assert.throws(() => normalizeCursor({ i: 'a' }, 'recent'), /cursor/);
  assert.deepEqual(normalizeCursor({ t: 100, i: 'a' }, 'recent'), { key: 100, id: 'a' });
});

test('每种排序生成对应的游标键', () => {
  const row = {
    id: 'wp_1', title: 'Demo', bytes: 2048, published_at: 5000, created_at: 4000, width: 3840, height: 2160,
  };
  assert.deepEqual(decodeCursor(cursorForSort('recent', row)), { t: 5000, i: 'wp_1' });
  assert.deepEqual(decodeCursor(cursorForSort('oldest', row)), { t: 5000, i: 'wp_1' });
  assert.deepEqual(decodeCursor(cursorForSort('name', row)), { t: 'Demo', i: 'wp_1' });
  assert.deepEqual(decodeCursor(cursorForSort('size', row)), { t: 2048, i: 'wp_1' });
  assert.deepEqual(decodeCursor(cursorForSort('resolution', row)), { t: 3840 * 2160, i: 'wp_1' });
  assert.deepEqual(decodeCursor(cursorForSort('resolution', { ...row, width: null, height: null })), { t: 0, i: 'wp_1' });
});
