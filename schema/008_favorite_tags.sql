-- 给「喜欢 / 收藏」两个标签建档，方便后台按标签筛选后批量删除。
--   wrangler d1 execute folia --file=./schema/008_favorite_tags.sql --remote

INSERT INTO tags (id, name, sort_order, created_at, updated_at)
VALUES
  ('tag_like', '喜欢', 50, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('tag_fav',  '收藏', 60, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;
