#!/usr/bin/env node
/**
 * D1 用量面板（阶段四拉过来先用，阶段六的运维三件套之一）。
 *
 * 为什么需要：2026-11-05 的线上事故就是「免费额度悄悄用完，整站公开接口 500」。
 * 光有快照只能挡住公开读；写侧（上传/重建/审计）仍然会吃配额，必须能随时看余量。
 *
 * 数据源：Cloudflare GraphQL Analytics（`d1AnalyticsAdaptiveGroups`，按小时分桶）。
 * 需要 token 带 **Account Analytics: Read**；没有权限时脚本以退出码 3 明说，
 * 而不是打一行看不懂的 403。
 *
 * 用法：
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node tools/d1-usage.mjs
 *   node tools/d1-usage.mjs --days 7          # 最近 7 天（按 UTC 日汇总）
 *   node tools/d1-usage.mjs --json            # 机器可读，给 CI / 定时任务
 *
 * 退出码：0 正常；2 使用率 > 80%（该清缓存/该扩容了）；3 缺凭据或没权限。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** D1 免费额度（Cloudflare 现行口径，2026-11）。付费版就该把这里改掉或忽略告警。 */
export const FREE_TIER = Object.freeze({
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  storageBytes: 5 * 1024 * 1024 * 1024,
});

function parseArgs(argv) {
  const out = { days: 1, json: false, warnAt: 0.8 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') out.days = Math.max(1, Math.min(31, Number(argv[++i] ?? 1) || 1));
    else if (arg === '--json') out.json = true;
    else if (arg === '--warn-at') out.warnAt = Math.min(1, Math.max(0.1, Number(argv[++i] ?? 0.8) || 0.8));
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/d1-usage.mjs [--days N] [--json] [--warn-at 0.8]');
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return out;
}

/** 从 wrangler.toml 读 database_id（和部署用的是同一份配置）。 */
function readDatabaseId() {
  const file = resolve(repoRoot, 'wrangler.toml');
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').match(/database_id\s*=\s*"([^"]+)"/)?.[1] ?? '';
}

const options = parseArgs(process.argv.slice(2));
const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CF_D1_ID || readDatabaseId();

if (!token || !accountId) {
  console.error('缺少凭据：需要 CF_API_TOKEN 与 CF_ACCOUNT_ID（token 需 Account Analytics: Read）');
  process.exit(3);
}
if (!databaseId) {
  console.error('缺少 D1 database id：wrangler.toml 里没有，或用 CF_D1_ID 指定');
  process.exit(3);
}

const iso = (date) => date.toISOString().replace(/\.\d+Z$/, 'Z');
const now = new Date();
const start = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);

const QUERY = `query D1Usage($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        limit: 5000
        filter: { datetime_geq: $start, datetime_leq: $end, databaseId: "${databaseId}" }
        orderBy: [date_ASC]
      ) {
        sum { rowsRead rowsWritten }
        dimensions { date }
      }
    }
  }
}`;

async function graphql(query, variables) {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (body.errors?.length) {
    const message = body.errors.map((item) => item.message).join('; ');
    if (/authorization|permission|not authorized/i.test(message)) {
      console.error(`GraphQL 无权限（token 需要 Account Analytics: Read）：${message.slice(0, 200)}`);
      process.exit(3);
    }
    throw new Error(message.slice(0, 300));
  }
  return body.data;
}

/**
 * 按 UTC 日聚合。Cloudflare 的 `date` 维度本身就是按日分片（免费额度也按 UTC 日清零），
 * 所以不需要自己在 JS 里切时间戳 —— 之前按 `datetime`（按秒分片）聚合，一旦窗口内
 * 分片超过 limit 就会被截断，算出来的「今日行读」可能是 0（踩过）。
 */
function byDay(groups) {
  return groups.map((group) => ({
    day: group.dimensions.date,
    rowsRead: group.sum.rowsRead ?? 0,
    rowsWritten: group.sum.rowsWritten ?? 0,
  })).sort((a, b) => (a.day < b.day ? -1 : 1));
}

async function readStorage() {
  // 存储用量是另一张表；没有权限/没有这个数据集时返回 null，不影响主报告。
  try {
    const data = await graphql(`query Storage($accountTag: String!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $start, datetime_leq: $end, databaseId: "${databaseId}" }, orderBy: [datetime_DESC]) {
          sum { databaseSizeBytes }
          dimensions { datetime }
        }
      } }
    }`, { accountTag: accountId, start: iso(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)), end: iso(now) });
    const groups = data?.viewer?.accounts?.[0]?.d1StorageAdaptiveGroups ?? [];
    return groups[0]?.sum?.databaseSizeBytes ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const data = await graphql(QUERY, { accountTag: accountId, start: iso(start), end: iso(now) });
  const groups = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const days = byDay(groups);
  const storage = await readStorage();

  const today = iso(now).slice(0, 10);
  const todayRow = days.find((item) => item.day === today) ?? { day: today, rowsRead: 0, rowsWritten: 0 };
  const readRate = todayRow.rowsRead / FREE_TIER.rowsReadPerDay;
  const writeRate = todayRow.rowsWritten / FREE_TIER.rowsWrittenPerDay;
  const storageRate = storage === null ? null : storage / FREE_TIER.storageBytes;
  const worst = Math.max(readRate, writeRate, storageRate ?? 0);
  const warn = worst >= options.warnAt;

  if (options.json) {
    console.log(JSON.stringify({
      databaseId,
      today,
      rowsRead: todayRow.rowsRead,
      rowsWritten: todayRow.rowsWritten,
      storageBytes: storage,
      limits: FREE_TIER,
      usage: { rowsRead: Number(readRate.toFixed(3)), rowsWritten: Number(writeRate.toFixed(3)), storage: storageRate === null ? null : Number(storageRate.toFixed(3)) },
      warn,
      days,
    }, null, 2));
  } else {
    const pct = (value) => `${(value * 100).toFixed(1)}%`;
    const fmt = (value) => Number(value ?? 0).toLocaleString('en-US');
    console.log(`D1 用量（${databaseId}）  窗口 ${options.days} 天  今日 ${today}（UTC）\n`);
    console.log(`  行读   ${fmt(todayRow.rowsRead).padStart(12)} / ${fmt(FREE_TIER.rowsReadPerDay)}   ${pct(readRate)}`);
    console.log(`  行写   ${fmt(todayRow.rowsWritten).padStart(12)} / ${fmt(FREE_TIER.rowsWrittenPerDay)}   ${pct(writeRate)}`);
    console.log(`  存储   ${storage === null ? '（无权限/无数据）' : `${fmt(storage).padStart(12)} / ${fmt(FREE_TIER.storageBytes)}   ${pct(storageRate)}`}`);
    if (days.length > 1) {
      console.log('\n  按日：');
      for (const item of days) {
        console.log(`    ${item.day}  rowsRead=${fmt(item.rowsRead).padStart(10)}  rowsWritten=${fmt(item.rowsWritten).padStart(8)}`);
      }
    }
    if (warn) {
      console.log(`\n⚠ 使用率已超 ${pct(options.warnAt)}：检查是否有接口绕过了快照/缓存，或考虑升级套餐。`);
    } else {
      console.log(`\n✓ 使用率 ${pct(worst)}（阈值 ${pct(options.warnAt)}）`);
    }
  }
  process.exit(warn ? 2 : 0);
}

main().catch((error) => {
  console.error('读取 D1 用量失败：', error?.message ?? error);
  process.exit(1);
});
