#!/usr/bin/env node
/**
 * 线上公开 API 冒烟脚本 —— **每次部署后跑一次**。
 *
 * 2026-11-05 事故：14:38 部署后公开接口还正常，晚上 D1 免费额度耗尽，6 个端点
 * 全部 500，而本地 312 个测试全绿（它们跑在 sqlite 夹具上，不碰线上配额）。
 * 这个脚本只打线上，检查「状态码 + 条目数 + facets 自洽 + manifest 304」，
 * 部署流水线/人工都能在 10 秒内发现同类回归。
 *
 * 用法：
 *   node tools/smoke-public-api.mjs
 *   node tools/smoke-public-api.mjs --base https://folia-5ve.pages.dev
 *   node tools/smoke-public-api.mjs --allow-degraded   # D1 额度耗尽、快照兜底时也通过
 *
 * 退出码：0 全绿；1 有失败项。
 */
import { argv, exit } from 'node:process';

/**
 * 期望条数：**默认从 D1 现算**（线上真值），只有拿不到凭据时才退回环境变量。
 *
 * 为什么改：原来把 110 / 46 写死在默认值里，线上每多发一条素材，这个门禁就红一次，
 * 红到最后大家都学会了「反正它老红」——门禁一旦可以忽略，就等于没有。
 * 现在拿 D1 里与公开接口**同一条谓词**的结果当期望值，红只可能是因为接口和库不一致。
 */
const PUBLIC_WHERE = `
  w.status = 'published' AND w.storage_key IS NOT NULL AND w.verified_at IS NOT NULL
  AND w.review_status = 'approved' AND c.is_public = 1
`;

