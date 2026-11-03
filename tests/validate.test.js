import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanCategoryRef, cleanPassword, cleanTags, parseCategoryCreate, parseLimit,
  parseLogin, parsePage, parseWallpaperCreate, parseWallpaperPatch, parseSort,
} from '../src/core/validate.js';

const codeOf = (fn) => {
  try {
    fn();
    return 'no-throw';
  } catch (error) {
    return error.code;
  }
};

test('新建壁纸：必填标题、默认值正确', () => {
  const parsed = parseWallpaperCreate({ title: '  夜雨 霓虹  ' });
  assert.equal(parsed.title, '夜雨 霓虹');
  assert.equal(parsed.kind, 'static');
  assert.equal(parsed.categoryId, null);
  assert.deepEqual(parsed.tags, []);
  assert.equal(parsed.featured, false);

  assert.equal(codeOf(() => parseWallpaperCreate({})), 'bad_request');
  assert.equal(codeOf(() => parseWallpaperCreate({ title: 'x'.repeat(121) })), 'bad_request');
});

test('分类引用：空字符串等于未分类，非法 id 被拒', () => {
  assert.equal(cleanCategoryRef(''), null);
  assert.equal(cleanCategoryRef(null), null);
  assert.equal(cleanCategoryRef('cat_dynamic'), 'cat_dynamic');
  assert.equal(codeOf(() => cleanCategoryRef('a b')), 'bad_request');
  assert.equal(codeOf(() => cleanCategoryRef('x'.repeat(65))), 'bad_request');
});

test('标签只接受词表内的四个词', () => {
  assert.deepEqual(cleanTags('动漫, 游戏'), ['动漫', '游戏']);
  assert.deepEqual(cleanTags(['自然风景', '自然风景']), ['自然风景']);
  assert.deepEqual(cleanTags(''), []);
  assert.deepEqual(cleanTags(undefined), []);

  // 词表外的词直接拒绝，并告诉调用方合法值
  assert.equal(codeOf(() => cleanTags('示例')), 'bad_request');
  assert.equal(codeOf(() => cleanTags('动漫,夜景')), 'bad_request');
});

test('PATCH 壁纸：没有字段可改时报错，status 必须合法', () => {
  assert.equal(codeOf(() => parseWallpaperPatch({})), 'bad_request');
  assert.equal(codeOf(() => parseWallpaperPatch({ status: 'live' })), 'bad_request');
  assert.deepEqual(parseWallpaperPatch({ status: 'published' }), { status: 'published' });
  // 显式传 null 表示清空分类，与「不传」必须区分
  assert.deepEqual(parseWallpaperPatch({ categoryId: null }), { categoryId: null });
});

test('密码强度：至少 10 位、两类字符、拒绝常见弱口令', () => {
  assert.equal(codeOf(() => cleanPassword('short1')), 'bad_request');
  assert.equal(codeOf(() => cleanPassword('aaaaaaaaaaaa')), 'bad_request');
  assert.equal(codeOf(() => cleanPassword('password123')), 'bad_request');
  assert.equal(cleanPassword('Folia-2026-x'), 'Folia-2026-x');
});

test('登录参数只做长度防御，不泄漏规则细节', () => {
  assert.equal(codeOf(() => parseLogin({ email: '', password: '' })), 'bad_request');
  const parsed = parseLogin({ email: ' A@B.CO ', password: 'whatever-1' });
  assert.equal(parsed.email, 'a@b.co');
});

test('新建分类：名称必填，isPublic 默认 true', () => {
  const parsed = parseCategoryCreate({ name: ' 极简 ' });
  assert.equal(parsed.name, '极简');
  assert.equal(parsed.isPublic, true);
  assert.equal(codeOf(() => parseCategoryCreate({ name: '' })), 'bad_request');
});

test('排序与分页参数有边界', () => {
  assert.equal(parseSort(null), 'recent');
  assert.equal(codeOf(() => parseSort('random')), 'bad_request');
  assert.equal(parseLimit(null), 24);
  assert.equal(parseLimit('500', { max: 100 }), 100);
  assert.equal(codeOf(() => parseLimit('0')), 'bad_request');
  assert.equal(codeOf(() => parseLimit('abc')), 'bad_request');

  assert.equal(parsePage(null), 1);
  assert.equal(parsePage('3'), 3);
  assert.equal(codeOf(() => parsePage('0')), 'bad_request');
  assert.equal(codeOf(() => parsePage('-2')), 'bad_request');
  assert.equal(codeOf(() => parsePage('abc')), 'bad_request');
});
