/**
 * 上传实拍结果：每个作品一条（动态版），封面取视频帧。
 *
 *   node tools/upload-captures-batch.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const CAP = resolve('build', 'cap');
const WE_ROOT = 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const TAG_MAP = { Anime: '动漫', Game: '游戏', Girls: '明星', Fantasy: '自然风景', Nature: '自然风景', Landscape: '自然风景' };

// 第 5 条前几秒有作者提示卡，封面往后取
const THUMB_AT = { 3470764447: 8 };

const manifest = JSON.parse(await readFile(join(CAP, 'manifest.json'), 'utf8').then((t) => t.replace(/^\uFEFF/, '')));

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'admin@folia.local', password: process.env.FOLIA_PASSWORD ?? '' }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

const existing = await (await fetch(`${BASE}/api/admin/wallpapers?limit=300`, { headers: { cookie } })).json();
const known = new Set(existing.data.items.map((i) => i.title));

let ok = 0;
let skipped = 0;
let failed = 0;

for (const item of manifest) {
  const title = `${item.title.replace(/\s+/g, ' ').trim()}（动态版）`.slice(0, 120);
  if (known.has(title)) { console.log(`  跳过（已存在）${title.slice(0, 30)}`); skipped += 1; continue; }

  let tags = [];
  try {
    const meta = JSON.parse(await readFile(join(WE_ROOT, item.id, 'project.json'), 'utf8'));
    tags = [...new Set((meta.tags ?? []).map((t) => TAG_MAP[t]).filter(Boolean))];
  } catch { /* 忽略 */ }

  try {
    const created = await fetch(`${BASE}/api/admin/wallpapers`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title, kind: 'dynamic', categoryId: 'cat_wallpaper', tags }),
    });
    const cj = await created.json();
    if (!created.ok) throw new Error(cj.error?.message ?? created.status);
    const id = cj.data.wallpaper.id;

    const up = await fetch(`${BASE}/api/admin/wallpapers/${id}/asset`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'video/mp4' },
      body: new Uint8Array(await readFile(item.mp4)),
    });
    if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);
    const meta = (await up.json()).data.wallpaper;

    const thumbPath = join(CAP, `${item.id}-thumb.jpg`);
    const at = THUMB_AT[item.id] ?? 2;
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(at), '-i', item.mp4,
      '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '4', thumbPath]);
    await fetch(`${BASE}/api/admin/wallpapers/${id}/thumb`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(await readFile(thumbPath)),
    });
    await rm(thumbPath, { force: true });

    await fetch(`${BASE}/api/admin/wallpapers/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'published' }) });
    known.add(title);
    ok += 1;
    console.log(`  OK  ${meta.width}x${meta.height} ${(meta.bytes / 1048576).toFixed(1)}MB  ${title.slice(0, 34)}`);
  } catch (error) {
    console.log(`  FAIL ${title.slice(0, 28)}  ${error.message}`);
    failed += 1;
  }
}

console.log(`\n完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