async function expectedFromD1() {
  const accountId = process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CF_D1_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId || !databaseId || !token) return null;
  const query = async (sql) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params: [] }),
    });
    const body = await response.json().catch(() => ({}));
    if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors ?? body).slice(0, 160)}`);
    return body.result?.[0]?.results?.[0] ?? {};
  };
  const total = await query(`SELECT COUNT(*) AS n FROM wallpapers w JOIN categories c ON c.id = w.category_id WHERE ${PUBLIC_WHERE}`);
  const wallpaper = await query(`SELECT COUNT(*) AS n FROM wallpapers w JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_WHERE} AND c.slug = 'wallpaper'`);
  return { total: Number(total.n ?? 0), wallpaper: Number(wallpaper.n ?? 0) };
}

function parseArgs(args) {
  const options = {
    base: process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev',
    allowDegraded: false,
    // null = 还没定；先看命令行，再看环境变量，最后从 D1 现算
    expectedTotal: process.env.EXPECTED_TOTAL ? Number(process.env.EXPECTED_TOTAL) : null,
    expectedWallpaper: process.env.EXPECTED_WALLPAPER ? Number(process.env.EXPECTED_WALLPAPER) : null,
    timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS || 15000),
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--base') options.base = args[++i] ?? options.base;
    else if (arg === '--allow-degraded') options.allowDegraded = true;
    else if (arg === '--expected-total') options.expectedTotal = Number(args[++i]);
    else if (arg === '--expected-wallpaper') options.expectedWallpaper = Number(args[++i]);
    else if (arg === '--timeout') options.timeoutMs = Number(args[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/smoke-public-api.mjs [--base URL] [--allow-degraded] [--expected-total 110] [--expected-wallpaper 46] [--timeout 15000]');
      exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  options.base = String(options.base).replace(/\/+$/, '');
  return options;
}

const options = parseArgs(argv.slice(2));
const failures = [];
const results = [];

// 期望条数优先级：命令行 / 环境变量 > D1 现算 > 拿不到凭据就用线上当前值（并明确标注）
if (options.expectedTotal === null || options.expectedWallpaper === null) {
  let derived = null;
  try {
    derived = await expectedFromD1();
  } catch (error) {
    console.warn(`[smoke] 从 D1 取期望值失败（跳过）：${error.message}`);
  }
  if (derived) {
    if (options.expectedTotal === null) options.expectedTotal = derived.total;
    if (options.expectedWallpaper === null) options.expectedWallpaper = derived.wallpaper;
    options.expectFrom = 'd1';
  }
}
if (options.expectedTotal === null || options.expectedWallpaper === null) {
  // 没有 D1 凭据：拿线上当前值当基线（只验"自洽"，不验"条数没变"，并在输出里写明）
  const probe = await fetch(`${options.base}/api/v1/public/wallpapers?limit=1`, { signal: AbortSignal.timeout(options.timeoutMs) });
  const body = await probe.json().catch(() => null);
  const cat = await fetch(`${options.base}/api/v1/public/wallpapers?category=wallpaper&limit=1`, { signal: AbortSignal.timeout(options.timeoutMs) });
  const catBody = await cat.json().catch(() => null);
  if (options.expectedTotal === null) options.expectedTotal = Number(body?.data?.total ?? 0);
  if (options.expectedWallpaper === null) options.expectedWallpaper = Number(catBody?.data?.total ?? 0);
  options.expectFrom = 'live';
}

function ok(name, detail) {
  results.push({ name, status: 'PASS', detail });
}

function fail(name, detail) {
  failures.push({ name, detail });
  results.push({ name, status: 'FAIL', detail });
}

async function request(path, init = {}) {
  const url = `${options.base}${path}`;
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { url, response, status: response.status, headers: response.headers, text, body };
}

function isDegraded(payload) {
  return payload?.data?.degraded === true || payload?.degraded === true;
}

function checkDegraded(label, payload) {
  if (!isDegraded(payload)) return true;
  if (options.allowDegraded) {
    ok(`${label} · 降级快照`, `D1 不可用，快照 generatedAt=${payload.data?.snapshotGeneratedAt ?? payload.snapshotGeneratedAt}`);
    return true;
  }
  fail(`${label} · 降级快照`, '返回的是快照而不是 D1 实时数据（加 --allow-degraded 可放行）');
  return false;
}

function snippet(text, max = 160) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function checkList(label, path) {
  const res = await request(path);
  if (res.status !== 200) return fail(label, `HTTP ${res.status}: ${snippet(res.text)}`);
  if (res.body?.ok !== true || !Array.isArray(res.body?.data?.items)) return fail(label, `形状不对: ${snippet(res.text)}`);
  const data = res.body.data;
  if (data.total !== options.expectedTotal) return fail(label, `total=${data.total}，期望 ${options.expectedTotal}`);
  if (data.items.length > 100) return fail(label, `items=${data.items.length} 超过 limit 上限`);
  const facetTotal = (data.facets?.categories ?? []).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  if (facetTotal !== data.total) return fail(label, `facets.categories 合计=${facetTotal} != total=${data.total}`);
  if (!checkDegraded(label, res.body)) return;
  ok(label, `HTTP 200 · total=${data.total} · items=${data.items.length} · facetSum=${facetTotal} · edge=${res.headers.get('x-folia-edge') ?? '-'}`);
  return res;
}

async function main() {
  console.log(`Folia public API smoke → ${options.base}`);
  console.log(`expect total=${options.expectedTotal} wallpaper=${options.expectedWallpaper} allowDegraded=${options.allowDegraded} 来源=${options.expectFrom ?? '命令行/环境变量'}\n`);

  // 1) 旧路径清单
  const legacy = await checkList('/api/public/wallpapers · 旧路径', '/api/public/wallpapers?limit=100');
  // 2) v1 清单
  const v1 = await checkList('/api/v1/public/wallpapers · v1', '/api/v1/public/wallpapers?limit=100');

  // 3) 旧路径 == v1（同一条请求逐字节相同，事故时这条能直接指向「两个壳分叉」）
  if (legacy?.body && v1?.body) {
    const legacyText = JSON.stringify(legacy.body);
    const v1Text = JSON.stringify(v1.body);
    if (legacyText === v1Text) ok('/api/public/* == /api/v1/public/*', '响应体逐字节相同');
    else fail('/api/public/* == /api/v1/public/*', '旧路径与 v1 响应体不一致');
  }

  // 4) wallpaper 分类 46 条（插件默认模块）
  const wallpaper = await request(`/api/v1/public/wallpapers?category=wallpaper&limit=100`);
  if (wallpaper.status !== 200) fail('/wallpapers?category=wallpaper', `HTTP ${wallpaper.status}: ${snippet(wallpaper.text)}`);
  else if (wallpaper.body?.data?.total !== options.expectedWallpaper) fail('/wallpapers?category=wallpaper', `total=${wallpaper.body?.data?.total}，期望 ${options.expectedWallpaper}`);
  else if (!checkDegraded('/wallpapers?category=wallpaper', wallpaper.body)) { /* 已在 checkDegraded 记 fail */ }
  else ok('/wallpapers?category=wallpaper', `HTTP 200 · total=${wallpaper.body.data.total} · items=${wallpaper.body.data.items.length}`);

  // 5) 分类 / 6) 标签
  for (const [label, path, key] of [
    ['/api/public/categories', '/api/public/categories', 'categories'],
    ['/api/public/tags', '/api/public/tags', 'tags'],
  ]) {
    const res = await request(path);
    if (res.status !== 200) { fail(label, `HTTP ${res.status}: ${snippet(res.text)}`); continue; }
    if (!Array.isArray(res.body?.data?.[key])) { fail(label, `缺 data.${key}: ${snippet(res.text)}`); continue; }
    if (!checkDegraded(label, res.body)) continue;
    ok(label, `HTTP 200 · ${key}=${res.body.data[key].length} · edge=${res.headers.get('x-folia-edge') ?? '-'}`);
  }

  // 7) manifest + ETag/304
  const manifest = await request('/api/v1/public/manifest.json');
  if (manifest.status !== 200) fail('/api/v1/public/manifest.json', `HTTP ${manifest.status}: ${snippet(manifest.text)}`);
  else if (manifest.body?.total !== options.expectedTotal) fail('/api/v1/public/manifest.json', `total=${manifest.body?.total}，期望 ${options.expectedTotal}`);
  else if (manifest.body?.items?.length !== options.expectedTotal) fail('/api/v1/public/manifest.json', `items=${manifest.body?.items?.length}，期望 ${options.expectedTotal}`);
  else if (!checkDegraded('/api/v1/public/manifest.json', manifest.body)) { /* 已记 fail */ }
  else {
    ok('/api/v1/public/manifest.json', `HTTP 200 · total=${manifest.body.total} · items=${manifest.body.items.length} · etag=${manifest.headers.get('etag')}`);
    const etag = manifest.headers.get('etag');
    if (!etag) fail('manifest ETag/304', '响应没有 ETag');
    else {
      const conditional = await request('/api/v1/public/manifest.json', { headers: { 'if-none-match': etag } });
      if (conditional.status === 304 && conditional.text === '') ok('manifest ETag/304', 'HTTP 304 · 空 body');
      else fail('manifest ETag/304', `期望 304/空 body，实际 ${conditional.status}/${snippet(conditional.text, 80)}`);
    }
  }

  // 8) 详情：用清单里第一条的 slug
  const slug = legacy?.body?.data?.items?.[0]?.slug ?? v1?.body?.data?.items?.[0]?.slug;
  if (!slug) fail('/wallpapers/:slug', '清单里没有 slug，无法验详情');
  else {
    const detail = await request(`/api/v1/public/wallpapers/${encodeURIComponent(slug)}`);
    if (detail.status !== 200) fail('/wallpapers/:slug', `HTTP ${detail.status}: ${snippet(detail.text)}`);
    else if (detail.body?.data?.wallpaper?.slug !== slug) fail('/wallpapers/:slug', `slug 不匹配: ${snippet(detail.text)}`);
    else if (!checkDegraded('/wallpapers/:slug', detail.body)) { /* 已记 fail */ }
    else ok('/wallpapers/:slug', `HTTP 200 · slug=${slug}`);
  }

  console.log('结果：');
  for (const item of results) {
    console.log(`  ${item.status === 'PASS' ? '✔' : '✘'} ${item.name} — ${item.detail}`);
  }
  console.log(`\n${results.filter((item) => item.status === 'PASS').length}/${results.length} 通过，失败 ${failures.length}`);
  if (failures.length) {
    console.error('\n失败项：');
    for (const item of failures) console.error(`  - ${item.name}: ${item.detail}`);
    exit(1);
  }
  console.log('\nSMOKE OK');
}

main().catch((error) => {
  console.error('SMOKE CRASH:', error?.stack ?? error?.message ?? error);
  exit(1);
});
