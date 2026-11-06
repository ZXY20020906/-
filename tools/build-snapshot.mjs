#!/usr/bin/env node
/**
 * 阶段三 · 公开读静态化：**手动/定时重建公开快照**。
 *
 * 它调用的是 Worker 里同一份 `src/server/snapshot.js`（`buildSnapshot` / `publishSnapshot`），
 * 所以「工具造的快照」和「上传后自动重建的快照」不可能有两套形状。
 *
 * 两种数据源：
 *   · 生产（默认）：Cloudflare REST API 直连 D1 / R2
 *       CF_API_TOKEN=… CF_ACCOUNT_ID=… node tools/build-snapshot.mjs
 *       数据库与桶的 ID 默认从 wrangler.toml 读，也可用 --database / --bucket 覆盖。
 *   · 本地导出文件（CI / 排障）：`--sqlite build/d1-export.sqlite`，只读本地库，
 *       加 `--dry-run` 就完全不碰网络。
 *
 * 用法：
 *   node tools/build-snapshot.mjs                 # 构建并切换 current.json
 *   node tools/build-snapshot.mjs --dry-run       # 只算 version 与条目数，不写
 *   node tools/build-snapshot.mjs --force         # 内容未变也写新 version（排障用）
 *   node tools/build-snapshot.mjs --status        # 只打印 current.json 指向哪一版
 *   node tools/build-snapshot.mjs --sqlite x.db --dry-run
 *
 * 退出码：0 成功；1 失败（构建失败会保留旧 current.json，线上读不受影响）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function parseArgs(argv) {
  const out = {
    dryRun: false,
    force: false,
    status: false,
    sqlite: '',
    origin: '',
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
    databaseId: '',
    bucket: '',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--status') out.status = true;
    else if (arg === '--sqlite') out.sqlite = resolve(argv[++i] ?? '');
    else if (arg === '--origin' || arg === '--media-base') out.origin = String(argv[++i] ?? '');
    else if (arg === '--database') out.databaseId = String(argv[++i] ?? '');
    else if (arg === '--bucket') out.bucket = String(argv[++i] ?? '');
    else if (arg === '--account') out.accountId = String(argv[++i] ?? '');
    else if (arg === '--token') out.token = String(argv[++i] ?? '');
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node tools/build-snapshot.mjs [--dry-run] [--force] [--status]
       [--sqlite <导出文件>] [--origin https://folia-5ve.pages.dev]
       [--account <account id>] [--database <d1 id>] [--bucket <r2 桶名>]`);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return out;
}

/** 从 wrangler.toml 读 D1 的 database_id 与 R2 的 bucket_name（就是部署用的那份配置）。 */
function readWranglerConfig() {
  const file = resolve(repoRoot, 'wrangler.toml');
  if (!existsSync(file)) return { databaseId: '', bucket: '', origin: '' };
  const text = readFileSync(file, 'utf8');
  const pick = (re) => text.match(re)?.[1] ?? '';
  return {
    databaseId: pick(/database_id\s*=\s*"([^"]+)"/),
    bucket: pick(/bucket_name\s*=\s*"([^"]+)"/),
    origin: pick(/PUBLIC_ORIGIN\s*=\s*"([^"]+)"/),
  };
}

function log(options, ...args) {
  if (!options.quiet) console.log(...args);
}

/* ------------------------------------------------------------------ D1 (REST) */

const D1_ENDPOINT = (accountId, databaseId) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

/**
 * 把 Cloudflare 的 D1 REST 接口包成 Worker 的 `env.DB` 形状（只读）。
 * 一次 prepare 一次往返——构建总共 6 条查询，可以接受。
 */
