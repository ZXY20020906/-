-- 020_pet_kind.sql — 桌宠包要写 kind='pet'，但 001 的 CHECK 只允许 static/dynamic。
-- SQLite 改不了 CHECK ⇒ 整表重建；DDL 取自"020 之前全部迁移之后"的真实结构，不手抄列。
-- 由 tools/fix-pet-kind.mjs 配套使用；本文件只跑一次（迁移器按文件名顺序执行）。

PRAGMA foreign_keys = OFF;

CREATE TABLE wallpapers_new (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- 用于 /w/<slug> 与直链
  title        TEXT NOT NULL,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'static' CHECK (kind IN ('static', 'dynamic', 'pet')),
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
, duration_ms INTEGER, thumb_key TEXT, description TEXT, subtag TEXT, review_status TEXT NOT NULL DEFAULT 'pending', verified_at INTEGER, missing_reason TEXT, codec TEXT, faststart INTEGER DEFAULT 0, content_fingerprint TEXT, variants TEXT, fps REAL, pix_fmt TEXT, has_audio INTEGER, poster_key TEXT, license TEXT, source TEXT, author TEXT, needs_variant INTEGER NOT NULL DEFAULT 0, variant_reason TEXT);

INSERT INTO wallpapers_new SELECT * FROM wallpapers;
DROP TABLE wallpapers;
ALTER TABLE wallpapers_new RENAME TO wallpapers;

CREATE INDEX idx_wallpapers_status ON wallpapers(status, published_at DESC);
CREATE INDEX idx_wallpapers_category ON wallpapers(category_id, sort_order);
CREATE INDEX idx_wallpapers_creator ON wallpapers(created_by);
CREATE UNIQUE INDEX idx_wallpapers_sha ON wallpapers(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_wallpapers_cat_status ON wallpapers(category_id, status);
CREATE INDEX idx_wallpapers_license ON wallpapers(license);
CREATE INDEX idx_wallpapers_author ON wallpapers(author);
CREATE INDEX idx_wallpapers_needs_variant ON wallpapers(needs_variant) WHERE needs_variant = 1;

CREATE TRIGGER trg_media_audit_insert
AFTER INSERT ON wallpapers
WHEN NEW.storage_key IS NOT NULL
  OR NEW.sha256 IS NOT NULL
  OR NEW.bytes > 0
BEGIN
  INSERT INTO media_audit (
    wallpaper_id, slug, changed_at, changed_by, fields,
    old_storage_key, new_storage_key,
    old_bytes, new_bytes,
    old_sha256, new_sha256
  ) VALUES (
    NEW.id, NEW.slug,
    CAST(strftime('%s','now') AS INTEGER) * 1000,
    NULL,
    'insert',
    NULL, NEW.storage_key,
    NULL, NEW.bytes,
    NULL, NEW.sha256
  );
END;
CREATE TRIGGER trg_media_audit_update
AFTER UPDATE ON wallpapers
WHEN (OLD.storage_key IS NOT NEW.storage_key)
  OR (OLD.bytes IS NOT NEW.bytes)
  OR (OLD.sha256 IS NOT NEW.sha256)
BEGIN
  INSERT INTO media_audit (
    wallpaper_id, slug, changed_at, changed_by, fields,
    old_storage_key, new_storage_key,
    old_bytes, new_bytes,
    old_sha256, new_sha256
  ) VALUES (
    NEW.id, NEW.slug,
    CAST(strftime('%s','now') AS INTEGER) * 1000,
    NULL,
    trim(
      (CASE WHEN OLD.storage_key IS NOT NEW.storage_key THEN 'storage_key,' ELSE '' END) ||
      (CASE WHEN OLD.bytes IS NOT NEW.bytes THEN 'bytes,' ELSE '' END) ||
      (CASE WHEN OLD.sha256 IS NOT NEW.sha256 THEN 'sha256,' ELSE '' END),
      ','
    ),
    OLD.storage_key, NEW.storage_key,
    OLD.bytes, NEW.bytes,
    OLD.sha256, NEW.sha256
  );
END;

PRAGMA foreign_keys = ON;
