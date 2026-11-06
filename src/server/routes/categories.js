/**
 * 分类接口：
 *   GET    /api/admin/categories           列表（含每个分类的壁纸数）
 *   POST   /api/admin/categories           新建（管理员）
 *   PATCH  /api/admin/categories/:id       改名/描述/公开状态
 *   DELETE /api/admin/categories/:id?strategy=block|detach|move[&to=<分类 id>]
 *   POST   /api/admin/categories/reorder   拖拽排序落库
 *
 * 删除时分类下还有壁纸，有三种收尾方式：
 *   block  默认，直接 409，让前端先问清楚；
 *   detach 把壁纸改成「未分类」，再删分类；
 *   move   把这些壁纸挂到 to 指定的分类上，再删分类。
 */
import { Q } from '../queries.js';
import { all, batch, count, first, run, statement } from '../db.js';
import { nowMs } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import { cleanEnum, cleanId, parseCategoryCreate, parseCategoryPatch } from '../../core/validate.js';
import { uniqueSlug } from '../../core/slug.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { created, json, readJson } from '../http.js';
import { categoryDto } from '../dto.js';
import { buildReorderPlan, nextSortOrder } from '../../core/ordering.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { newId } from '../util.js';
import { rebuildSnapshotQuietly } from '../snapshot.js';

async function loadCategory(env, id) {
  const row = await first(env, Q.categoryById, cleanId(id, 'id'));
  if (!row) throw notFound('分类不存在');
  return row;
}

async function assertNameFree(env, name, exceptId = null) {
  const other = await first(env, Q.categoryByName, name);
  if (other && other.id !== exceptId) throw conflict(`分类名「${name}」已存在`, { field: 'name' });
}

export async function list({ env, actor }) {
  assertCan(actor, ACTION.CATEGORY_READ);
  const rows = await all(env, Q.listCategories);
  return json({ categories: rows.map(categoryDto) });
}

/** 下拉选择用：所有登录成员都能读，不额外要权限。 */
export async function options({ env, actor }) {
  assertCan(actor, ACTION.CATEGORY_READ);
  const rows = await all(env, Q.listCategories);
  return json({
    categories: rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      isPublic: row.is_public === 1,
      wallpaperCount: Number(row.wallpaper_count ?? 0),
    })),
  });
}

/** 标签分类的统计（后台「分类」页展示用） */
export async function tagStats({ env, actor }) {
  assertCan(actor, ACTION.CATEGORY_READ);
  const [tagRows, countRows] = [await all(env, Q.listTags), await all(env, Q.adminTagStats)];
  const counts = new Map(countRows.map((row) => [row.tag, Number(row.n ?? 0)]));
  return json({
    tags: tagRows.map((row) => ({ tag: row.name, count: counts.get(row.name) ?? 0 })),
  });
}

export async function create({ env, actor, request }) {
  assertCan(actor, ACTION.CATEGORY_CREATE);
  const input = parseCategoryCreate(await readJson(request));
  await assertNameFree(env, input.name);

  const slug = await uniqueSlug(
    input.slug || input.name,
    async (candidate) => Boolean(await first(env, Q.categoryBySlug, candidate)),
    { fallback: 'category', max: 60 },
  );
  const maxSort = Number((await first(env, Q.maxCategorySort))?.m ?? 0);
  const sortOrder = nextSortOrder([{ sort_order: maxSort }]);
  const id = newId('cat');
  const now = nowMs();

  await run(env, Q.insertCategory, id, slug, input.name, input.description, sortOrder, input.isPublic ? 1 : 0, actor.id, now, now);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.CATEGORY_CREATE,
    targetType: 'category',
    targetId: id,
    detail: input.name,
  });

  const row = await first(env, Q.categoryById, id);
  return created({ category: categoryDto(row) });
}

