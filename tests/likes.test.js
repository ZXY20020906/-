import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { createEnv, jsonRequest, sessionCookie, sessionDeviceFields, USERS, wallpaperRow } from './harness.js';

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
  return { status: response.status, body };
}

const ROOT = `usr_${USERS.admin.id}`;

function likesEnv() {
  return createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.likesForUser]: () => [
      { slug: 'catppuccin', title: 'Catppuccin', category_slug: 'assistant-skin', created_at: 1700000000000 },
    ],
    [Q.wallpaperBySlug]: ([slug]) => (slug === 'catppuccin' ? [wallpaperRow({ id: 'wp_like', slug: 'catppuccin' })] : []),
    [Q.insertLike]: () => [],
    [Q.deleteLike]: () => [],
  });
}

test('喜欢：列表返回 slug + 分类', async () => {
  const { env } = likesEnv();
  const res = await call(env, jsonRequest('/api/likes', { cookie: sessionCookie() }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.likes, [{
    slug: 'catppuccin',
    title: 'Catppuccin',
    categorySlug: 'assistant-skin',
    createdAt: 1700000000000,
  }]);
});

test('喜欢：PUT 落库，DELETE 删除；未知 slug 404', async () => {
  const { env, find } = likesEnv();
  const add = await call(env, jsonRequest('/api/likes/catppuccin', { method: 'PUT', cookie: sessionCookie() }));
  assert.equal(add.status, 200);
  assert.equal(add.body.data.liked, true);
  assert.equal(find(Q.insertLike).length, 1);
  assert.equal(find(Q.insertLike)[0].args[0], USERS.admin.id);
  assert.equal(find(Q.insertLike)[0].args[1], 'wp_like');

  const remove = await call(env, jsonRequest('/api/likes/catppuccin', { method: 'DELETE', cookie: sessionCookie() }));
  assert.equal(remove.status, 200);
  assert.equal(remove.body.data.liked, false);
  assert.equal(find(Q.deleteLike).length, 1);

  const missing = await call(env, jsonRequest('/api/likes/nope', { method: 'PUT', cookie: sessionCookie() }));
  assert.equal(missing.status, 404);
});

test('喜欢：未登录访问被拒', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: () => [] });
  const res = await call(env, jsonRequest('/api/likes'));
  assert.equal(res.status, 401);
});

test('后台列表 liked=1 把当前用户传进 SQL，且不影响 kind 筛选', async () => {
  const { env, find } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.adminListWallpapers]: () => [],
    [Q.adminCountWallpapers]: () => [{ n: 0 }],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers?liked=1', { cookie: sessionCookie() }));
  assert.equal(res.status, 200);
  const args = find(Q.adminListWallpapers)[0].args;
  assert.equal(args.length, 12);
  assert.equal(args[8], USERS.admin.id);
  assert.equal(args[9], null, '没传 review 时应该是 null');
  assert.equal(args[10], null, '没传 subtag 时应该是 null');
  assert.equal(args[11], null, '没传 format 时应该是 null');
});
