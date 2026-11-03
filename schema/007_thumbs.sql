-- 缩略图字段：列表页用小的，详情页用原图。
-- 缩略图在浏览器里用 canvas 生成（Worker 没有图像解码能力），存到 R2 的 thumbs/ 前缀。
--   wrangler d1 execute folia --file=./schema/007_thumbs.sql --remote

ALTER TABLE wallpapers ADD COLUMN thumb_key TEXT;
