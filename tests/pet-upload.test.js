/**
 * 桌宠包上传链路（`/api/admin/wallpapers/import` → ingestAsset → DTO → 公开列表）。
 *
 * 门 1 的六条验收里，②③④⑥ 都落在这条链路上，所以这里用真 SQLite + 真路由跑一遍：
 *   · 合规包 ⇒ 入库、DTO 带 kind='pet' 与 pet 对象、thumbUrl 是预览图
 *   · 坏包 ⇒ 422 + 具体原因，且**不留半条记录**
 *   · 普通 zip ⇒ 仍然走原通道（回归）
 *   · 发布会进入公开列表与快照
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { call, openSite, snapshotEnv, sqliteSkip, NOW } from './sqlite-site.js';
import { makePetZip, makeZip, petManifest, TINY_PNG } from './pet-zip.js';

const DEVICE = 'e'.repeat(43);
const TOKEN = 'pet-upload-token';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function realSqlite(t) {
  if (sqliteSkip) { t.skip('当前 Node 没有 node:sqlite（需要 ≥ 22.5）'); return false; }
  return true;
}

async function makeSite(t) {
  const site = openSite([
    { id: 'wp_old', slug: 'old', title: '旧素材', category_id: 'cat_wallpaper' },
  ]);
  t.after(() => site.close());
  const now = Date.now();
  site.db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
    VALUES (?, 'usr_site', ?, ?, '', '', ?, ?)`)
    .run(sha256(TOKEN), now, now + 3600_000, sha256(DEVICE), now);
  return site;
}

/** multipart 上传（与前端 importEntry 的字段一致）。 */
async function uploadZip(site, env, { zip, title, categoryId = 'cat_desktop_pet', publish = '0', kind = 'static' }) {
  const form = new FormData();
  form.append('title', title);
  form.append('kind', kind);
  form.append('categoryId', categoryId);
  form.append('tags', '[]');
  form.append('publish', publish);
  form.append('reportId', `test_${title}`);
  form.append('file', new Blob([zip], { type: 'application/zip' }), `${title}.zip`);
  return call(env, '/api/admin/wallpapers/import', {
    method: 'POST',
    headers: {
      cookie: `folia_session=${TOKEN}; folia_device=${DEVICE}`,
      'x-folia-client': 'admin',
    },
    body: form,
  });
}

function listed(env) {
  return call(env, '/api/admin/wallpapers?limit=200', {
    headers: { cookie: `folia_session=${TOKEN}; folia_device=${DEVICE}`, 'x-folia-client': 'admin' },
  });
}

test('K1 合规桌宠包：入库后 DTO 带 kind=pet 与完整 pet 对象', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const zip = await makePetZip();

  const res = await uploadZip(site, site.env, { zip, title: '鲸鱼娘' });
  assert.equal(res.status, 200, res.text.slice(0, 400));
  assert.equal(res.body.data.item.status, 'imported', res.text.slice(0, 400));

  const list = await listed(site.env);
  const row = list.body.data.items.find((item) => item.title === '鲸鱼娘');
  assert.ok(row, '列表里应有这条');
  assert.equal(row.kind, 'pet', '对外的 kind 必须是 pet');
  assert.ok(row.pet, '必须有 pet 对象');
  assert.equal(row.pet.id, 'whale-girl');
  assert.equal(row.pet.displayName, '鲸鱼娘');
  assert.equal(row.pet.columns, 8);
  assert.deepEqual(row.pet.frames, [8, 8, 8, 8, 8, 8, 8, 8, 8]);
  assert.ok(row.pet.tracks.includes('idle'), 'tracks 必须含 idle');
  // 预览图走标准缩略图通道（thumbs/<id>/<sha16>.<ext>），所以是绝对/相对 media 前缀都行
  assert.match(row.pet.previewUrl, /\/media\/thumbs\//, 'previewUrl 指向抽出来的预览图');
  assert.equal(row.thumbUrl, row.pet.previewUrl, 'thumbUrl 就是预览图');
  assert.deepEqual(row.variants, [], '公开的 variants 字段保持原样（空）');
  assert.equal(row.mime, 'application/zip');
});

test('K1b 表单选 static，入库后 kind 列仍是 pet（问题 2）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const zip = await makePetZip();
  // 关键在于表单照样传 static（真实默认值）——服务端必须按包内容覆盖它
  const res = await uploadZip(site, site.env, { zip, title: '强制归档', kind: 'static' });
  assert.equal(res.status, 200, res.text.slice(0, 400));
  const row = site.db.prepare("SELECT kind, mime FROM wallpapers WHERE title = '强制归档'").get();
  assert.ok(row, '入库了');
  assert.equal(row.kind, 'pet', 'kind 列必须被强制成 pet（不是 static）');
  assert.equal(row.mime, 'application/zip');
  const autoFixes = (res.body.data.item && res.body.data.item.autoFixes) || [];
  assert.ok(autoFixes.includes('petKind'), '报告里要说明已按桌宠归档');
});

test('K2 预览图真的写进了 R2（对象存在且是图片）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const zip = await makePetZip();
  await uploadZip(site, site.env, { zip, title: '鲸鱼娘2' });

  const list = await listed(site.env);
  const row = list.body.data.items.find((item) => item.title === '鲸鱼娘2');
  const key = row.pet.previewUrl.replace(/^.*\/media\//, '');
  assert.ok(site.bucket.objects.has(key), `R2 里应有 ${key}`);
  const bytes = site.bucket.objects.get(key);
  assert.equal(bytes[0], 0x89, 'PNG 头');
});

