import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import {
  createEnv, jsonRequest, sessionCookie, sessionDeviceFields, USERS, wallpaperRow,
} from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const PNG = new Uint8Array(readFileSync(resolve(here, 'fixtures', 'sample.png')));

// 删除成员要站点级口令（env.ADMIN_PASSCODE），不是操作者密码
const DELETE_PASSCODE = 'test-delete-passcode';

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

test('公开接口无需登录，并带 CORS', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: () => [],
    [Q.publicRecent]: () => [],
    [Q.publicCount]: () => [{ n: 0 }],
  });
  const res = await call(env, new Request('https://example.test/api/public/wallpapers'));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.items, []);
  assert.equal(res.body.data.hasMore, false);
  // 插件 / 扩展从任意源来取，公开只读数据统一 *
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('公开接口的 OPTIONS 预检返回 204', async () => {
  const { env } = createEnv({});
  const res = await call(env, new Request('https://example.test/api/public/wallpapers', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /GET/);
});

test('公开列表：筛选条件与 limit+1 正确下传，并给出 nextCursor', async () => {
  const rows = [
    { id: 'wp_3', slug: 'c', title: 'C', kind: 'static', bytes: 3, width: 1, height: 1, tags: '[]', featured: 0, published_at: 3000, created_at: 3000, storage_key: 'k3.png', category_id: null },
    { id: 'wp_2', slug: 'b', title: 'B', kind: 'static', bytes: 2, width: 1, height: 1, tags: '[]', featured: 0, published_at: 2000, created_at: 2000, storage_key: 'k2.png', category_id: null },
    { id: 'wp_1', slug: 'a', title: 'A', kind: 'static', bytes: 1, width: 1, height: 1, tags: '[]', featured: 0, published_at: 1000, created_at: 1000, storage_key: 'k1.png', category_id: null },
  ];
  const { env, calls } = createEnv({
    [Q.sessionByToken]: () => [],
    [Q.publicRecent]: () => rows,
    [Q.publicCount]: () => [{ n: 42 }],
  });
  const res = await call(env, new Request('https://example.test/api/public/wallpapers?category=dynamic&kind=static&q=%E5%A4%9C&limit=2'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 2);
  assert.equal(res.body.data.total, 42);
  assert.equal(res.body.data.hasMore, true);
  assert.ok(res.body.data.nextCursor);

  const listCall = calls.find((entry) => entry.sql === Q.publicRecent);
  assert.deepEqual(listCall.args.slice(0, 3), ['dynamic', 'static', '%夜%']);
  assert.equal(listCall.args[6], 3, 'limit 应该以 limit+1 查询，才能判断 hasMore');
});

test('公开列表：page 参数换算 offset，并返回页码信息', async () => {
  const rows = [
    { id: 'wp_2', slug: 'b', title: 'B', kind: 'static', bytes: 2, width: 1, height: 1, tags: '[]', featured: 0, published_at: 2000, created_at: 2000, storage_key: 'k2.png', category_id: null },
    { id: 'wp_1', slug: 'a', title: 'A', kind: 'static', bytes: 1, width: 1, height: 1, tags: '[]', featured: 0, published_at: 1000, created_at: 1000, storage_key: 'k1.png', category_id: null },
  ];
  const { env, calls } = createEnv({
    [Q.sessionByToken]: () => [],
    [Q.publicRecent]: () => rows,
    [Q.publicCount]: () => [{ n: 42 }],
  });
  const res = await call(env, new Request('https://example.test/api/public/wallpapers?page=2&limit=2'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.page, 2);
  assert.equal(res.body.data.pageCount, 21);
  assert.equal(res.body.data.offset, 2);
  assert.equal(res.body.data.pageSize, 2);
  assert.equal(res.body.data.nextCursor, null, '页码模式下不再返回游标');

  const listCall = calls.find((entry) => entry.sql === Q.publicRecent);
  assert.equal(listCall.args[9], 2, 'offset 应该是 (page - 1) * limit');
});

test('公开单张：不存在时 404', async () => {
  const { env } = createEnv({ [Q.publicBySlug]: () => [] });
  const res = await call(env, new Request('https://example.test/api/public/wallpapers/nope'));
  assert.equal(res.status, 404);
});

test('写请求缺少 X-Folia-Client 头被拒绝（CSRF 防线）', async () => {
  const { env } = createEnv({});
  const request = new Request('https://example.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co', password: 'whatever-1' }),
  });
  const res = await call(env, request);
  assert.equal(res.status, 403);
  assert.match(res.body.error.message, /X-Folia-Client/);
});