function restD1({ accountId, databaseId, token }) {
  const clean = (args) => args.map((value) => (value === undefined ? null : value));
  async function query(sql, params) {
    const response = await fetch(D1_ENDPOINT(accountId, databaseId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params: clean(params) }),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`D1 查询返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    if (!response.ok || body.success === false) {
      const detail = body.errors?.map((item) => item.message).join('; ') ?? text.slice(0, 200);
      throw new Error(`D1 查询失败（HTTP ${response.status}）：${detail}`);
    }
    return body.result?.[0]?.results ?? [];
  }
  return {
    prepare(sql) {
      const state = { args: [] };
      const api = {
        bind(...args) { state.args = args; return api; },
        async all() { return { results: await query(sql, state.args) }; },
        async first() { return (await query(sql, state.args))[0] ?? null; },
        async run() { throw new Error('build-snapshot 只读：不允许写 D1'); },
      };
      return api;
    },
    async batch() { throw new Error('build-snapshot 只读：不允许写 D1'); },
  };
}

/* ------------------------------------------------------------------ R2 (REST) */

const R2_OBJECT = (accountId, bucket, key) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;

function restR2({ accountId, bucket, token }) {
  return {
    async put(key, body, { httpMetadata } = {}) {
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': httpMetadata?.contentType ?? 'application/octet-stream',
      };
      if (httpMetadata?.cacheControl) headers['cache-control'] = httpMetadata.cacheControl;
      const response = await fetch(R2_OBJECT(accountId, bucket, key), { method: 'PUT', headers, body });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`R2 写入失败 ${key}（HTTP ${response.status}）：${text.slice(0, 200)}`);
      }
    },
    async get(key) {
      const response = await fetch(R2_OBJECT(accountId, bucket, key), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`R2 读取失败 ${key}（HTTP ${response.status}）`);
      const text = await response.text();
      return { text: async () => text, json: async () => JSON.parse(text), body: new TextEncoder().encode(text) };
    },
    async head(key) {
      const object = await this.get(key);
      return object ? { size: (await object.text()).length } : null;
    },
    async delete(key) {
      const response = await fetch(R2_OBJECT(accountId, bucket, key), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 404) throw new Error(`R2 删除失败 ${key}（HTTP ${response.status}）`);
    },
  };
}

/* ------------------------------------------------------------------ 本地 sqlite */

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
  };
}

/** 内存桶：`--dry-run --sqlite` 时用，读写都留在进程里。 */
function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) { objects.set(key, String(body)); },
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { text: async () => text, json: async () => JSON.parse(text), body: new TextEncoder().encode(text) };
    },
    async head(key) { return objects.has(key) ? { size: objects.get(key).length } : null; },
    async delete(key) { objects.delete(key); },
  };
}

/* ------------------------------------------------------------------ 主流程 */

const options = parseArgs(process.argv.slice(2));
const wrangler = readWranglerConfig();
const databaseId = options.databaseId || wrangler.databaseId;

const { buildSnapshot, publishSnapshot, readCurrent, SNAPSHOT_PREFIX, CURRENT_KEY } = await import('../src/server/snapshot.js');

async function makeEnv() {
  if (options.sqlite) {
    if (!existsSync(options.sqlite)) throw new Error(`找不到文件: ${options.sqlite}`);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(options.sqlite, { readOnly: false });
    if (options.sqlite.toLowerCase().endsWith('.sql')) db.exec(readFileSync(options.sqlite, 'utf8'));
    return {
      env: {
        DB: makeD1(db),
        BUCKET: memoryBucket(),
        PUBLIC_ORIGIN: options.origin || wrangler.origin || 'https://folia-5ve.pages.dev',
      },
      source: `sqlite:${options.sqlite}`,
      close: () => db.close(),
    };
  }

  if (!options.token) throw new Error('缺少 API token：设 CF_API_TOKEN（或传 --token）');
  if (!options.accountId) throw new Error('缺少 account id：设 CF_ACCOUNT_ID（或传 --account）');
  if (!databaseId) throw new Error('缺少 D1 database id：wrangler.toml 里没有，或用 --database 指定');
  const bucketName = options.bucket || wrangler.bucket;
  if (!bucketName) throw new Error('缺少 R2 桶名：wrangler.toml 里没有，或用 --bucket 指定');

  return {
    env: {
      DB: restD1({ accountId: options.accountId, databaseId, token: options.token }),
      BUCKET: restR2({ accountId: options.accountId, bucket: bucketName, token: options.token }),
      PUBLIC_ORIGIN: options.origin || wrangler.origin || 'https://folia-5ve.pages.dev',
    },
    source: `d1:${databaseId} r2:${bucketName}`,
    close: () => {},
  };
}

async function main() {
  const { env, source, close } = await makeEnv();
  try {
    log(options, `快照构建 → ${source}`);
    const current = await readCurrent(env);
    log(options, `当前版本: ${current?.version ?? '（无）'}`);

    if (options.status) {
      if (!current) {
        log(options, 'current.json 不存在：公开读目前回退 D1');
        return 0;
      }
      const base = `${SNAPSHOT_PREFIX}/${current.version}`;
      const [manifest, wallpapers] = await Promise.all([env.BUCKET.get(`${base}/manifest.json`), env.BUCKET.get(`${base}/wallpapers.json`)]);
      log(options, `current.json → ${current.version}`);
      log(options, `  generatedAt: ${current.generatedAt} (${current.generatedAt ? new Date(current.generatedAt).toISOString() : '-'})`);
      log(options, `  manifest.json: ${manifest ? 'ok' : '缺失'}`);
      log(options, `  wallpapers.json: ${wallpapers ? 'ok' : '缺失'}`);
      return 0;
    }

    if (options.dryRun) {
      const snapshot = await buildSnapshot(env);
      const facets = snapshot.core.items.length;
      log(options, `[dry-run] version      : ${snapshot.version}`);
      log(options, `[dry-run] items        : ${snapshot.core.total}`);
      log(options, `[dry-run] manifest     : ${snapshot.manifest.total}`);
      log(options, `[dry-run] categories   : ${snapshot.core.categories.length}`);
      log(options, `[dry-run] tags/subtags : ${snapshot.core.tags.tags.length}/${snapshot.core.subtags.length}`);
      log(options, `[dry-run] 与当前一致   : ${current?.version === snapshot.version ? '是（不会写新对象）' : '否（会切新版本）'}`);
      log(options, `[dry-run] 未写入任何对象（items=${facets}）`);
      return 0;
    }

    const result = await publishSnapshot(env, { force: options.force });
    log(options, `version   : ${result.version}`);
    log(options, `items     : ${result.total}`);
    log(options, `耗时      : ${result.ms}ms`);
    log(options, `切换      : ${result.wrote ? '已写入并切 current.json' : '内容未变，未写新对象（--force 可强制）'}`);
    log(options, `对象前缀  : ${SNAPSHOT_PREFIX}/${result.version}/`);
    log(options, `指针      : ${CURRENT_KEY}`);
    return 0;
  } finally {
    close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('构建快照失败：', error?.message ?? error);
    console.error('（旧 current.json 未被改动，线上公开读不受影响）');
    process.exit(1);
  });
