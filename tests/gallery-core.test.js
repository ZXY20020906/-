import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ROTATION,
  absoluteUrl,
  addToRotation,
  buildShareUrl,
  downloadUrl,
  extensionForMime,
  formatBytes,
  formatDimensions,
  formatDuration,
  mediaKind,
  isPetItem,
  cardBadge,
  parseFavoriteList,
  parseIdList,
  qualityLabel,
  readSharedRotation,
  removeFromRotation,
  serializeIdList,
  stepIndex,
  toggleFavorite,
} from '../public/assets/gallery-core.js';

test('parseIdList：去空、去重、保序、截断', () => {
  assert.deepEqual(parseIdList('a,b,,a, c '), ['a', 'b', 'c']);
  assert.deepEqual(parseIdList(['x', 'y']), ['x', 'y']);
  assert.deepEqual(parseIdList(''), []);
  assert.equal(parseIdList(Array.from({ length: 30 }, (_, i) => `id${i}`)).length, MAX_ROTATION);
});

test('serializeIdList 与 parseIdList 互逆', () => {
  assert.equal(serializeIdList(['a', 'b']), 'a,b');
  assert.equal(serializeIdList([]), '');
});

test('加入轮换：重复不加、满了报 full', () => {
  const first = addToRotation([], 'a');
  assert.deepEqual(first, { ids: ['a'], added: true, full: false });

  const dup = addToRotation(['a'], 'a');
  assert.equal(dup.added, false);
  assert.equal(dup.full, false);

  const fullList = Array.from({ length: MAX_ROTATION }, (_, i) => `id${i}`);
  const overflow = addToRotation(fullList, 'new');
  assert.equal(overflow.added, false);
  assert.equal(overflow.full, true);
  assert.equal(overflow.ids.length, MAX_ROTATION);
});

