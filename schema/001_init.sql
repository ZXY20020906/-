-- Folia 壁纸库 · 管理/分类/权限 初始结构
-- 目标：Cloudflare D1 (SQLite)。执行：wrangler d1 execute <db> --file=./schema/001_init.sql --remote

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- 账号
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,          -- 统一存小写
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  password_hash  TEXT NOT NULL,                 -- PBKDF2-SHA256 / base64url
  password_salt  TEXT NOT NULL,
  iterations     INTEGER NOT NULL DEFAULT 100000 CHECK (iterations = 100000),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     INTEGER NOT NULL,              -- 毫秒时间戳
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ---------------------------------------------------------------- 会话
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                  -- sha256(cookie 原文)，库里不存明文
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip_hash    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------- 分类
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,             -- 用于 URL / 前端 tab 的稳定标识
  name        TEXT NOT NULL UNIQUE,             -- 展示名，如「动态」「皮肤包」
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,       -- 越小越靠前
  is_public   INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_categories_order ON categories(sort_order, name);

-- ---------------------------------------------------------------- 壁纸
CREATE TABLE IF NOT EXISTS wallpapers (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- 用于 /w/<slug> 与直链
  title        TEXT NOT NULL,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'static' CHECK (kind IN ('static', 'dynamic')),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  storage_key  TEXT,                            -- R2 key；未上传时为 NULL
  mime         TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  width        INTEGER,
  height       INTEGER,
  sha256       TEXT,                            -- 去重：同一文件只允许入库一次
  tags         TEXT NOT NULL DEFAULT '[]',      -- JSON 数组字符串
  featured     INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wallpapers_status ON wallpapers(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallpapers_category ON wallpapers(category_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_wallpapers_creator ON wallpapers(created_by);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallpapers_sha ON wallpapers(sha256) WHERE sha256 IS NOT NULL;

-- ---------------------------------------------------------------- 审计
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor_id    TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  actor_role  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,                    -- wallpaper.create / category.delete ...
  target_type TEXT NOT NULL,                    -- wallpaper / category / member / auth
  target_id   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT ''          -- 人类可读摘要
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
