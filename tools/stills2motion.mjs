/**
 * 把 RePKG 挖出的静图做成「缓慢推近」的动态壁纸，并上传成（动态版）。
 *
 *   node tools/stills2motion.mjs
 *
 * 为什么这么做：scene 包里的动态元素（粒子/视差）没法从 .pkg 复原，
 * 但插件只认 video/*。用静图做 12 秒缓慢推近，既保留 4K 画质，
 * 又能让插件当视频播放。这不是原版动效，属于「可用的折中」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const EMAIL = 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD ?? '';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const BUILD = resolve('build');
const DYN = join(BUILD, 'dyn');
const WE_ROOT = 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const CATEGORY_ID = 'cat_wallpaper';
const TAG_MAP = { Anime: '动漫', Game: '游戏', Girls: '明星', Fantasy: '自然风景', Nature: '自然风景', Landscape: '自然风景' };
const SECONDS = 12;
const FPS = 30;
const SIZE = '2560x1440';

await mkdir(DYN, { recursive: true });
const stills = JSON.parse(await readFile(join(BUILD, 'stills.json'), 'utf8'));

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

const existing = await (await fetch(`${BASE}/api/admin/wallpapers?limit=300`, { headers: { cookie } })).json();
const known = new Set(existing.data.items.map((item) => item.title));

let ok = 0;
let skipped = 0;
let failed = 0;

for (const still of stills) {
  const baseTitle = still.title.replace(/\s+/g, ' ').trim();
  const title = `${baseTitle}（动态版）`.slice(0, 120);
  if (known.has(title)) { console.log(`  跳过（已有）${baseTitle.slice(0, 30)}`); skipped += 1; continue; }

  const videoPath = join(DYN, `${still.id}.mp4`);
  try {
    if (!existsSync(videoPath)) {
      const frames = SECONDS * FPS;
      execFileSync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-loop', '1', '-i', still.path,
        '-vf', `zoompan=z='min(1.0+${(0.12 / frames).toFixed(8)}*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${SIZE}:fps=${FPS}`,
        '-frames:v', String(frames),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', videoPath,
      ], { stdio: 'ignore' });
    }

    let tags = [];
    try {
      const meta = JSON.parse(await readFile(join(WE_ROOT, still.id, 'project.json'), 'utf8'));
      tags = [...new Set((meta.tags ?? []).map((t) => TAG_MAP[t]).filter(Boolean))];
    } catch { /* 忽略 */ }

    const created = await fetch(`${BASE}/api/admin/wallpapers`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title, kind: 'dynamic', categoryId: CATEGORY_ID, tags }),
    });
    const cj = await created.json();
    if (!created.ok) throw new Error(cj.error?.message ?? created.status);
    const id = cj.data.wallpaper.id;

    const up = await fetch(`${BASE}/api/admin/wallpapers/${id}/asset`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'video/mp4' },
      body: new Uint8Array(await readFile(videoPath)),
    });
    if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);
    const meta = (await up.json()).data.wallpaper;

    const thumbPath = join(DYN, `${still.id}-thumb.jpg`);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', still.path,
      '-vf', 'scale=640:-1', '-q:v', '4', thumbPath]);
    await fetch(`${BASE}/api/admin/wallpapers/${id}/thumb`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(await readFile(thumbPath)),
    });
    await rm(thumbPath, { force: true });

    await fetch(`${BASE}/api/admin/wallpapers/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'published' }) });
    known.add(title);
    ok += 1;
    console.log(`  OK  ${meta.width}x${meta.height} ${(meta.bytes / 1048576).toFixed(1)}MB  ${baseTitle.slice(0, 32)}`);
  } catch (error) {
    console.log(`  FAIL ${baseTitle.slice(0, 28)}  ${error.message}`);
    failed += 1;
  }
}

console.log(`\n完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
