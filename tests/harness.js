/**
 * 测试用假环境：用「SQL 原文 → 处理函数」的精确映射代替真数据库。
 * 好处：路由若调用了没注册的查询会立刻报错，不会静默返回空结果。
 * 同时校验 bind 数量与占位符一致 —— D1 在线上就是在这里报错的。
 */
import { Q } from '../src/server/queries.js';
import { sha256Hex } from '../src/server/util.js';

export function bindCount(sql) {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  if (numbered.length) return Math.max(...numbered);
  return (sql.replace(/\?\d+/g, '').match(/\?/g) ?? []).length;
}

/**
 * 有些查询每次都会用到、且内容固定（比如标签词表），给个默认实现，
 * 免得每个用例都重复注册。
 */
const DEFAULT_HANDLERS = {
  [Q.listTags]: () => ([
    { id: 'tag_nature', name: '自然风景', sort_order: 10 },
    { id: 'tag_star', name: '明星', sort_order: 20 },
    { id: 'tag_anime', name: '动漫', sort_order: 30 },
    { id: 'tag_game', name: '游戏', sort_order: 40 },
  ]),
  // 上传成功后的记账（verified_at / codec / faststart），用例不关心具体值
  [Q.markWallpaperVerified]: () => [],
};

export function createEnv(handlers, { bucket } = {}) {
  const calls = [];
  const puts = [];
  const deletes = [];

  async function runQuery(sql, args) {
    const expected = bindCount(sql);
    if (args.length !== expected) {
      throw new Error(`bind 数量不符：传了 ${args.length}，占位符需要 ${expected} → ${sql.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    const handler = handlers[sql] ?? DEFAULT_HANDLERS[sql];
    if (!handler) {
      throw new Error(`未注册的查询：${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    calls.push({ sql, args });
    const rows = await handler(args);
    return Array.isArray(rows) ? rows : [];
  }

  const db = {
    prepare(sql) {
      const state = { sql, args: [] };
      const stmt = {
        bind(...args) {
          state.args = args;
          return stmt;
        },
        async all() {
          return { results: await runQuery(state.sql, state.args) };
        },
        async first() {
          const rows = await runQuery(state.sql, state.args);
          return rows[0] ?? null;
        },
        async run() {
          await runQuery(state.sql, state.args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
  };

  const fakeBucket = bucket ?? {
    async put(key, bytes, options) {
      puts.push({ key, bytes, options });
    },
    async get() {
      return null;
    },
    async delete(key) {
      deletes.push(key);
    },
  };

  return {
    env: {
      DB: db,
      BUCKET: fakeBucket,
      PUBLIC_ORIGIN: 'https://example.test',
      BOOTSTRAP_TOKEN: 'boot-token',
    },
    calls,
    puts,
    deletes,
    find(query) {
      return calls.filter((call) => call.sql === query);
    },
  };
}

export function jsonRequest(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const init = { method, headers: { 'x-folia-client': 'admin', ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (cookie) init.headers.cookie = cookie;
  return new Request(`https://example.test${path}`, init);
}

/** 会话绑定设备：测试里固定一枚设备 ID，请求 Cookie 与会话行必须对上。 */
export const TEST_DEVICE_ID = 'e'.repeat(43);
export const TEST_DEVICE_HASH = await sha256Hex(TEST_DEVICE_ID);

/** 会话行里跟设备/闲置相关的字段，app.test.js 的 sessionOf 直接展开即可。 */
export function sessionDeviceFields() {
  return { device_hash: TEST_DEVICE_HASH, last_seen_at: Date.now() };
}

export function sessionCookie(token = 'test-token') {
  return `folia_session=${token}; folia_device=${TEST_DEVICE_ID}`;
}

export const USERS = {
  admin: { id: 'usr_admin', email: 'admin@folia.test', name: '站长', role: 'admin', active: 1, created_at: 1, last_login_at: null },
  editor: { id: 'usr_editor', email: 'editor@folia.test', name: '小编', role: 'editor', active: 1, created_at: 2, last_login_at: null },
};

export function wallpaperRow(overrides = {}) {
  return {
    id: 'wp_1',
    slug: 'demo',
    title: '示例壁纸',
    category_id: 'cat_dynamic',
    kind: 'static',
    status: 'draft',
    storage_key: null,
    mime: null,
    bytes: 0,
    width: null,
    height: null,
    sha256: null,
    tags: '[]',
    featured: 0,
    sort_order: 10,
    created_by: 'usr_editor',
    created_at: 1000,
    updated_at: 1000,
    published_at: null,
    ...overrides,
  };
}

export { Q };
