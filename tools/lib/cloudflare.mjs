/**
 * Cloudflare REST 小工具集（运维脚本共用）。
 *
 * 为什么单独一个文件：`build-snapshot.mjs` / `inspect-assets.mjs` / `export-d1.mjs`
 * 三个脚本都要「读 D1」「读写 R2」，各抄一份 REST 适配层的话，改一处漏两处。
 * 这里只做**薄封装**，不做业务判断。
 *
 * 约定：
 *   · token 只从环境变量来，**不接受命令行参数**（命令行会进 shell history / ps）；
 *   · 所有失败都抛 Error（带 HTTP 状态与接口原话），由脚本决定退出码；
 *   · D1 的 `prepare()` 形状刻意与 Workers 的 `env.DB` 一致，方便复用线上同一套代码。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

export const API_BASE = 'https://api.cloudflare.com/client/v4';

/** 从 wrangler.toml 读部署用的那份配置（database_id / bucket / PUBLIC_ORIGIN）。 */
export function readWranglerConfig() {
  const file = resolve(REPO_ROOT, 'wrangler.toml');
  if (!existsSync(file)) return { databaseId: '', bucket: '', origin: '' };
  const text = readFileSync(file, 'utf8');
  const pick = (re) => text.match(re)?.[1] ?? '';
  return {
    databaseId: pick(/database_id\s*=\s*"([^"]+)"/),
    bucket: pick(/bucket_name\s*=\s*"([^"]+)"/),
    origin: pick(/PUBLIC_ORIGIN\s*=\s*"([^"]+)"/),
  };
}

/**
 * 解析凭据：环境变量优先，命令行只允许覆盖 account/database/bucket 这类**非机密**值。
 * @returns {{token: string, accountId: string, databaseId: string, bucket: string}}
 */
export function resolveCredentials({ accountId = '', databaseId = '', bucket = '' } = {}) {
  const config = readWranglerConfig();
  const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '';
  const account = accountId || process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
  const d1 = databaseId || process.env.CF_D1_ID || config.databaseId;
  const r2 = bucket || process.env.CF_R2_BUCKET || config.bucket;
  return { token, accountId: account, databaseId: d1, bucket: r2 };
}

async function readJson(response, what) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${what} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
  if (!response.ok || body.success === false) {
    const detail = body.errors?.map((item) => item.message).join('; ') ?? text.slice(0, 200);
    const error = new Error(`${what} 失败（HTTP ${response.status}）：${detail}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

/* ------------------------------------------------------------------ D1 */

/**
 * D1 REST 适配层。返回的对象形状与 Workers 的 `env.DB` 一致（prepare/bind/all/first/run），
 * 于是快照构建这类代码可以原样复用到本地脚本里。
 */
export function makeD1({ accountId, databaseId, token }) {
  if (!accountId || !databaseId) throw new Error('缺少 account id 或 D1 database id');
  const endpoint = `${API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const clean = (args) => args.map((value) => (value === undefined ? null : value));

  async function query(sql, params) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params: clean(params) }),
    });
    const body = await readJson(response, 'D1 查询');
    const result = body.result?.[0] ?? {};
    return { results: result.results ?? [], meta: result.meta ?? {} };
  }

  return {
    /** 直接跑一条 SQL（工具用）。 */
    query,
    /** 与 Workers 同形的只读接口。 */
    prepare(sql) {
      const state = { args: [] };
      const api = {
        bind(...args) { state.args = args; return api; },
        async all() { return { results: (await query(sql, state.args)).results }; },
        async first() { return (await query(sql, state.args)).results[0] ?? null; },
        async run() { throw new Error('这个适配层是只读的：脚本不直接写 D1'); },
      };
      return api;
    },
    /** 分页取全量（D1 REST 单次返回有条数上限，导出/巡检都要用）。 */
    async all(sql, { params = [], pageSize = 500, maxRows = 1_000_000 } = {}) {
      const rows = [];
      let offset = 0;
      for (;;) {
        const page = await query(`${sql} LIMIT ${pageSize} OFFSET ${offset}`, params);
        rows.push(...page.results);
        if (page.results.length < pageSize || rows.length >= maxRows) break;
        offset += pageSize;
      }
      return rows;
    },
  };
}

/* ------------------------------------------------------------------ R2 */

/** R2 REST 适配层。key 里的 `/` 必须保留，只对每段做 encodeURIComponent。 */
export function makeR2({ accountId, bucket, token }) {
  if (!accountId || !bucket) throw new Error('缺少 account id 或 R2 桶名');
  const objectUrl = (key) =>
    `${API_BASE}/accounts/${accountId}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;

  /**
   * 列对象。R2 的列表接口分页用 cursor：`result` 是数组，`result_info.is_truncated` 指示还有下一页。
   * @returns {Promise<{key: string, size: number, lastModified: string|null}[]>}
   */
  async function listObjects({ prefix = '', max = 5000, pageSize = 1000 } = {}) {
    const out = [];
    let cursor = '';
    for (;;) {
      const search = new URLSearchParams({ prefix, per_page: String(Math.min(pageSize, 1000)) });
      if (cursor) search.set('cursor', cursor);
      const response = await fetch(
        `${API_BASE}/accounts/${accountId}/r2/buckets/${bucket}/objects?${search.toString()}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const body = await readJson(response, 'R2 列表');
      const page = Array.isArray(body.result) ? body.result : (body.result?.objects ?? []);
      for (const item of page) {
        out.push({ key: item.key, size: Number(item.size ?? 0), lastModified: item.last_modified ?? null });
      }
      const truncated = body.result_info?.is_truncated === true;
      cursor = body.result_info?.cursor ?? '';
      if (!truncated || !cursor || out.length >= max) break;
    }
    return out.slice(0, max);
  }

  return {
    /**
     * 「这个 key 在不在、多大」。
     *
     * R2 的 REST API **不支持 HEAD**（返回 405），所以这里退化成「按 key 精确列一次」：
     * 列表接口同样返回 size，一次往返、不下载内容。真要大范围对账，请直接用 `list()` 建索引
     * （N 条记录只需要几次列表，而不是 N 次请求）。
     */
    async head(key) {
      const objects = await listObjects({ prefix: key, max: 1000 });
      const hit = objects.find((item) => item.key === key);
      return hit ? { size: hit.size, etag: hit.etag ?? null } : null;
    },
    async get(key) {
      const response = await fetch(objectUrl(key), { headers: { authorization: `Bearer ${token}` } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`R2 GET ${key} 失败（HTTP ${response.status}）`);
      // 立刻读成字节：对象可能是 mp4/webp（二进制），走 text() 会把内容解坏。
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        key,
        size: bytes.byteLength,
        body: bytes,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    async put(key, body, { httpMetadata } = {}) {
      const headers = { authorization: `Bearer ${token}`, 'content-type': httpMetadata?.contentType ?? 'application/octet-stream' };
      if (httpMetadata?.cacheControl) headers['cache-control'] = httpMetadata.cacheControl;
      const response = await fetch(objectUrl(key), { method: 'PUT', headers, body });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`R2 PUT ${key} 失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
      }
    },
    /**
     * 列对象（分页 + cursor）。返回 `{key, size, lastModified}`。
     */
    list: listObjects,
  };
}
