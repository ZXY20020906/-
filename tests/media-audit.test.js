/**
 * 媒体元数据审计（schema/015 + src/server/media-audit.js）。
 *
 * 用**真 SQLite**（node:sqlite）跑 schema：这里的价值全在触发器 SQL 上
 * （WHEN 条件、fields 拼接、NULL 语义），假映射只会把触发器逻辑再抄一遍。
 * 拿不到 node:sqlite（Node < 22.5）时整组 skip，不拉红基线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEDIA_ACTOR, setMediaIdentity } from '../src/server/media-audit.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '..', 'schema');
const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const skip = DatabaseSync ? false : '需要 Node ≥ 22.5 的 node:sqlite';

/** 全量迁移（001–015）建一个内存库：验证 015 能挂在现有表上，而不是单独摘出来跑。 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  return db;
}

const INSERT_WALLPAPER = `INSERT INTO wallpapers
  (id, slug, title, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
   tags, featured, sort_order, created_by, created_at, updated_at, published_at)
  VALUES (?, ?, ?, NULL, 'static', 'draft', ?, ?, ?, ?, ?, ?, '[]', 0, 0, NULL, ?, ?, NULL)`;

function insertWallpaper(db, overrides = {}) {
  const row = {
    id: 'wp_audit_1',
    slug: 'audit-1',
    title: '审计用例',
    storageKey: 'wallpapers/wp_audit_1/aaaaaaaaaaaaaaaa.png',
    mime: 'image/png',
    bytes: 100,
    width: 1920,
    height: 1080,
    sha256: 'a'.repeat(64),
    now: 1_760_000_000_000,
    ...overrides,
  };
  db.prepare(INSERT_WALLPAPER).run(
    row.id, row.slug, row.title, row.storageKey, row.mime, row.bytes,
    row.width, row.height, row.sha256, row.now, row.now,
  );
  return row;
}

function audits(db, id = 'wp_audit_1') {
  return db.prepare('SELECT * FROM media_audit WHERE wallpaper_id = ? ORDER BY id').all(id);
}

/** D1 → node:sqlite 最小适配（只实现被测代码用到的 run/first/all）。 */
function makeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const state = { args: [] };
      const api = {
        bind(...args) {
          state.args = args;
          return api;
        },
        async all() {
          return { results: stmt.all(...state.args) };
        },
        async first() {
          return stmt.get(...state.args) ?? null;
        },
        async run() {
          stmt.run(...state.args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
}

test('015：表、索引、两个触发器都建出来了', { skip }, () => {
  const db = makeDb();
  const names = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE '%media_audit%' ORDER BY type, name").all();
  assert.deepEqual(
    names.map((row) => `${row.type}:${row.name}`),
    [
      'index:idx_media_audit_wp',
      'table:media_audit',
      'trigger:trg_media_audit_insert',
      'trigger:trg_media_audit_update',
    ],
  );
  db.close();
});

test('015 可重复执行：IF NOT EXISTS 不报错、不重复建触发器', { skip }, () => {
  const db = makeDb();
  db.exec(readFileSync(resolve(SCHEMA_DIR, '015_media_audit.sql'), 'utf8'));
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_media_audit%'").all();
  assert.equal(triggers.length, 2);
  db.close();
});

test('插入带媒体的行：产生 insert 审计，三值写进 new_* 列', { skip }, () => {
  const db = makeDb();
  const row = insertWallpaper(db);
  const rows = audits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields, 'insert');
  assert.equal(rows[0].old_storage_key, null);
  assert.equal(rows[0].new_storage_key, row.storageKey);
  assert.equal(rows[0].old_bytes, null);
  assert.equal(rows[0].new_bytes, row.bytes);
  assert.equal(rows[0].old_sha256, null);
  assert.equal(rows[0].new_sha256, row.sha256);
  assert.equal(rows[0].changed_by, null, '触发器拿不到调用方，changed_by 由应用层补');
  assert.ok(Number.isInteger(rows[0].changed_at) && rows[0].changed_at > 0);
  db.close();
});

test('插入没有媒体的草稿：不产生审计（避免每条草稿一条噪音）', { skip }, () => {
  const db = makeDb();
  insertWallpaper(db, {
    id: 'wp_audit_draft',
    slug: 'audit-draft',
    storageKey: null,
    mime: null,
    bytes: 0,
    width: null,
    height: null,
    sha256: null,
  });
  assert.equal(audits(db, 'wp_audit_draft').length, 0);
  db.close();
});

test('只改 bytes：一条审计，fields=bytes', { skip }, () => {
  const db = makeDb();
  insertWallpaper(db);
  db.prepare("UPDATE wallpapers SET bytes = 200 WHERE id = 'wp_audit_1'").run();

  const rows = audits(db);
  assert.equal(rows.length, 2, 'insert + 一次 bytes 变更');
  assert.equal(rows[1].fields, 'bytes');
  assert.equal(rows[1].old_bytes, 100);
  assert.equal(rows[1].new_bytes, 200);
  assert.equal(rows[1].old_storage_key, rows[1].new_storage_key);
  db.close();
});

test('同时改 bytes + sha256：fields=bytes,sha256', { skip }, () => {
  const db = makeDb();
  insertWallpaper(db);
  db.prepare("UPDATE wallpapers SET bytes = 300, sha256 = ? WHERE id = 'wp_audit_1'").run('b'.repeat(64));

  const rows = audits(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].fields, 'bytes,sha256');
  assert.equal(rows[1].old_sha256, 'a'.repeat(64));
  assert.equal(rows[1].new_sha256, 'b'.repeat(64));
  db.close();
});

