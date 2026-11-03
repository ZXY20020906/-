-- 给壁纸表补一个时长字段：开机动画视频需要显示循环时长（几秒一循环）。
-- 一次性的 ALTER，重复执行会报 duplicate column，这是预期行为。
--   wrangler d1 execute folia --file=./schema/004_boot_animation_duration.sql --remote

ALTER TABLE wallpapers ADD COLUMN duration_ms INTEGER;
