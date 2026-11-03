/** 审计日志查询（仅管理员）。 */
import { Q } from '../queries.js';
import { all } from '../db.js';
import { ACTION, assertCan } from '../../core/permissions.js';
import { parseLimit } from '../../core/validate.js';
import { json } from '../http.js';
import { auditDto } from '../dto.js';

export async function list({ env, actor, url }) {
  assertCan(actor, ACTION.AUDIT_READ);
  const limit = parseLimit(url.searchParams.get('limit'), { def: 100, max: 200 });
  const rows = await all(env, Q.listAudit, limit);
  return json({ items: rows.map(auditDto), limit });
}
