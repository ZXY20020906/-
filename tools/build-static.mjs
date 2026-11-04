/**
 * 生成静态站点的数据与素材清单：
 *   1. 把真实视频 + 生成的示例图算好哈希、宽高、时长
 *   2. 写 deploy/public/data/catalog.json（前端静态模式读它）
 *   3. 打印 wrangler 上传命令（R2 key 与 catalog 里的 url 一一对应）
 *
 *   node tools/build-static.mjs --videos <dir> --out deploy
 */
import { mkdir, readdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDurationMs, readMediaMeta } from '../src/core/image-meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const videoDir = option('videos', '');
const outDir = resolve(root, option('out', 'deploy'));
const publicDir = resolve(outDir, 'public');
const seedDir = resolve(outDir, '.seed');

const CATEGORIES = [
  { id: 'cat_dynamic', slug: 'dynamic', name: '动态', description: '动态壁纸 / 视频壁纸', sortOrder: 10, isPublic: true },
  { id: 'cat_skinpack', slug: 'skin-pack', name: '皮肤包', description: '成套皮肤与配色包', sortOrder: 20, isPublic: true },
  { id: 'cat_bootanim', slug: 'boot-animation', name: '开机动画', description: '手机 / 平板开机动画视频', sortOrder: 30, isPublic: true },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 和线上一致：wallpapers/<id>/<sha 前 16 位>.<ext>（与 src/server/storage.js 的 HASH_PREFIX_LEN 对齐） */
function assetKey(id, hash, ext) {
  return `wallpapers/${id}/${hash.slice(0, 16)}.${ext}`;
}

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/gif': 'gif', 'video/mp4': 'mp4',
  'video/webm': 'webm', 'application/zip': 'zip',
};

async function addFile(items, filePath, { title, category, kind }) {
  const bytes = new Uint8Array(await readFile(filePath));
  const meta = readMediaMeta(bytes);
  if (!meta.mime) {
    console.warn(`跳过（无法识别）：${basename(filePath)}`);
    return null;
  }
  const hash = sha256(bytes);
  const id = `wp_${hash.slice(0, 12)}`;
  const key = assetKey(id, hash, EXT_BY_MIME[meta.mime] ?? 'bin');
  const item = {
    id,
    slug: `${category}-${items.length + 1}`,
    title,
    kind,
    mime: meta.mime,
    bytes: bytes.byteLength,
    width: meta.width,
    height: meta.height,
    durationMs: readDurationMs(bytes, meta.mime),
    tags: kind === 'dynamic' ? ['动漫'] : ['自然风景'],
    featured: false,
    category: (() => {
      const found = CATEGORIES.find((entry) => entry.slug === category);
      return { id: found.id, slug: found.slug, name: found.name };
    })(),
    url: `/media/${key}`,
    publishedAt: Date.now() - items.length * 60_000,
    createdAt: Date.now() - items.length * 60_000,
    _file: filePath,
    _key: key,
  };
  items.push(item);
  return item;
}

const items = [];

if (videoDir) {
  const names = (await readdir(videoDir)).filter((name) => /\.(mp4|webm)$/i.test(name)).sort();
  for (const name of names) {
    await addFile(items, join(videoDir, name), {
      title: `开机动画 ${String(items.length + 1).padStart(2, '0')}`,
      category: 'boot-animation',
      kind: 'dynamic',
    });
  }
}

// 示例图：让每个 tab 都有内容，同时演示不同宽高比
const stills = (await readdir(seedDir)).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort();
for (const name of stills) {
  const index = Number(/(\d+)/.exec(name)?.[1] ?? 1);
  const category = index <= 2 ? 'dynamic' : 'skin-pack';
  await addFile(items, join(seedDir, name), {
    title: `示例壁纸 ${String(index).padStart(2, '0')}`,
    category,
    kind: 'static',
  });
}

const catalog = {
  generatedAt: new Date().toISOString(),
  categories: CATEGORIES.map((category) => ({
    ...category,
    wallpaperCount: items.filter((item) => item.category.slug === category.slug).length,
    publishedCount: items.filter((item) => item.category.slug === category.slug).length,
  })),
  wallpapers: items.map(({ _file, _key, ...rest }) => rest),
};

await mkdir(resolve(publicDir, 'data'), { recursive: true });
await writeFile(resolve(publicDir, 'data', 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');

const manifest = items.map((item) => ({ key: item._key, file: item._file, bytes: item.bytes }));
await writeFile(resolve(outDir, '.upload.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`catalog: ${catalog.wallpapers.length} 条，${catalog.categories.length} 个分类`);
for (const item of items) {
  const size = (item.bytes / 1048576).toFixed(1);
  const dur = item.durationMs ? `${(item.durationMs / 1000).toFixed(2)}s` : '—';
  console.log(`  ${item.category.name.padEnd(4)} ${item.title.padEnd(10)} ${String(item.width).padStart(4)}x${item.height}  ${dur.padStart(7)}  ${size}MB  ${item._key}`);
}
