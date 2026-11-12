/**
 * 前台编辑弹层的「子标签」：可选项来自后台字典（/api/admin/subtags），
 * 作品上的 subtag 仍是文本字段。这里锁三件事：
 *   ① PATCH { subtag } 能写进公开 DTO
 *   ② PATCH { subtag: '' } 能清空
 *   ③ 前端只读字典、不新建；没有子标签时显示「无标签」
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { call, openSite, sqliteSkip } from './sqlite-site.js';

const DEVICE = 'f'.repeat(43);
const TOKEN = 'subtag-edit-token';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const cookie = () => `folia_session=${TOKEN}; folia_device=${DEVICE}`;

function makeSite() {
  const site = openSite([{
    id: 'wp_sub',
    slug: 'sub',
    title: '露西',
    status: 'published',
    review_status: 'approved',
    category_id: 'cat_wallpaper',
    kind: 'static',
  }]);
  const now = Date.now();
  site.db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
    VALUES (?, 'usr_site', ?, ?, '', '', ?, ?)`)
    .run(sha(TOKEN), now, now + 3600_000, sha(DEVICE), now);
  return site;
}

const admin = (env, method, path, body) => call(env, path, {
  method,
  headers: {
    'x-folia-client': 'admin',
    cookie: cookie(),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

test('PATCH subtag ⇒ 公开接口带出来；清空 ⇒ 回到空串', { skip: sqliteSkip }, async () => {
  const site = makeSite();
  const env = site.env;

  const set = await admin(env, 'PATCH', '/api/admin/wallpapers/wp_sub', { subtag: '动漫' });
  assert.equal(set.status, 200, set.text.slice(0, 300));

  const pub = await call(env, '/api/public/wallpapers?limit=10');
  const item = pub.body.data.items.find((row) => row.id === 'wp_sub');
  assert.ok(item, '作品应当出现在公开列表');
  assert.equal(item.subtag, '动漫', '公开 DTO 必须带 subtag');

  const clear = await admin(env, 'PATCH', '/api/admin/wallpapers/wp_sub', { subtag: '' });
  assert.equal(clear.status, 200, clear.text.slice(0, 300));
  const pub2 = await call(env, '/api/public/wallpapers?limit=10');
  assert.equal(pub2.body.data.items.find((row) => row.id === 'wp_sub').subtag, '');
});

test('后台子标签字典可读（空表返回空数组）', { skip: sqliteSkip }, async () => {
  const site = makeSite();
  const res = await admin(site.env, 'GET', '/api/admin/subtags');
  assert.equal(res.status, 200, res.text.slice(0, 300));
  // 路由统一包在 data 里；兼容两种形状，避免以后换封装就红
  const list = res.body && (res.body.subtags || (res.body.data && res.body.data.subtags));
  assert.ok(Array.isArray(list), 'subtags 必须是数组');
});

test('前端编辑弹层：读后台字典、没有就显示「无标签」、不新建', () => {
  const src = readFileSync('public/assets/editor.js', 'utf8');
  assert.ok(src.includes("request('/admin/subtags')"), '子标签选项必须来自后台字典');
  assert.ok(src.includes("request('/admin/subtags/used')"), '还要合并「作品上实际用过的子标签」');
  assert.ok(src.includes('无标签'), '没有子标签时要有明确提示');
  assert.ok(/body\.subtag\s*=/.test(src), '保存时要提交 subtag');
  assert.ok(src.includes("method: 'POST'") === false || !/POST[\s\S]{0,80}\/admin\/subtags/.test(src),
    '前端不允许新建子标签（字典在后端维护）');
});

test('卡片下方同时显示标签与子标签（编辑模式用来定位目标）', () => {
  const src = readFileSync('public/assets/editor.js', 'utf8');
  assert.ok(src.includes('标签：${item.tags.join'), '卡片行要带标签');
  assert.ok(src.includes('子标签：${item.subtag}'), '卡片行要带子标签');
  assert.ok(src.includes('metaText'), '两段拼成一行，空的一段不显示');
});

test('前台筛选栏：标签行下面有子标签行，首屏就加载', () => {
  const src = readFileSync('public/assets/gallery.js', 'utf8');
  assert.ok(src.includes("chipHtml('subtag'"), '子标签 chip 要能点（data-filter=subtag）');
  assert.ok(/await loadTags\(\);[\s\S]{0,240}await loadSubtags\(\);/.test(src), 'boot 链里在标签之后加载子标签');
  assert.ok(/Promise\.all\(\[loadTags\(\), loadSubtags\(\)\]\)/.test(src), '切分类时标签与子标签一起刷新');
  assert.ok(src.includes("params.set('category', state.tab)"), '子标签按分类过滤');
});

test('编辑模式也显示标签/子标签筛选（不再隐藏 #filters）', () => {
  const gallery = readFileSync('public/assets/gallery.js', 'utf8');
  const css = readFileSync('public/assets/editor.css', 'utf8');
  assert.ok(!/body\.editing #filters/.test(css), '编辑模式不该再把筛选栏藏起来');
  assert.ok(!/state\.tag = '';\s*\n\s*state\.aspect = ''/.test(gallery), '进编辑模式不再清空标签筛选');
  assert.ok(/fetchPublicList\(state\.page\)/.test(gallery), '编辑模式走公开列表，筛选参数才生效');
});

test('删除确认用居中弹层，不用 window.confirm', () => {
  const src = readFileSync('public/assets/editor.js', 'utf8');
  const css = readFileSync('public/assets/editor.css', 'utf8');
  assert.ok(src.includes('function confirmSheet('), '要有居中确认框');
  assert.ok(!/window\.confirm\(/.test(src), '不能再出现 window.confirm（原生确认条在窗口顶部）');
  assert.ok(/await confirmSheet\(/.test(src), '删除前要 await 确认结果');
  assert.ok(css.includes('.confirm-sheet'), '确认框要居中且限宽');
});

test('编辑弹层：标签（多选 chips）与子标签（下拉）是两行', () => {
  const src = readFileSync('public/assets/editor.js', 'utf8');
  const css = readFileSync('public/assets/editor.css', 'utf8');
  assert.ok(src.includes('async function tagsFieldHtml('), '要有「标签」字段');
  assert.ok(src.includes("request('/admin/tags')"), '标签字典来自后台');
  assert.ok(src.includes('tag-pick--chips'), '标签用 chips 多选');
  assert.ok(src.includes('<label class="field-row">子标签'), '「子标签」单独一行下拉');
  assert.ok(src.includes('body.tags ='), '保存时提交 tags');
  assert.ok(!src.includes('已有标签'), '旧的只读「已有标签」行应移除');
  assert.ok(css.includes('.tag-chip.active'), 'chips 选中态要有样式');
});
