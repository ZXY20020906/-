/**
 * 测试用的「真 SQLite 站点」小工具（不是 .test.js，不会被 run-tests 当用例加载）。
 *
 * 为什么要有它：公开接口的很多语义（facets 的 canonical 聚合、数值筛选的 NULL 行为、
 * `?license=` 的 SQL 大小写）只能在真 SQL 上验证；假映射只会把实现再抄一遍。
 * `tests/metadata.test.js` / `tests/tag-alias.test.js` / `tests/api-v1-filters.test.js`
 * 共用这一份建库 + 插行 + 调接口的代码，避免三份各写一遍 schema 路径。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from '../src/server/app.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = resolve(here, '..', 'schema');
export const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();
export const NOW = 1_760_000_000_000;

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
export const sqliteSkip = DatabaseSync ? false : '需要 Node ≥ 22.5 的 node:sqlite';

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

/**
 * 测试用假桶。
 *
 * 阶段三之后它还要能存 **JSON 快照**，所以 `get()` 返回的对象必须同时具备
 * `text()` / `json()` / `arrayBuffer()` 三种读法（真实 R2 对象就是这样）。
 * `put()` 既接受字符串（快照），也接受 Uint8Array（素材字节）。
 */
export function makeBucket() {
  const objects = new Map();
  const puts = [];
  const toBytes = (value) => {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(String(value));
  };
  const view = (key, bytes) => ({
    key,
    size: bytes.byteLength,
    body: bytes,
    async text() { return new TextDecoder().decode(bytes); },
    async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  });
  return {
    objects,
    puts,
    async put(key, value, options) {
      const bytes = toBytes(value);
      objects.set(key, bytes);
      puts.push({ key, options: options ?? null, size: bytes.byteLength });
      return { key, size: bytes.byteLength };
    },
    async get(key) { return objects.has(key) ? view(key, objects.get(key)) : null; },
    async head(key) {
      return objects.has(key) ? { size: objects.get(key).byteLength, httpEtag: `"${key}"` } : null;
    },
    async delete(key) { objects.delete(key); },
    /** 只列出对象 key（快照断言用）。 */
    keys() { return [...objects.keys()].sort(); },
  };
}

const INSERT_COLUMNS = [
  'id', 'slug', 'title', 'description', 'subtag', 'review_status', 'category_id', 'kind', 'status',
  'storage_key', 'mime', 'bytes', 'width', 'height', 'duration_ms', 'sha256', 'tags', 'featured',
  'sort_order', 'created_by', 'created_at', 'updated_at', 'published_at', 'verified_at',
  'fps', 'codec', 'pix_fmt', 'has_audio', 'poster_key', 'license', 'source', 'author', 'variants',
];
const INSERT_SQL = `INSERT INTO wallpapers (${INSERT_COLUMNS.join(', ')})
  VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`;

/** 一行公开可见的默认值；传 overrides 覆盖。 */
export function wallpaperRow(overrides = {}) {
  const value = (key, fallback) => (overrides[key] === undefined ? fallback : overrides[key]);
  return {
    id: value('id', 'wp_site_1'),
    slug: value('slug', value('id', 'wp_site_1')),
    title: value('title', `素材 ${value('id', 'wp_site_1')}`),
    description: '',
    subtag: value('subtag', ''),
    review_status: value('review_status', 'approved'),
    category_id: value('category_id', 'cat_wallpaper'),
    kind: value('kind', 'dynamic'),
    status: value('status', 'published'),
    storage_key: value('storage_key', `wallpapers/${value('id', 'wp_site_1')}/abcdef0123456789.mp4`),
    mime: value('mime', 'video/mp4'),
    bytes: value('bytes', 1_000_000),
    width: value('width', 1920),
    height: value('height', 1080),
    duration_ms: value('duration_ms', 8000),
    sha256: value('sha256', null),
    tags: JSON.stringify(value('tags', [])),
    featured: value('featured', 0),
    sort_order: value('sort_order', 0),
    created_by: value('created_by', 'usr_site'),
    created_at: value('created_at', NOW - 1000),
    updated_at: value('updated_at', NOW),
    published_at: value('published_at', NOW),
    verified_at: value('verified_at', NOW),
    fps: value('fps', 30),
    codec: value('codec', 'h264'),
    pix_fmt: value('pix_fmt', 'yuv420p'),
    has_audio: value('has_audio', 0),
    poster_key: value('poster_key', null),
    license: value('license', null),
    source: value('source', null),
    author: value('author', null),
    variants: value('variants', null),
  };
}

/**
 * 建一个真库：跑完整 schema（含分类/标签/别名种子），插一行管理员 + 若干壁纸。
 * @param {object[]} rows wallpaperRow() 形状
 */
export function openSite(rows = []) {
  if (!DatabaseSync) throw new Error('当前 Node 没有 node:sqlite（需要 ≥ 22.5）');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  db.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'h', 's', 100000, 1, ?, ?)`)
    .run('usr_site', 'site@folia.test', '站点', 'admin', NOW, NOW);
  const insert = db.prepare(INSERT_SQL);
  for (const row of rows) {
    const full = wallpaperRow(row);
    insert.run(...INSERT_COLUMNS.map((column) => full[column]));
  }
  const bucket = makeBucket();
  // 单测默认关快照回落，避免 D1 报错被生产快照掩盖；快照用例单独打开。
  // SNAPSHOT_AUTO=0：默认不自动重建公开快照（否则每个写用例都会去打 R2）。
  // 快照相关的用例用 `snapshotEnv()` 显式打开。
  const env = {
    DB: makeD1(db),
    BUCKET: bucket,
    PUBLIC_ORIGIN: 'https://example.test',
    PUBLIC_SNAPSHOT_FALLBACK: '0',
    SNAPSHOT_AUTO: '0',
  };
  return {
    db,
    bucket,
    env,
    insert(row) {
      const full = wallpaperRow(row);
      insert.run(...INSERT_COLUMNS.map((column) => full[column]));
      return full;
    },
    close() { db.close(); },
  };
}

/**
 * 阶段三用：同一个库 + 同一个桶，但**打开**快照路径。
 * @param {{DB: object, BUCKET: object}} base 通常是 `openSite().env`
 */
export function snapshotEnv(base, overrides = {}) {
  return { ...base, SNAPSHOT_AUTO: '1', ...overrides };
}

/** 走真实路由（不带 gate），返回 status/headers/body/text。 */
export async function call(env, path, { method = 'GET', headers = {} } = {}) {
  const saved = globalThis.caches;
  delete globalThis.caches;
  try {
    const request = new Request(`https://example.test${path}`, { method, headers });
    const response = await handle(request, env);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status, headers: response.headers, body, text };
  } finally {
    if (saved !== undefined) globalThis.caches = saved;
  }
}
