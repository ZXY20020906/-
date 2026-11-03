-- 010：作品增加「子标签」和「审核状态」
--   npx wrangler d1 execute folia --file=./schema/010_subtag_review.sql --remote
--
-- 分类 → 标签 → 子标签 三层；子标签先做成一列文本（后台带历史值补全），
-- 以后要独立管理再拆表。
-- 审核状态：pending 未审核 / approved 已审核。

ALTER TABLE wallpapers ADD COLUMN subtag TEXT;
ALTER TABLE wallpapers ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
