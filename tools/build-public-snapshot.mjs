#!/usr/bin/env node
/**
 * 从**生产 D1 的导出文件**生成公开接口快照（`src/server/public-snapshot.js`）。
 *
 * 为什么需要它：2026-11-05 生产 D1 免费额度耗尽，所有公开接口 500。数据本身没坏，
 * 但「公开接口只有 D1 一个读源」这件事让整站不可用。快照是最后一层保险：D1 额度
 * 耗尽 / 表缺失 / 绑定失效时，`public-api.js` 回落到这份只读快照，插件仍然能拿到
 * 110 条站点素材。
 *
 * 输入是 D1 的 SQL 导出（control plane 的 `POST .../export` 下载的 .sql），不是手工
 * 拼的 JSON —— 这样 DTO/分页/facets 全部走真实 `public-api.js`，不会出现「快照和
 * 线上接口两套形状」。
 *
 * 用法：
 *   1) 从 Cloudflare 导出：`POST /accounts/<acct>/d1/database/<db>/export`，body
 *      `{"output_format":"file"}`，下载 signed_url 到 `build/d1-export.sql`；
 *   2) 用 sqlite3/Python 执行这个 .sql 得到一个 .sqlite 文件；
 *   3) `node tools/build-public-snapshot.mjs --sqlite build/d1-export.sqlite`
 *
 * 也可以直接给 `.sql`（本工具会用 node:sqlite 执行），但大库建议先转成 .sqlite。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function parseArgs(argv) {
  const out = { sqlite: '', out: resolve(repoRoot, 'src/server/public-snapshot.js'), origin: 'https://folia-5ve.pages.dev', commit: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sqlite') out.sqlite = resolve(argv[++i] ?? '');
    else if (arg === '--out') out.out = resolve(argv[++i] ?? out.out);
    else if (arg === '--origin') out.origin = String(argv[++i] ?? out.origin).replace(/\/+$/, '');
    else if (arg === '--commit') out.commit = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/build-public-snapshot.mjs --sqlite <export.sqlite|export.sql> [--out src/server/public-snapshot.js] [--origin https://folia-5ve.pages.dev] [--commit <sha>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!out.sqlite) throw new Error('缺少 --sqlite（生产 D1 导出文件）');
  if (!existsSync(out.sqlite)) throw new Error(`找不到文件: ${out.sqlite}`);
  if (!out.commit) {
    try {
      out.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      out.commit = '';
    }
  }
  return out;
}

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

const { DatabaseSync } = await import('node:sqlite');
const options = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(options.sqlite, { readOnly: false });

// 如果给的是 .sql，先执行它（node:sqlite 的 exec 支持多语句）。
if (options.sqlite.toLowerCase().endsWith('.sql')) {
  db.exec(readFileSync(options.sqlite, 'utf8'));
}

const {
  wallpapersPayload, categoriesPayload, tagsPayload, subtagsPayload, manifestPayload,
} = await import('../src/server/public-api.js');

const env = {
  DB: makeD1(db),
  PUBLIC_ORIGIN: options.origin,
  MEDIA_BASE: '',
  PUBLIC_SNAPSHOT_FALLBACK: '0',
};

const base = 'https://snapshot.local/api/v1/public';
const first = await wallpapersPayload({ env, url: new URL(`${base}/wallpapers?limit=100&page=1`) });
const second = await wallpapersPayload({ env, url: new URL(`${base}/wallpapers?limit=100&page=2`) });
const items = [...first.data.items, ...second.data.items];
const total = first.data.total;
if (items.length !== total) throw new Error(`快照条目数不一致：items=${items.length}，total=${total}`);
if (first.data.facets.categories.reduce((sum, item) => sum + item.count, 0) !== total) {
  throw new Error('facets.categories 合计 != total，拒绝生成自相矛盾的快照');
}

const categories = (await categoriesPayload(env)).categories;
const tags = await tagsPayload({ env, url: new URL(`${base}/tags`) });
const subtags = (await subtagsPayload({ env, url: new URL(`${base}/subtags`) })).subtags;
const manifest = await manifestPayload(env);
if (manifest.total !== total) throw new Error(`manifest.total=${manifest.total} != ${total}`);

// schema/017 之前的库没有 tag_aliases：生成器不因此失败，快照里就没有归一表。
let aliases = {};
try {
  aliases = Object.fromEntries(
    db.prepare('SELECT alias, canonical FROM tag_aliases').all().map((row) => [row.alias, row.canonical]),
  );
} catch (error) {
  console.warn('tag_aliases 不可用，快照不包含标签归一表：', error?.message ?? error);
}

const generatedAt = Number(manifest.generatedAt ?? 0);
const snapshot = {
  generatedAt,
  sourceCommit: options.commit || null,
  sourceDatabase: 'folia',
  total,
  items,
  categories,
  tags: { tags: tags.tags, aspects: tags.aspects, kinds: tags.kinds },
  subtags,
  manifest,
  aliases,
};

const banner = `/**
 * 公开接口的「最近一次成功导出」快照 —— **由工具生成，不要手改**。
 *
 * 生成命令：
 *   node tools/build-public-snapshot.mjs --sqlite <生产 D1 导出文件> --commit ${options.commit || '<sha>'}
 *
 * 数据源：Cloudflare D1 \`folia\` 导出（${total} 条公开素材，generatedAt=${generatedAt}）。
 * 只在 D1 不可用（额度耗尽 / 缺表 / 绑定失效）时由 public-api.js 回落使用；
 * 正常请求永远走 D1。响应会带 \`degraded: true\` 与 \`snapshotGeneratedAt\`。
 */
`;

const body = `${banner}export const SNAPSHOT = ${JSON.stringify(snapshot)};\n\nexport default SNAPSHOT;\n`;
writeFileSync(options.out, body, 'utf8');

const size = Buffer.byteLength(body, 'utf8');
console.log(`wrote ${options.out}`);
console.log(`total=${total} items=${items.length} categories=${categories.length} tags=${tags.tags.length} subtags=${subtags.length} manifest=${manifest.items.length} size=${(size / 1024).toFixed(1)}KB`);
console.log(`generatedAt=${generatedAt} (${new Date(generatedAt).toISOString()}) commit=${options.commit || '-'}`);
db.close();
