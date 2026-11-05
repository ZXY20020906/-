-- 018：公开 API key（第三期）
--   npx wrangler d1 execute folia --file=./schema/018_api_keys.sql --remote
--   或用本仓库的工具（UTF-8 安全、可重复执行）：
--   node tools/d1-apply-schema.mjs --file=schema/018_api_keys.sql --allow-duplicate
--
-- 设计：
--   - 库里**只存 key 的 SHA-256**（`key_hash`），明文只在创建时返回一次；
--   - `rpm` 是每分钟请求上限（窗口 60s，isolate 内存计数，见 rate-limit.js）；
--     没有 key 的请求仍按 IP 限流（120/min），key 默认 600/min；
--   - `last_used_at` 用于运营观察，写入做了节流（60s 内不重复 UPDATE），不拖慢请求；
--   - `active = 0` 可立即停用（不用删行，保留审计痕迹）。
--
-- 幂等：表 / 索引 IF NOT EXISTS，可重复执行。
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  rpm          INTEGER NOT NULL DEFAULT 600,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(active);