test('移出轮换只删指定项', () => {
  assert.deepEqual(removeFromRotation(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(removeFromRotation(['a'], 'z'), ['a']);
});

test('收藏：再次点击取消，新收藏排在最前', () => {
  const added = toggleFavorite(['old'], 'new');
  assert.deepEqual(added.list, ['new', 'old']);
  assert.equal(added.added, true);

  const removed = toggleFavorite(['new', 'old'], 'new');
  assert.deepEqual(removed.list, ['old']);
  assert.equal(removed.added, false);
});

test('收藏列表解析容错：坏 JSON / 非数组都返回空', () => {
  assert.deepEqual(parseFavoriteList('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseFavoriteList('not json'), []);
  assert.deepEqual(parseFavoriteList('{"a":1}'), []);
  assert.deepEqual(parseFavoriteList(null), []);
});

test('← → 切换在两端回绕', () => {
  assert.equal(stepIndex(3, 0, -1), 2);
  assert.equal(stepIndex(3, 2, 1), 0);
  assert.equal(stepIndex(1, 0, 1), 0);
  assert.equal(stepIndex(0, 0, 1), -1);
});

test('体积与尺寸格式化', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatDimensions(3840, 2160), '3840×2160');
  assert.equal(formatDimensions(null, 2160), '—');
});

test('分辨率档位：竖屏 4K 也算 4K', () => {
  assert.equal(qualityLabel(3840, 2160), '4K');
  assert.equal(qualityLabel(2160, 3840), '4K');
  assert.equal(qualityLabel(7680, 4320), '8K');
  assert.equal(qualityLabel(2560, 1440), '2K');
  assert.equal(qualityLabel(1920, 1080), '1080P');
  assert.equal(qualityLabel(800, 600), '');
  assert.equal(qualityLabel(null, null), '');
});

test('时长格式化：秒级一位小数，超过一分钟用 m:ss', () => {
  assert.equal(formatDuration(6500), '6.5s');
  assert.equal(formatDuration(999), '1.0s');
  assert.equal(formatDuration(75_000), '1:15');
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(-1), '');
});

test('按 mime 推断下载后缀', () => {
  assert.equal(extensionForMime('video/mp4'), 'mp4');
  assert.equal(extensionForMime('video/webm'), 'webm');
  assert.equal(extensionForMime('application/zip'), 'zip');
  assert.equal(extensionForMime('application/octet-stream'), '');
  assert.equal(extensionForMime(null), '');
});

test('下载地址：站内直链直接加参数', () => {
  assert.equal(downloadUrl('/media/a.mp4', 'https://x.io', '夜.mp4'), '/media/a.mp4?download=%E5%A4%9C.mp4');
  assert.equal(downloadUrl('/media/a.mp4', 'https://x.io'), '/media/a.mp4?download=1');
  assert.equal(downloadUrl('', 'https://x.io'), '');
});

test('下载地址：自定义域名的直链绕回站内 /media，才能带上附件头', () => {
  const out = downloadUrl('https://img.x.io/wallpapers/wp_1/abc.mp4', 'https://x.io', '夜雨.mp4');
  assert.equal(out, 'https://x.io/media/wallpapers/wp_1/abc.mp4?download=%E5%A4%9C%E9%9B%A8.mp4');
});

test('下载地址：识别不出 /wallpapers/ 路径时退回原地址', () => {
  const out = downloadUrl('https://cdn.x.io/other/abc.mp4', 'https://x.io', 'a.mp4');
  assert.equal(out, 'https://cdn.x.io/other/abc.mp4?download=a.mp4');
});

test('判断图片还是视频还是开机动画包，靠 mime', () => {
  assert.equal(mediaKind({ mime: 'video/mp4', kind: 'static' }), 'video');
  assert.equal(mediaKind({ mime: 'image/webp', kind: 'dynamic' }), 'image');
  assert.equal(mediaKind({ mime: 'application/zip', kind: 'dynamic' }), 'bundle');
  assert.equal(mediaKind({ mime: null, kind: 'dynamic' }), 'video');
});

test('直链：相对路径补 origin，绝对地址原样返回', () => {
  assert.equal(absoluteUrl('/media/a.png', 'https://x.io'), 'https://x.io/media/a.png');
  assert.equal(absoluteUrl('/media/a.png', 'https://x.io/'), 'https://x.io/media/a.png');
  assert.equal(absoluteUrl('https://img.x.io/a.png', 'https://x.io'), 'https://img.x.io/a.png');
  assert.equal(absoluteUrl('', 'https://x.io'), '');
});

test('轮换链接可分享且能还原（含中文 slug）', () => {
  const url = buildShareUrl('https://x.io', '/', ['夜雨', 'demo-2']);
  assert.match(url, /^https:\/\/x\.io\/#r=/);
  const hash = url.slice(url.indexOf('#'));
  assert.deepEqual(readSharedRotation(hash), ['夜雨', 'demo-2']);
});

test('没有轮换时分享链接不带 hash', () => {
  assert.equal(buildShareUrl('https://x.io', '/', []), 'https://x.io/');
  assert.deepEqual(readSharedRotation(''), []);
  assert.deepEqual(readSharedRotation('#'), []);
});

test('isPetItem：kind=pet 或带 pet 对象都算桌宠（含历史 kind=static 的行）', () => {
  assert.equal(isPetItem({ kind: 'pet', mime: 'application/zip' }), true);
  assert.equal(isPetItem({ kind: 'static', mime: 'application/zip', pet: { id: 'whale' } }), true);
  assert.equal(isPetItem({ kind: 'static', mime: 'application/zip' }), false);
  assert.equal(isPetItem({ kind: 'dynamic', mime: 'video/mp4' }), false);
  assert.equal(isPetItem(null), false);
});

test('cardBadge：桌宠 > 资源包 > null（其余交给视频/清晰度）', () => {
  assert.equal(cardBadge({ kind: 'pet', mime: 'application/zip' }), '桌宠');
  assert.equal(cardBadge({ kind: 'static', mime: 'application/zip', pet: { id: 'x' } }), '桌宠');
  assert.equal(cardBadge({ kind: 'static', mime: 'application/zip' }), '资源包');
  assert.equal(cardBadge({ kind: 'dynamic', mime: 'video/mp4' }), null);
  assert.equal(cardBadge({ kind: 'static', mime: 'image/png' }), null);
});
