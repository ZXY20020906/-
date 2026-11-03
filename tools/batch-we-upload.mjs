/**
 * 批量把 Wallpaper Engine 的 scene 作品打包上传成「资源包」草稿。
 *
 *   node tools/batch-we-upload.mjs "D:\SteamLibrary\steamapps\workshop\content\431960"
 *
 * 只处理带 scene.pkg 的目录；zip 超过接口上限（88MB）的会跳过并记下来。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const BASE = 'https://folia-5ve.pages.dev';
const EMAIL = 'admin@folia.local';
const PASSWORD = process.env.FOLIA_PASSWORD ?? '';
const LIMIT = 88 * 1024 * 1024;
const CATEGORY_ID = 'cat_wallpaper';
const TAG_MAP = { Anime: '动漫', Game: '游戏', Girls: '明星', Fantasy: '自然风景' };

const root = resolve(process.argv[2] || 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960');
const cacheDir = resolve('.cache');
await mkdir(cacheDir, { recursive: true });
const tmpZip = join(cacheDir, 'batch-tmp.zip');

const H = { 'content-type': 'application/json', 'x-folia-client': 'admin' };
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
if (!login.ok) throw new Error(`登录失败 ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
const auth = { ...H, cookie };

const existing = await (await fetch(`${BASE}/api/admin/wallpapers?limit=200`, { headers: { cookie } })).json();
const known = new Set(existing.data.items.map((item) => item.title));
console.log(`库里已有 ${existing.data.total} 条`);

let ok = 0;
let skipped = 0;
let failed = 0;

for (const dir of (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory())) {
  const dirPath = join(root, dir.name);
  const files = await readdir(dirPath);
  if (!files.includes('scene.pkg')) continue;

  let meta = {};
  try { meta = JSON.parse(await readFile(join(dirPath, 'project.json'), 'utf8')); } catch { meta = {}; }
  const baseTitle = String(meta.title || dir.name).slice(0, 100);
  const title = `${baseTitle}（WE 工程包）`.slice(0, 120);
  if (known.has(title)) { console.log(`跳过（已存在）：${baseTitle.slice(0, 28)}`); skipped += 1; continue; }

  const tags = [...new Set((meta.tags ?? []).map((t) => TAG_MAP[t]).filter(Boolean))];

  try {
    execFileSync(process.execPath, [resolve('tools/pack-we-project.mjs'), dirPath, tmpZip], { stdio: 'ignore' });
    const info = await stat(tmpZip);
    if (info.size > LIMIT) {
      console.log(`跳过（${(info.size / 1048576).toFixed(1)}MB 超过 88MB）：${baseTitle.slice(0, 28)}`);
      await rm(tmpZip, { force: true });
      skipped += 1;
      continue;
    }

    const created = await fetch(`${BASE}/api/admin/wallpapers`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ title, kind: 'dynamic', categoryId: CATEGORY_ID, tags }),
    });
    const cj = await created.json();
    if (!created.ok) throw new Error(cj.error?.message ?? created.status);

    const bytes = new Uint8Array(await readFile(tmpZip));
    const up = await fetch(`${BASE}/api/admin/wallpapers/${cj.data.wallpaper.id}/asset`, {
      method: 'PUT', headers: { 'x-folia-client': 'admin', cookie, 'content-type': 'application/zip' }, body: bytes,
    });
    if (!up.ok) throw new Error((await up.json()).error?.message ?? up.status);

    await rm(tmpZip, { force: true });
    known.add(title);
    ok += 1;
    console.log(`OK  ${(info.size / 1048576).toFixed(1)}MB  ${baseTitle.slice(0, 34)}`);
  } catch (error) {
    console.log(`FAIL ${baseTitle.slice(0, 30)}  ${error.message}`);
    await rm(tmpZip, { force: true });
    failed += 1;
  }
}

console.log(`\n完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
