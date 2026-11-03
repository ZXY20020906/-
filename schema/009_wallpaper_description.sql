-- 009：给作品加一段描述
--   npx wrangler d1 execute folia --file=./schema/009_wallpaper_description.sql --remote
--
-- 后台列表在标题下面显示它；前台详情层也会展示。
-- 允许为空，历史数据不用回填。

ALTER TABLE wallpapers ADD COLUMN description TEXT;
