import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 资源包（皮肤包 / 桌宠 zip）没有首帧可抽，封面只能靠后台上传的 poster。
 * 公开 DTO 已有 posterUrl，前台必须用它，否则卡片永远显示 ZIP 占位。
 */
test('卡片与预览：资源包封面优先用 posterUrl', () => {
  const src = readFileSync('public/assets/gallery.js', 'utf8');
  assert.ok(/item\.posterUrl \|\| item\.thumbUrl/.test(src), '封面优先级里要有 posterUrl');
  assert.ok(/stage\.innerHTML = item\.posterUrl/.test(src), '预览弹层对资源包也要展示 poster');
});

test('后台上传封面后提示与真相一致（已落库，不需要再保存）', () => {
  const admin = readFileSync('public/admin/app.js', 'utf8');
  assert.ok(admin.includes('/poster'), '后台调用封面上传接口');
  assert.ok(!admin.includes('已上传，保存后生效'), '文案不该让人以为还要点保存才生效');
});

test('后台列表缩略图也用 posterUrl（前台显示了后台也要同步）', () => {
  const admin = readFileSync('public/admin/app.js', 'utf8');
  const fn = admin.slice(admin.indexOf('function thumbHtml('), admin.indexOf('function formatDuration('));
  assert.ok(/item\.posterUrl \|\|/.test(fn), '后台 thumbHtml 优先取 posterUrl');
  assert.ok(!/const cover = item\.thumbUrl &&/.test(fn), '旧写法（只认 thumbUrl）应已移除');
});
