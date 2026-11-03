/**
 * 解 .mpkg / PKGM0014 容器（壁纸网站常见打包格式）。
 *
 *   node tools/extract-pkgm.mjs <包.mpkg> <输出目录>
 *
 * 结构（实测）：
 *   u32 magicLen(8) + "PKGM0014"
 *   u32 count
 *   每项：u32 nameLen, name(nameLen), u32 offset, u32 size
 *   offset 相对数据区起点，数据区紧跟在目录之后
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('用法：node tools/extract-pkgm.mjs <包> <输出目录>');
  process.exit(2);
}

const buf = await readFile(resolve(input));
const out = resolve(outDir);
await mkdir(out, { recursive: true });

const magicLen = buf.readUInt32LE(0);
const magic = buf.subarray(4, 4 + magicLen).toString('latin1');
if (!magic.startsWith('PKGM')) {
  console.error(`不是 PKGM 容器（magic=${magic}）`);
  process.exit(1);
}

let cursor = 4 + magicLen;
const count = buf.readUInt32LE(cursor);
cursor += 4;

const entries = [];
for (let i = 0; i < count; i += 1) {
  const nameLen = buf.readUInt32LE(cursor);
  cursor += 4;
  const name = buf.subarray(cursor, cursor + nameLen).toString('utf8');
  cursor += nameLen;
  const offset = buf.readUInt32LE(cursor);
  cursor += 4;
  const size = buf.readUInt32LE(cursor);
  cursor += 4;
  entries.push({ name, offset, size });
}

const dataStart = cursor;
console.log(`容器 ${basename(input)}  ${(buf.length / 1048576).toFixed(2)}MB，${count} 项，数据区起点 0x${dataStart.toString(16)}`);

for (const entry of entries) {
  const safe = entry.name.replace(/[\\/:*?"<>|]/g, '_');
  const target = join(out, safe);
  await writeFile(target, buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size));
  console.log(`  ${(entry.size / 1048576).toFixed(2).padStart(6)}MB  ${safe}`);
}

await writeFile(join(out, '_entries.json'), JSON.stringify(entries, null, 2), 'utf8');
console.log(`输出目录：${out}`);
