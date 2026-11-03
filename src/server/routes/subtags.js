/**
 * 子标签字典（分类页第三块）：
 *   GET    /api/admin/subtags[?tag=标签名]   列表（可按标签过滤）
 *   POST   /api/admin/subtags                新建 {tagId?, name}
 *   DELETE /api/admin/subtags/:id            删除
 *
 * 作品上的 subtag 仍是文本，这里只维护「可选项」和归属。
 */
import { Q } from '../queries.js';
import { all, first, run } from '../db.js';
import { nowMs } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import { cleanId, cleanText } from '../../core/validate.js';
import { conflict, notFound } from '../../core/errors.js';
import { created, json } from '../http.js';
import { AUDIT_ACTION, writeAudit } from '../audit.js';
import { newId } from '../util.js';

function subtagDto(row) {
  return {
    id: row.id,
    name: row.name,
    tagId: row.tag_id ?? null,
    tagName: row.tag_name ?? null,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export async function list({ env, actor, url }) {
  assertCan(actor, ACTION.CATEGORY_READ);
  const rows = await all(env, Q.listSubtagsAdmin);
  const wanted = String(url?.searchParams.get('tag') ?? '').trim();
  const filtered = wanted ? rows.filter((row) => row.tag_name === wanted) : rows;
  return json({ subtags: filtered.map(subtagDto) });
}

export async function create({ env, actor, request }) {
  assertCan(actor, ACTION.CATEGORY_CREATE);
  const body = await request.json().catch(() => ({}));
  const name = cleanText(body.name, 'name', { min: 1, max: 40, collapse: true });
  const tagId = body.tagId ? cleanId(body.tagId, 'tagId') : null;
  if (tagId) {
    const tag = await first(env, Q.tagById, tagId);
    if (!tag) throw notFound('标签不存在');
  }
  if (await first(env, Q.subtagByName, tagId, name)) {
    throw conflict(`子标签「${name}」已经存在`, { field: 'name' });
  }
  const maxSort = Number((await first(env, Q.maxSubtagSort, tagId))?.m ?? 0);
  const id = newId('st');
  await run(env, Q.insertSubtag, id, tagId, name, maxSort + 10, nowMs());
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.TAG_CREATE,
    targetType: 'subtag',
    targetId: id,
    detail: name,
  });
  const row = (await all(env, Q.listSubtagsAdmin)).find((item) => item.id === id);
  return created({ subtag: subtagDto(row) });
}

/** 把子标签挂到某个标签下（或改回未归类）。 */
export async function update({ env, actor, request, params }) {
  assertCan(actor, ACTION.CATEGORY_UPDATE);
  const row = await first(env, Q.subtagById, cleanId(params.id, 'id'));
  if (!row) throw notFound('子标签不存在');
  const body = await request.json().catch(() => ({}));
  const tagId = body.tagId ? cleanId(body.tagId, 'tagId') : null;
  if (tagId) {
    const tag = await first(env, Q.tagById, tagId);
    if (!tag) throw notFound('标签不存在');
  }
  if (await first(env, Q.subtagByName, tagId, row.name)) {
    throw conflict(`那个标签下已经有「${row.name}」了`);
  }
  const maxSort = Number((await first(env, Q.maxSubtagSort, tagId))?.m ?? 0);
  await run(env, Q.updateSubtagTag, tagId, maxSort + 10, row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.TAG_UPDATE,
    targetType: 'subtag',
    targetId: row.id,
    detail: `${row.name} 归类`,
  });
  return json({ updated: true, id: row.id, tagId });
}

export async function remove({ env, actor, params }) {  assertCan(actor, ACTION.CATEGORY_DELETE);
  const row = await first(env, Q.subtagById, cleanId(params.id, 'id'));
  if (!row) throw notFound('子标签不存在');
  await run(env, Q.deleteSubtag, row.id);
  await writeAudit(env, {
    actor,
    action: AUDIT_ACTION.TAG_DELETE,
    targetType: 'subtag',
    targetId: row.id,
    detail: row.name,
  });
  return json({ deleted: true, id: row.id });
}
