/**
 * 用 RePKG 从 Wallpaper Engine 的 scene.pkg 里挖原始纹理，导出成高清静图。
 *
 *   node tools/pkg2stills.mjs [--limit 5]
 *
 * 为什么比录屏强：
 * - 拿到的是纹理原图（常比屏幕大，例：3187×1992），不是 2560×1440 的截屏；
 * - 不碰桌面，不弹窗，不留图标和光标；
 * - 一个作品 2~5 秒。
 *
 * 局限（照实说）：scene 是「纹理 + 摆位 + 粒子」合成的，
 * 这里给的是**主纹理**本身，构图和实际桌面上的效果基本一致，
 * 但动态元素（粒子、视差）不会体现在静图里。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPKG = resolve('..', '.tools', 'repkg', 'RePKG', 'RePKG.exe');
const WE_ROOT = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960');
const WORK = resolve('build', 'pkg');
const OUT = resolve('build', 'stills');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

if (!existsSync(REPKG)) {
  console.error(`找不到 RePKG：${REPKG}`);
  process.exit(2);
}

await mkdir(WORK, { recursive: true });
await mkdir(OUT, { recursive: true });

const repkg = (args) => {
  try {
    execFileSync(REPKG, args, { stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
};

/** 读 JPEG/PNG 宽高（够用就行，不引依赖） */
async function imageSize(path) {
  const buf = await readFile(path);
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

const results = [];
const dirs = (await readdir(WE_ROOT, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let processed = 0;
for (const id of dirs) {
  if (processed >= limit) break;
  const dir = join(WE_ROOT, id);
  const pkg = join(dir, 'scene.pkg');
  if (!existsSync(pkg)) continue;

  let title = id;
  try {
    title = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).title || id;
  } catch { /* 忽略 */ }

  const rawDir = join(WORK, id);
  const imgDir = join(WORK, `${id}-img`);
  await rm(rawDir, { recursive: true, force: true });
  await rm(imgDir, { recursive: true, force: true });

  // RePKG 读不了 D:\ 上的包，先复制到本地再解
  await mkdir(rawDir, { recursive: true });
  const localPkg = join(rawDir, 'scene.pkg');
  await copyFile(pkg, localPkg);

  if (!repkg(['extract', localPkg, '-o', join(rawDir, 'raw'), '--no-tex-convert'])) {
    console.log(`  FAIL 解包失败  ${title.slice(0, 30)}`);
    continue;
  }

  // RePKG 的目录批量转换不生效，必须逐个 tex 转
  const extractRoot = join(rawDir, 'raw');
  const texFiles = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith('.tex')) texFiles.push(full);
    }
  };
  await walk(extractRoot);

  let best = null;
  for (const tex of texFiles) {
    repkg(['extract', tex, '-t', '-o', imgDir]);
  }

  const images = [];
  if (existsSync(imgDir)) {
    const walkImg = async (d) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) await walkImg(full);
        else if (/\.(jpg|jpeg|png)$/i.test(entry.name)) images.push(full);
      }
    };
    await walkImg(imgDir);
  }

  for (const img of images) {
    const { width, height } = await imageSize(img);
    // 太小的多半是遮罩或粒子贴图，跳过
    if (width < 1200 || height < 600) continue;
    const area = width * height;
    const { size } = await stat(img);
    const bytesPerPixel = size / area;
    // 低于 0.08 B/px 的多半是纯色遮罩/渐变，不是画面
    if (bytesPerPixel < 0.08) continue;
    if (!best || area > best.area) best = { path: img, width, height, area, bytesPerPixel };
  }

  if (!best) {
    console.log(`  SKIP 没有够大的纹理  ${title.slice(0, 30)}`);
    continue;
  }

  const target = join(OUT, `${id}.jpg`);
  await copyFile(best.path, target);
  const info = await stat(target);
  results.push({ id, title, path: target, width: best.width, height: best.height, bytes: info.size, bytesPerPixel: Number(best.bytesPerPixel.toFixed(2)) });
  console.log(`  OK  ${String(best.width).padStart(4)}x${String(best.height).padEnd(4)} ${(info.size / 1048576).toFixed(2)}MB  ${title.slice(0, 30)}`);
  processed += 1;
}

console.log(`\n完成 ${results.length} 个，输出在 ${OUT}`);
await mkdir(resolve('build'), { recursive: true });
const { writeFile } = await import('node:fs/promises');
await writeFile(resolve('build', 'stills.json'), JSON.stringify(results, null, 2), 'utf8');
console.log('清单：.cache/stills.json');
