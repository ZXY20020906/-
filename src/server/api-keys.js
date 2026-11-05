/**
 * 公开 API key 的解析与限流（第三期）。
 *
 * 支持两种携带方式（同时给时以 Authorization 为准）：
 *   1. `Authorization: Bearer <key>`     —— 推荐；不会进日志/Referer/浏览器历史
 *   2. `?key=<key>`                       —— 给不方便设头的客户端兜底
 *
 * 安全要点：
 *   - 服务端只存 `sha256(key)`；本文件只把 key 哈希后拿去查库，明文不落库、不写日志；
 *   - key 无效/停用 → 401 `api_key_invalid`（而不是静默降级成匿名，否则配额形同虚设）；
 *   - **没有带 key** 的请求不查库、按 IP 限流（120/min），所以匿名路径不增加 D1 读；
 *   - 表还没迁移（schema/018 未执行）时查库会失败 —— 只 warn 一次并回落匿名，
 *     绝不能因为「限流表没建好」把公开接口打成 500。
 */
import { Q } from './queries.js';
import { first, run } from './db.js';
import { sha256Hex } from './util.js';

/** key 的格式：`flk_` + base64url；放宽到 16~200 位，方便以后换长度。 */
const KEY_RE = /^[A-Za-z0-9_-]{16,200}$/;

/** 默认每分钟上限（有 key）。环境变量 API_KEY_RPM 可覆盖默认值。 */
export const DEFAULT_KEY_RPM = 600;

/** `last_used_at` 的写节流：60 秒内不重复 UPDATE，避免每个请求一次 D1 写。 */
export const TOUCH_INTERVAL_MS = 60_000;

/** 从请求里取原始 key（不校验存在性）。没有就返回 null。 */
export function readApiKey(request, url) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) {
    const value = match[1].trim();
    return value || null;
  }
  const fromQuery = url?.searchParams?.get('key');
  return fromQuery ? String(fromQuery).trim() : null;
}

/** 格式校验：不合法直接当成「无效 key」，而不是忽略。 */
export function isValidKeyFormat(raw) {
  return typeof raw === 'string' && KEY_RE.test(raw);
}

let warnedMissingTable = false;

/**
 * 按明文 key 查库。
 *
 * 返回三态（不能只返回 null：要区分「key 不存在」和「表没建好」）：
 *   - `{ key: {...} }`      找到且 active；
 *   - `{ key: null }`       格式合法但查不到 / 已停用 ⇒ 调用方应 401；
 *   - `{ unavailable: true }` 查库本身失败（schema/018 未执行等）⇒ 回落匿名限流，不 500。
 *
 * @returns {Promise<{key: {id:string,label:string,rpm:number,last_used_at:number|null}|null, unavailable?: boolean}>}
 */
export async function findApiKey(env, raw) {
  if (!isValidKeyFormat(raw)) return { key: null };
  const hash = await sha256Hex(raw);
  try {
    const row = await first(env, Q.apiKeyByHash, hash);
    if (!row) return { key: null };
    if (row.active === 0 || row.active === false) return { key: null };
    const rpm = Number(row.rpm);
    return {
      key: {
        id: row.id,
        label: row.label ?? '',
        rpm: Number.isFinite(rpm) && rpm > 0 ? rpm : DEFAULT_KEY_RPM,
        last_used_at: row.last_used_at ?? null,
      },
    };
  } catch (error) {
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.warn('[api-key] 查 api_keys 失败（schema/018 未执行？），本次回落匿名限流', error?.message ?? error);
    }
    return { key: null, unavailable: true };
  }
}

/**
 * 记录使用时间（节流）。失败只 warn：统计是旁路，不能把公开读取卡住。
 * @param {object} key findApiKey() 的返回值
 * @param {number} now
 */
export async function touchApiKey(env, key, now = Date.now()) {
  if (!key) return;
  const last = Number(key.last_used_at ?? 0);
  if (last && now - last < TOUCH_INTERVAL_MS) return;
  try {
    await run(env, Q.touchApiKey, now, key.id);
  } catch (error) {
    console.warn('[api-key] 更新 last_used_at 失败', error?.message ?? error);
  }
}
