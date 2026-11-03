-- 011：子标签字典（挂在标签下面，可管理）
--   npx wrangler d1 execute folia --file=./schema/011_subtags.sql --remote
--
-- 之前子标签只是 wallpapers.subtag 的自由文本，没法提前建、也没法统一改名。
-- 现在单独一张表：tag_id 指向归属标签（NULL = 未归类）。
-- 作品上的 subtag 仍是文本，两者按名字对应。

CREATE TABLE IF NOT EXISTS subtags (
  id         TEXT PRIMARY KEY,
  tag_id     TEXT,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (tag_id, name)
);

CREATE INDEX IF NOT EXISTS idx_subtags_tag ON subtags(tag_id, sort_order);

-- 把库里已经用过的子标签收进来（先都放「未归类」，后台再拖到标签下）
INSERT OR IGNORE INTO subtags (id, tag_id, name, sort_order, created_at)
SELECT 'st_' || lower(hex(randomblob(6))), NULL, subtag, 0,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM (SELECT DISTINCT subtag FROM wallpapers WHERE subtag IS NOT NULL AND subtag <> '');