test('登录：账号不存在时也返回同一句话', async () => {
  const { env } = createEnv({
    [Q.userByEmail]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@folia.test', password: 'whatever-123' },
  }));
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, '邮箱或密码不正确');
});

test('未登录访问管理接口 → 401', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: () => [] });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers'));
  assert.equal(res.status, 401);
});

test('编辑不能改别人上传的壁纸 → 403', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.admin.id })],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { title: '偷改标题' },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.details.required, 'wallpaper:update');
});

test('编辑可以改自己上传的壁纸', async () => {
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id })],
    [Q.updateWallpaper]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { title: '我的新标题' },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 200);
  const updates = calls.filter((call_) => call_.sql === Q.updateWallpaper);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].args[1], '我的新标题');
});

test('编辑发布自己的壁纸 → 403（发布权只给管理员）', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, storage_key: 'k.png' })],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { status: 'published' },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 403);
  assert.equal(res.body.error.details.required, 'wallpaper:publish');
});

test('管理员发布时写入 published_at', async () => {
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, storage_key: 'k.png' })],
    [Q.updateWallpaper]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { status: 'published' },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 200);
  const update = calls.find((call_) => call_.sql === Q.updateWallpaper);
  // slug, title, description, subtag, category, kind, status, review_status, tags, featured, sort, updated_at, published_at, id
  assert.equal(update.args[6], 'published');
  assert.equal(typeof update.args[12], 'number');
  assert.ok(update.args[12] > 0, 'published_at 应该被写入时间戳');
});

test('没有文件时不允许发布', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.wallpaperById]: () => [wallpaperRow({ storage_key: null })],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { status: 'published' },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /上传/);
});

test('编辑不能删除壁纸 → 403', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: sessionOf(USERS.editor) });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'DELETE',
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 403);
});

test('编辑不能新建分类、不能看成员列表', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.insertAudit]: () => [],
  });
  const createRes = await call(env, jsonRequest('/api/admin/categories', {
    method: 'POST',
    body: { name: '新分类' },
    cookie: sessionCookie(),
  }));
  assert.equal(createRes.status, 403);

  const membersRes = await call(env, new Request('https://example.test/api/admin/members', {
    headers: { cookie: sessionCookie() },
  }));
  assert.equal(membersRes.status, 403);
});

test('上传：文本文件冒充图片被拒（415）', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id })],
  });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'application/octet-stream' },
    body: new TextEncoder().encode('definitely not an image, just text'),
  }));
  assert.equal(res.status, 415);
});

test('上传：真 PNG 写入 R2 并记录尺寸', async () => {
  const { env, puts } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, kind: 'static' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'image/png' },
    body: PNG,
  }));
  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^wallpapers\/wp_1\/[0-9a-f]{16}\.png$/);
  assert.equal(puts[0].options.httpMetadata.contentType, 'image/png');
  assert.match(res.body.data.url, /^\/media\//);
});

test('上传：视频会把类型自动改成动态（不再由人手动选）', async () => {
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, kind: 'static' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
  });
  const mp4 = new Uint8Array(32);
  for (const [i, ch] of [...'ftypmp42'].entries()) mp4[4 + i] = ch.charCodeAt(0);
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'video/mp4' },
    body: mp4,
  }));
  assert.equal(res.status, 200);
  const update = calls.find((entry) => entry.sql === Q.updateWallpaperAsset);
  assert.equal(update.args[7], 'dynamic');
});

