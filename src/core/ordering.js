/**
 * 排序与重排的纯函数：必须先校验「提交的 id 集合 == 库里的 id 集合」，
 * 否则一个越权请求就能把别人的壁纸顺序改乱或凭空插入不存在的 id。
 */
import { badRequest } from './errors.js';

export const SORT_STEP = 10;

export function nextSortOrder(rows) {
  let max = 0;
  for (const row of rows ?? []) {
    const value = Number(row.sort_order ?? row.sortOrder ?? 0);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + SORT_STEP;
}

/**
 * @param {string[]} currentIds 库里现有的全部 id（按当前顺序）
 * @param {string[]} orderedIds 前端提交的新顺序
 * @returns {{id:string, sortOrder:number}[]}
 */
export function buildReorderPlan(currentIds, orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw badRequest('ids 必须是非空数组');
  }
  if (orderedIds.length !== new Set(orderedIds).size) {
    throw badRequest('ids 中存在重复项');
  }
  const current = new Set(currentIds);
  if (orderedIds.length !== current.size) {
    throw badRequest(`需要提交全部 ${current.size} 项，实际提交 ${orderedIds.length} 项`);
  }
  for (const id of orderedIds) {
    if (!current.has(id)) throw badRequest(`未知的 id：${id}`);
  }
  return orderedIds.map((id, index) => ({ id, sortOrder: (index + 1) * SORT_STEP }));
}
