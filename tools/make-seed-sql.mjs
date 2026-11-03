/**
 * 把 catalog.json 转成 D1 的 INSERT 脚本。
 * 只灌壁纸行——分类由 schema/002、003 建好，不重复插入。
 *
 *   node tools/make-seed-sql.mjs deploy/public/data/catalog.json deploy/seed.sql
 */
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法：node tools/make-seed-sql.mjs <catalog.json> <out.sql>');
  process.exit(2);
}

const catalog = JSON.parse(await readFile(input, 'utf8'));

const quote = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
};

const keyOf = (url) => String(url ?? '').replace(/^\/media\//, '');

const rows = catalog.wallpapers.map((item) => {
  const key = keyOf(item.url);
  if (!key) throw new Error(`缺少 storage_key：${item.title}`);
  return `(
  ${quote(item.id)}, ${quote(item.slug)}, ${quote(item.title)}, ${quote(item.category.id)},
  ${quote(item.kind)}, 'published', ${quote(key)}, ${quote(item.mime)},
  ${quote(item.bytes)}, ${quote(item.width)}, ${quote(item.height)}, ${quote(item.durationMs)},
  NULL, ${quote(JSON.stringify(item.tags ?? []))}, ${item.featured ? 1 : 0}, 10,
  NULL, ${quote(item.createdAt)}, ${quote(item.createdAt)}, ${quote(item.publishedAt)}
)`;
});

const sql = `-- 由 tools/make-seed-sql.mjs 生成，来源：${input}
INSERT INTO wallpapers
  (id, slug, title, category_id, kind, status, storage_key, mime, bytes, width, height, duration_ms,
   sha256, tags, featured, sort_order, created_by, created_at, updated_at, published_at)
VALUES
${rows.join(',\n')};
`;

await writeFile(output, sql, 'utf8');
console.log(`写入 ${rows.length} 行 → ${output}`);
