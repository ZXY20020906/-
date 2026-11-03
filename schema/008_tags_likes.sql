-- 008：标签归属分类 + 「喜欢」改成按账号存
--   npx wrangler d1 execute folia --file=./schema/008_tags_likes.sql --remote
--
-- 标签：
--   category_id 为 NULL = 全局标签（所有分类都显示），否则只属于那个分类。
--   历史标签保持全局，管理员可以逐个归到分类下。
--
-- 喜欢：
--   以前只存在浏览器 localStorage，换设备就没了，后台也筛不出来。
--   现在按 (user_id, wallpaper_id) 存库，前端仍然可以先写本地再同步。

ALTER TABLE tags ADD COLUMN category_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tags_category ON tags(category_id);

CREATE TABLE IF NOT EXISTS likes (
  user_id      TEXT NOT NULL,
  wallpaper_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, wallpaper_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_wallpaper ON likes(wallpaper_id);
