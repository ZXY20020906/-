import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { createEnv, jsonRequest, sessionCookie, sessionDeviceFields, USERS } from './harness.js';

const sessionOf = (user) => () => [{
  token_hash: 'hashed',
  expires_at: Date.now() + 60_000,
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  active: user.active,
  ...sessionDeviceFields(),
}];

async function call(env, request) {
  const response = await handle(request, env);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

const CATEGORIES = {
  cat_a: { id: 'cat_a', slug: 'dynamic', name: '动态', description: '', sort_order: 10, is_public: 1 },
  cat_b: { id: 'cat_b', slug: 'static', name: '静态', description: '', sort_order: 20, is_public: 1 },
};

function deleteEnv({ used = 3 } = {}) {
  return createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.categoryById]: (args) => (CATEGORIES[args[0]] ? [CATEGORIES[args[0]]] : []),
    [Q.countWallpapersInCategory]: () => [{ n: used }],
    [Q.detachWallpapersFromCategory]: () => [],
    [Q.moveWallpapersToCategory]: () => [],
    [Q.deleteCategory]: () => [],
    [Q.insertAudit]: () => [],
  });
}

const deleteRequest = (path) => jsonRequest(path, { method: 'DELETE', cookie: sessionCookie() });

test('删除分类：默认策略在下还有壁纸时 409，并告知可用的收尾方式', async () => {
  const { env } = deleteEnv();
  const res = await call(env, deleteRequest('/api/admin/categories/cat_a'));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.details.wallpaperCount, 3);
  assert.deepEqual(res.body.error.details.strategies, ['detach', 'move']);
});

test('删除分类：strategy=detach 把壁纸改成未分类', async () => {
  const { env, find } = deleteEnv();
  const res = await call(env, deleteRequest('/api/admin/categories/cat_a?strategy=detach'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.detached, 3);
  assert.equal(res.body.data.moved, 0);
  assert.equal(find(Q.detachWallpapersFromCategory).length, 1);
  assert.equal(find(Q.moveWallpapersToCategory).length, 0);
});

test('删除分类：strategy=move&to 迁移壁纸后再删，顺序不能反', async () => {
  const { env, calls, find } = deleteEnv();
  const res = await call(env, deleteRequest('/api/admin/categories/cat_a?strategy=move&to=cat_b'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.moved, 3);
  assert.equal(res.body.data.to, 'cat_b');

  const moved = find(Q.moveWallpapersToCategory);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].args[0], 'cat_b');
  assert.equal(moved[0].args[2], 'cat_a');
  assert.equal(find(Q.detachWallpapersFromCategory).length, 0);

  const order = calls.map((call_) => call_.sql);
  assert.ok(order.indexOf(Q.moveWallpapersToCategory) < order.indexOf(Q.deleteCategory), '先迁移再删分类');
});

test('删除分类：strategy=move 缺 to、指向自己、指向不存在的分类都被拒', async () => {
  const missing = deleteEnv();
  const noTarget = await call(missing.env, deleteRequest('/api/admin/categories/cat_a?strategy=move'));
  assert.equal(noTarget.status, 400);
  assert.equal(noTarget.body.error.details.field, 'to');
  assert.equal(missing.find(Q.deleteCategory).length, 0);

  const self = deleteEnv();
  const selfTarget = await call(self.env, deleteRequest('/api/admin/categories/cat_a?strategy=move&to=cat_a'));
  assert.equal(selfTarget.status, 400);
  assert.equal(self.find(Q.deleteCategory).length, 0);

  const unknown = deleteEnv();
  const ghost = await call(unknown.env, deleteRequest('/api/admin/categories/cat_a?strategy=move&to=cat_zzz'));
  assert.equal(ghost.status, 404);
  assert.equal(unknown.find(Q.deleteCategory).length, 0);
});

test('删除分类：空分类不需要策略也能直接删', async () => {
  const { env, find } = deleteEnv({ used: 0 });
  const res = await call(env, deleteRequest('/api/admin/categories/cat_a'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.detached, 0);
  assert.equal(res.body.data.moved, 0);
  assert.equal(find(Q.deleteCategory).length, 1);
  assert.equal(find(Q.detachWallpapersFromCategory).length, 0);
});

test('删除分类：编辑角色无权删除 → 403', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: sessionOf(USERS.editor) });
  const res = await call(env, deleteRequest('/api/admin/categories/cat_a?strategy=detach'));
  assert.equal(res.status, 403);
});