test('改无关列（title/mime/width）：不产生审计', { skip }, () => {
  const db = makeDb();
  insertWallpaper(db);
  db.prepare("UPDATE wallpapers SET title = '改标题', mime = 'image/webp', width = 1280 WHERE id = 'wp_audit_1'").run();
  assert.equal(audits(db).length, 1, '只有插入那一条');
  db.close();
});

test('删除记录不产生审计（删除交由 audit_log / 应用层，不在 media_audit 猜）', { skip }, () => {
  const db = makeDb();
  insertWallpaper(db);
  db.prepare("DELETE FROM wallpapers WHERE id = 'wp_audit_1'").run();
  assert.equal(audits(db).length, 1);
  db.close();
});

test('setMediaIdentity：更新三列，并把最近一条审计补上 changed_by', { skip }, async () => {
  const db = makeDb();
  const row = insertWallpaper(db);
  const env = { DB: makeD1(db) };

  await setMediaIdentity(env, row.id, {
    storageKey: 'wallpapers/wp_audit_1/bbbbbbbbbbbbbbbb.png',
    bytes: 999,
    sha256: 'c'.repeat(64),
    actor: MEDIA_ACTOR.REPLACE,
    mime: 'image/png',
    width: 2560,
    height: 1440,
    durationMs: null,
    kind: 'static',
  });

  const fresh = db.prepare("SELECT storage_key, bytes, sha256, width, height FROM wallpapers WHERE id = 'wp_audit_1'").get();
  assert.equal(fresh.storage_key, 'wallpapers/wp_audit_1/bbbbbbbbbbbbbbbb.png');
  assert.equal(fresh.bytes, 999);
  assert.equal(fresh.sha256, 'c'.repeat(64));
  assert.equal(fresh.width, 2560);

  const rows = audits(db);
  assert.equal(rows.at(-1).changed_by, MEDIA_ACTOR.REPLACE);
  assert.equal(rows.at(-1).fields, 'storage_key,bytes,sha256');
  assert.equal(rows.at(-1).old_bytes, row.bytes);
  assert.equal(rows.at(-1).new_bytes, 999);
  db.close();
});

test('setMediaIdentity 最小形态（工具重算）：只改三列，不碰 mime/kind', { skip }, async () => {
  const db = makeDb();
  const row = insertWallpaper(db);
  const env = { DB: makeD1(db) };

  await setMediaIdentity(env, row.id, {
    storageKey: row.storageKey,
    bytes: 777,
    sha256: 'd'.repeat(64),
    actor: MEDIA_ACTOR.SHA_RESYNC,
  });

  const fresh = db.prepare("SELECT mime, kind, bytes, sha256 FROM wallpapers WHERE id = 'wp_audit_1'").get();
  assert.equal(fresh.mime, 'image/png', '工具没传 mime，不能被清空');
  assert.equal(fresh.kind, 'static', '工具没传 kind，不能被清空');
  assert.equal(fresh.bytes, 777);
  assert.equal(fresh.sha256, 'd'.repeat(64));

  const rows = audits(db);
  assert.equal(rows.at(-1).changed_by, MEDIA_ACTOR.SHA_RESYNC);
  assert.equal(rows.at(-1).fields, 'bytes,sha256');
  db.close();
});
