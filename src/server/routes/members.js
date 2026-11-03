/**
 * 成员与角色接口（仅管理员）：
 *   GET   /api/admin/members
 *   POST  /api/admin/members        建号（管理员直接设初始密码，让对方首次登录后自行修改）
 *   PATCH /api/admin/members/:id    改邮箱/姓名/角色/启停/重置密码
 *   DELETE /api/admin/members/:id   删号（必须带 body: {password: 自己的登录密码}）
 *
 * 几条硬规则，防止把自己锁在门外：
 *   1. 不能改自己的角色、不能停用自己；
 *   2. 全站至少要留一个「启用中的管理员」；
 *   3. 删人必须复核操作者本人的密码，防止会话被借用时误删。
 */
import { Q } from '../queries.js';
import { all, count, first, run } from '../db.js';
import { nowMs } from '../db.js';
import { ACTION, assertCan, ROLE } from '../../core/permissions.js';
import { cleanId, parseMemberCreate, parseMemberPatch } from '../../core/validate.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { userDto } from '../dto.js';
import { hashPassword } from '../password.js';
import { destroyAllSessions } from '../session.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { newId, constantTimeEqual, sha256Hex } from '../util.js';
import { hit } from '../rate-limit.js';

async function loadMember(env, id) {
  const row = await first(env, Q.userById, cleanId(id, 'id'));
  if (!row) throw notFound('成员不存在');
  return row;
}

export async function list({ env, actor }) {
  assertCan(actor, ACTION.MEMBER_MANAGE);
  const rows = await all(env, Q.listUsers);
  return json({ members: rows.map(userDto) });
}

export async function create({ env, actor, request }) {
  assertCan(actor, ACTION.MEMBER_MANAGE);
  const input = parseMemberCreate(await readJson(request));

  const existing = await first(env, Q.userByEmail, input.email);
  if (existing) throw conflict('该邮箱已被使用', { field: 'email' });

  const hashed = await hashPassword(input.password);
  const now = nowMs();
  const id = newId('usr');
  await run(
    env, Q.insertUser,
    id, input.email, input.name, input.role,
    hashed.hash, hashed.salt, hashed.iterations, 1, now, now,
  );

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.MEMBER_CREATE,
    targetType: 'member',
    targetId: id,
    detail: `${input.email}（${input.role}）`,
  });

  const row = await first(env, Q.userById, id);
  return created({ member: userDto(row) });
}

export async function update({ env, actor, request, params }) {
  assertCan(actor, ACTION.MEMBER_MANAGE);
  const target = await loadMember(env, params.id);
  const patch = parseMemberPatch(await readJson(request));
  const isSelf = target.id === actor.id;

  if (isSelf && patch.role && patch.role !== target.role) {
    throw badRequest('不能修改自己的角色，请让另一位管理员操作', { field: 'role' });
  }
  if (isSelf && patch.active === false) {
    throw badRequest('不能停用自己', { field: 'active' });
  }
  if (isSelf && patch.password) {
    throw badRequest('修改自己的密码请用「修改密码」入口', { field: 'password' });
  }

  const wasActiveAdmin = target.role === ROLE.ADMIN && (target.active === 1 || target.active === true);
  const losingAdmin = wasActiveAdmin && (
    (patch.role !== undefined && patch.role !== ROLE.ADMIN)
    || patch.active === false
  );
  if (losingAdmin) {
    const admins = await count(env, Q.countActiveAdmins);
    if (admins <= 1) throw conflict('至少要保留一位启用状态的管理员');
  }

  const next = {
    email: patch.email ?? target.email,
    name: patch.name ?? target.name,
    role: patch.role ?? target.role,
    active: patch.active !== undefined ? patch.active : (target.active === 1 || target.active === true),
  };

  if (next.email !== target.email) {
    const clash = await first(env, Q.userByEmail, next.email);
    if (clash && clash.id !== target.id) throw conflict('该邮箱已被使用', { field: 'email' });
  }

  if (patch.password) {
    const hashed = await hashPassword(patch.password);
    await run(env, Q.updateUserPassword, hashed.hash, hashed.salt, hashed.iterations, nowMs(), target.id);
    // 重置密码后，该成员所有旧会话立即失效
    await destroyAllSessions(env, target.id);
  }

  await run(env, Q.updateUserProfile, next.email, next.name, next.role, next.active ? 1 : 0, nowMs(), target.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.MEMBER_UPDATE,
    targetType: 'member',
    targetId: target.id,
    detail: `字段：${Object.keys(patch).join(', ')}${patch.password ? '（密码已重置）' : ''}`,
  });

  const row = await first(env, Q.userById, target.id);
  return json({ member: userDto(row) });
}

/**
 * 删除管理员 / 编辑。
 * 三道保护：不能删自己、不能删掉最后一位启用中的管理员、必须输入删除口令。
 * 口令是站点级的（Cloudflare 里的 ADMIN_PASSCODE 变量），不是操作者自己的登录密码，
 * 所以把会话交给别人时，对方也删不动。
 * 删除会连带注销该成员的所有会话；他上传的壁纸不会消失，只是 created_by 变成 NULL。
 */
export async function remove({ env, actor, request, params }) {
  assertCan(actor, ACTION.MEMBER_MANAGE);
  const target = await loadMember(env, params.id);

  if (target.id === actor.id) throw badRequest('不能删除自己');

  const expected = String(env.ADMIN_PASSCODE ?? '').trim();
  if (!expected) {
    throw forbidden('站点还没配置删除口令：在 Cloudflare Pages 项目里设置 ADMIN_PASSCODE 后重试');
  }

  // 口令爆破限流：15 分钟内最多 5 次（放在读 body 之前，省得先解析一遍请求体；
  // 也放在「是否配置口令」之后 —— 配置缺失是运维问题，不该烧掉用户的尝试次数）
  const rl = hit(`passcode:${actor.id}`, { max: 5, windowMs: 15 * 60 * 1000 });
  if (rl.limited) throw tooManyRequests(`口令尝试过于频繁，请 ${rl.retryAfter} 秒后再试`);

  const body = await readJson(request);
  const given = typeof body.passcode === 'string' ? body.passcode.trim() : '';
  if (!given) throw badRequest('删除成员需要输入删除口令', { field: 'passcode' });

  // 两边都过一遍 sha256 再比（长度固定），比较本身用常量时间，避免逐字节短路泄时间
  const [givenHash, expectedHash] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  if (!constantTimeEqual(givenHash, expectedHash)) {
    await writeAudit(env, {
      actor,
      action: AUDIT_ACTION.LOGIN_FAILED,
      targetType: 'member',
      targetId: target.id,
      detail: '删除成员时口令校验失败',
    });
    throw forbidden('口令不正确，删除未执行', { field: 'passcode' });
  }

  const isActiveAdmin = target.role === ROLE.ADMIN
    && (target.active === 1 || target.active === true);
  if (isActiveAdmin) {
    const admins = await count(env, Q.countActiveAdmins);
    if (admins <= 1) throw conflict('至少要保留一位启用状态的管理员');
  }

  await destroyAllSessions(env, target.id);
  await run(env, Q.deleteUser, target.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.MEMBER_DELETE,
    targetType: 'member',
    targetId: target.id,
    detail: `${target.email}（${target.role}）`,
  });

  return json({ deleted: true, id: target.id });
}
