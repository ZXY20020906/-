#!/usr/bin/env node
/**
 * `inspect-assets` —— 资产对账（阶段六运维三件套之一）。
 *
 * 为什么需要它：站点踩过两次「D1 说有、R2 没有」的坑（用户点下载直接 404），
 * 而且这类不一致**不会报错**——只有真去下载的人才发现。所以要有办法一条命令扫全库：
 *
 *   ① DB 有记录 ⇒ R2 对象在不在（HEAD）、大小对不对；`--sha N` 再抽 N 条验内容哈希
 *   ② 缩略图 / 海报 key 是否存在（**只算告警**：公开 DTO 会回落到原图或 null）
 *   ③ `_tmp/` 残留（分片上传中断留下的临时对象）
 *   ④ `needs_variant=1` 堆积、草稿超过 7 天（运营该清理的东西）
 *
 * 用法（生产，需要 CF_API_TOKEN + CF_ACCOUNT_ID）：
 *   node tools/inspect-assets.mjs                # 全量对账
 *   node tools/inspect-assets.mjs --sample 50    # 只看前 50 条（冒烟）
 *   node tools/inspect-assets.mjs --sha 3        # 另外抽 3 条下载验 sha256
 *   node tools/inspect-assets.mjs --json         # 机器可读
 *   node tools/inspect-assets.mjs --orphans wallpapers/   # 扫这个前缀有没有「无 DB 记录」的对象
 *
 * 退出码：0 正常；1 有异常（对象缺失 / 大小不符 / sha 不符 / 显式开启的阈值被突破）；3 缺凭据。
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makeD1, makeR2, resolveCredentials } from './lib/cloudflare.mjs';

/** 判定优先级：没有文件 < 对象缺失 < 大小不符 < 一致。纯函数，单测直接用。 */
export function classifyAssetRow(row, head) {
  if (!row?.storage_key) return { state: 'no-asset' };
  if (!head) return { state: 'missing', key: row.storage_key };
  const expected = Number(row.bytes ?? 0);
  const actual = Number(head.size ?? 0);
  if (expected > 0 && actual !== expected) {
    return { state: 'size-mismatch', key: row.storage_key, expected, actual };
  }
  return { state: 'ok' };
}

/**
 * 汇总：把逐行结果、`_tmp/` 残留、队列堆积整理成报告 + 退出码。
 * 纯函数（不碰网络），测试里直接喂构造数据。
 */
export function summarize({
  checked = [],
  tmpObjects = [],
  orphanObjects = null,
  counts = {},
  thresholds = {},
  now = Date.now(),
} = {}) {
  const assets = checked.filter((item) => item.state !== 'no-asset');
  const problems = assets.filter((item) => item.state === 'missing' || item.state === 'size-mismatch' || item.state === 'sha-mismatch');
  const thumbMissing = checked.filter((item) => item.thumbState === 'missing').length;
  const posterMissing = checked.filter((item) => item.posterState === 'missing').length;
  const tmpStale = tmpObjects.filter((item) => item.lastModified && now - Date.parse(item.lastModified) > 24 * 3600 * 1000);

  const breaches = [];
  if (thresholds.maxMissing && problems.length > thresholds.maxMissing) {
    breaches.push(`对象问题 ${problems.length} 条，超过阈值 ${thresholds.maxMissing}`);
  }
  if (thresholds.maxTmp && tmpObjects.length > thresholds.maxTmp) {
    breaches.push(`_tmp/ 残留 ${tmpObjects.length} 个，超过阈值 ${thresholds.maxTmp}`);
  }
  if (thresholds.maxNeedsVariant && (counts.needsVariant ?? 0) > thresholds.maxNeedsVariant) {
    breaches.push(`needs_variant=1 堆积 ${counts.needsVariant} 条，超过阈值 ${thresholds.maxNeedsVariant}`);
  }
  if (thresholds.maxOldDrafts && (counts.oldDrafts ?? 0) > thresholds.maxOldDrafts) {
    breaches.push(`超过 7 天的草稿 ${counts.oldDrafts} 条，超过阈值 ${thresholds.maxOldDrafts}`);
  }

  return {
    ok: problems.length === 0 && breaches.length === 0,
    exitCode: problems.length === 0 && breaches.length === 0 ? 0 : 1,
    counts: {
      checked: checked.length,
      withAsset: assets.length,
      ok: assets.filter((item) => item.state === 'ok').length,
      missing: assets.filter((item) => item.state === 'missing').length,
      sizeMismatch: assets.filter((item) => item.state === 'size-mismatch').length,
      shaMismatch: assets.filter((item) => item.state === 'sha-mismatch').length,
      noAsset: checked.filter((item) => item.state === 'no-asset').length,
      thumbMissing,
      posterMissing,
      tmpObjects: tmpObjects.length,
      tmpStale: tmpStale.length,
      orphans: orphanObjects === null ? null : orphanObjects.length,
      ...counts,
    },
    problems,
    breaches,
    tmpStale,
    orphanSample: (orphanObjects ?? []).slice(0, 20).map((item) => item.key),
  };
}

