/**
 * 清理分片上传的遗留临时对象（`_tmp/uploads/` 下超过 24 小时的）。
 *
 *   FOLIA_PASSWORD=... node tools/cleanup-orphan-uploads.mjs [--dry-run]
 *   FOLIA_SESSION_COOKIE='folia_session=…; folia_device=…' node tools/cleanup-orphan-uploads.mjs --dry-run
 *
 * `--dry-run` 现在会**真的列一遍**会被删掉的对象（服务端 `?dryRun=1`），而不是只做个登录检查 ——
 * 「先看清楚再删」才是预演的意义。
 *
 * 两种认证方式：
 *   · FOLIA_PASSWORD：脚本自己走 `/__gate` + `/api/auth/login`（日常用这个）；
 *   · FOLIA_SESSION_COOKIE：直接给一枚已登录的 Cookie（CI / 临时会话用，免去在机器上存密码）。
 */
const BASE = process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev';
const EMAIL = process.env.FOLIA_EMAIL || 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD || '';
const SESSION_COOKIE = process.env.FOLIA_SESSION_COOKIE || '';
const DRY_RUN = process.argv.includes('--dry-run');

if (!PASSWORD && !SESSION_COOKIE) {
  console.error('缺少 FOLIA_PASSWORD（管理员密码）或 FOLIA_SESSION_COOKIE（已登录 Cookie）');
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

const cookie = SESSION_COOKIE || await login();

// 预演：`?dryRun=1` 让服务端只列不删
const res = await fetch(`${BASE}/api/admin/uploads/cleanup${DRY_RUN ? '?dryRun=1' : ''}`, {
  method: 'POST',
  headers: { ...HEAD, cookie },
});
const payload = await res.json().catch(() => null);
if (!res.ok || !payload?.ok) {
  console.error('清理失败：', res.status, JSON.stringify(payload).slice(0, 300));
  process.exit(1);
}
const data = payload.data;
if (DRY_RUN) {
  console.log(`dry-run：扫描 ${data.scanned} 个临时对象，**会删除** ${data.wouldDelete?.length ?? 0} 个（本次未删任何对象）`);
  for (const item of (data.wouldDelete ?? []).slice(0, 20)) console.log(`  - ${item.key}（上传于 ${item.uploaded ?? '未知'}）`);
  if ((data.wouldDelete?.length ?? 0) > 20) console.log(`  …还有 ${data.wouldDelete.length - 20} 个`);
  process.exit(0);
}
console.log(`扫描 ${data.scanned} 个临时对象，删除 ${data.deleted} 个`);
if (data.failed?.length) {
  console.warn('部分删除失败：', data.failed.slice(0, 5));
}
