/**
 * 分片上传的 `_tmp/` 清理：`?dryRun=1` 必须**只列不删**（验收 E4 的单测版本）。
 *
 * 线上那一条只能证明「接口通了」——线上现在没有 24 小时前的临时对象，
 * 空列表说明不了「不删」。这里用假桶造一个 48 小时前的对象，直接验两个分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanup } from '../src/server/routes/uploads.js';

const ADMIN = { id: 'usr_test', role: 'admin', active: 1 };

function makeBucket(objects) {
  const deleted = [];
  return {
    deleted,
    async list({ prefix, cursor }) {
      const matched = objects.filter((item) => item.key.startsWith(prefix ?? ''));
      // 一次给完，测的是「删不删」而不是分页
      return { objects: cursor ? [] : matched, truncated: false, cursor: null };
    },
    async delete(key) { deleted.push(key); },
  };
}

const OLD = {
  key: '_tmp/uploads/wp_1/old.bin',
  uploaded: new Date(Date.now() - 48 * 3600 * 1000),
  size: 10,
};
const FRESH = {
  key: '_tmp/uploads/wp_1/fresh.bin',
  uploaded: new Date(Date.now() - 60 * 1000),
  size: 10,
};

test('清理：dryRun 只列出将被删除的对象，一个都不删', async () => {
  const bucket = makeBucket([OLD, FRESH]);
  const response = await cleanup({
    env: { BUCKET: bucket },
    actor: ADMIN,
    url: new URL('https://x.test/api/admin/uploads/cleanup?dryRun=1'),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.dryRun, true);
  assert.equal(payload.data.scanned, 2, '扫到两个对象');
  assert.equal(payload.data.deleted, 0);
  assert.deepEqual(payload.data.wouldDelete.map((item) => item.key), [OLD.key], '只有超过 24h 的那个会被删');
  assert.deepEqual(bucket.deleted, [], 'dry-run 不能真的删任何东西');
});

test('清理：不带 dryRun 才真的删（且仍然只删超过 24h 的）', async () => {
  const bucket = makeBucket([OLD, FRESH]);
  const response = await cleanup({
    env: { BUCKET: bucket },
    actor: ADMIN,
    url: new URL('https://x.test/api/admin/uploads/cleanup'),
  });
  const payload = await response.json();
  assert.equal(payload.data.dryRun, undefined);
  assert.equal(payload.data.scanned, 2);
  assert.equal(payload.data.deleted, 1);
  assert.deepEqual(bucket.deleted, [OLD.key], '新对象不能被误删');
});
