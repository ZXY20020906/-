/**
 * fix-pet-kind.mjs — 把「桌宠包但 kind≠pet」的历史行修正成 `kind='pet'`（问题 2 的迁移）。
 *
 * 背景：导入表单默认「壁纸」，桌宠 zip 入库后 `kind` 列被写成 `static`，
 * 与 `mime=application/zip` 自相矛盾；公开 DTO 靠 variant 判对，但任何按 kind 列
 * 过滤的地方（后台筛选、统计、后续逻辑）都会漏。
 *
 * 判定口径（与 ingest 的修复一致）：
 *   `variants` 里存在 `{kind:'pet'}` 且 `kind <> 'pet'` 且 `mime = 'application/zip'`
 *
 * 用法：
 *   node tools/fix-pet-kind.mjs                 # dry-run（默认，只打印将要改什么）
 *   node tools/fix-pet-kind.mjs --write         # 真写
 *   node tools/fix-pet-kind.mjs --sqlite x.db   # 本地导出库（CI/排障）
 *
 * 幂等：再跑一次不会有任何行被选中。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeD1 as restD1, readWranglerConfig } from './lib/cloudflare.mjs';

function parseArgs(argv) {
  const out = {
    write: false,
    sqlite: '',
    accountId: process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '',
    token: process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '',
    databaseId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') out.write = true;
    else if (arg === '--dry-run') out.write = false;
    else if (arg === '--sqlite') out.sqlite = resolve(argv[++i] ?? '');
    else if (arg === '--database') out.databaseId = String(argv[++i] ?? '');
    else if (arg === '--account') out.accountId = String(argv[++i] ?? '');
    else if (arg === '--token') out.token = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node tools/fix-pet-kind.mjs [--write] [--sqlite <导出文件>]
       [--account <id>] [--database <d1 id>] [--token <api token>]`);
      process.exit(0);
    } else throw new Error(`未知参数: ${arg}`);
  }
  return out;
}

/** 本地 sqlite（导出文件）→ 最小 D1 门面（只实现本脚本要用的三种形状）。 */
function d1FromSqlite(db) {
  const bind = (args) => args.map((value) => (value === undefined ? null : value));
  return {
    async all(sql, ...args) {
      return { results: db.prepare(sql).all(...bind(args)) };
    },
    async run(sql, ...args) {
      const info = db.prepare(sql).run(...bind(args));
      return { changes: Number(info.changes) || 0 };
    },
  };
}

const options = parseArgs(process.argv.slice(2));
const wrangler = readWranglerConfig();

const SELECT = `SELECT id, slug, kind, mime,
  (SELECT COUNT(*) FROM json_each(wallpapers.variants) WHERE json_extract(value, '$.kind') = 'pet') AS pet_markers
  FROM wallpapers
  WHERE kind <> 'pet'
    AND mime = 'application/zip'
    AND EXISTS (SELECT 1 FROM json_each(wallpapers.variants) WHERE json_extract(value, '$.kind') = 'pet')
  ORDER BY created_at`;

async function main() {
  let db;
  let source;
  if (options.sqlite) {
    if (!existsSync(options.sqlite)) throw new Error(`找不到文件: ${options.sqlite}`);
    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(options.sqlite, { readOnly: !options.write });
    db = d1FromSqlite(sqlite);
    source = `sqlite:${options.sqlite}`;
  } else {
    if (!options.token) throw new Error('缺少 API token：设 CF_API_TOKEN（或传 --token）');
    if (!options.accountId) throw new Error('缺少 account id：设 CF_ACCOUNT_ID（或传 --account）');
    const databaseId = options.databaseId || wrangler.databaseId;
    if (!databaseId) throw new Error('缺少 D1 database id：wrangler.toml 里没有，或用 --database 指定');
    db = restD1({ accountId: options.accountId, databaseId, token: options.token });
    source = `d1:${databaseId}`;
  }

  const rows = (await db.all(SELECT)).results || [];
  console.log(`数据源 ${source}`);
  console.log(`命中 ${rows.length} 行（kind≠pet 但 variants 里有 pet 标记）`);
  for (const row of rows) {
    console.log(`  · ${row.slug}  kind=${row.kind}  mime=${row.mime}  pet标记=${row.pet_markers}`);
  }

  if (!rows.length) { console.log('无需修改。'); return; }
  if (!options.write) {
    console.log('\n[dry-run] 未写入。确认无误后加 --write 再跑一次。');
    return;
  }

  let changed = 0;
  for (const row of rows) {
    const result = await db.run('UPDATE wallpapers SET kind = ?, updated_at = ? WHERE id = ? AND kind <> ?', 'pet', Date.now(), row.id, 'pet');
    changed += Number(result.changes) || 0;
  }
  console.log(`\n已更新 ${changed} 行。建议随后重建公开快照：node tools/build-snapshot.mjs`);
}

main().catch((error) => {
  console.error('失败：', error?.message ?? error);
  process.exit(1);
});
