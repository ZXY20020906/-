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
