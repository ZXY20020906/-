/**
 * 第一期验收：元数据（fps / codec / pix_fmt / has_audio / poster）+ 授权字段 + variants 扩列。
 *
 * 用**真 SQLite** 跑完整 schema（001–016）：
 *   - 证明 ingest 真的把 fps/codec/has_audio 写进了 D1（不是只放进报告）；
 *   - 证明公开 DTO 的字段名/三态（null ≠ false）没被「顺手补默认值」；
 *   - 证明 `?license=` 在真 SQL 里生效。
 * 假环境（harness）只负责路由层用例；这里要看列与值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from '../src/server/app.js';
import { ingestAsset } from '../src/server/ingest.js';
import { wallpaperDto, variantsDto } from '../src/server/dto.js';
import { readVideoAudio } from '../src/core/image-meta.js';
import { makeMp4 } from './mp4-fixture.js';
import { createEnv, jsonRequest, sessionCookie, sessionDeviceFields, USERS, wallpaperRow } from './harness.js';
import { Q } from '../src/server/queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '..', 'schema');
const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();
const NOW = 1_760_000_000_000;

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync ? false : '需要 Node ≥ 22.5 的 node:sqlite';

/** 一个最小但合法的 WebP（VP8X 头 + 1280×720），只够 readMediaMeta 读出宽高。 */
function makeWebp({ width = 1280, height = 720 } = {}) {
  const out = new Uint8Array(30);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  new DataView(out.buffer).setUint32(4, 22, true);
  ascii(8, 'WEBP');
  ascii(12, 'VP8X');
  new DataView(out.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  out[24] = w & 0xff; out[25] = (w >> 8) & 0xff; out[26] = (w >> 16) & 0xff;
  out[27] = h & 0xff; out[28] = (h >> 8) & 0xff; out[29] = (h >> 16) & 0xff;
  return out;
}

/** 拼一个 MP4 box（只为 readVideoAudio 的盒遍历服务，不是完整可播文件）。 */
function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}
function concat(...chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
/** hdlr payload：version/flags(4) + pre_defined(4) + handler_type(4)。 */
function hdlr(handler) {
  const payload = new Uint8Array(20);
  for (let i = 0; i < 4; i += 1) payload[8 + i] = handler.charCodeAt(i);
  return box('hdlr', payload);
}
function trakWith(handler) {
  return box('trak', box('mdia', hdlr(handler)));
}
function mp4WithTracks(handlers) {
  return box('moov', concat(...handlers.map(trakWith)));
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  db.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'h', 's', 100000, 1, ?, ?)`)
    .run('usr_meta', 'meta@folia.test', '元数据', 'admin', NOW, NOW);
  return db;
}

/** D1 → node:sqlite 最小适配（undefined→NULL、boolean→0/1）。 */
function makeD1(db) {
  const bind = (args) => args.map((value) => {
    if (value === undefined) return null;
    if (value === true) return 1;
    if (value === false) return 0;
    return value;
  });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const state = { args: [] };
      const api = {
        bind(...args) { state.args = bind(args); return api; },
        async all() { return { results: stmt.all(...state.args) }; },
        async first() { return stmt.get(...state.args) ?? null; },
        async run() { stmt.run(...state.args); return { success: true, meta: { changes: 1 } }; },
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

function makeBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async head(key) {
      return objects.has(key) ? { size: objects.get(key).byteLength, httpEtag: `"${key}"` } : null;
    },
    async delete(key) { objects.delete(key); },
  };
}

function makeSite() {
  const db = makeDb();
  const bucket = makeBucket();
  return {
    db,
    bucket,
    env: { DB: makeD1(db), BUCKET: bucket, PUBLIC_ORIGIN: 'https://example.test' },
  };
}

const ACTOR = { id: 'usr_meta', email: 'meta@folia.test', name: '元数据', role: 'admin', active: 1 };

const INSERT_COLUMNS = [
  'id', 'slug', 'title', 'description', 'subtag', 'review_status', 'category_id', 'kind', 'status',
  'storage_key', 'mime', 'bytes', 'width', 'height', 'sha256', 'tags', 'featured', 'sort_order',
  'created_by', 'created_at', 'updated_at', 'published_at', 'verified_at',
  'fps', 'codec', 'pix_fmt', 'has_audio', 'poster_key', 'license', 'source', 'author', 'variants',
];
const INSERT_ROW = `INSERT INTO wallpapers (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`;

function insertRow(db, overrides = {}) {
  const value = (key, fallback) => (overrides[key] === undefined ? fallback : overrides[key]);
  const row = {
    id: value('id', 'wp_meta_1'),
    slug: value('slug', 'meta-1'),
    title: value('title', '元数据样例'),
    description: '',
    subtag: '',
    review_status: 'approved',
    category_id: value('category_id', 'cat_wallpaper'),
    kind: value('kind', 'dynamic'),
    status: value('status', 'published'),
    storage_key: value('storage_key', 'wallpapers/wp_meta_1/abcdef0123456789.mp4'),
    mime: value('mime', 'video/mp4'),
    bytes: value('bytes', 1_000_000),
    width: value('width', 1920),
    height: value('height', 1080),
    sha256: value('sha256', null),
    tags: JSON.stringify(value('tags', ['动漫'])),
    featured: 0,
    sort_order: 0,
    created_by: value('created_by', ACTOR.id),
    created_at: value('created_at', NOW - 1000),
    updated_at: value('updated_at', NOW),
    published_at: value('published_at', NOW),
    verified_at: value('verified_at', NOW),
    fps: value('fps', 30),
    codec: value('codec', 'h264'),
    pix_fmt: value('pix_fmt', 'yuv420p'),
    has_audio: value('has_audio', 0),
    poster_key: value('poster_key', 'posters/wp_meta_1/1111111111111111.webp'),
    license: value('license', 'cc0'),
    source: value('source', 'https://example.test/source'),
    author: value('author', '画师甲'),
    variants: value('variants', null),
  };
  db.prepare(INSERT_ROW).run(...INSERT_COLUMNS.map((column) => row[column]));
  return row;
}

async function call(env, path) {
  const request = new Request(`https://example.test${path}`);
  const response = await handle(request, env);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

test('探针：readVideoAudio 三态（有音轨 / 确认无音轨 / 读不出）', () => {
  assert.equal(readVideoAudio(mp4WithTracks(['vide', 'soun']), 'video/mp4'), true);
  assert.equal(readVideoAudio(mp4WithTracks(['vide']), 'video/mp4'), false);
  // 没有 moov（文件头不完整）⇒ 未知，而不是 false
  assert.equal(readVideoAudio(box('ftyp', new Uint8Array(12)), 'video/mp4'), null);
  // WebM：CodecID 明文出现在头部 ⇒ true；扫不到 ⇒ 未知（不猜 false）
  const webm = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(12), new TextEncoder().encode('A_OPUS'));
  assert.equal(readVideoAudio(webm, 'video/webm'), true);
  assert.equal(readVideoAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'video/webm'), null);
});

