/**
 * 把实拍视频替换成「单帧 + 缓慢推近」的流畅版本。
 *
 *   node tools/refix-captures.mjs
 *
 * 为什么要换：抓屏只能抓到 ~10fps（720 帧里 600 多帧是重复的），
 * 在 60fps 容器里就是一卡一卡。合成推近是严格 30fps，绝不掉帧；
 * 画面仍是这次真实渲染出来的那一帧，所以构图是对的。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const CAP = resolve('build', 'cap');
const TMP = resolve('build', 'refix');
const SECONDS = 12;
const FPS = 30;
const SIZE = '2560x1440';
/** 取第 6 秒：作者提示卡一般 5 秒后消失 */
const FRAME_AT = 6;

await mkdir(TMP, { recursive: true });
const manifest = JSON.parse((await readFile(join(CAP, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, ''));

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'admin@folia.local', password: process.env.FOLIA_PASSWORD ?? '' }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

const list = await (await fetch(`${BASE}/api/admin/wallpapers?limit=300`, { headers: { cookie } })).json();
const norm = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 40);

let ok = 0;
let failed = 0;

for (const entry of manifest) {
  const base = norm(entry.title);
  const target = list.data.items.find((i) => norm(i.title).startsWith(base) && i.title.includes('（动态版）'));
  if (!target) { console.log(`  跳过（站上没找到）${base.slice(0, 28)}`); failed += 1; continue; }

  const frame = join(TMP, `${entry.id}.jpg`);
  const video = join(TMP, `${entry.id}.mp4`);
  const thumb = join(TMP, `${entry.id}-thumb.jpg`);
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(FRAME_AT), '-i', entry.mp4,
      '-frames:v', '1', '-q:v', '2', frame]);
    const frames = SECONDS * FPS;
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', frame,
      '-vf', `zoompan=z='min(1.0+${(0.12 / frames).toFixed(8)}*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${SIZE}:fps=${FPS}`,
      '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], { stdio: 'ignore' });
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', frame, '-vf', 'scale=640:-1', '-q:v', '4', thumb]);

    const up = await fetch(`${BASE}/api/admin/wallpapers/${target.id}/asset`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'video/mp4' },
      body: new Uint8Array(await readFile(video)),
    });
    if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);
    const meta = (await up.json()).data.wallpaper;

    await fetch(`${BASE}/api/admin/wallpapers/${target.id}/thumb`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' },
      body: new Uint8Array(await readFile(thumb)),
    });

    await rm(frame, { force: true });
    await rm(video, { force: true });
    await rm(thumb, { force: true });
    ok += 1;
    console.log(`  OK  ${meta.width}x${meta.height} ${(meta.bytes / 1048576).toFixed(1)}MB  ${base.slice(0, 30)}`);
  } catch (error) {
    console.log(`  FAIL ${base.slice(0, 26)}  ${error.message}`);
    failed += 1;
  }
}

console.log(`\n完成：替换 ${ok}，失败 ${failed}`);
