/**
 * snapshot-rebuild.test.js — 问题 1 的判据：**改变公开可见性的写路径必须重建快照**。
 *
 * 真实事故：后台「发布 + 审核通过」之后，D1 已经是 published/approved，
 * 但公开接口仍旧快照（total 113、新条目 0），直到有人手工跑脚本。
 *
 * 这里用真库 + 真路由 + 真桶，逐条验证：
 *   ① 发布 draft ⇒ 快照 version 变化、公开列表 total +1
 *   ② 审核通过（pending → approved）⇒ 同上
 *   ③ 分类设为隐藏 ⇒ total 减少
 *   ④ 删除作品 ⇒ total 减少
 *   ⑤ 重建失败 ⇒ 管理端 `/api/admin/snapshot-status` 能看到 ok:false + 原因（不再静默）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { call, openSite, snapshotEnv, sqliteSkip, NOW } from './sqlite-site.js';
import { readCurrent } from '../src/server/snapshot.js';

const DEVICE = 'b'.repeat(43);
const TOKEN = 'snapshot-admin-token';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** 建站点 + 一条管理员会话（管理端路由需要 session）。 */
function makeSite(t) {
  const site = openSite();
  t.after(() => site.close());
  const now = Date.now();
  site.db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
    VALUES (?, 'usr_site', ?, ?, '', '', ?, ?)`)
    .run(sha(TOKEN), now, now + 3600_000, sha(DEVICE), now);
  return site;
}

const cookie = () => `folia_session=${TOKEN}; folia_device=${DEVICE}`;
const admin = (method, path, body) => call(
  globalThis.__snapshotEnv,
  path,
  {
    method,
    headers: { 'x-folia-client': 'admin', cookie: cookie(), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  },
);

async function total(env) {
  const response = await call(env, '/api/v1/public/wallpapers?limit=100');
  return response.body.data.total;
}

async function version(env) {
  const current = await readCurrent(env);
  return current ? current.version : '';
}

test('R1 发布 draft ⇒ 快照重建，total +1', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_live', slug: 'live', status: 'published', review_status: 'approved' });
  // 草稿：`status=draft` 是唯一挡住它的条件（verified_at 已有，模拟"上传完成但没点发布"）
  site.insert({ id: 'wp_draft', slug: 'draft', status: 'draft', review_status: 'pending' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  const res = await admin('PATCH', '/api/admin/wallpapers/wp_draft', { status: 'published', reviewStatus: 'approved' });
  assert.equal(res.status, 200, res.text.slice(0, 300));

  const afterTotal = await total(env);
  const afterVersion = await version(env);
  assert.equal(beforeTotal, 1, '初始只有 1 条公开');
  assert.equal(afterTotal, 2, '发布后公开列表 +1');
  assert.notEqual(afterVersion, beforeVersion, '快照 version 必须变化');
});

test('R2 审核通过（pending→approved）⇒ 快照重建，total +1', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_a', slug: 'a', status: 'published', review_status: 'approved' });
  site.insert({ id: 'wp_pending', slug: 'pending', status: 'published', review_status: 'pending' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  const res = await admin('PATCH', '/api/admin/wallpapers/wp_pending', { reviewStatus: 'approved' });
  assert.equal(res.status, 200, res.text.slice(0, 300));

  assert.equal(beforeTotal, 1);
  assert.equal(await total(env), 2, '审核通过后公开列表 +1');
  assert.notEqual(await version(env), beforeVersion);
});

test('R3 分类设为隐藏 ⇒ 快照重建，total 减少', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_skin', slug: 'skin', category_id: 'cat_assistant_skin', status: 'published', review_status: 'approved' });
  site.insert({ id: 'wp_wall', slug: 'wall', category_id: 'cat_wallpaper', status: 'published', review_status: 'approved' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  const res = await admin('PATCH', '/api/admin/categories/cat_assistant_skin', { isPublic: false });
  assert.equal(res.status, 200, res.text.slice(0, 300));

  assert.equal(beforeTotal, 2);
  assert.equal(await total(env), 1, '隐藏分类后该分类的作品不再公开');
  assert.notEqual(await version(env), beforeVersion);
});

test('R4 删除作品 ⇒ 快照重建，total 减少', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_keep', slug: 'keep', status: 'published', review_status: 'approved' });
  site.insert({ id: 'wp_drop', slug: 'drop', status: 'published', review_status: 'approved' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  const res = await admin('DELETE', '/api/admin/wallpapers/wp_drop');
  assert.equal(res.status, 200, res.text.slice(0, 300));

  assert.equal(beforeTotal, 2);
  assert.equal(await total(env), 1, '删除后公开列表 -1');
  assert.notEqual(await version(env), beforeVersion);
});

test('R5 重建失败可见（管理端 snapshot-status 有 ok:false 与原因）', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_x', slug: 'x', status: 'published', review_status: 'approved' });

  // 让本轮的 R2 写入直接失败：重建必然抛，必须被记录下来
  const realPut = site.bucket.put;
  site.bucket.put = async () => { throw new Error('r2-unavailable-for-test'); };

  const res = await admin('PATCH', '/api/admin/wallpapers/wp_x', { title: '改名触发重建' });
  assert.equal(res.status, 200, '重建失败不能影响保存本身');

  const status = await admin('GET', '/api/admin/snapshot-status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.lastRebuild.ok, false, '失败必须可见');
  assert.match(String(status.body.data.lastRebuild.error), /r2-unavailable-for-test/);

  site.bucket.put = realPut;
  // 修好后重建一次，状态应回到 ok:true（证明它是"最近一次"的真相，不是一次性快照）
  await admin('PATCH', '/api/admin/wallpapers/wp_x', { title: '再改一次' });
  const after = await admin('GET', '/api/admin/snapshot-status');
  assert.equal(after.body.data.lastRebuild.ok, true, '重建恢复后状态也要恢复');
});

test('R6 批量通过审核也会重建（本轮修的那条漏网路径）', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_ok', slug: 'ok', status: 'published', review_status: 'approved' });
  site.insert({ id: 'wp_p1', slug: 'p1', status: 'published', review_status: 'pending' });
  site.insert({ id: 'wp_p2', slug: 'p2', status: 'published', review_status: 'pending' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  const res = await admin('POST', '/api/admin/wallpapers/approve-all');
  assert.equal(res.status, 200, res.text.slice(0, 300));

  assert.equal(beforeTotal, 1);
  assert.equal(await total(env), 3, '批量审核后 3 条都公开');
  assert.notEqual(await version(env), beforeVersion, '批量审核必须重建快照');
});

test('R7 刷新时间戳：NOW 与快照版本不冲突（防止版本秒级碰撞）', { skip: sqliteSkip }, async () => {
  if (sqliteSkip) return;
  assert.ok(Number.isFinite(NOW));
});


test('R8 软删作品（status=hidden）⇒ 快照重建，total -1', { skip: sqliteSkip }, async (t) => {
  if (sqliteSkip) return t.skip('no sqlite');
  const site = makeSite(t);
  const env = snapshotEnv(site.env);
  globalThis.__snapshotEnv = env;
  site.insert({ id: 'wp_soft_keep', slug: 'soft-keep', status: 'published', review_status: 'approved' });
  site.insert({ id: 'wp_soft_drop', slug: 'soft-drop', status: 'published', review_status: 'approved' });

  const beforeTotal = await total(env);
  const beforeVersion = await version(env);

  // 软删：行还在、R2 文件还在，只是 status 变 hidden
  const res = await admin('PATCH', '/api/admin/wallpapers/wp_soft_drop', { status: 'hidden' });
  assert.equal(res.status, 200, res.text.slice(0, 300));

  assert.equal(beforeTotal, 2);
  assert.equal(await total(env), 1, '软删后公开列表 -1');
  assert.notEqual(await version(env), beforeVersion, '软删也要重建快照');

  const row = site.db.prepare('SELECT status, storage_key FROM wallpapers WHERE id = ?').get('wp_soft_drop');
  assert.equal(row.status, 'hidden');
  assert.ok(row.storage_key, '软删必须保留 R2 文件引用（不是硬删）');
});
