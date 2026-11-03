import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION, ROLE, capabilitiesFor, can, assertCan, matrix,
} from '../src/core/permissions.js';

const admin = { id: 'a', role: ROLE.ADMIN, active: true };
const editor = { id: 'e', role: ROLE.EDITOR, active: true };
const disabled = { id: 'd', role: ROLE.ADMIN, active: false };

test('管理员拥有全部动作，编辑只有上传与自己的草稿', () => {
  assert.ok(can(admin, ACTION.WALLPAPER_DELETE));
  assert.ok(can(admin, ACTION.CATEGORY_DELETE));
  assert.ok(can(admin, ACTION.MEMBER_MANAGE));
  assert.ok(can(admin, ACTION.AUDIT_READ));

  assert.ok(can(editor, ACTION.WALLPAPER_CREATE));
  assert.equal(can(editor, ACTION.WALLPAPER_DELETE), false);
  assert.equal(can(editor, ACTION.WALLPAPER_PUBLISH), false);
  assert.equal(can(editor, ACTION.CATEGORY_CREATE), false);
  assert.equal(can(editor, ACTION.CATEGORY_DELETE), false);
  assert.equal(can(editor, ACTION.MEMBER_MANAGE), false);
  assert.equal(can(editor, ACTION.AUDIT_READ), false);
});

test('归属规则：编辑只能改自己上传的壁纸', () => {
  assert.ok(can(editor, ACTION.WALLPAPER_UPDATE, { created_by: 'e' }));
  assert.equal(can(editor, ACTION.WALLPAPER_UPDATE, { created_by: 'a' }), false);
  assert.equal(can(editor, ACTION.WALLPAPER_UPDATE, null), false);

  // 管理员不受归属限制
  assert.ok(can(admin, ACTION.WALLPAPER_UPDATE, { created_by: 'e' }));
});

test('未登录 / 停用账号一律拒绝', () => {
  assert.equal(can(null, ACTION.WALLPAPER_READ), false);
  assert.equal(can(undefined, ACTION.WALLPAPER_READ), false);
  assert.equal(can(disabled, ACTION.WALLPAPER_READ), false);
  assert.throws(() => assertCan(disabled, ACTION.WALLPAPER_READ), /账号不可用/);
});

test('assertCan 抛出 403 且带 required 细节', () => {
  try {
    assertCan(editor, ACTION.WALLPAPER_DELETE);
    assert.fail('应当抛错');
  } catch (error) {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'forbidden');
    assert.equal(error.details.required, ACTION.WALLPAPER_DELETE);
  }
});

test('能力集合稳定且无重复', () => {
  for (const role of Object.values(ROLE)) {
    const caps = capabilitiesFor(role);
    assert.equal(caps.length, new Set(caps).size, `${role} 有重复能力`);
    assert.ok(caps.includes(ACTION.WALLPAPER_UPDATE));
  }
  const editorCaps = capabilitiesFor(ROLE.EDITOR);
  assert.ok(editorCaps.includes('wallpaper:update:own'));
  assert.ok(!editorCaps.includes('wallpaper:update:any'));
});

test('matrix() 与 can() 结果一致', () => {
  for (const row of matrix()) {
    for (const action of row.actions) {
      const actor = { id: 'probe', role: row.role, active: true };
      assert.ok(can(actor, action, { created_by: 'probe' }), `${row.role} 应能 ${action}`);
    }
    assert.equal(row.canEditOwnWallpaper, true);
    assert.equal(row.canEditOthersWallpaper, row.role === ROLE.ADMIN);
  }
});
