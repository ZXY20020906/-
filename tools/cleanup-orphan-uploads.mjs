/**
 * 清理分片上传的遗留临时对象（`_tmp/uploads/` 下超过 24 小时的）。
 *
 *   FOLIA_PASSWORD=... node tools/cleanup-orphan-uploads.mjs [--dry-run]
 *
 * Worker 里没法跑定时任务，所以由本脚本或 CI 定时调用
 * `POST /api/admin/uploads/cleanup`（服务端按 uploaded 时间过滤）。
 */
const BASE = process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev';
const EMAIL = process.env.FOLIA_EMAIL || 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD || '';
const DRY_RUN = process.argv.includes('--dry-run');

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

const cookie = await login();
if (DRY_RUN) {
  console.log('dry-run：只做登录检查，不调用清理接口');
  process.exit(0);
}

const res = await fetch(`${BASE}/api/admin/uploads/cleanup`, {
  method: 'POST',
  headers: { ...HEAD, cookie },
});
const payload = await res.json().catch(() => null);
if (!res.ok || !payload?.ok) {
  console.error('清理失败：', res.status, JSON.stringify(payload).slice(0, 300));
  process.exit(1);
}
console.log(`扫描 ${payload.data.scanned} 个临时对象，删除 ${payload.data.deleted} 个`);
if (payload.data.failed?.length) {
  console.warn('部分删除失败：', payload.data.failed.slice(0, 5));
}
