/**
 * Folia 素材网 JS 客户端（ESM，零依赖，Node ≥ 20）
 *
 * 用法：
 *   import { FoliaClient } from './folia-client.mjs';
 *   const client = new FoliaClient({ baseUrl: 'https://folia-5ve.pages.dev' });
 *   const page = await client.list({ category: 'wallpaper', limit: 24 });
 *   console.log(page.items.length, page.total);
 *
 * API key（可选，配额更高）：
 *   const client = new FoliaClient({ baseUrl: '...', apiKey: 'flk_...' });
 *
 * 约定：所有方法在 HTTP 非 2xx 时抛 `FoliaError`（带 status / code / hint），
 * 调用方可以直接读 `error.code` 做分支（见 docs/API-V1.md 的错误码表）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class FoliaError extends Error {
  constructor(status, body, url) {
    const error = body?.error ?? {};
    super(error.message || `请求失败（HTTP ${status}）`);
    this.name = 'FoliaError';
    this.status = status;
    this.code = error.code ?? 'internal_error';
    this.hint = error.hint ?? '';
    this.details = error.details ?? null;
    this.url = url;
  }
}

export class FoliaClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] 站点源（默认线上站点）
   * @param {string} [options.apiKey]  可选；`Authorization: Bearer` 携带
   * @param {typeof fetch} [options.fetch] 可注入的 fetch（测试/其他运行时）
   */
  constructor({ baseUrl = 'https://folia-5ve.pages.dev', apiKey = '', fetch: fetchImpl } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new Error('当前运行环境没有 fetch，请在 Node ≥ 20 或浏览器里使用');
  }

  #url(path, params) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) url.searchParams.set(key, value.join(','));
      else url.searchParams.set(key, String(value));
    }
    return url;
  }

  #headers(extra = {}) {
    const headers = { accept: 'application/json', ...extra };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async #json(path, params, { headers = {} } = {}) {
    const url = this.#url(path, params);
    const response = await this.fetch(url, { headers: this.#headers(headers) });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new FoliaError(response.status, body, url.toString());
    return body;
  }

  /** 列表（自动翻页请配合 page/cursor 字段）。返回 `data`：items / total / facets … */
  async list(params = {}) {
    const body = await this.#json('/api/v1/public/wallpapers', params);
    return body?.data ?? body;
  }

  /** 单条详情（按 slug）。返回 wallpaper 对象。 */
  async get(slug) {
    if (!slug) throw new Error('get(slug) 需要 slug');
    const body = await this.#json(`/api/v1/public/wallpapers/${encodeURIComponent(slug)}`);
    return body?.data?.wallpaper ?? null;
  }

  /** 全量 manifest 快照。传 etag 时命中 304 返回 null（省流量）。 */
  async manifest({ etag } = {}) {
    const headers = etag ? { 'if-none-match': etag } : {};
    const url = this.#url('/api/v1/public/manifest.json');
    const response = await this.fetch(url, { headers: this.#headers(headers) });
    if (response.status === 304) return null;
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new FoliaError(response.status, body, url.toString());
    return body;
  }

  /**
   * 下载文件到本地（流式，不把整个文件读进内存）。
   *
   * @param {string} urlOrKey 绝对 URL，或 R2 key（自动拼 `${baseUrl}/media/`）
   * @param {string} dest 目标路径
   * @param {object} [options]
   * @param {string|boolean} [options.verifySha] 传字符串：校验 sha256 必须相等；
   *   传 true：只计算并返回；false/缺省：不校验
   * @param {(received:number, total:number)=>void} [options.onProgress]
   * @returns {Promise<{path:string, bytes:number, sha256:string}>}
   */
  async download(urlOrKey, dest, { verifySha = false, onProgress } = {}) {
    if (!dest) throw new Error('download(url, dest) 需要目标路径');
    const url = /^https?:\/\//i.test(urlOrKey)
      ? urlOrKey
      : `${this.baseUrl}/media/${String(urlOrKey).replace(/^\/+/, '')}`;

    const response = await this.fetch(url, { headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {} });
    if (!response.ok) throw new FoliaError(response.status, await this.#safeJson(response), url);

    const total = Number(response.headers.get('content-length') ?? 0);
    // 相对路径也先建父目录（dirname('a.mp4') === '.'，mkdir 会跳过 / 已存在不报错）
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.part-${process.pid}`;
    const hash = createHash('sha256');
    let received = 0;

    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      onProgress?.(received, total);
    });

    try {
      await pipeline(stream, createWriteStream(tmp));
      await rename(tmp, dest);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }

    const sha256 = hash.digest('hex');
    if (typeof verifySha === 'string' && verifySha && verifySha !== sha256) {
      throw new FoliaError(200, {
        error: {
          code: 'sha256_mismatch',
          message: `sha256 不一致：期望 ${verifySha}，实际 ${sha256}`,
          hint: '文件可能被截断或对象被覆盖，请重新获取 manifest 后重试。',
        },
      }, url);
    }
    return { path: dest, bytes: received, sha256 };
  }

  async #safeJson(response) {
    try {
      return JSON.parse(await response.text());
    } catch {
      return null;
    }
  }
}

export default FoliaClient;