export async function update({ env, actor, request, params }) {
  assertCan(actor, ACTION.CATEGORY_UPDATE);
  const row = await loadCategory(env, params.id);
  const patch = parseCategoryPatch(await readJson(request));
  if (patch.name && patch.name !== row.name) await assertNameFree(env, patch.name, row.id);

  const next = {
    name: patch.name ?? row.name,
    description: patch.description ?? row.description,
    isPublic: patch.isPublic !== undefined ? patch.isPublic : row.is_public === 1,
    sortOrder: patch.sortOrder ?? Number(row.sort_order ?? 0),
  };

  await run(env, Q.updateCategory, next.name, next.description, next.isPublic ? 1 : 0, next.sortOrder, nowMs(), row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.CATEGORY_UPDATE,
    targetType: 'category',
    targetId: row.id,
    detail: `字段：${Object.keys(patch).join(', ')}`,
  });

  const fresh = await first(env, Q.categoryById, row.id);
  // 阶段三：`is_public` 是公开快照的准入条件（A 方案）。改公开/隐藏、改名、改排序
  // 都会改变公开接口的输出，所以要重建快照 —— 否则「隐藏分类」要等下一次定时重建才生效。
  await rebuildSnapshotQuietly(env, '编辑分类');
  return json({ category: categoryDto(fresh) });
}

/** strategy=move 时解析目标分类：必须存在，且不能是被删的这一个。 */
async function loadMoveTarget(env, url, source) {
  const raw = url.searchParams.get('to');
  if (!raw) throw badRequest('strategy=move 需要同时提供 to=<目标分类 id>', { field: 'to' });
  const target = await first(env, Q.categoryById, cleanId(raw, 'to'));
  if (!target) throw notFound('目标分类不存在');
  if (target.id === source.id) throw badRequest('不能把壁纸迁移到正在删除的分类', { field: 'to' });
  return target;
}

export async function remove({ env, actor, url, params }) {
  assertCan(actor, ACTION.CATEGORY_DELETE);
  const row = await loadCategory(env, params.id);
  const strategy = cleanEnum(url.searchParams.get('strategy') ?? 'block', 'strategy', ['block', 'detach', 'move']);
  const used = await count(env, Q.countWallpapersInCategory, row.id);

  if (used > 0 && strategy === 'block') {
    throw conflict(`「${row.name}」下还有 ${used} 张壁纸，请先移走，或改为未分类 / 迁移到其他分类后再删`, {
      wallpaperCount: used,
      categoryId: row.id,
      strategies: ['detach', 'move'],
    });
  }

  // 就算当前分类是空的，只要显式指定了 move，也把目标校验一遍，避免前端拼错 id 时静默成功
  const target = strategy === 'move' ? await loadMoveTarget(env, url, row) : null;

  const now = nowMs();
  const statements = [];
  if (used > 0 && target) {
    statements.push(statement(env, Q.moveWallpapersToCategory, target.id, now, row.id));
  } else if (used > 0) {
    statements.push(statement(env, Q.detachWallpapersFromCategory, now, row.id));
  }
  statements.push(statement(env, Q.deleteCategory, row.id));
  await batch(env, statements);

  const moved = used > 0 && target ? used : 0;
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.CATEGORY_DELETE,
    targetType: 'category',
    targetId: row.id,
    detail: moved
      ? `${row.name}（${moved} 张壁纸迁到「${target.name}」）`
      : used > 0 ? `${row.name}（${used} 张壁纸转为未分类）` : row.name,
  });

  return json({ deleted: true, id: row.id, detached: used - moved, moved, to: target ? target.id : null });
}

export async function reorder({ env, actor, request }) {
  assertCan(actor, ACTION.CATEGORY_REORDER);
  const body = await readJson(request);
  if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');

  const rows = await all(env, Q.listCategories);
  const plan = buildReorderPlan(rows.map((r) => r.id), body.ids);
  const now = nowMs();
  await batch(env, plan.map((item) => statement(env, Q.updateCategorySort, item.sortOrder, now, item.id)));

  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.CATEGORY_REORDER,
    targetType: 'category',
    targetId: 'all',
    detail: `重排 ${plan.length} 个分类`,
  });

  return json({ reordered: plan.length });
}
