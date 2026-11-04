-- 降档变体（1080p）索引（TODO-16）。
--
-- 一条壁纸可以有多个按高度分档的副本：4K 原画 40–50 MB，弱网用户根本拉不动，
-- 1080p 只有 5–8 MB，是「5 秒出画面」的数量级手段。这里存 JSON 数组：
--   [{"height":1080,"key":"wallpapers/<id>/<sha16>.1080p.mp4","bytes":N,"sha256":"…"}]
--
-- 为什么单独一列而不是一张变体表：变体永远跟着主行走，没有独立查询需求
-- （只按 wallpaper_id 取整条），一列 JSON 省一次 JOIN，也不会出现「主行删了
-- 变体还在」的孤儿数据。R2 的 key 里带内容哈希，所以换变体只需改这一列。
--
-- 代码里同样是「可选依赖」：dto.js 解析失败一律降级成空数组，老库没有这列
-- 也不会让接口 500。
--
-- 注意：本文件是 ALTER TABLE ADD COLUMN，重复执行会报 duplicate column name，
-- 只能跑一次（同 schema/012、013 的教训）。线上已执行（2026-11-03 试点）。

ALTER TABLE wallpapers ADD COLUMN variants TEXT;
