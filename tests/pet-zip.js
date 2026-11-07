/**
 * 测试用桌宠包夹具。
 *
 * zip 构造器在 `tools/lib/zip.mjs`（工具与测试共用一份实现），这里只放
 * 「一张 1×1 PNG」「合规 pet.json」「合规 zip」这些夹具数据。
 */
import { makeZip } from '../tools/lib/zip.mjs';

export { crc32, makeZip } from '../tools/lib/zip.mjs';

/** 一张 1×1 的透明 PNG（字节固定，不需要图像库）。 */
export const TINY_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/** 一份合规的 pet.json（可按字段覆盖）。 */
export function petManifest(overrides = {}) {
  return JSON.stringify({
    petManifestVersion: 2,
    id: 'whale-girl',
    displayName: '鲸鱼娘',
    renderer: 'sprite2d',
    sprite2d: {
      spritesheetPath: 'spritesheet.webp',
      columns: 8,
      cell: { width: 192, height: 208 },
      frames: [8, 8, 8, 8, 8, 8, 8, 8, 8],
      tracks: {
        idle: { durations: new Array(8).fill(220) },
        'running-right': { durations: new Array(8).fill(120) },
        wave: { durations: new Array(8).fill(160) },
      },
    },
    ...overrides,
  }, null, 2);
}

/** 一个合规的桌宠包（含 1 张预览图）。 */
export async function makePetZip({ manifest = petManifest(), extraFiles = [], deflate = true, separator = '/' } = {}) {
  return makeZip([
    { name: 'pet.json', data: manifest },
    { name: 'spritesheet.webp', data: TINY_PNG },
    { name: 'previews/idle.webp', data: TINY_PNG },
    ...extraFiles,
  ], { deflate, separator });
}