test('DTO：fps/codec/pixFmt/hasAudio/posterUrl/license/source/author 全部输出', () => {
  const dto = wallpaperDto({
    id: 'wp_x', slug: 'x', title: 'X', kind: 'dynamic', mime: 'video/mp4',
    bytes: 10, width: 1920, height: 1080, storage_key: 'wallpapers/wp_x/a.mp4',
    thumb_key: 'thumbs/wp_x/a.webp', poster_key: 'posters/wp_x/b.webp',
    fps: 29.97, codec: 'h264', pix_fmt: 'yuv420p', has_audio: 1,
    license: 'cc-by', source: 'https://example.test/s', author: '作者',
    tags: '[]', updated_at: 1,
  }, { mediaBase: 'https://cdn.test' });
  assert.equal(dto.fps, 29.97);
  assert.equal(dto.codec, 'h264');
  assert.equal(dto.pixFmt, 'yuv420p');
  assert.equal(dto.hasAudio, true);
  assert.equal(dto.posterUrl, 'https://cdn.test/posters/wp_x/b.webp');
  assert.equal(dto.license, 'cc-by');
  assert.equal(dto.source, 'https://example.test/s');
  assert.equal(dto.author, '作者');
});

test('DTO：hasAudio 三态 —— 缺列/空值是 null，不是 false', () => {
  const base = { id: 'wp_x', slug: 'x', title: 'X', kind: 'static', tags: '[]' };
  assert.equal(wallpaperDto(base).hasAudio, null, '缺列 ⇒ 未知');
  assert.equal(wallpaperDto({ ...base, has_audio: null }).hasAudio, null);
  assert.equal(wallpaperDto({ ...base, has_audio: 0 }).hasAudio, false);
  assert.equal(wallpaperDto({ ...base, has_audio: 1 }).hasAudio, true);
  // 拿不到 fps/pixFmt 时不补 0、不补字符串
  assert.equal(wallpaperDto(base).fps, null);
  assert.equal(wallpaperDto(base).pixFmt, null);
  assert.equal(wallpaperDto(base).posterUrl, null);
});

test('variants：width 存在（老数据为 null），fps 原样输出', () => {
  const out = variantsDto({
    variants: JSON.stringify([
      { label: '1080p', width: 1920, height: 1080, fps: 30, key: 'wallpapers/wp_1/a.1080p.mp4', bytes: 2 },
      { label: '30fps', height: 1080, key: 'wallpapers/wp_1/b.30fps.mp4', bytes: 1 },
    ]),
  });
  assert.deepEqual(out.map((item) => item.width), [null, 1920]);
  assert.deepEqual(out.map((item) => item.fps), [null, 30]);
});

