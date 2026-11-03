/**
 * 对账：逐条 HEAD 线上媒体，找出「D1 有、R2 没有 / 大小不符 / 未校验」的记录。
 *
 *   node tools/reconcile.mjs            # 只报告
 *   node tools/reconcile.mjs --apply    # 额外生成 reconcile.sql（再用 wrangler 执行）
 *
 * 需要环境变量：FOLIA_PASSWORD（管理员密码）
 * 可选：FOLIA_EMAIL（默认 admin@folia.local）、FOLIA_BASE（默认 https://folia-5ve.pages.dev）
 *
 * 产出的 SQL 做三件事：
 *   · 对象缺失 → status='hidden' + missing_reason='object-missing'
 *   · 大小不符 → bytes=<真实大小> + verified_at=now
 *   · 校验通过 → verified_at=now
 */
import { writeFileSync } from 'node:fs';

const BASE = process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev';
const EMAIL = process.env.FOLIA_EMAIL || 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD || '';
const APPLY = process.argv.includes('--apply');

if (!PASSWORD) {
  console.error('缺少 FOLIA_PASSWORD（管理员密码）');
  process.exit(1);
}

const HEAD = { 'x-folia-client': 'admin', accept: 'application/json' };

async function login() {
  const gate = await fetch(`${BASE}/__gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  let cookie = (gate.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { ...HEAD, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie += '; ' + (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (res.status !== 200) throw new Error(`登录失败：${res.status}`);
  return cookie;
}

async function listAll(cookie) {
  const items = [];
  for (let offset = 0; ; offset += 200) {
    const res = await fetch(`${BASE}/api/admin/wallpapers?limit=200&offset=${offset}`, {
      headers: { ...HEAD, cookie },
    });
    const data = (await res.json()).data;
    items.push(...data.items);
    if (offset + 200 >= data.total) break;
  }
  return items;
}

const cookie = await login();
const items = await listAll(cookie);
console.log(`共 ${items.length} 条，逐条 HEAD …`);

const missing = [];
const mismatch = [];
const ok = [];
const skipped = [];

for (const item of items) {
  if (!item.url) {
    skipped.push(item);
    continue;
  }
  const url = item.url.startsWith('http') ? item.url : `${BASE}${item.url}`;
  let res;
  try {
    res = await fetch(url, { method: 'HEAD' });
  } catch (error) {
    missing.push({ ...item, reason: `HEAD 失败：${error.message}` });
    continue;
  }
  if (res.status === 404) {
    missing.push({ ...item, reason: '404' });
    continue;
  }
  if (res.status !== 200) {
    missing.push({ ...item, reason: `HTTP ${res.status}` });
    continue;
  }
  const size = Number(res.headers.get('content-length') || 0);
  if (size && Number(item.bytes) !== size) mismatch.push({ ...item, realSize: size });
  else ok.push(item);
}

console.log(`\n检查 ${items.length}：正常 ${ok.length}，大小不符 ${mismatch.length}，缺失 ${missing.length}，跳 ${skipped.length}`);
for (const row of missing.slice(0, 10)) console.log('  缺失', row.slug, row.reason);
for (const row of mismatch.slice(0, 10)) console.log('  大小', row.slug, `${row.bytes} → ${row.realSize}`);

if (APPLY) {
  const now = Date.now();
  const lines = [];
  for (const row of missing) {
    lines.push(`UPDATE wallpapers SET status='hidden', missing_reason='object-missing', verified_at=NULL WHERE id='${row.id}';`);
  }
  for (const row of mismatch) {
    lines.push(`UPDATE wallpapers SET bytes=${row.realSize}, verified_at=${now}, missing_reason=NULL WHERE id='${row.id}';`);
  }
  for (const row of ok) {
    lines.push(`UPDATE wallpapers SET verified_at=${now}, missing_reason=NULL WHERE id='${row.id}';`);
  }
  writeFileSync('reconcile.sql', lines.join('\n'), 'utf8');
  console.log('\n已生成 reconcile.sql，执行：');
  console.log('  npx wrangler d1 execute folia --remote --file=./reconcile.sql --yes');
}
