/**
 * 把 RePKG 挖出来的静图批量上传成「静态版」作品。
 *
 *   node tools/upload-stills.mjs
 *
 * 读 build/stills.json（pkg2stills.mjs 产出），
 * 标题取 workshop 的 project.json，标签做一次映射，默认发布。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const EMAIL = 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD ?? '';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const WE_ROOT = 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const BUILD = resolve('build');
const CATEGORY_ID = 'cat_wallpaper';
const TAG_MAP = { Anime: '动漫', Game: '游戏', Girls: '明星', Fantasy: '自然风景', Nature: '自然风景' };

const stills = JSON.parse(await readFile(join(BUILD, 'stills.json'), 'utf8'));

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

const existing = await (await fetch(`${BASE}/api/admin/wallpapers?limit=300`, { headers: { cookie } })).json();
const known = new Set(existing.data.items.map((item) => item.title));
console.log(`库里有 ${existing.data.total} 条，待传 ${stills.length} 张静图`);

let ok = 0;
let skipped = 0;
let failed = 0;

for (const still of stills) {
  const title = `${still.title.replace(/\s+/g, ' ').trim()}（静态版）`.slice(0, 120);
  if (known.has(title)) { console.log(`  跳过（已存在）${title.slice(0, 34)}`); skipped += 1; continue; }

  let tags = [];
  try {
    const meta = JSON.parse(await readFile(join(WE_ROOT, still.id, 'project.json'), 'utf8'));
    tags = [...new Set((meta.tags ?? []).map((t) => TAG_MAP[t]).filter(Boolean))];
  } catch { /* 没 tags 就算了 */ }

  try {
    const created = await fetch(`${BASE}/api/admin/wallpapers`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title, kind: 'static', categoryId: CATEGORY_ID, tags }),
    });
    const cj = await created.json();
    if (!created.ok) throw new Error(cj.error?.message ?? created.status);
    const id = cj.data.wallpaper.id;

    const bytes = new Uint8Array(await readFile(still.path));
    const up = await fetch(`${BASE}/api/admin/wallpapers/${id}/asset`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' }, body: bytes,
    });
    if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);

    // 封面 640px
    const thumbPath = join(BUILD, `${id}-thumb.jpg`);
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', still.path,
      '-vf', 'scale=640:-1:flags=lanczos', '-q:v', '4', thumbPath]);
    const thumb = new Uint8Array(await readFile(thumbPath));
    await fetch(`${BASE}/api/admin/wallpapers/${id}/thumb`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'image/jpeg' }, body: thumb,
    });
    await rm(thumbPath, { force: true });

    await fetch(`${BASE}/api/admin/wallpapers/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'published' }) });
    known.add(title);
    ok += 1;
    console.log(`  OK  ${still.width}x${still.height}  ${(still.bytes / 1048576).toFixed(1)}MB  ${title.slice(0, 36)}`);
  } catch (error) {
    console.log(`  FAIL ${title.slice(0, 30)}  ${error.message}`);
    failed += 1;
  }
}

console.log(`\n完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
