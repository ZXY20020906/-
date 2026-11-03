-- 012：上传可验证 + 视频编码标记
--
-- ⚠️ 线上 D1 已经执行过这份迁移（2026-11-03，verified_at / missing_reason / codec / faststart 四列 + 索引），
--    重复执行会报 "duplicate column name"。新环境才需要跑：
--      npx wrangler d1 execute folia --file=./schema/012_verify_and_codec.sql --remote
--
-- verified_at：上传写完回读 R2 成功的时间戳。公开接口只认它，
--              避免「D1 有记录、R2 没对象」的条目被用户点到 404/500。
-- missing_reason：对账发现对象丢失时的原因（object-missing 等）。
-- codec：     视频编码（h264 / hevc / av1 / vp9 …），H.265 浏览器常常解不了。
-- faststart： moov 是否在 mdat 之前；0 表示要下完整个文件才能起播。

ALTER TABLE wallpapers ADD COLUMN verified_at INTEGER;
ALTER TABLE wallpapers ADD COLUMN missing_reason TEXT;
ALTER TABLE wallpapers ADD COLUMN codec TEXT;
ALTER TABLE wallpapers ADD COLUMN faststart INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wallpapers_cat_status ON wallpapers(category_id, status);
