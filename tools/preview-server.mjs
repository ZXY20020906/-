/**
 * 本地预览服务器：只做一件事——把真实前台页面跑起来给你看，不需要 D1 / R2 / 登录。
 *
 *   node tools/preview-server.mjs --media "D:\path\to\videos" --port 8788
 *
 * - 静态文件来自 public/
 * - /api/public/* 用内存里的假数据，但宽高、时长是真的（用项目自己的解析器读文件头）
 * - /media/* 直接读本地视频目录，支持 Range，所以能拖进度条
 *
 * 它不模拟登录、不写任何东西，纯只读。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDurationMs, readMediaMeta } from '../src/core/image-meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const publicDir = resolve(root, 'public');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(option('port', '8788'));
const mediaDir = resolve(option('media', resolve(root, 'preview-media')));

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

/** 扫描素材目录，生成和 /api/public/wallpapers 一致的 DTO */
async function buildItems() {
  let names = [];
  try {
    names = (await readdir(mediaDir)).filter((name) => /\.(mp4|webm|png|jpe?g|webp|avif|gif)$/i.test(name)).sort();
  } catch {
    return [];
  }
  const items = [];
  for (const [index, name] of names.entries()) {
    const path = join(mediaDir, name);
    const info = await stat(path);
    const bytes = new Uint8Array(await readFile(path));
    const meta = readMediaMeta(bytes);
    if (!meta.mime) continue;
    const durationMs = readDurationMs(bytes, meta.mime);
    items.push({
      id: `preview_${index + 1}`,
      slug: `preview-${index + 1}`,
      title: `开机动画 ${String(index + 1).padStart(2, '0')}`,
      kind: 'dynamic',
      mime: meta.mime,
      bytes: info.size,
      width: meta.width,
      height: meta.height,
      durationMs,
      tags: [],
      featured: false,
      category: { id: 'cat_bootanim', slug: 'boot-animation', name: '开机动画' },
      url: `/media/${encodeURIComponent(name)}`,
      publishedAt: Date.now() - index * 1000,
      createdAt: Date.now() - index * 1000,
      _file: name,
    });
  }
  return items;
}

function json(res, data, status = 200) {
  const body = JSON.stringify({ ok: true, data });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function stripPrivate(item) {
  const { _file, ...rest } = item;
  return rest;
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(publicDir, normalize(rel));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(res, `${pathname.replace(/\/$/, '')}/index.html`);
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

async function serveMedia(req, res, pathname, searchParams) {
  const name = decodeURIComponent(pathname.replace(/^\/media\//, ''));
  if (!name || name.includes('..')) {
    res.writeHead(404).end('not found');
    return;
  }
  const target = resolve(mediaDir, name);
  if (!target.startsWith(mediaDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  const type = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream';
  // 和线上 /media 路由保持一致：?download=<文件名> 走附件下载
  const download = searchParams.has('download')
    ? (searchParams.get('download') || `folia${extname(target)}`).replace(/[\u0000-\u001f"\\/:*?<>|]+/g, '').slice(0, 80)
    : null;
  const disposition = download
    ? `attachment; filename="${download.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(download)}`
    : null;

  const range = download ? null : req.headers.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : info.size - 1;
    if (start >= info.size || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
      return;
    }
    const clipped = Math.min(end, info.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': clipped - start + 1,
      'content-range': `bytes ${start}-${clipped}/${info.size}`,
      'accept-ranges': 'bytes',
    });
    createReadStream(target, { start, end: clipped }).pipe(res);
    return;
  }

  const headers = {
    'content-type': type,
    'content-length': info.size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  if (disposition) headers['content-disposition'] = disposition;
  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

const items = await buildItems();
const categories = [
  { id: 'cat_dynamic', slug: 'dynamic', name: '动态', description: '', sortOrder: 10, isPublic: true, wallpaperCount: 0, publishedCount: 0 },
  { id: 'cat_skinpack', slug: 'skin-pack', name: '皮肤包', description: '', sortOrder: 20, isPublic: true, wallpaperCount: 0, publishedCount: 0 },
  {
    id: 'cat_bootanim', slug: 'boot-animation', name: '开机动画', description: '手机 / 平板开机动画',
    sortOrder: 30, isPublic: true, wallpaperCount: items.length, publishedCount: items.length,
  },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/public/categories') {
    return json(res, { categories });
  }

  if (pathname === '/api/meta') {
    return json(res, { initialized: true, statuses: ['draft', 'published', 'hidden'], kinds: ['static', 'dynamic'], sorts: ['recent', 'oldest', 'name', 'size', 'resolution'] });
  }

  if (pathname === '/api/public/wallpapers') {
    const category = url.searchParams.get('category');
    const filtered = category ? items.filter((item) => item.category.slug === category) : items;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 24) || 24, 100);
    const pageCount = Math.max(1, Math.ceil(filtered.length / limit));
    const page = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), pageCount);
    const offset = (page - 1) * limit;
    return json(res, {
      items: filtered.slice(offset, offset + limit).map(stripPrivate),
      total: filtered.length,
      hasMore: page < pageCount,
      nextCursor: null,
      page,
      pageSize: limit,
      pageCount,
      offset,
      sort: url.searchParams.get('sort') ?? 'recent',
    });
  }

  const single = /^\/api\/public\/wallpapers\/([^/]+)$/.exec(pathname);
  if (single) {
    const slug = decodeURIComponent(single[1]);
    const item = items.find((entry) => entry.slug === slug);
    if (!item) {
      return json(res, null, 404);
    }
    return json(res, { wallpaper: stripPrivate(item) });
  }

  if (pathname.startsWith('/api/')) {
    return json(res, null, 404);
  }

  if (pathname.startsWith('/media/')) {
    return serveMedia(req, res, pathname, url.searchParams);
  }

  return serveStatic(res, pathname);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`预览已启动：http://127.0.0.1:${port}/?cat=boot-animation`);
  console.log(`素材目录：${mediaDir}（${items.length} 条）`);
  for (const item of items) {
    console.log(`  ${basename(item._file)}  ${item.width}x${item.height}  ${item.durationMs ? (item.durationMs / 1000).toFixed(2) + 's' : '时长未知'}  ${(item.bytes / 1048576).toFixed(1)}MB`);
  }
});
