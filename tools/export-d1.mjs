#!/usr/bin/env node
/**
 * `export-d1` —— 把 D1 的业务数据导成一份可 JSON.parse 的备份（阶段六运维三件套之一）。
 *
 * 为什么不用 `wrangler d1 export`：那条命令要装 wrangler、要交互式登录，而「先备份再动手」
 * 这件事应该在**任何一台机器、任何一次调整之前**都能一条命令跑完。这里直接走 REST，
 * 只需要一个只读 token。
 *
 * 导出范围（只读、按表分页）：
 *   wallpapers（含 variants JSON 列）、categories、tags、subtags、tag_aliases、
 *   api_keys（**不含 key_hash**）、sessions 只导计数（不导令牌哈希）。
 *   其它表（likes / audit_log / media_audit / upload_usage）可显式 `--include <表>` 追加。
 *
 * 用法：
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node tools/export-d1.mjs
 *   node tools/export-d1.mjs --out backups/folia-20261106.json
 *   node tools/export-d1.mjs --include likes --include audit_log
 *   node tools/export-d1.mjs --verify            # 只校验：条数对比 + JSON.parse
 *
 * 产物：`backups/d1-YYYYMMDD-HHmm.json`（`backups/` 已在 .gitignore 里）。
 * 退出码：0 成功；1 失败；3 缺凭据。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeD1, resolveCredentials, REPO_ROOT } from './lib/cloudflare.mjs';

/**
 * 每个表的导出定义。
 * `columns` 缺省 = `SELECT *`；给了就只导这些列（api_keys 的 key_hash 就是这样被挡掉的）。
 */
export const TABLES = Object.freeze({
  wallpapers: { order: 'created_at' },
  categories: { order: 'sort_order' },
  tags: { order: 'sort_order' },
  subtags: { order: 'sort_order' },
  tag_aliases: { order: 'alias' },
  // 只导非敏感列：key_hash 是「令牌的 sha256」，虽然不是明文，但没有导出的必要。
  api_keys: { order: 'created_at', columns: 'id, label, rpm, active, created_at, last_used_at' },
  likes: { order: 'created_at', optional: true },
  audit_log: { order: 'at', optional: true },
  media_audit: { order: 'changed_at', optional: true },
  upload_usage: { order: 'day', optional: true },
});

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const out = {
    out: resolve(REPO_ROOT, 'backups', `d1-${stamp}.json`),
    include: [],
    verify: false,
    pageSize: 500,
    account: '',
    database: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = resolve(argv[++i] ?? out.out);
    else if (arg === '--include') out.include.push(String(argv[++i] ?? ''));
    else if (arg === '--verify') out.verify = true;
    else if (arg === '--page-size') out.pageSize = Math.max(10, Number(argv[++i] ?? 500) || 500);
    else if (arg === '--account') out.account = String(argv[++i] ?? '');
    else if (arg === '--database') out.database = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node tools/export-d1.mjs [--out <file>] [--include <表>]... [--verify]
       [--page-size 500] [--account <id>] [--database <d1 id>]`);
      console.log(`可导出的表：${Object.keys(TABLES).join(', ')}`);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return out;
}

/** 纯函数：给一组表名 + 已取到的行，组装导出文档（测试直接调它）。 */
export function buildExport({ tables, counts, generatedAt = Date.now(), databaseId = '' }) {
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value ?? 0), 0);
  return {
    version: 1,
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    databaseId,
    tables,
    counts,
    totalRows: total,
  };
}

/**
 * 校验导出文档：必须能 JSON.parse（调用方传原文时用）、条数与声明一致。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function verifyExport(document) {
  const errors = [];
  if (!document || typeof document !== 'object') return { ok: false, errors: ['导出文档不是对象'] };
  if (!document.tables || typeof document.tables !== 'object') errors.push('缺少 tables');
  if (!document.counts || typeof document.counts !== 'object') errors.push('缺少 counts');
  for (const [name, rows] of Object.entries(document.tables ?? {})) {
    if (!Array.isArray(rows)) {
      errors.push(`${name} 不是数组`);
      continue;
    }
    const declared = Number(document.counts[name] ?? -1);
    if (declared !== rows.length) errors.push(`${name} 条数不符：声明 ${declared}，实际 ${rows.length}`);
  }
  if (typeof document.totalRows === 'number') {
    const sum = Object.values(document.tables ?? {}).reduce((acc, rows) => acc + (Array.isArray(rows) ? rows.length : 0), 0);
    if (sum !== document.totalRows) errors.push(`totalRows 不符：声明 ${document.totalRows}，实际 ${sum}`);
  }
  return { ok: errors.length === 0, errors };
}

async function exportTable(db, name, spec, pageSize) {
  const columns = spec.columns ?? '*';
  const order = spec.order ? ` ORDER BY ${spec.order}` : '';
  try {
    const rows = await db.all(`SELECT ${columns} FROM ${name}${order}`, { pageSize });
    return { rows, error: null };
  } catch (error) {
    // 老库可能没有这张表 / 这一列：标成 skipped，不打断整份导出
    return { rows: [], error: error?.message ?? String(error) };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const creds = resolveCredentials({ accountId: options.account, databaseId: options.database });
  if (!creds.token || !creds.accountId || !creds.databaseId) {
    console.error('缺少凭据/配置：需要 CF_API_TOKEN、CF_ACCOUNT_ID、D1 database id（从 wrangler.toml 读）');
    process.exit(3);
  }
  const db = makeD1(creds);

  const names = Object.keys(TABLES).filter((name) => !TABLES[name].optional || options.include.includes(name));
  for (const extra of options.include) {
    if (!TABLES[extra] && !names.includes(extra)) names.push(extra);
  }

  const tables = {};
  const counts = {};
  const skipped = {};
  for (const name of names) {
    const spec = TABLES[name] ?? {};
    const { rows, error } = await exportTable(db, name, spec, options.pageSize);
    if (error) {
      skipped[name] = error;
      continue;
    }
    tables[name] = rows;
    counts[name] = rows.length;
    console.log(`  ${name.padEnd(14)} ${String(rows.length).padStart(6)} 行`);
  }

  const document = buildExport({ tables, counts, databaseId: creds.databaseId });
  if (Object.keys(skipped).length) document.skipped = skipped;
  const { ok, errors } = verifyExport(document);
  if (!ok) throw new Error(`导出自检失败：${errors.join('；')}`);

  if (options.verify) {
    console.log(`\n✓ 自检通过：${Object.keys(tables).length} 张表 / ${document.totalRows} 行`);
    if (Object.keys(skipped).length) console.log(`  跳过：${JSON.stringify(skipped)}`);
    return 0;
  }

  mkdirSync(dirname(options.out), { recursive: true });
  const text = JSON.stringify(document, null, 2);
  writeFileSync(options.out, text, 'utf8');
  // 写完立刻回读校验：文件坏了要当场知道，而不是等到要恢复的那天
  const reparsed = verifyExport(JSON.parse(readFileSync(options.out, 'utf8')));
  if (!reparsed.ok) throw new Error(`写出的文件自检失败：${reparsed.errors.join('；')}`);

  console.log(`\n✓ 已导出 ${options.out}`);
  console.log(`  ${Object.keys(tables).length} 张表 / ${document.totalRows} 行 / ${(Buffer.byteLength(text) / 1024).toFixed(1)}KB`);
  if (Object.keys(skipped).length) console.log(`  跳过：${JSON.stringify(skipped)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('export-d1 失败：', error?.message ?? error);
      process.exit(1);
    });
}
