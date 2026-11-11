/**
 * apply-sql.mjs — 把一份 .sql 按语句逐条打到 D1（REST），适用于**没有 wrangler** 的机器。
 *
 * 为什么要自己切分：D1 的 `/query` 一次只吃一条语句，而迁移文件里有
 * `CREATE TRIGGER ... BEGIN ... END;` 这种**体内含分号**的语句，简单 split(';') 会切坏。
 * 这里的切分器只把"不在 BEGIN...END 块里的分号"当语句边界。
 *
 * 用法：node tools/.apply-sql.mjs schema/020_pet_kind.sql [--database <id>] [--account <id>] [--token <t>]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const out = {
    file: '',
    databaseId: process.argv.find((item) => item === '--database') || '',
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
    db: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--database') out.db = String(argv[++i] ?? '');
    else if (arg === '--account') out.accountId = String(argv[++i] ?? '');
    else if (arg === '--token') out.token = String(argv[++i] ?? '');
    else if (arg === '--dry-run') out.dryRun = true;
    else if (!arg.startsWith('--')) out.file = arg;
  }
  return out;
}

/**
 * 按"BEGIN/CASE ... END 之外的分号"切语句。
 *
 * 坑：触发器体里既有 `BEGIN ... END;`，也有 `CASE WHEN ... END`（媒体审计触发器就用）。
 * 只数 BEGIN 会把 CASE 里的 END 误当成块结束 ⇒ 切出一个孤立的 `END` 语句。
 * 所以 BEGIN 和 CASE 都让深度 +1，END 让深度 -1。
 */
export function splitStatements(sql) {
  const statements = [];
  let buffer = '';
  let depth = 0;
  const token = /('(?:''|[^'])*')|(\bBEGIN\b)|(\bCASE\b)|(\bEND\b)|(;)/gi;
  let last = 0;
  let match;
  while ((match = token.exec(sql)) !== null) {
    buffer += sql.slice(last, match.index);
    last = token.lastIndex;
    if (match[1]) { buffer += match[0]; continue; }
    if (match[2] || match[3]) { depth += 1; buffer += match[0]; continue; }
    if (match[4]) { depth = Math.max(0, depth - 1); buffer += match[0]; continue; }
    // 分号
    if (depth === 0) {
      const text = buffer.trim();
      if (text) statements.push(text);
      buffer = '';
    } else {
      buffer += ';';
    }
  }
  buffer += sql.slice(last);
  const tail = buffer.trim();
  if (tail) statements.push(tail);
  return statements
    .map((statement) => statement.replace(/^\s*(--[^\n]*\n\s*)+/, '').trim())
    .filter(Boolean);
}

/** 只有直接执行时才跑主流程（被别人 import 时只导出 splitStatements）。 */
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (!invokedDirectly) {
  // 被 import：什么都不做
} else {
const options = parseArgs(process.argv.slice(2));
if (!options.file) { console.error('用法: node tools/.apply-sql.mjs <file.sql> --database <id>'); process.exit(1); }

const sql = readFileSync(resolve(options.file), 'utf8');
const statements = splitStatements(sql);
console.log(`文件 ${options.file}：切出 ${statements.length} 条语句`);
for (const [index, statement] of statements.entries()) {
  console.log(`  ${index + 1}. ${statement.split('\n')[0].slice(0, 90)}`);
}
if (options.dryRun) { console.log('[dry-run] 未执行'); process.exit(0); }

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/d1/database/${options.db}/query`;
for (const [index, statement] of statements.entries()) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: `${statement};` }),
  });
  const doc = await response.json();
  if (!doc.success) {
    console.error(`第 ${index + 1} 条失败：`, JSON.stringify(doc.errors).slice(0, 300));
    process.exit(1);
  }
  console.log(`  ✓ ${index + 1}/${statements.length}`);
}
console.log('全部执行完成');
}
