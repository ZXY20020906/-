/**
 * 测试用假环境：用「SQL 原文 → 处理函数」的精确映射代替真数据库。
 * 好处：路由若调用了没注册的查询会立刻报错，不会静默返回空结果。
 * 同时校验 bind 数量与占位符一致 —— D1 在线上就是在这里报错的。
 */
import { Q, PUBLIC_FACETS } from '../src/server/queries.js';
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
  // 缩略图 / 1080p 变体：ingestAsset() 现在会为图片补 thumb_key、为超 1080p 的视频写 variants。
  // 老用例只关心「上传成功」，这两条在假环境里注册成 no-op（真 SQL 由 tests/batch-ingest.test.js 验）。
  [Q.updateWallpaperThumb]: () => [],
  [Q.updateWallpaperVariants]: () => [],
  /**
   * schema/016 的元数据列：假环境一律「列都在」，这样上传用例走的是**新版路径**
   * （写 fps/pix_fmt/has_audio/poster_key），而不是悄悄回落到旧行为。
   * 真 SQL 与列默认值由 tests/metadata.test.js 用 node:sqlite 验。
   */
  [Q.wallpaperTechColumns]: () => ([
    { name: 'fps' }, { name: 'pix_fmt' }, { name: 'has_audio' }, { name: 'poster_key' },
  ]),
  [Q.updateWallpaperTech]: () => [],
  [Q.updateWallpaperPoster]: () => [],
  // 通用列探测：默认「存在」，避免 fingerprint / poster 分支在假环境里被当成「没迁移」
  [Q.wallpaperColumnExists]: ([name]) => [{ name }],
  // v1 manifest：假环境没有快照，默认空清单（形状由 tests/api-v1.test.js 验）
  [Q.publicManifest]: () => [],
  // manifest 的 generatedAt 取「公开集合最新 updated_at」；假环境给 0 → 回落到 items 最大值
  [Q.publicMaxUpdatedAt]: () => [{ n: 0 }],
  /**
   * API key（schema/018）：假环境默认「没有这把 key」。
   * 带 key 的用例在 tests/api-keys.test.js 里显式注册；不带 key 的请求**不会**查库。
   */
  [Q.apiKeyByHash]: () => [],
  [Q.touchApiKey]: () => [],
  [Q.wallpaperTitleBytesTaken]: () => [],
  // 大文件指纹去重：假环境「没有重复」，与 schema/013 列存在时的行为对齐
  [Q.wallpaperFingerprintTaken]: () => [],
  // schema/015 的审计补标注：假环境没有 media_audit 表，注册成 no-op 避免 warn 噪音；
  // 真实行为（触发器 + changed_by）由 tests/media-audit.test.js 用真 SQLite 验证。
  [Q.mediaAuditAnnotate]: () => [],
  /**
   * 筛选面板（facets）的聚合。假环境不跑 SQL，默认给「没有可统计的条目」；
   * 计数语义（GROUP BY / json_each / UNION ALL）由 tests/public-facets.test.js 用真 SQLite 验证，
   * 这样既不让每个老用例都要多注册一次查询，也不会用假数据假装算对了。
   */
  [PUBLIC_FACETS]: () => [],
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
      // 单测默认关掉快照回落：未注册的查询 / 真实 SQL 错误必须当场炸出来，
      // 不能被生产快照「兜」成 200。快照行为由 public-snapshot.test.js 显式打开。
      PUBLIC_SNAPSHOT_FALLBACK: '0',
      // 阶段三：默认不自动重建公开快照（假桶存不了快照，真 SQL 也没注册）。
      // 需要快照路径的用例显式设 SNAPSHOT_AUTO: '1'。
      SNAPSHOT_AUTO: '0',
      // 阶段四：后台列表的 60s 短缓存默认关掉 —— 用例之间会直接改夹具数据，
      // 缓存会让「刚插的行看不见」。缓存行为由 tests/admin-list.test.js 显式打开。
      ADMIN_LIST_CACHE_MS: '0',
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
