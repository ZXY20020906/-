/**
 * 把 WE 渲染产物（静帧 + 视频）上传成两个作品条目。
 *
 *   node tools/upload-captures.mjs --still shot.jpg --video shot.mp4 --title "作品名"
 *
 * 会顺手生成 640px 封面，并默认发布。
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const EMAIL = 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD ?? '';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const CACHE = resolve('.cache');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const still = opt('still', '');
const video = opt('video', '');
const title = opt('title', '');
const tags = opt('tags', '').split(',').map((s) => s.trim()).filter(Boolean);
const categoryId = opt('category', 'cat_wallpaper');

if (!title || (!still && !video)) {
  console.error('用法：--title 名称 [--still a.jpg] [--video b.mp4] [--tags 明星,动漫]');
  process.exit(2);
}

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

async function makeThumb(source, outName) {
  const target = resolve(CACHE, outName);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
    '-frames:v', '1', '-vf', 'scale=640:-1:flags=lanczos', '-q:v', '4', target]);
  return target;
}

async function publish({ file, mime, kind, itemTitle, thumbSource }) {
  const created = await fetch(`${BASE}/api/admin/wallpapers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: itemTitle, kind, categoryId, tags }),
  });
  const cj = await created.json();
  if (!created.ok) throw new Error(cj.error?.message ?? created.status);
  const id = cj.data.wallpaper.id;

  const bytes = new Uint8Array(await readFile(file));
  const up = await fetch(`${BASE}/api/admin/wallpapers/${id}/asset`, {
    method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': mime }, body: bytes,
  });
  if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);
  const meta = (await up.json()).data.wallpaper;

  const thumbPath = await makeThumb(thumbSource, `${id}-thumb.jpg`);
  const thumb = new Uint8Array(await readFile(thumbPath));
  const tp = await fetch(`${BASE}/api/admin/wallpapers/${id}/thumb`, {
    method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' }, body: thumb,
  });
  if (!tp.ok) console.warn('  封面失败', tp.status);
  await rm(thumbPath, { force: true });

  await fetch(`${BASE}/api/admin/wallpapers/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'published' }) });
  console.log(`  OK  ${meta.width}x${meta.height} · ${(meta.bytes / 1048576).toFixed(2)}MB · ${itemTitle}`);
  return id;
}

if (still) await publish({ file: still, mime: 'image/jpeg', kind: 'static', itemTitle: `${title}（静态版）`, thumbSource: still });
if (video) await publish({ file: video, mime: 'video/mp4', kind: 'dynamic', itemTitle: `${title}（动态版）`, thumbSource: video });
console.log('完成');
