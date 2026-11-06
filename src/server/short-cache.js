/**
 * 进程内短缓存（阶段四）。
 *
 * 为什么不用 Cache API：`caches.default` 是**边缘缓存**，按 URL 缓存，带 Cookie 的
 * 管理接口不能往里放（会把 A 管理员的列表发给 B）。管理端列表要按「谁在看 + 什么筛选」
 * 区分，天然是进程内键值缓存。
 *
 * 已知局限（和 `rate-limit.js` 同一类）：**只在当前 isolate 内有效**。Cloudflare 会
 * 在不同 colo 起多个 isolate，跨 isolate 的失效最多要等 TTL 过期。所以：
 *   · TTL 一律短（管理端列表 60s）；
 *   · 任何写操作都主动清一次当前 isolate 的缓存；
 *   · 真正的「全局一致」不靠它 —— 公开读已经有阶段三的快照，管理端接受 60s 内的可见性抖动。
 *
 * 容量上限按「条数」而不是字节：一个列表响应约 100–500KB（200 条 DTO），
 * 64 条上限在 Workers 128MB 里是可控的；超了按插入顺序淘汰最老的（FIFO）。
 */
const store = new Map();

/** 组装 key：前缀 + 规范化后的参数数组（顺序由调用方固定，不要用对象字面量）。 */
export function cacheKey(prefix, parts) {
  return `${prefix}${JSON.stringify(parts)}`;
}

export function getCached(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * @param {string} key
 * @param {any} value
 * @param {number} ttlMs <= 0 表示不缓存（测试/排障用）
 * @param {number} [maxEntries]
 */
export function setCached(key, value, ttlMs, maxEntries = 64) {
  if (!(ttlMs > 0)) return;
  if (store.size >= maxEntries && !store.has(key)) {
    // 先清过期的，再按插入顺序淘汰
    const now = Date.now();
    for (const [existingKey, entry] of store) {
      if (entry.expiresAt <= now) store.delete(existingKey);
    }
    while (store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 清掉某个前缀下的全部缓存；不传前缀就是清空。 */
export function clearCache(prefix = '') {
  if (!prefix) {
    const size = store.size;
    store.clear();
    return size;
  }
  let removed = 0;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** 诊断用：当前缓存条数 / 未过期的条数。 */
export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const entry of store.values()) if (entry.expiresAt > now) live += 1;
  return { size: store.size, live };
}
