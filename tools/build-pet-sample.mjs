#!/usr/bin/env node
/**
 * 造一个**合规的桌宠包样本**（门 1 的验收夹具）。
 *
 * 为什么要这个工具：工单指定的 `tests/fixtures/pets/whale-girl-refined.zip`
 * （sha256 1b12ec…）在插件仓库、站点仓库和本机都不存在（我用 GitHub tree API 扫过
 * `folia` / `main` / `folia-archive` 三个分支，也扫过本机磁盘）。为了能端到端验证
 * 「zip 内含 pet.json ⇒ 桌宠包」这条路，这里按契约造一个**等价的**样本：
 *
 *   pet.json（petManifestVersion=2 / sprite2d / 8 列 9 行 / idle+running-right+wave）
 *   spritesheet.webp（8×9 格，每格 192×208，由一张立绘缩放平铺而来）
 *   previews/（2 张 webp，列表封面用第一张）
 *
 * 用法：
 *   node tools/build-pet-sample.mjs --sprite <png> [--out tests/fixtures/pets/sample-pet-v2.zip]
 *   不传 --sprite 时用插件仓库克隆里的鲸鱼立绘（本机默认路径，找不到会提示）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { makeZip } from './lib/zip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const FFMPEG = process.env.FOLIA_FFMPEG || 'ffmpeg';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SPRITE = option('sprite', resolve('C:/Users/Lenovo/Documents/deepseek-harness/default-workspace/.tools/dsh-folia-main/assets/rope/whale.png'));
const OUT = resolve(ROOT, option('out', 'tests/fixtures/pets/sample-pet-v2.zip'));
const CELL = { width: 192, height: 208 };
const COLUMNS = 8;
const ROWS = 9;

if (!existsSync(SPRITE)) {
  console.error(`找不到立绘：${SPRITE}\n用 --sprite <png> 指定一张图。`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'pet-sample-'));
const run = (list) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...list], { stdio: 'inherit' });

try {
  // 1) 单格：等比缩放进 192×208，居中补边
  const cellPath = join(work, 'cell.rgb');
  run([
    '-i', SPRITE,
    '-vf', `scale=${CELL.width}:${CELL.height}:force_original_aspect_ratio=decrease,`
      + `pad=${CELL.width}:${CELL.height}:(ow-iw)/2:(oh-ih)/2:color=0x000000`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', cellPath,
  ]);
  const cell = readFileSync(cellPath);
  const cellBytes = CELL.width * CELL.height * 3;
  if (cell.length !== cellBytes) throw new Error(`单格尺寸不符：${cell.length} != ${cellBytes}`);

  // 2) 平铺成 8×9 的雪碧图（夹具用同一格重复，结构上完全合法）
  const sheetWidth = CELL.width * COLUMNS;
  const sheetHeight = CELL.height * ROWS;
  const sheet = Buffer.alloc(sheetWidth * sheetHeight * 3);
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      for (let y = 0; y < CELL.height; y += 1) {
        const src = y * CELL.width * 3;
        const dest = ((row * CELL.height + y) * sheetWidth + column * CELL.width) * 3;
        cell.copy(sheet, dest, src, src + CELL.width * 3);
      }
    }
  }
  const sheetRaw = join(work, 'sheet.rgb');
  writeFileSync(sheetRaw, sheet);
  const sheetWebp = join(work, 'spritesheet.webp');
  run([
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${sheetWidth}x${sheetHeight}`, '-i', sheetRaw,
    '-c:v', 'libwebp', '-quality', '82', '-frames:v', '1', sheetWebp,
  ]);

  // 3) 预览图两张（列表封面 / 详情大图）
  mkdirSync(join(work, 'previews'), { recursive: true });
  run(['-i', SPRITE, '-vf', 'scale=384:-2', '-c:v', 'libwebp', '-quality', '85', '-frames:v', '1', join(work, 'previews', 'idle.webp')]);
  run(['-i', SPRITE, '-vf', 'scale=768:-2', '-c:v', 'libwebp', '-quality', '85', '-frames:v', '1', join(work, 'previews', 'wave.webp')]);

  // 4) pet.json（契约 §1.1）
  const manifest = {
    petManifestVersion: 2,
    id: 'whale-girl',
    displayName: '鲸鱼娘',
    renderer: 'sprite2d',
    sprite2d: {
      spritesheetPath: 'spritesheet.webp',
      columns: COLUMNS,
      cell: { width: CELL.width, height: CELL.height },
      frames: new Array(ROWS).fill(COLUMNS),
      tracks: {
        idle: { durations: new Array(COLUMNS).fill(220) },
        'running-right': { durations: new Array(COLUMNS).fill(120) },
        wave: { durations: new Array(COLUMNS).fill(160) },
      },
    },
    license: { type: 'local-fixture', note: '站点仓库自造夹具，不是工单指定的 whale-girl-refined.zip' },
    generatedBy: 'tools/build-pet-sample.mjs',
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(work, 'pet.json'), manifestText);

  // 5) 打包（store：webp 已经压过，再 deflate 只是白费 CPU）
  const files = [
    { name: 'pet.json', data: manifestText },
    { name: 'spritesheet.webp', data: readFileSync(sheetWebp) },
    { name: 'previews/idle.webp', data: readFileSync(join(work, 'previews', 'idle.webp')) },
    { name: 'previews/wave.webp', data: readFileSync(join(work, 'previews', 'wave.webp')) },
  ];
  const zip = await makeZip(files, { deflate: false });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, zip);

  const sha = createHash('sha256').update(zip).digest('hex');
  console.log(`wrote ${OUT}`);
  console.log(`  ${files.length} 个文件 · ${(zip.length / 1024).toFixed(1)}KB · sha256=${sha}`);
  console.log(`  雪碧图 ${sheetWidth}×${sheetHeight}（${COLUMNS} 列 × ${ROWS} 行，每格 ${CELL.width}×${CELL.height}）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
