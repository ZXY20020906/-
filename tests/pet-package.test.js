/**
 * 桌宠包解析器（`src/server/pet-package.js`）的单测。
 *
 * 这一层的价值全在「判定」：什么算桌宠包、什么算坏包、坏在哪。
 * 所以每条用例都造一个真 zip（store / deflate / 反斜杠路径都覆盖），而不是喂假对象。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { listZipEntries, parsePetPackage } from '../src/server/pet-package.js';
import { makePetZip, makeZip, petManifest, TINY_PNG } from './pet-zip.js';

test('P1 合规包：识别为桌宠包并给出元数据与封面', async () => {
  const zip = await makePetZip();
  const result = await parsePetPackage(zip);
  assert.equal(result.isPet, true);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.pet.id, 'whale-girl');
  assert.equal(result.pet.displayName, '鲸鱼娘');
  assert.equal(result.pet.columns, 8);
  assert.deepEqual(result.pet.frames, [8, 8, 8, 8, 8, 8, 8, 8, 8]);
  assert.deepEqual(result.pet.tracks, ['idle', 'running-right', 'wave']);
  assert.equal(result.preview.name, 'previews/idle.webp');
  assert.equal(result.preview.mime, 'image/png', 'TINY_PNG 的内容嗅探结果');
  assert.ok(result.preview.bytes.byteLength > 0);
});

test('P2 没有 pet.json ⇒ 不是桌宠包（普通 zip 通道，不算错）', async () => {
  const zip = await makeZip([
    { name: 'readme.txt', data: 'hello' },
    { name: 'scene.pkg', data: 'binary-ish' },
  ]);
  const result = await parsePetPackage(zip);
  assert.equal(result.isPet, false);
  assert.equal(result.ok, undefined);
});

test('P3 反斜杠路径按 / 认（工单点名的历史怪癖）', async () => {
  const zip = await makePetZip({ separator: '\\' });
  const entries = listZipEntries(zip);
  assert.ok(entries.every((entry) => !entry.name.includes('\\')));
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.preview.name, 'previews/idle.webp');
});

test('P4 store 方式（不压缩）也能解', async () => {
  const zip = await makePetZip({ deflate: false });
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, true, result.reason);
});

test('P5 petManifestVersion 不是 2 ⇒ 422 理由明确', async () => {
  const zip = await makePetZip({ manifest: petManifest({ petManifestVersion: 1 }) });
  const result = await parsePetPackage(zip);
  assert.equal(result.isPet, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /petManifestVersion 必须为 2/);
});

test('P6 renderer 不是 sprite2d ⇒ 422', async () => {
  const zip = await makePetZip({ manifest: petManifest({ renderer: 'webgl' }) });
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, false);
  assert.match(result.reason, /renderer 必须为 sprite2d/);
});

test('P7 雪碧图不在包里 ⇒ 422（点名路径）', async () => {
  const manifest = petManifest();
  const zip = await makeZip([
    { name: 'pet.json', data: manifest },
    { name: 'previews/idle.png', data: TINY_PNG },
  ], { deflate: true });
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, false);
  assert.match(result.reason, /找不到雪碧图：spritesheet\.webp/);
});

test('P8 frames 不是非空数组 ⇒ 422', async () => {
  const manifest = JSON.parse(petManifest());
  manifest.sprite2d.frames = [];
  const result = await parsePetPackage(await makePetZip({ manifest: JSON.stringify(manifest) }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /frames 必须是非空数组/);
});

test('P9 tracks 缺 idle ⇒ 422（列出已有的 state）', async () => {
  const manifest = JSON.parse(petManifest());
  manifest.sprite2d.tracks = { walk: { durations: [100] } };
  const result = await parsePetPackage(await makePetZip({ manifest: JSON.stringify(manifest) }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /至少要有 idle/);
  assert.match(result.reason, /walk/);
});

test('P10 没有 previews/ ⇒ 422', async () => {
  const zip = await makeZip([
    { name: 'pet.json', data: petManifest() },
    { name: 'spritesheet.webp', data: TINY_PNG },
  ], { deflate: true });
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, false);
  assert.match(result.reason, /previews\/ 里至少要有 1 张图片/);
});

test('P11 pet.json 不是合法 JSON ⇒ 422', async () => {
  const zip = await makeZip([
    { name: 'pet.json', data: '{ not json' },
    { name: 'spritesheet.webp', data: TINY_PNG },
    { name: 'previews/a.png', data: TINY_PNG },
  ], { deflate: true });
  const result = await parsePetPackage(zip);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不是合法 JSON/);
});

test('P12 不是 zip（普通图片字节）⇒ 不当桌宠包，也不抛异常', async () => {
  const result = await parsePetPackage(TINY_PNG);
  assert.equal(result.isPet, false);
  assert.ok(result.zipError);
});

test('P13 多张预览按文件名稳定取第一张', async () => {
  const zip = await makeZip([
    { name: 'pet.json', data: petManifest() },
    { name: 'spritesheet.webp', data: TINY_PNG },
    { name: 'previews/z-last.png', data: TINY_PNG },
    { name: 'previews/a-first.png', data: TINY_PNG },
  ], { deflate: true });
  const result = await parsePetPackage(zip);
  assert.equal(result.preview.name, 'previews/a-first.png');
  assert.equal(result.previewCount, 2);
});