test('上传：开机动画包可以挂在「动态」下', async () => {
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 0x03, 0x04], 0);
  const { env, puts } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, kind: 'dynamic' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'application/zip' },
    body: zip,
  }));
  assert.equal(res.status, 200);
  assert.match(puts[0].key, /\.zip$/);
  assert.equal(puts[0].options.httpMetadata.contentType, 'application/zip');
});

test('上传：zip 保持原类型（皮肤包仍是静态）', async () => {
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 0x03, 0x04], 0);
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, kind: 'static' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'application/zip' },
    body: zip,
  }));
  assert.equal(res.status, 200);
  const update = calls.find((entry) => entry.sql === Q.updateWallpaperAsset);
  assert.equal(update.args[7], 'static');
});

test('上传：mp4 视频会把时长写进库', async () => {
  const mp4 = new Uint8Array(96);
  for (const [i, ch] of [...'ftypmp42'].entries()) mp4[i + 4] = ch.charCodeAt(0);
  const mvhd = 32;
  for (const [i, ch] of [...'mvhd'].entries()) mp4[mvhd + i] = ch.charCodeAt(0);
  mp4[mvhd + 4] = 0; // version 0
  mp4[mvhd + 18] = 0x03; mp4[mvhd + 19] = 0xe8; // timescale = 1000
  mp4[mvhd + 22] = 0x17; mp4[mvhd + 23] = 0x70; // duration = 6000 → 6.0s

  const { env, calls, puts } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.editor),
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: USERS.editor.id, kind: 'dynamic' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, new Request('https://example.test/api/admin/wallpapers/wp_1/asset', {
    method: 'PUT',
    headers: { cookie: sessionCookie(), 'x-folia-client': 'admin', 'content-type': 'video/mp4' },
    body: mp4,
  }));
  assert.equal(res.status, 200);
  const update = calls.find((entry) => entry.sql === Q.updateWallpaperAsset);
  assert.equal(update.args[5], 6000, 'duration_ms 应该被解析出来');
  assert.match(puts[0].key, /\.mp4$/);
});

test('成员：不能删除自己', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [{ ...USERS.admin, password_hash: 'h', password_salt: 's', iterations: 100000 }],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest(`/api/admin/members/${USERS.admin.id}`, {
    method: 'DELETE',
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /不能删除自己/);
});

test('成员：不能删掉最后一位启用中的管理员', async () => {
  const other = { ...USERS.editor, id: 'usr_other', role: 'admin', active: 1 };
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [other],
    [Q.countActiveAdmins]: () => [{ n: 1 }],
    [Q.insertAudit]: () => [],
  });
  env.ADMIN_PASSCODE = DELETE_PASSCODE;
  const res = await call(env, jsonRequest('/api/admin/members/usr_other', {
    method: 'DELETE',
    cookie: sessionCookie(),
    body: { passcode: DELETE_PASSCODE },
  }));
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /至少/);
});

test('成员：删除口令错误 403 且不删；没配置口令直接拒绝', async () => {
  const other = { ...USERS.editor, id: 'usr_other' };
  const { env, find } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [other],
    [Q.countActiveAdmins]: () => [{ n: 2 }],
    [Q.insertAudit]: () => [],
  });
  env.ADMIN_PASSCODE = DELETE_PASSCODE;
  const wrong = await call(env, jsonRequest('/api/admin/members/usr_other', {
    method: 'DELETE',
    cookie: sessionCookie(),
    body: { passcode: 'not-the-passcode' },
  }));
  assert.equal(wrong.status, 403);
  assert.equal(find(Q.deleteUser).length, 0);

  const unset = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [other],
    [Q.insertAudit]: () => [],
  });
  const missing = await call(unset.env, jsonRequest('/api/admin/members/usr_other', {
    method: 'DELETE',
    cookie: sessionCookie(),
    body: { passcode: DELETE_PASSCODE },
  }));
  assert.equal(missing.status, 403);
  assert.match(missing.body.error.message, /口令/);
});

