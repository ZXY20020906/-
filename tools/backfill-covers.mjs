/**
 * 给已有作品补封面。
 *
 *   node tools/backfill-covers.mjs [workshop目录]
 *
 * 规则：
 *   - WE 工程包（title 以「（WE 工程包）」结尾）→ 用源目录里的 preview.jpg/gif 当封面
 *   - 视频 → 用 ffmpeg 抽第 2 秒的一帧
 *   - 已经有封面（thumbUrl ≠ url）的跳过
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const EMAIL = 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD ?? '';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const CACHE = resolve('.cache');
const WE_ROOT = resolve(process.argv[2] || 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960');

await mkdir(CACHE, { recursive: true });

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';

const list = await (await fetch(`${BASE}/api/admin/wallpapers?limit=300`, { headers: { cookie } })).json();
const items = list.data.items.filter((item) => item.hasAsset && item.thumbUrl === item.url);
console.log(`需要补封面 ${items.length} 条`);

// 建立「标题 → 源目录」映射
const titleToDir = new Map();
for (const dir of (await readdir(WE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory())) {
  const dirPath = join(WE_ROOT, dir.name);
  try {
    const meta = JSON.parse(await readFile(join(dirPath, 'project.json'), 'utf8'));
    if (meta.title) titleToDir.set(String(meta.title).slice(0, 100), dirPath);
  } catch { /* 没有 project.json 就跳过 */ }
}

async function uploadThumb(id, bytes, mime) {
  const res = await fetch(`${BASE}/api/admin/wallpapers/${id}/thumb`, {
    method: 'PUT',
    headers: { 'x-folia-client': 'admin', cookie, 'content-type': mime },
    body: bytes,
  });
  if (!res.ok) throw new Error((await res.json()).error?.message ?? res.status);
}

async function frameFromVideo(item) {
  const videoPath = join(CACHE, 'cover-src.mp4');
  const framePath = join(CACHE, 'cover.jpg');
  const res = await fetch(BASE + item.url);
  if (!res.ok) throw new Error(`下载视频失败 ${res.status}`);
  await writeFile(videoPath, new Uint8Array(await res.arrayBuffer()));
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '2', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-1', '-q:v', '3', framePath]);
  const bytes = await readFile(framePath);
  await rm(videoPath, { force: true });
  await rm(framePath, { force: true });
  return bytes;
}

let ok = 0;
let skipped = 0;

for (const item of items) {
  const baseTitle = item.title.replace(/（WE 工程包）$/, '');
  try {
    if (item.mime === 'application/zip') {
      const dirPath = titleToDir.get(baseTitle);
      if (!dirPath) { console.log(`跳过（找不到源目录）：${baseTitle.slice(0, 28)}`); skipped += 1; continue; }
      const files = await readdir(dirPath);
      const preview = files.find((f) => /^preview\.(jpe?g|png|gif)$/i.test(f));
      if (!preview) { console.log(`跳过（没有 preview）：${baseTitle.slice(0, 28)}`); skipped += 1; continue; }
      const mime = /\.gif$/i.test(preview) ? 'image/gif' : /\.png$/i.test(preview) ? 'image/png' : 'image/jpeg';
      await uploadThumb(item.id, await readFile(join(dirPath, preview)), mime);
      console.log(`OK  预览图  ${baseTitle.slice(0, 30)}`);
      ok += 1;
    } else if (item.mime?.startsWith('video/')) {
      await uploadThumb(item.id, await frameFromVideo(item), 'image/jpeg');
      console.log(`OK  抽帧    ${item.title.slice(0, 30)}`);
      ok += 1;
    } else {
      skipped += 1;
    }
  } catch (error) {
    console.log(`FAIL ${item.title.slice(0, 28)}  ${error.message}`);
    skipped += 1;
  }
}

console.log(`\n完成：补上 ${ok} 个封面，跳过 ${skipped}`);
