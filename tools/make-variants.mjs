/**
 * 阶段二：本机把「待转码」原片转成 30fps 可播变体，上传并自动发布。
 *
 *   node tools/make-variants.mjs --id wp_xxx
 *   node tools/make-variants.mjs --all-draft [--dry-run] [--limit N]
 *
 * 环境变量：
 *   FOLIA_PASSWORD  管理员密码（必填）
 *   FOLIA_BASE      默认 https://folia-5ve.pages.dev
 *   FOLIA_EMAIL     默认 admin@folia.local
 *   FOLIA_FFMPEG    ffmpeg 可执行文件路径（默认从 PATH 找）
 *
 * 幂等：已有合规变体 ⇒ 跳过（--dry-run 也会显示「将跳过」）。
 * 发布失败会回滚变体记录，避免「半发布」。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev';
const EMAIL = process.env.FOLIA_EMAIL || 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD || '';
const FFMPEG = process.env.FOLIA_FFMPEG || 'ffmpeg';
const CRF = process.env.FOLIA_VARIANT_CRF || '23';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all-draft');
const idIndex = args.indexOf('--id');
const ONLY_ID = idIndex >= 0 ? args[idIndex + 1] : null;
const limitIndex = args.indexOf('--limit');
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) || 0 : 0;

if (!PASSWORD) { console.error('缺少 FOLIA_PASSWORD'); process.exit(1); }
if (!ALL && !ONLY_ID) { console.error('用法：--id <wallpaperId> 或 --all-draft [--dry-run] [--limit N]'); process.exit(1); }

const H = { 'x-folia-client': 'admin', accept: 'application/json' };

async function login() {
  const gate = await fetch(`${BASE}/__gate`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL, password: PASSWORD }).toString(),
  });
  let cookie = (gate.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json', cookie },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie += '; ' + (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (res.status !== 200) throw new Error(`登录失败：${res.status}`);
  return cookie;
}

const playable = (v) => v && Number(v.fps) > 0 && Number(v.fps) <= 30.1
  && Number(v.width) <= 3840 && Number(v.height) <= 2160
  && Number(v.width) * Number(v.height) <= 8_300_000;

const row = (label, value) => console.log(`  ${label.padEnd(14)}${value}`);

async function main() {
  const cookie = await login();
  const auth = { ...H, cookie };

  const listRes = await fetch(`${BASE}/api/admin/wallpapers?needsVariant=1`, { headers: auth });
  const list = (await listRes.json()).data;
  let items = list.items || [];
  if (ONLY_ID) items = items.filter((item) => item.id === ONLY_ID);
  if (LIMIT > 0) items = items.slice(0, LIMIT);
  console.log(`待转码 ${items.length} 条${DRY ? '（dry-run）' : ''}`);

  let done = 0; let skippedEmpty = 0; let processed = 0; const failed = [];
  for (const item of items) {
    const existing = (item.variants || []).filter((v) => playable(v));
    if (existing.length) {
      skippedEmpty += 1;
      console.log(`  跳过 ${item.title}（已有可播变体 ${existing.map((v) => v.label).join('/')}）`);
      continue;
    }
    if (DRY) {
      console.log(`  将处理 ${item.title} · ${item.variantReason || '?'} · ${(item.bytes / 1048576).toFixed(1)}MB`);
      continue;
    }

    const workdir = mkdtempSync(join(tmpdir(), 'folia-variant-'));
    try {
      const src = join(workdir, 'src.mp4');
      const out = join(workdir, 'out.mp4');
      const url = item.url.startsWith('http') ? item.url : BASE + item.url;
      const download = await fetch(url);
      if (!download.ok) throw new Error(`下载原片失败 ${download.status}`);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(src, Buffer.from(await download.arrayBuffer()));

      const width = Number(item.width) || 1920;
      const height = Number(item.height) || 1080;
      const scale = width > 1920 ? "fps=30,scale='min(1920,iw)':-2" : 'fps=30';
      execFileSync(FFMPEG, [
        '-y', '-i', src, '-vf', scale, '-c:v', 'libx264', '-crf', CRF, '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out,
      ], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
      const produced = readFileSync(out);
      if (!produced.length) throw new Error('ffmpeg 产物为空');
      // >100MB 不再拒绝：下面会自动走分片上传（服务端硬上限 400MB）

      const label = width > 1920 ? '1080p' : `${height}p`;
      if (produced.length > 400 * 1024 * 1024) throw new Error('变体超过 400MB 上限，请降低 crf 或分辨率');
      if (produced.length > 100 * 1024 * 1024) {
        // 超 100MB：走分片，再让服务端把 _tmp 对象转成变体
        const init = await (await fetch(`${BASE}/api/admin/uploads/init`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: 'variant.mp4', size: produced.length, contentType: 'video/mp4' }),
        })).json();
        const parts = [];
        const partSize = init.data.partSize;
        for (let i = 0; i * partSize < produced.length; i += 1) {
          const chunk = produced.subarray(i * partSize, Math.min(produced.length, (i + 1) * partSize));
          const res = await fetch(`${BASE}/api/admin/uploads/part?uploadId=${encodeURIComponent(init.data.uploadId)}&part=${i + 1}&key=${encodeURIComponent(init.data.key)}`, {
            method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: chunk,
          });
          const payload = await res.json();
          if (!payload.ok) throw new Error(`变体分片 ${i + 1} 上传失败`);
          parts.push({ partNumber: i + 1, etag: payload.data.etag });
        }
        const done2 = await (await fetch(`${BASE}/api/admin/uploads/complete`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ uploadId: init.data.uploadId, key: init.data.key, parts, meta: { wallpaperId: item.id, variantLabel: label, fps: 30, size: produced.length } }),
        })).json();
        if (!done2?.ok) throw new Error(`变体合并失败 ${JSON.stringify(done2).slice(0, 120)}`);
      } else {
        const upload = await fetch(`${BASE}/api/admin/wallpapers/${item.id}/variant?label=${encodeURIComponent(label)}&fps=30`, {
          method: 'PUT', headers: { ...auth, 'content-type': 'video/mp4' }, body: produced,
        });
        const uploaded = await upload.json().catch(() => null);
        if (!upload.ok || !uploaded?.ok) throw new Error(`上传变体失败 ${upload.status} ${JSON.stringify(uploaded).slice(0, 120)}`);
      }

      const pub = await fetch(`${BASE}/api/admin/wallpapers/${item.id}/publish`, { method: 'POST', headers: auth });
      const published = await pub.json().catch(() => null);
      if (!pub.ok || !published?.ok) {
        // 真正回滚：删掉刚写入的变体记录（含 R2 引用），不留半发布
        await fetch(`${BASE}/api/admin/wallpapers/${item.id}/variant?label=${encodeURIComponent(label)}`, {
          method: 'DELETE', headers: auth,
        }).catch(() => {});
        throw new Error(`发布失败 ${pub.status} ${JSON.stringify(published).slice(0, 120)}`);
      }
      done += 1;
      processed += 1;
      console.log(`  ✓ ${item.title} → ${label} 30fps · ${(produced.length / 1048576).toFixed(1)}MB · published`);
    } catch (error) {
      failed.push({ title: item.title, reason: error.message });
      console.log(`  ✗ ${item.title}：${error.message}`);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  console.log('\n汇总');
  row('待转码', String(items.length));
  row('处理', String(done));
  row('跳过', String(skippedEmpty));
  row('失败', String(failed.length));
  for (const item of failed) console.log(`  - ${item.title}：${item.reason}`);
}

main().catch((error) => { console.error('make-variants 失败：', error.message); process.exit(1); });
