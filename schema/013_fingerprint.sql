-- 大文件内容指纹（TODO-06）。
--
-- >40MB 的文件不再计算 sha256（Worker 内存会爆），改用单次遍历的指纹做
-- 内容寻址与去重，落在这列里。刻意不复用 sha256 列：那一列是对外输出的
-- 真 sha256 语义（dto.js 会原样吐给调用方），写近似值等于让接口说谎。
--
-- 代码里同样是「可选依赖」：用 pragma_table_info 探测，列不存在就跳过
-- 指纹去重与写入，老库照常能上传。
--
-- 未执行到线上：按交接单 §3 第 8 条，D1 迁移属于线上操作，需人工确认后执行。
-- 注意：本文件是 ALTER TABLE ADD COLUMN，重复执行会报 duplicate column name，
-- 只能跑一次（同 schema/012 的教训）。

ALTER TABLE wallpapers ADD COLUMN content_fingerprint TEXT;