test('K3 坏包（缺 idle）：422 + 原因，且不留记录', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const manifest = JSON.parse(petManifest());
  manifest.sprite2d.tracks = { walk: { durations: [100] } };
  const zip = await makePetZip({ manifest: JSON.stringify(manifest) });

  const before = site.db.prepare('SELECT COUNT(*) AS n FROM wallpapers').get().n;
  const res = await uploadZip(site, site.env, { zip, title: '坏桌宠' });
  // 批量入口的契约：单条失败进报告（HTTP 仍是 200），报告项里带 httpStatus=422 与原因
  const item = res.body.data.item;
  assert.equal(item.status, 'failed', res.text.slice(0, 400));
  assert.equal(item.code, 'pet_package_invalid');
  assert.equal(item.httpStatus, 422);
  assert.match(item.reason, /idle/, res.text.slice(0, 400));
  const after = site.db.prepare("SELECT COUNT(*) AS n FROM wallpapers WHERE title = '坏桌宠'").get().n;
  assert.equal(after, 0, '失败不能留半条记录');
  assert.equal(site.db.prepare('SELECT COUNT(*) AS n FROM wallpapers').get().n, before);
});

test('K4 缺 pet.json 的 zip 在**普通分类**：仍然走原资源包通道（回归）', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const zip = await makeZip([
    { name: 'readme.txt', data: 'bundle' },
    { name: 'preview.jpg', data: TINY_PNG },
  ], { deflate: true });

  const res = await uploadZip(site, site.env, { zip, title: '普通资源包', categoryId: 'cat_assistant_skin' });
  assert.equal(res.status, 200, res.text.slice(0, 400));
  assert.equal(res.body.data.item.status, 'imported', res.text.slice(0, 400));
  const list = await listed(site.env);
  const row = list.body.data.items.find((item) => item.title === '普通资源包');
  assert.ok(row);
  assert.notEqual(row.kind, 'pet', '没有 pet.json 就不能被当成桌宠');
  assert.equal(row.pet, undefined);
});

test('K4b 缺 pet.json 的 zip 上传到**桌宠分类**：422，并说清该怎么办', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  const zip = await makeZip([{ name: 'readme.txt', data: 'bundle' }], { deflate: true });

  const res = await uploadZip(site, site.env, { zip, title: '错放分类的包', categoryId: 'cat_desktop_pet' });
  const item = res.body.data.item;
  assert.equal(item.status, 'failed', res.text.slice(0, 400));
  assert.equal(item.code, 'pet_package_invalid');
  assert.equal(item.httpStatus, 422);
  assert.match(item.reason, /必须包含 pet\.json/);
  assert.equal(site.db.prepare("SELECT COUNT(*) AS n FROM wallpapers WHERE title = '错放分类的包'").get().n, 0);
});

test('K6 单文件上传接口（PUT /asset）对坏包返回真正的 HTTP 422', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  site.insert({ id: 'wp_pet_bad', slug: 'pet-bad', title: '坏包条目', category_id: 'cat_desktop_pet', status: 'draft' });
  const manifest = JSON.parse(petManifest());
  manifest.sprite2d.tracks = { walk: { durations: [100] } };
  const zip = await makePetZip({ manifest: JSON.stringify(manifest) });

  const res = await call(site.env, '/api/admin/wallpapers/wp_pet_bad/asset', {
    method: 'PUT',
    headers: {
      cookie: `folia_session=${TOKEN}; folia_device=${DEVICE}`,
      'x-folia-client': 'admin',
      'content-type': 'application/zip',
    },
    body: zip,
  });
  assert.equal(res.status, 422, res.text.slice(0, 400));
  assert.equal(res.body.error.code, 'pet_package_invalid');
  assert.match(res.body.error.message, /idle/);
  // 坏包一个字节都不该落盘：storage_key 保持原值、R2 没多出对象
  const keyAfter = site.db.prepare('SELECT storage_key FROM wallpapers WHERE id = ?').get('wp_pet_bad').storage_key;
  assert.equal(keyAfter, 'wallpapers/wp_pet_bad/abcdef0123456789.mp4', '失败不能改写 storage_key');
  assert.equal(site.bucket.keys().filter((key) => key.startsWith('thumbs/wp_pet_bad/')).length, 0, '不能写出预览图');
});

test('K5 发布后进入公开列表与快照，且 pet 字段随快照走', { skip: sqliteSkip }, async (t) => {
  if (!realSqlite(t)) return;
  const site = await makeSite(t);
  // 桌宠分类要公开，公开接口才看得到
  site.db.prepare("UPDATE categories SET is_public = 1 WHERE id = 'cat_desktop_pet'").run();

  const zip = await makePetZip();
  const res = await uploadZip(site, site.env, { zip, title: '鲸鱼娘3', publish: '1' });
  assert.equal(res.status, 200, res.text.slice(0, 400));
  // 直接置为已审核（导入默认 pending）
  site.db.prepare("UPDATE wallpapers SET review_status = 'approved' WHERE title = '鲸鱼娘3'").run();

  const env = snapshotEnv(site.env);
  const { publishSnapshot } = await import('../src/server/snapshot.js');
  const published = await publishSnapshot(env);
  assert.equal(published.wrote, true);

  const publicList = await call(env, '/api/v1/public/wallpapers?category=desktop-pet&limit=10');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.body.data.total, 1, publicList.text.slice(0, 300));
  const item = publicList.body.data.items[0];
  assert.equal(item.kind, 'pet');
  assert.equal(item.pet.id, 'whale-girl');
  assert.ok(item.pet.tracks.includes('idle'));
  assert.equal(item.thumbUrl, item.pet.previewUrl);
});
