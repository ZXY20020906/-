/**
 * 登录限流：按 isolate 内存计的滑动窗口。
 * 说明：Workers 每个实例内存独立，这不是精确的全局限流，
 * 但足以挡住「同 IP 小规模爆破」；需要严格限流时接 Durable Object 或 Turnstile。
 */
const buckets = new Map();
const MAX_KEYS = 5000;

/**
 * @param {string} key
 * @param {{max?: number, windowMs?: number}} [options]
 * @returns {{limited: boolean, retryAfter: number, remaining: number}}
 */
export function hit(key, { max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, v] of buckets) {
      if (now > v.resetAt) buckets.delete(k);
      if (buckets.size <= MAX_KEYS / 2) break;
    }
  }
  const entry = buckets.get(key);
  if (!entry || now > entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false, retryAfter: 0, remaining: max - 1 };
  }
  entry.count += 1;
  if (entry.count > max) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000), remaining: 0 };
  }
  return { limited: false, retryAfter: 0, remaining: max - entry.count };
}

export function reset(key) {
  buckets.delete(key);
}

/** 仅测试用：清空所有计数。 */
export function resetAll() {
  buckets.clear();
}
