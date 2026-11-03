-- 上传配额计数（TODO-05）。
--
-- 为什么不用 audit_log.detail 里的文本算：那一列是给人看的自由文本，
-- 既没有索引也没有统一的单位，算出来的数字迟早和真实字节数对不上。
-- 这里按「天 + 账号」累加真实落盘字节数（R2 head 校验后的 size）。
--
-- 注意：代码里对这张表是「可选依赖」——表不存在时只 console.warn 并跳过记账，
-- 不会让上传 500（同一个降级模式见 codec/faststart 的探测）。
--
-- 未执行到线上：按交接单 §3 第 8 条，D1 迁移属于线上操作，需人工确认后执行。

CREATE TABLE IF NOT EXISTS upload_usage (
  day TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, actor_id)
);
