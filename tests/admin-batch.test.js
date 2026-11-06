/**
 * 阶段五 · 管理端效率的**后端**契约（P1–P6）。
 *
 * 前端那套「拖 10 个 / 失败重试 / 批量改」压到最后都落在两个新接口上：
 *   POST /api/admin/wallpapers/batch            批量套同一份 patch
 *   POST /api/admin/wallpapers/duplicate-check  上传前查重
 *
 * 这里用真 SQLite + 真路由验证：批量与单条 PATCH 逐字段等价、部分失败不中断、
 * 权限仍然按角色/归属判、快照跟着重建。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { call, openSite, snapshotEnv, sqliteSkip, NOW } from './sqlite-site.js';
import { readCurrent } from '../src/server/snapshot.js';
import { Q } from '../src/server/queries.js';

const ROWS = [
  { id: 'wp_a', slug: 'a', title: '甲', category_id: 'cat_wallpaper', tags: ['动漫'] },
  { id: 'wp_b', slug: 'b', title: '乙', category_id: 'cat_wallpaper', tags: ['动漫'] },
  { id: 'wp_c', slug: 'c', title: '丙', category_id: 'cat_wallpaper', tags: [] },
  { id: 'wp_d', slug: 'd', title: '丁', category_id: 'cat_wallpaper', tags: [] },
  { id: 'wp_e', slug: 'e', title: '戊', category_id: 'cat_assistant_skin', tags: [] },
];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const DEVICE = 'e'.repeat(43);
const ADMIN_TOKEN = 'batch-admin-token';
const EDITOR_TOKEN = 'batch-editor-token';

function realSqlite(t) {
  if (sqliteSkip) {
    t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5），跳过真实 SQL 用例');
    return false;
  }
  return true;
}

/** 建站 + 两个会话（admin 与 editor）。 */
async function makeSite(t) {
  const site = openSite(ROWS);
  t.after(() => site.close());
  const now = Date.now();
  site.db.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'h', 's', 100000, 1, ?, ?)`).run('usr_editor', 'editor@folia.test', '小编', 'editor', now, now);
  // 归属：c/d 属于编辑（先建用户再挂，否则外键过不去）
  site.db.prepare("UPDATE wallpapers SET created_by = 'usr_editor' WHERE id IN ('wp_c', 'wp_d')").run();
  const insert = site.db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
    VALUES (?, ?, ?, ?, '', '', ?, ?)`);
  for (const [token, user] of [[ADMIN_TOKEN, 'usr_site'], [EDITOR_TOKEN, 'usr_editor']]) {
    insert.run(sha256(token), user, now, now + 3600_000, sha256(DEVICE), now);
  }
  return site;
}

function asAdmin(site, env, path, body) {
  return asUser(site, env, ADMIN_TOKEN, path, body);
}

function asUser(site, env, token, path, body) {
  return call(env, path, {
    method: 'POST',
    headers: {
      cookie: `folia_session=${token}; folia_device=${DEVICE}`,
      'x-folia-client': 'admin',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const batch = (site, env, ids, patch) => asAdmin(site, env, '/api/admin/wallpapers/batch', { ids, patch });

test('P1 批量改标签：5 条一次改完，逐条都生效', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const ids = ['wp_a', 'wp_b', 'wp_c', 'wp_d', 'wp_e'];

  const res = await batch(site, site.env, ids, { tags: ['游戏'] });
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(res.body.data.updated, 5);
  assert.deepEqual(res.body.data.failed, []);
  assert.deepEqual(res.body.data.patch, ['tags']);

  for (const id of ids) {
    const row = site.db.prepare('SELECT tags FROM wallpapers WHERE id = ?').get(id);
    assert.deepEqual(JSON.parse(row.tags), ['游戏'], `${id} 的标签没改到`);
  }

  // 一条审计、target_id=bulk（不是 5 条散记）
  const audit = site.db.prepare("SELECT target_id, detail FROM audit_log WHERE target_type='wallpaper' ORDER BY id DESC LIMIT 1").get();
  assert.equal(audit.target_id, 'bulk');
  assert.match(audit.detail, /批量改 tags × 5 条/);
});

test('P2 批量发布 / 下线 / 软删：published_at 的语义与单条 PATCH 一致', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const ids = ['wp_a', 'wp_b'];

  // 夹具默认就是 published，先下线成 draft
  const down = await batch(site, site.env, ids, { status: 'draft' });
  assert.equal(down.body.data.updated, 2);
  let row = site.db.prepare('SELECT status, published_at FROM wallpapers WHERE id = ?').get('wp_a');
  assert.equal(row.status, 'draft');
  assert.equal(row.published_at, null, '下线必须清 published_at');

  const up = await batch(site, site.env, ids, { status: 'published' });
  assert.equal(up.body.data.updated, 2);
  row = site.db.prepare('SELECT status, published_at FROM wallpapers WHERE id = ?').get('wp_a');
  assert.equal(row.status, 'published');
  assert.ok(Number(row.published_at) > 0, '重新发布要补 published_at');

  const hidden = await batch(site, site.env, ids, { status: 'hidden' });
  assert.equal(hidden.body.data.updated, 2);
  row = site.db.prepare('SELECT status, published_at FROM wallpapers WHERE id = ?').get('wp_a');
  assert.equal(row.status, 'hidden');
  assert.equal(row.published_at, null);
});

test('P3 批量部分失败：坏 id 不拖累其余条目，原因逐条返回', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  // 一个不存在的 id + 一个格式非法的 id + 两条正常
  const res = await batch(site, site.env, ['wp_a', 'wp_missing', 'bad id!!', 'wp_b'], { tags: ['明星'] });
  assert.equal(res.status, 200, '部分失败仍然是 200，失败明细在 body 里');
  assert.equal(res.body.data.updated, 2);
  assert.equal(res.body.data.failed.length, 2);
  assert.equal(res.body.data.failed[0].status, 404);
  assert.equal(res.body.data.failed[1].status, 400);
  assert.deepEqual(res.body.data.ids.sort(), ['wp_a', 'wp_b']);
});

test('P4 权限：编辑不能发布，但能改自己的标签；改别人的被拒', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);

  const publish = await asUser(site, site.env, EDITOR_TOKEN, '/api/admin/wallpapers/batch', {
    ids: ['wp_c'], patch: { status: 'published' },
  });
  assert.equal(publish.status, 403, '发布是管理员动作，整批在鉴权处就被挡');

  const ownTags = await asUser(site, site.env, EDITOR_TOKEN, '/api/admin/wallpapers/batch', {
    ids: ['wp_c'], patch: { tags: ['自然风景'] },
  });
  assert.equal(ownTags.status, 200);
  assert.equal(ownTags.body.data.updated, 1);

  // 混入一条别人的：自己那条成功，别人的那条 403
  const mixed = await asUser(site, site.env, EDITOR_TOKEN, '/api/admin/wallpapers/batch', {
    ids: ['wp_c', 'wp_a'], patch: { tags: ['游戏'] },
  });
  assert.equal(mixed.body.data.updated, 1);
  assert.equal(mixed.body.data.failed.length, 1);
  assert.equal(mixed.body.data.failed[0].id, 'wp_a');
  assert.equal(mixed.body.data.failed[0].status, 403);
});