function parseArgs(argv) {
  const out = {
    sample: 0,
    sha: 0,
    json: false,
    scope: 'live',
    orphans: [],
    maxTmp: 0,
    maxNeedsVariant: 0,
    maxOldDrafts: 0,
    account: '',
    database: '',
    bucket: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sample') out.sample = Math.max(0, Number(argv[++i] ?? 0) || 0);
    else if (arg === '--sha') out.sha = Math.max(0, Number(argv[++i] ?? 0) || 0);
    else if (arg === '--json') out.json = true;
    else if (arg === '--scope') out.scope = String(argv[++i] ?? 'live') === 'all' ? 'all' : 'live';
    else if (arg === '--orphans') out.orphans.push(String(argv[++i] ?? ''));
    else if (arg === '--max-tmp') out.maxTmp = Number(argv[++i] ?? 0) || 0;
    else if (arg === '--max-needs-variant') out.maxNeedsVariant = Number(argv[++i] ?? 0) || 0;
    else if (arg === '--max-old-drafts') out.maxOldDrafts = Number(argv[++i] ?? 0) || 0;
    else if (arg === '--account') out.account = String(argv[++i] ?? '');
    else if (arg === '--database') out.database = String(argv[++i] ?? '');
    else if (arg === '--bucket') out.bucket = String(argv[++i] ?? '');
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node tools/inspect-assets.mjs [--scope live|all] [--sample N] [--sha N] [--json]
       [--orphans <prefix>]... [--max-tmp N] [--max-needs-variant N] [--max-old-drafts N]
       [--account <id>] [--database <d1 id>] [--bucket <r2 桶>]`);
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return out;
}

/** 小并发池：HEAD 是网络往返，串行跑 200 条要十几秒。 */
async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

const SQL_ROWS = `SELECT id, slug, title, status, storage_key, thumb_key, poster_key, bytes, sha256,
  duration_ms, created_at, updated_at, needs_variant, verified_at
  FROM wallpapers ORDER BY created_at`;

const SQL_COUNTS = `SELECT
  (SELECT COUNT(*) FROM wallpapers WHERE needs_variant = 1) AS needsVariant,
  (SELECT COUNT(*) FROM wallpapers WHERE status = 'draft' AND created_at < ?) AS oldDrafts,
  (SELECT COUNT(*) FROM wallpapers) AS total,
  (SELECT COUNT(*) FROM wallpapers WHERE storage_key IS NOT NULL) AS withAsset`;

export function formatTable(report) {
  const lines = [];
  const row = (label, value) => lines.push(`  ${label.padEnd(22)} ${value}`);
  row('检查范围', report.counts.scope === 'all' ? '全部（含 hidden）' : '在用条目（status != hidden）');
  row('检查条目', report.counts.checked);
  row('有文件', report.counts.withAsset);
  row('对象一致', report.counts.ok);
  row('对象缺失', report.counts.missing);
  row('大小不符', report.counts.sizeMismatch);
  row('sha 不符', report.counts.shaMismatch);
  row('无文件（草稿等）', report.counts.noAsset);
  row('缩略图缺失（告警）', report.counts.thumbMissing);
  row('海报缺失（告警）', report.counts.posterMissing);
  row('_tmp/ 残留', `${report.counts.tmpObjects}（>24h: ${report.counts.tmpStale}）`);
  if (report.counts.orphans !== null) row('无 DB 记录的对象', report.counts.orphans);
  row('needs_variant=1', report.counts.needsVariant ?? '-');
  row('超过 7 天的草稿', report.counts.oldDrafts ?? '-');
  if (report.counts.hiddenMissing) row('hidden 中缺对象（归档）', report.counts.hiddenMissing);
  if (report.problems.length) {
    lines.push('\n  异常明细：');
    for (const item of report.problems.slice(0, 50)) {
      lines.push(`    [${item.state}] ${item.id ?? ''} ${item.key ?? ''} ${item.expected !== undefined ? `期望 ${item.expected} 实际 ${item.actual}` : ''}`);
    }
    if (report.problems.length > 50) lines.push(`    …还有 ${report.problems.length - 50} 条`);
  }
  if (report.breaches.length) {
    lines.push('\n  阈值突破：');
    for (const item of report.breaches) lines.push(`    - ${item}`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const creds = resolveCredentials({ accountId: options.account, databaseId: options.database, bucket: options.bucket });
  const missing = ['token', 'accountId', 'databaseId', 'bucket'].filter((key) => !creds[key]);
  if (missing.length) {
    console.error(`缺少凭据/配置：${missing.join(', ')}（CF_API_TOKEN / CF_ACCOUNT_ID，database_id 与桶名从 wrangler.toml 读）`);
    process.exit(3);
  }

  const db = makeD1(creds);
  const r2 = makeR2(creds);

  const rows = await db.all(SQL_ROWS);
  /**
   * 默认只查「还在用的」条目（`status != 'hidden'`）。
   *
   * 为什么：`hidden` 是**有意归档**的状态 —— 站点曾经有一批对象丢失的条目（见
   * `deploy/broken-summary.json`），处置方式就是把它们置为 hidden。如果默认连它们一起查，
   * 健康站点也会永远 exit 1，这个巡检就没人看了。要考古就 `--scope all`。
   */
  const scoped = options.scope === 'all' ? rows : rows.filter((row) => row.status !== 'hidden');
  const selected = options.sample > 0 ? scoped.slice(0, options.sample) : scoped;
  const counts = (await db.query(SQL_COUNTS, [Date.now() - 7 * 24 * 3600 * 1000])).results[0] ?? {};

  /**
   * 为什么先「整桶列一遍」而不是逐条 HEAD：R2 的 REST API 不支持 HEAD（405），
   * 逐条查只能退化成「按 key 列一次」，235 条就是 235 次往返；而整桶列表一次就能拿到
   * key → size 的完整索引（当前站点 ~700 个对象，一次分页就完了）。
   */
  const objects = await r2.list({ max: 20000 });
  const index = new Map(objects.map((item) => [item.key, item]));

  const checked = selected.map((row) => {
    const asset = row.storage_key ? index.get(row.storage_key) ?? null : null;
    const verdict = classifyAssetRow(row, asset ? { size: asset.size } : null);
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      ...verdict,
      thumbState: row.thumb_key ? (index.has(row.thumb_key) ? 'ok' : 'missing') : 'none',
      posterState: row.poster_key ? (index.has(row.poster_key) ? 'ok' : 'missing') : 'none',
    };
  });

  // hidden 里缺对象的数量单独统计（只报数，不算异常）
  const hiddenMissing = options.scope === 'all'
    ? 0
    : rows.filter((row) => row.status === 'hidden' && row.storage_key && !index.has(row.storage_key)).length;

  // 抽样验 sha256：真下载，只在前 N 条上做（大文件很贵）
  if (options.sha > 0) {
    const candidates = checked.filter((item) => item.state === 'ok').slice(0, options.sha);
    for (const item of candidates) {
      const row = selected.find((candidate) => candidate.id === item.id);
      const object = await r2.get(row.storage_key).catch(() => null);
      if (!object) {
        item.shaState = 'skipped';
        continue;
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (row.sha256 && actual !== row.sha256) {
        item.state = 'sha-mismatch';
        item.expected = row.sha256;
        item.actual = actual;
      } else {
        item.shaState = row.sha256 ? 'ok' : 'no-hash';
      }
    }
  }

  const tmpObjects = objects.filter((item) => item.key.startsWith('_tmp/'));
  let orphanObjects = null;
  if (options.orphans.length) {
    const known = new Set(rows.flatMap((row) => [row.storage_key, row.thumb_key, row.poster_key].filter(Boolean)));
    orphanObjects = objects.filter((item) => options.orphans.some((prefix) => item.key.startsWith(prefix)) && !known.has(item.key));
  }

  const report = summarize({
    checked,
    tmpObjects,
    orphanObjects,
    counts: {
      needsVariant: Number(counts.needsVariant ?? 0),
      oldDrafts: Number(counts.oldDrafts ?? 0),
      totalRows: Number(counts.total ?? 0),
      hiddenMissing,
      scope: options.scope,
    },
    thresholds: {
      maxMissing: 0,
      maxTmp: options.maxTmp,
      maxNeedsVariant: options.maxNeedsVariant,
      maxOldDrafts: options.maxOldDrafts,
    },
  });

  if (options.json) {
    console.log(JSON.stringify({ ok: report.ok, counts: report.counts, problems: report.problems, breaches: report.breaches }, null, 2));
  } else {
    console.log(`Folia 资产对账  →  D1 ${creds.databaseId} · R2 ${creds.bucket}`);
    console.log(formatTable(report));
    console.log(report.ok ? '\n✓ 全部一致' : `\n✗ 发现 ${report.problems.length + report.breaches.length} 个问题`);
  }
  process.exit(report.exitCode);
}

// 只有直接运行时才执行（被测试 import 时只拿纯函数）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('inspect-assets 失败：', error?.message ?? error);
    process.exit(2);
  });
}
