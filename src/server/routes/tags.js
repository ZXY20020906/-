/**
 * 标签管理（后台「分类」页的第二块）。
 * 权限沿用分类那套：能管分类的人就能管标签。
 */
import { Q } from '../queries.js';
import { all, batch, count, first, run, statement } from '../db.js';
import { nowMs } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import { cleanId, cleanText } from '../../core/validate.js';
import { normalizeTag } from '../../core/tag-vocabulary.js';
import { buildReorderPlan, nextSortOrder } from '../../core/ordering.js';
import { created, json, readJson } from '../http.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { newId } from '../util.js';

function tagDto(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: Number(row.sort_order ?? 0),
    // null = 全局标签（所有分类都显示）
    categoryId: row.category_id ?? null,
  };
}

/** 标签归属：空 = 全局；否则必须是存在的分类。 */
async function cleanCategoryId(env, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const id = cleanId(value, 'categoryId');
  const row = await first(env, Q.categoryById, id);
  if (!row) throw badRequest('分类不存在', { field: 'categoryId' });
  return id;
}

async function loadTag(env, id) {
  const row = await first(env, Q.tagById, cleanId(id, 'id'));
  if (!row) throw notFound('标签不存在');
  return row;
}

async function assertNameFree(env, name, exceptId = null) {
  const other = await first(env, Q.tagByName, name);
  if (other && other.id !== exceptId) throw conflict(`标签「${name}」已存在`, { field: 'name' });
}

export async function list({ env, actor }) {
  assertCan(actor, ACTION.CATEGORY_READ);
  const rows = await all(env, Q.listTags);
  return json({ tags: rows.map(tagDto) });
}

export async function create({ env, actor, request }) {
  assertCan(actor, ACTION.CATEGORY_CREATE);
  const body = await readJson(request);
  // 词表归一：新建「anime」会落到「动漫」；若已存在则走 conflict，而不是造出第二个同义标签
  const name = normalizeTag(cleanText(body.name, 'name', { min: 1, max: 24, collapse: true }));
  const categoryId = (await cleanCategoryId(env, body.categoryId)) ?? null;
  await assertNameFree(env, name);

  const maxSort = Number((await first(env, Q.maxTagSort))?.m ?? 0);
  const sortOrder = nextSortOrder([{ sort_order: maxSort }]);
  const id = newId('tag');
  const now = nowMs();
  await run(env, Q.insertTag, id, name, sortOrder, categoryId, now, now);
  await writeAudit(env, { actor, action: AUDIT_ACTION.TAG_CREATE, targetType: 'tag', targetId: id, detail: name });

  const row = await first(env, Q.tagById, id);
  return created({ tag: tagDto(row) });
}

export async function update({ env, actor, request, params }) {
  assertCan(actor, ACTION.CATEGORY_UPDATE);
  const row = await loadTag(env, params.id);
  const body = await readJson(request);
  const name = body.name === undefined
    ? row.name
    : normalizeTag(cleanText(body.name, 'name', { min: 1, max: 24, collapse: true }));
  if (name !== row.name) await assertNameFree(env, name, row.id);

  const categoryId = body.categoryId === undefined
    ? (row.category_id ?? null)
    : await cleanCategoryId(env, body.categoryId);
  const sortOrder = body.sortOrder === undefined ? Number(row.sort_order ?? 0) : Number(body.sortOrder);
  await run(env, Q.updateTag, name, sortOrder, categoryId, nowMs(), row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.TAG_UPDATE,
    targetType: 'tag',
    targetId: row.id,
    detail: name === row.name ? '排序 / 归属' : `${row.name} → ${name}`,
  });

  const fresh = await first(env, Q.tagById, row.id);
  return json({ tag: tagDto(fresh) });
}

export async function remove({ env, actor, params }) {
  assertCan(actor, ACTION.CATEGORY_DELETE);
  const row = await loadTag(env, params.id);
  const used = await count(env, Q.countWallpapersWithTag, row.name);
  if (used > 0) {
    throw conflict(`「${row.name}」还有 ${used} 件作品在用，先去改掉那些作品再删`, {
      wallpaperCount: used,
      tagId: row.id,
    });
  }
  await run(env, Q.deleteTag, row.id);
  await writeAudit(env, { actor, action: AUDIT_ACTION.TAG_DELETE, targetType: 'tag', targetId: row.id, detail: row.name });
  return json({ deleted: true, id: row.id });
}

export async function reorder({ env, actor, request }) {
  assertCan(actor, ACTION.CATEGORY_REORDER);
  const body = await readJson(request);
  if (!Array.isArray(body.ids)) throw badRequest('ids 必须是数组');

  const rows = await all(env, Q.listTags);
  const plan = buildReorderPlan(rows.map((r) => r.id), body.ids);
  const now = nowMs();
  await batch(env, plan.map((item) => statement(env, Q.updateTagSort, item.sortOrder, now, item.id)));
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.TAG_REORDER,
    targetType: 'tag',
    targetId: 'all',
    detail: `重排 ${plan.length} 个标签`,
  });
  return json({ reordered: plan.length });
}

/** 编辑作品时用来校验标签合法性 */
export async function allowedTagNames(env) {
  const rows = await all(env, Q.listTags);
  return rows.map((row) => row.name);
}
