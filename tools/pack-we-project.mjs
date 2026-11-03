/**
 * 把 Wallpaper Engine 的本地作品目录打成可分发的 zip。
 *
 *   node tools/pack-we-project.mjs "D:\...\workshop\content\431960\2814641807" out.zip
 *
 * 为什么不转码：scene 类型是 .pkg（模型+材质+着色器），只有 WE 自己能渲染。
 * 把原目录原样打包，用户解压到 WE 的 projects 目录即可加载，效果一模一样。
 */
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createDeflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const [sourceDir, outFile] = process.argv.slice(2);
if (!sourceDir || !outFile) {
  console.error('用法：node tools/pack-we-project.mjs <作品目录> <输出.zip>');
  process.exit(2);
}

const dir = resolve(sourceDir);

// ---- 极简 zip 写入器（store 模式：.pkg 本身已压缩，再压几乎没收益） ----
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

const DOS_TIME = 0;   // 时间字段留 0，解压时不影响
const DOS_DATE = 0x21; // 1980-01-01

async function buildZip(entries, target) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 文件名
    local.writeUInt16LE(0, 8);            // store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, entry.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBytes]));

    offset += local.length + nameBytes.length + size;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  const handle = createWriteStream(target);
  for (const chunk of [...chunks, centralBuf, end]) {
    if (!handle.write(chunk)) await new Promise((r) => handle.once('drain', r));
  }
  await new Promise((r, j) => { handle.end(r); handle.on('error', j); });
}

const README = `Wallpaper Engine 本地作品
==========================

用法：
1. 解压这个压缩包到：
   ...\\steamapps\\common\\wallpaper_engine\\projects\\myprojects\\<随便起个目录名>\\
   解压后该目录里应该直接看到 project.json 和 scene.pkg。

2. 打开 Wallpaper Engine → 左侧「已安装」→ 就能看到这件作品。
   （scene 类型是实时渲染的，不是视频，效果与创意工坊原版一致。）

3. 想删掉就删整个目录。

说明：
- 需要 Wallpaper Engine（Steam 版）。
- 本包版权归原作者的创意工坊作品，仅供个人使用，请勿二次分发。
`;

const files = (await readdir(dir)).filter((name) => /\.(pkg|json|jpe?g|png|gif|webp)$/i.test(name));
const entries = [];
for (const name of files) {
  const path = join(dir, name);
  const info = await stat(path);
  if (!info.isFile()) continue;
  entries.push({ name, data: await readFile(path) });
}
entries.push({ name: 'README.txt', data: Buffer.from(README, 'utf8') });

await buildZip(entries, outFile);
const out = await stat(outFile);
console.log(`打包 ${entries.length} 个文件 → ${basename(outFile)}  ${(out.size / 1048576).toFixed(2)} MB`);
