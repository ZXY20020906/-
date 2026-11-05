/** D1 的小包装，避免每处都写 env.DB.prepare(...).bind(...)。 */

export function nowMs() {
  return Date.now();
}

export async function all(env, sql, ...binds) {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result?.results ?? [];
}

export async function first(env, sql, ...binds) {
  return (await env.DB.prepare(sql).bind(...binds).first()) ?? null;
}

export async function run(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds).run();
}

export function statement(env, sql, ...binds) {
  return env.DB.prepare(sql).bind(...binds);
}

export async function batch(env, statements) {
  if (!statements.length) return [];
  return env.DB.batch(statements);
}

export async function count(env, sql, ...binds) {
  const row = await first(env, sql, ...binds);
  return Number(row?.n ?? 0);
}

/**
 * D1 不可用（额度耗尽 / 表或列缺失 / 绑定失效）的可识别错误。
 *
 * 公开只读接口遇到这些错误时不应把整站打成 500：生产库的 `tag_aliases` / `api_keys`
 * 曾经因为迁移没跑而在线上缺失，而本地 sqlite 夹具是全量 schema，测试永远绿。
 * 现在统一由 public-api 回落「最近一次成功导出的快照」，并把原始错误写日志。
 *
 * 注意只匹配**数据库层**错误；业务代码的 TypeError 不在这里，免得把真 bug 藏进快照。
 */
export function isD1Unavailable(error) {
  const message = String(error?.message ?? error ?? '');
  if (!message) return false;
  return /7500|exceeded D1's free tier|no such table|no such column|database is locked|D1_ERROR|D1 binding|Network connection lost|Cannot read properties of undefined \(reading 'prepare'\)/i.test(message);
}

/** 免费额度/限流型错误：可以触发短时熔断，避免每个请求都去撞一次 D1。 */
export function isD1QuotaError(error) {
  const message = String(error?.message ?? error ?? '');
  return /7500|exceeded D1's free tier/i.test(message);
}