test('P5 批量改分类：统一校验一次，非法分类整批 400', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);

  const ok = await batch(site, site.env, ['wp_a', 'wp_b'], { categoryId: 'cat_assistant_skin' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.updated, 2);
  const row = site.db.prepare('SELECT category_id FROM wallpapers WHERE id = ?').get('wp_a');
  assert.equal(row.category_id, 'cat_assistant_skin');

  const bad = await batch(site, site.env, ['wp_a'], { categoryId: 'cat_nope' });
  assert.equal(bad.status, 400);
});

test('P6 批量改完会重建公开快照（公开接口跟着变）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const env = snapshotEnv(site.env);

  // 先发一份快照
  const { publishSnapshot } = await import('../src/server/snapshot.js');
  const first = await publishSnapshot(env);
  assert.equal(first.wrote, true);
  assert.equal((await readCurrent(env)).version, first.version);

  // 把 5 条全改成私有分类的内容 → 分类变更会重建快照
  const res = await batch(site, env, ['wp_a', 'wp_b', 'wp_c', 'wp_d', 'wp_e'], { tags: ['游戏'] });
  assert.equal(res.body.data.updated, 5);

  const after = await readCurrent(env);
  assert.notEqual(after.version, first.version, '批量写之后 current.json 必须换版本');
  const publicList = await call(env, '/api/v1/public/wallpapers?tag=游戏&limit=100');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.body.data.total, 5, '公开接口要能按新标签筛到这 5 条');
});

test('P7 查重：sha256 命中 / 未命中 / 标题+字节数 兜底', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const digest = 'c'.repeat(64);
  site.db.prepare('UPDATE wallpapers SET sha256 = ?, bytes = ? WHERE id = ?').run(digest, 123456, 'wp_a');

  const hit = await asAdmin(site, site.env, '/api/admin/wallpapers/duplicate-check', { sha256: digest });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.matchedBy, 'sha256');
  assert.equal(hit.body.data.duplicate.id, 'wp_a');
  assert.equal(hit.body.data.duplicate.slug, 'a');
  // 响应里不能出现 R2 内部 key
  assert.equal(JSON.stringify(hit.body.data).includes('storage_key'), false);

  const miss = await asAdmin(site, site.env, '/api/admin/wallpapers/duplicate-check', { sha256: 'd'.repeat(64) });
  assert.equal(miss.body.data.duplicate, null);

  // 大文件走采样指纹时拿不到完整 sha256，用「标题 + 字节数」兜底
  const byTitle = await asAdmin(site, site.env, '/api/admin/wallpapers/duplicate-check', { title: '甲', bytes: 123456 });
  assert.equal(byTitle.body.data.matchedBy, 'title+bytes');
  assert.equal(byTitle.body.data.duplicate.id, 'wp_a');

  // 非法 sha 不报错，只是不匹配（前端偶尔会传来空串）
  const junk = await asAdmin(site, site.env, '/api/admin/wallpapers/duplicate-check', { sha256: 'not-a-hash' });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.data.duplicate, null);
});

test('P8 查重：指纹命中（schema/013 的 content_fingerprint）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const fingerprint = 'f'.repeat(64);
  site.db.prepare('UPDATE wallpapers SET content_fingerprint = ? WHERE id = ?').run(fingerprint, 'wp_b');

  const hit = await asAdmin(site, site.env, '/api/admin/wallpapers/duplicate-check', { fingerprint });
  assert.equal(hit.body.data.matchedBy, 'fingerprint');
  assert.equal(hit.body.data.duplicate.id, 'wp_b');
});

test('P9 批量接口对未登录/无权限是 401/403，不做任何写入', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const anonymous = await call(site.env, '/api/admin/wallpapers/batch', {
    method: 'POST',
    headers: { 'x-folia-client': 'admin', 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['wp_a'], patch: { tags: ['游戏'] } }),
  });
  assert.equal(anonymous.status, 401);
  const row = site.db.prepare('SELECT tags FROM wallpapers WHERE id = ?').get('wp_a');
  assert.deepEqual(JSON.parse(row.tags), ['动漫'], '被拒的请求不能改数据');
  // 顺带确认查询表里确实没有 sha 相关的注册项被误用
  assert.ok(Q.wallpaperShaTaken.includes('sha256'));
});