test('成员：删除成功会清会话并删行', async () => {
  const target = { ...USERS.editor };
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.userById]: () => [target],
    [Q.deleteUserSessions]: () => [],
    [Q.deleteUser]: () => [],
    [Q.insertAudit]: () => [],
  });
  env.ADMIN_PASSCODE = DELETE_PASSCODE;
  const res = await call(env, jsonRequest(`/api/admin/members/${target.id}`, {
    method: 'DELETE',
    cookie: sessionCookie(),
    body: { passcode: DELETE_PASSCODE },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.deleted, true);
  assert.ok(calls.some((entry) => entry.sql === Q.deleteUserSessions));
  assert.ok(calls.some((entry) => entry.sql === Q.deleteUser));
});

test('成员：编辑没有删除成员的权限', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: sessionOf(USERS.editor) });
  const res = await call(env, jsonRequest('/api/admin/members/usr_admin', {
    method: 'DELETE',
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 403);
});

test('标签：新建与重名冲突', async () => {
  const { env, calls } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.tagByName]: () => [],
    [Q.maxTagSort]: () => [{ m: 40 }],
    [Q.insertTag]: () => [],
    [Q.tagById]: () => [{ id: 'tag_new', name: '赛博', sort_order: 50 }],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/tags', {
    method: 'POST', body: { name: '赛博' }, cookie: sessionCookie(),
  }));
  assert.equal(res.status, 201);
  const insert = calls.find((entry) => entry.sql === Q.insertTag);
  assert.equal(insert.args[1], '赛博');
  assert.equal(insert.args[2], 50);
});

test('标签：还被作品用着时不允许删除', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.tagById]: () => [{ id: 'tag_anime', name: '动漫', sort_order: 30 }],
    [Q.countWallpapersWithTag]: () => [{ n: 3 }],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/tags/tag_anime', {
    method: 'DELETE', cookie: sessionCookie(),
  }));
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /3 件作品/);
});

test('标签：编辑角色不能管理标签', async () => {
  const { env } = createEnv({ [Q.sessionByToken]: sessionOf(USERS.editor) });
  const res = await call(env, jsonRequest('/api/admin/tags', {
    method: 'POST', body: { name: '赛博' }, cookie: sessionCookie(),
  }));
  assert.equal(res.status, 403);
});

test('重排：提交的 id 集合与库里不一致 → 400', async () => {
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(USERS.admin),
    [Q.listAllWallpaperIds]: () => [{ id: 'a' }, { id: 'b' }],
    [Q.insertAudit]: () => [],
  });
  const res = await call(env, jsonRequest('/api/admin/wallpapers/reorder', {
    method: 'POST',
    body: { ids: ['a'] },
    cookie: sessionCookie(),
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /全部 2 项/);
});

test('初始化：已有账号时拒绝重复初始化', async () => {
  const { env } = createEnv({ [Q.countUsers]: () => [{ n: 1 }] });
  const res = await call(env, jsonRequest('/api/setup', {
    method: 'POST',
    body: { token: 'boot-token', email: 'a@b.co', name: '站长', password: 'Folia-2026-x' },
  }));
  assert.equal(res.status, 409);
});

test('方法不匹配返回 405 并带 Allow', async () => {
  const { env } = createEnv({});
  const res = await call(env, jsonRequest('/api/auth/login', { method: 'PUT', body: {} }));
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow'), /POST/);
});

test('meta 反映初始化状态', async () => {
  const { env } = createEnv({ [Q.countUsers]: () => [{ n: 0 }] });
  const res = await call(env, new Request('https://example.test/api/meta'));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.initialized, false);
  assert.ok(res.body.data.kinds.includes('dynamic'));
});