test('ingest：真 SQLite 里 fps/codec/has_audio 成对落库，poster_key 指向 R2 对象', { skip }, async () => {
  const { db, bucket, env } = makeSite();
  insertRow(db, { id: 'wp_ing', slug: 'ing', status: 'draft', verified_at: null, poster_key: null });
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get('wp_ing');

  const result = await ingestAsset(env, ACTOR, row, {
    bytes: makeMp4({ width: 1920, height: 1080, fps: 30, codec: 'avc1', faststart: true }),
    poster: makeWebp({ width: 1280, height: 720 }),
  });

  const fresh = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get('wp_ing');
  assert.equal(fresh.fps, 30, 'fps 必须写入（纯 JS 探测）');
  assert.equal(fresh.codec, 'h264', 'codec 由 markWallpaperVerified 写入');
  assert.equal(fresh.pix_fmt, null, 'Worker 读不出 pix_fmt ⇒ NULL（不猜）');
  assert.equal(fresh.has_audio, 0, '无音轨 ⇒ 0');
  assert.ok(fresh.poster_key, 'poster_key 必须写入');
  assert.match(fresh.poster_key, /^posters\/wp_ing\/[0-9a-f]{16}\.webp$/);
  assert.ok(bucket.objects.has(fresh.poster_key), '海报必须真的写进了 R2');
  assert.equal(result.posterUrl, `/media/${fresh.poster_key}`);
  assert.equal(result.hasAudio, false);
  assert.equal(result.fps, 30);
});

test('ingest：没有海报素材时 poster_key 保持 NULL，入库照常成功', { skip }, async () => {
  const { db, env } = makeSite();
  insertRow(db, { id: 'wp_nop', slug: 'nop', status: 'draft', verified_at: null, poster_key: null });
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get('wp_nop');
  const result = await ingestAsset(env, ACTOR, row, {
    bytes: makeMp4({ width: 1920, height: 1080, fps: 30, faststart: true }),
  });
  const fresh = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get('wp_nop');
  assert.equal(fresh.poster_key, null);
  assert.equal(result.posterUrl, null);
  assert.equal(fresh.verified_at > 0, true, '媒体本身照常入库');
});

test('公开列表：?license= 生效，且 items 带新字段、variants 带 width/fps', { skip }, async () => {  const { db, env } = makeSite();
  insertRow(db, {
    id: 'wp_cc0', slug: 'cc0', license: 'cc0',
    variants: JSON.stringify([
      { label: '1080p', width: 1920, height: 1080, fps: 30, key: 'wallpapers/wp_cc0/v.1080p.mp4', bytes: 2_000_000, sha256: 'f'.repeat(64) },
    ]),
  });
  insertRow(db, { id: 'wp_unknown', slug: 'unknown', license: null });

  const all = await call(env, '/api/v1/public/wallpapers');
  assert.equal(all.status, 200);
  assert.equal(all.body.data.total, 2);

  const filtered = await call(env, '/api/v1/public/wallpapers?license=cc0');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.data.total, 1);
  assert.equal(filtered.body.data.items[0].id, 'wp_cc0');
  assert.equal(filtered.body.data.facets.categories[0].count, 1, 'facets 与清单同源');

  const item = filtered.body.data.items[0];
  assert.equal(item.fps, 30);
  assert.equal(item.codec, 'h264');
  assert.equal(item.pixFmt, 'yuv420p');
  assert.equal(item.hasAudio, false);
  assert.equal(item.posterUrl, 'https://example.test/media/posters/wp_meta_1/1111111111111111.webp');
  assert.equal(item.license, 'cc0');
  assert.equal(item.variants[0].width, 1920);
  assert.equal(item.variants[0].fps, 30);
  assert.equal(item.variants[0].label, '1080p');
});

test('PATCH：license/source/author 落库（license 归一为小写、文本去空白）', async () => {
  const actor = USERS.admin;
  const { env, calls } = createEnv({
    [Q.sessionByToken]: () => [{
      token_hash: 'hashed', expires_at: Date.now() + 60_000,
      ...actor, ...sessionDeviceFields(),
    }],
    [Q.wallpaperById]: () => [wallpaperRow({ created_by: actor.id })],
    [Q.updateWallpaper]: () => [],
    [Q.insertAudit]: () => [],
  });
  const res = await handle(jsonRequest('/api/admin/wallpapers/wp_1', {
    method: 'PATCH',
    body: { license: 'CC0', author: '  画师甲  ', source: 'https://example.test/source' },
    cookie: sessionCookie(),
  }), env);
  assert.equal(res.status, 200);
  const update = calls.find((entry) => entry.sql === Q.updateWallpaper);
  assert.ok(update, '必须执行 updateWallpaper');
  // 顺序：… updated_at(11), published_at(12), license(13), source(14), author(15), id(16)
  assert.equal(update.args[13], 'cc0', 'license 统一小写');
  assert.equal(update.args[14], 'https://example.test/source');
  assert.equal(update.args[15], '画师甲');
});
