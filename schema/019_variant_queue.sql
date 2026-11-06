-- 019：60fps / 超限素材「先入库、后转码」队列
--
-- 执行：node tools/d1-apply-schema.mjs schema/019_variant_queue.sql --allow-duplicate
--
-- needs_variant=1 表示这条原片超过发布门槛（fps>30 / 超分辨率 / 非 H.264），
-- 已入库但**不能发布**，等本机 tools/make-variants.mjs 转出 30fps 变体后再置 published。
-- variant_reason: fps-60 | oversize | codec | probe-failed

ALTER TABLE wallpapers ADD COLUMN needs_variant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallpapers ADD COLUMN variant_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_wallpapers_needs_variant ON wallpapers(needs_variant) WHERE needs_variant = 1;
