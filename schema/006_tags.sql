-- 标签表：把标签从代码常量搬进数据库，后台才能增删改排序。
-- 作品的 tags 字段仍然存标签名（JSON 数组），这样历史数据不用迁移。
--   wrangler d1 execute folia --file=./schema/006_tags.sql --remote

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_order ON tags(sort_order, name);

INSERT INTO tags (id, name, sort_order, created_at, updated_at)
VALUES
  ('tag_nature', '自然风景', 10, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('tag_star',   '明星',     20, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('tag_anime',  '动漫',     30, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('tag_game',   '游戏',     40, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;
