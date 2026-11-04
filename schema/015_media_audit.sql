-- 015：媒体元数据变更审计
--   npx wrangler d1 execute folia --file=./schema/015_media_audit.sql --remote
--
-- 记录 wallpapers.storage_key / bytes / sha256 这三列的每一次变化：
--   · 谁（changed_by）、什么时候（changed_at）、改了哪几列（fields）、旧值与新值。
--   · 表里只存这三列的旧/新值，不复制 mime / width / 标题等大字段。
--
-- 为什么 changed_by 允许为 NULL：
--   SQLite 触发器拿不到「调用方」——触发器和 UPDATE 在同一个连接里执行，
--   没有 request context。所以触发器只负责落事实（changed_by = NULL），
--   Web 写路径统一走 src/server/media-audit.js 的 setMediaIdentity()，
--   在 UPDATE 之后把最近一条未标注的审计补上 actor；工具/人工 SQL 可以事后
--   用 tools/audit-annotate.mjs 补（同样只是 UPDATE changed_by）。
--
-- fields 约定：
--   · UPDATE：按实际变化的列用逗号拼接，顺序固定 storage_key,bytes,sha256，
--     例如只改 bytes → 'bytes'，同时改 bytes + sha256 → 'bytes,sha256'；
--   · INSERT：固定为 'insert'（三列首次入库的值都在 new_* 列里，旧值为 NULL）。
--
-- 保留策略见 docs/MEDIA-AUDIT.md：建议保留 90 天，清理 SQL 只给不自动跑。
--
-- 幂等：表 / 索引 / 触发器全部 IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS media_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallpaper_id TEXT NOT NULL,
  slug TEXT,
  changed_at INTEGER NOT NULL,          -- 毫秒时间戳，与 wallpapers.updated_at 同单位
  changed_by TEXT,                      -- 写入方标识，触发器写 NULL，应用层补
  fields TEXT NOT NULL,                 -- 逗号分隔，例如 'bytes,sha256'；插入为 'insert'
  old_storage_key TEXT, new_storage_key TEXT,
  old_bytes INTEGER,    new_bytes INTEGER,
  old_sha256 TEXT,      new_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_audit_wp ON media_audit(wallpaper_id, changed_at DESC);

-- 首次入库：只有真的带媒体信息时才记（草稿的 storage_key/sha256 为 NULL、bytes=0，
-- 那种 INSERT 记进 media_audit 只会制造噪音；作品本身的创建另有 audit_log）。
CREATE TRIGGER IF NOT EXISTS trg_media_audit_insert
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

-- 三列任一变化就记一条。用 IS NOT 而不是 <>：NULL → 值、值 → NULL 也算变更。
CREATE TRIGGER IF NOT EXISTS trg_media_audit_update
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
