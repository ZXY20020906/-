/**
 * 批量导入本地壁纸目录。
 * 先用接口登录，再逐张「建草稿 → 传文件 →（可选）发布」，失败的不影响后面的。
 *
 * 用法：
 *   FOLIA_URL=https://folia-major-3t6.pages.dev \
 *   FOLIA_EMAIL=admin@example.com \
 *   FOLIA_PASSWORD='******' \
 *   node tools/import-wallpapers.mjs ./wallpapers --category dynamic --publish
 *
 * 可选参数：--category <slug>  --publish  --dry-run  --limit 20
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, basename } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const baseUrl = (process.env.FOLIA_URL || '').replace(/\/$/, '');
const email = process.env.FOLIA_EMAIL;
const password = process.env.FOLIA_PASSWORD;

if (!dir || !baseUrl || !email || !password) {
  console.error('缺少参数。需要：目录、FOLIA_URL、FOLIA_EMAIL、FOLIA_PASSWORD');
  process.exit(2);
}

const imageExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);
const videoExt = new Set(['.mp4', '.webm']);
const limit = Number(option('limit') || 0);

let cookie = '';

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const init = {
    method,
    headers: { 'x-folia-client': 'admin', ...(cookie ? { cookie } : {}), ...headers },
  };
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(`${baseUrl}/api${path}`, init);
  if (typeof response.headers.getSetCookie === 'function') {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0];
      if (pair.startsWith('folia_session=')) cookie = pair;
    }
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`${method} ${path} → ${message}`);
  }
  return payload?.data;
}

function titleOf(file) {
  return basename(file, extname(file)).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function main() {
  console.log(`登录 ${baseUrl} …`);
  await call('/auth/login', { method: 'POST', body: { email, password } });
  console.log('登录成功');

  const { categories } = await call('/admin/categories');
  const wanted = option('category');
  const category = wanted ? categories.find((row) => row.slug === wanted || row.name === wanted) : null;
  if (wanted && !category) {
    console.error(`找不到分类：${wanted}（现有：${categories.map((row) => `${row.slug}/${row.name}`).join(', ')}）`);
    process.exit(2);
  }

  const files = readdirSync(dir)
    .filter((name) => {
      const ext = extname(name).toLowerCase();
      return imageExt.has(ext) || videoExt.has(ext);
    })
    .sort()
    .slice(0, limit > 0 ? limit : undefined);

  console.log(`待导入 ${files.length} 个文件${category ? `，归类到「${category.name}」` : ''}`);

  let ok = 0;
  let failed = 0;
  for (const [index, name] of files.entries()) {
    const path = join(dir, name);
    const ext = extname(name).toLowerCase();
    const kind = videoExt.has(ext) ? 'dynamic' : 'static';
    const prefix = `[${index + 1}/${files.length}] ${name}`;
    try {
      if (!statSync(path).isFile()) continue;
      const bytes = new Uint8Array(readFileSync(path));
      if (flag('dry-run')) {
        console.log(`${prefix} （dry-run，${bytes.byteLength} 字节）`);
        ok += 1;
        continue;
      }
      const created = await call('/admin/wallpapers', {
        method: 'POST',
        body: { title: titleOf(name), kind, categoryId: category ? category.id : null, tags: [] },
      });
      const id = created.wallpaper.id;
      await call(`/admin/wallpapers/${id}/asset`, {
        method: 'PUT',
        body: bytes,
        headers: { 'content-type': kind === 'dynamic' ? 'video/mp4' : 'image/png' },
      });
      if (flag('publish')) {
        await call(`/admin/wallpapers/${id}`, { method: 'PATCH', body: { status: 'published' } });
      }
      console.log(`${prefix} ✓ ${kind}${flag('publish') ? ' 已发布' : ' 草稿'}`);
      ok += 1;
    } catch (error) {
      failed += 1;
      console.warn(`${prefix} ✗ ${error.message}`);
    }
  }

  console.log(`完成：成功 ${ok}，失败 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
