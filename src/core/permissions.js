/**
 * 权限矩阵 —— 全站唯一的鉴权真相。
 *
 * 设计要点：
 * 1. 角色只有两种：admin（管理员）、editor（编辑）。够用、可审计、加角色不影响现有代码。
 * 2. 权限用「能力字符串」表达，路由层只问 can(actor, ACTION.X, resource)。
 * 3. 归属规则只对「编辑自己的壁纸」生效：editor 有 update:own，只能改 created_by === 自己的行。
 * 4. 发布（publish）默认只给 admin —— 编辑上传的是草稿，管理员审过再上线。
 *    若你希望编辑能直接发布，把 ACTION.WALLPAPER_PUBLISH 加进 EDITOR_CAPS 即可。
 */
import { forbidden } from './errors.js';

export const ROLE = Object.freeze({ ADMIN: 'admin', EDITOR: 'editor' });
export const ROLES = Object.freeze([ROLE.ADMIN, ROLE.EDITOR]);
export const ROLE_LABELS = Object.freeze({ admin: '管理员', editor: '编辑' });
export const ROLE_HINTS = Object.freeze({
  admin: '可管理分类、成员、发布与删除任何壁纸，可查审计日志',
  editor: '可上传壁纸并维护自己上传的草稿，可选择已有分类，不能发布/删除',
});

export const ACTION = Object.freeze({
  WALLPAPER_READ: 'wallpaper:read',
  WALLPAPER_CREATE: 'wallpaper:create',
  WALLPAPER_UPDATE: 'wallpaper:update',
  WALLPAPER_DELETE: 'wallpaper:delete',
  WALLPAPER_PUBLISH: 'wallpaper:publish',
  WALLPAPER_REORDER: 'wallpaper:reorder',
  ASSET_UPLOAD: 'asset:upload',
  CATEGORY_READ: 'category:read',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',
  CATEGORY_REORDER: 'category:reorder',
  MEMBER_MANAGE: 'member:manage',
  AUDIT_READ: 'audit:read',
});

/** 内部能力：不对外当 action 用，只被 can() 消费。 */
const CAP = Object.freeze({
  UPDATE_ANY: 'wallpaper:update:any',
  UPDATE_OWN: 'wallpaper:update:own',
});

const ALL_ACTIONS = Object.freeze(Object.values(ACTION));

const EDITOR_CAPS = Object.freeze([
  ACTION.WALLPAPER_READ,
  ACTION.WALLPAPER_CREATE,
  ACTION.WALLPAPER_UPDATE,
  CAP.UPDATE_OWN,
  ACTION.ASSET_UPLOAD,
  ACTION.CATEGORY_READ,
]);

const ADMIN_CAPS = Object.freeze([
  ...ALL_ACTIONS,
  CAP.UPDATE_ANY,
  CAP.UPDATE_OWN,
]);

export const ROLE_CAPABILITIES = Object.freeze({
  [ROLE.ADMIN]: ADMIN_CAPS,
  [ROLE.EDITOR]: EDITOR_CAPS,
});

const CAP_SETS = Object.freeze({
  [ROLE.ADMIN]: new Set(ADMIN_CAPS),
  [ROLE.EDITOR]: new Set(EDITOR_CAPS),
});

const EMPTY = new Set();

export function capabilitiesOf(role) {
  return CAP_SETS[role] ?? EMPTY;
}

export function isActive(actor) {
  if (!actor) return false;
  return actor.active !== false && actor.active !== 0;
}

/**
 * @param {{id:string, role:string, active?:boolean|number}|null} actor
 * @param {string} action  ACTION.* 之一
 * @param {{created_by?:string}|null} [resource] 归属判断用；非归属动作可省略
 */
export function can(actor, action, resource = null) {
  if (!isActive(actor)) return false;
  const caps = capabilitiesOf(actor.role);
  if (!caps.has(action)) return false;

  if (action === ACTION.WALLPAPER_UPDATE) {
    if (caps.has(CAP.UPDATE_ANY)) return true;
    if (caps.has(CAP.UPDATE_OWN)) {
      return Boolean(resource) && resource.created_by === actor.id;
    }
    return false;
  }
  return true;
}

export function assertCan(actor, action, resource = null) {
  if (can(actor, action, resource)) return;
  if (!isActive(actor)) throw forbidden('账号不可用或未登录');
  throw forbidden(`缺少权限：${action}`, { required: action, role: actor.role ?? null });
}

/** 给前端 /api/auth/me 与文档用：把能力集合摊平成数组。 */
export function capabilitiesFor(role) {
  return [...capabilitiesOf(role)].sort();
}

/** 生成权限矩阵（测试和文档共用同一份数据，避免文档与实现漂移）。 */
export function matrix() {
  return ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    capabilities: capabilitiesFor(role),
    actions: ALL_ACTIONS.filter((a) => {
      const probe = { id: 'probe', role, active: true };
      // 归属型动作单独测两种情况
      if (a === ACTION.WALLPAPER_UPDATE) {
        return can(probe, a, { created_by: 'probe' });
      }
      return can(probe, a);
    }),
    canEditOwnWallpaper: can({ id: 'probe', role, active: true }, ACTION.WALLPAPER_UPDATE, { created_by: 'probe' }),
    canEditOthersWallpaper: can({ id: 'probe', role, active: true }, ACTION.WALLPAPER_UPDATE, { created_by: 'other' }),
  }));
}
