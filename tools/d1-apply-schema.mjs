#!/usr/bin/env node
/**
 * d1-apply-schema.mjs — 用 Cloudflare API 把 schema/*.sql 应用到线上 D1。
 *
 * 为什么不用 wrangler：`wrangler d1 execute` 需要另一套登录态；本仓库的运维脚本
 * 一直用 CF API token（`D:\folia-recover\cf-token.txt`）。但**必须**用 Node 的 fetch
 * 发请求 —— PowerShell 5.1 的 Invoke-RestMethod 会把中文按 ANSI 编码发出去，
 * 种子数据里的中文会变成 `??`（2026-11 标签别名表踩过一次，见下）。
 *
 * 用法：
 *   node tools/d1-apply-schema.mjs schema/017_tag_aliases.sql
 *   node tools/d1-apply-schema.mjs --file=schema/018_api_keys.sql --allow-duplicate
 *   node tools/d1-apply-schema.mjs --statement="DELETE FROM tag_aliases"   # 运维修数据
 *   node tools/d1-apply-schema.mjs --file=... --dry-run                    # 只打印语句
 *
 * 安全：
 *   - token 只从 `--token-file` / `CF_API_TOKEN` 读取，绝不打印；
 *   - `--dry-run` 只打印语句数量与首行；
 *   - `--allow-duplicate` 只在 D1 报 `duplicate column name` 时跳过该语句（迁移可重入）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const args = {
  file: '',
  statement: '',
  dryRun: false,
  allowDuplicate: false,
  tokenFile: process.env.CF_TOKEN_FILE || 'D:\\folia-recover\\cf-token.txt',
  account: process.env.CF_ACCOUNT_ID || '2f31addd6894dbafbcfb220c6809fee3',
  database: process.env.D1_DATABASE_ID || '64761fc2-cd88-46f4-b08f-c2b08d5b667f',
};
for (const raw of process.argv.slice(2)) {
  if (raw === '--dry-run') args.dryRun = true;
  else if (raw === '--allow-duplicate') args.allowDuplicate = true;
  else if (raw.startsWith('--file=')) args.file = raw.slice(7);
  else if (raw.startsWith('--statement=')) args.statement = raw.slice(12);
  else if (raw.startsWith('--token-file=')) args.tokenFile = raw.slice(13);
}

function readToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN.trim();
  if (existsSync(args.tokenFile)) return readFileSync(args.tokenFile, 'utf8').trim();
  console.error('找不到 token（CF_API_TOKEN 或 --token-file）');
  process.exit(1);
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error('token 是空的');
  process.exit(1);
}

/** 按 `;` 切语句，去掉 `--` 注释行。schema 文件里没有分号字符串，够用。 */
function splitStatements(text) {
  return text
    .split(';')
    .map((chunk) => chunk
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('--') && line.trim() !== '')
      .join('\n')
      .trim())
    .filter(Boolean);
}

const text = args.statement
  ? args.statement
  : (args.file ? readFileSync(resolve(ROOT, args.file), 'utf8') : '');
if (!text) {
  console.error('需要 --file=<path> 或 --statement=<sql>');
  process.exit(1);
}

const statements = splitStatements(text);
console.log(`[d1] 语句 ${statements.length} 条${args.dryRun ? '（dry-run）' : ''}`);
if (args.dryRun) {
  for (const [index, statement] of statements.entries()) {
    console.log(`  ${index + 1}. ${statement.split('\n')[0].slice(0, 100)}`);
  }
  process.exit(0);
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${args.account}/d1/database/${args.database}/query`;
let failed = 0;

for (const [index, statement] of statements.entries()) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: statement }),
  });
  const body = await response.json().catch(() => ({}));
  const first = statement.split('\n')[0].slice(0, 90);
  if (body.success) {
    console.log(`  OK  ${index + 1}. ${first}`);
    continue;
  }
  const messages = (body.errors ?? []).map((item) => item.message).join('; ') || `HTTP ${response.status}`;
  if (args.allowDuplicate && /duplicate column name/i.test(messages)) {
    console.log(`  SKIP(已存在) ${index + 1}. ${first}`);
    continue;
  }
  failed += 1;
  console.error(`  FAIL ${index + 1}. ${first}\n        ${messages}`);
}

console.log(`[d1] 完成：${statements.length - failed} 成功 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
