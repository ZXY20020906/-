-- 016：媒体元数据补全 + 海报 + 授权信息（「素材网」API v1 地基）
--
-- 目标：公开 API 能一次性给出「这个素材能不能用、多大、什么编码、有没有声音、封面在哪」，
-- 客户端不必自己下文件再算。所有列都可为空：拿不到就是 NULL，**绝不能让入库失败**。
--
-- 列说明
--   fps        REAL       视频帧率（head 探测；拿不到 NULL）
--   pix_fmt    TEXT       像素格式（yuv420p / yuv420p10le …；Worker 里拿不到，回填时由 ffprobe 写入）
--   has_audio  INTEGER    1 有音轨 / 0 无音轨 / NULL 未知
--   poster_key TEXT       首帧海报的 R2 key（1280 宽 WebP，内容哈希命名）
--   license    TEXT       许可证标识（cc0 / cc-by / personal …）
--   source     TEXT       来源或作者主页（≤200 字）
--   author     TEXT       作者名（≤120 字）
--
-- codec 列在 schema/012 已有（AVC 探测时写入），这里不重复 ADD。
--
-- ⚠️ ALTER TABLE ADD COLUMN 不可重复执行（重复会报 duplicate column name）。
--    线上已在 2026-11 执行过一次；新环境按文件名顺序跑一遍即可。
--    执行记录与回填结果见 docs/api.md 的「v1 元数据」一节。
ALTER TABLE wallpapers ADD COLUMN fps REAL;
ALTER TABLE wallpapers ADD COLUMN pix_fmt TEXT;
ALTER TABLE wallpapers ADD COLUMN has_audio INTEGER;
ALTER TABLE wallpapers ADD COLUMN poster_key TEXT;
ALTER TABLE wallpapers ADD COLUMN license TEXT;
ALTER TABLE wallpapers ADD COLUMN source TEXT;
ALTER TABLE wallpapers ADD COLUMN author TEXT;

-- 许可证筛选（?license=cc0）与「按作者找素材」都走这个索引。
CREATE INDEX IF NOT EXISTS idx_wallpapers_license ON wallpapers(license);
CREATE INDEX IF NOT EXISTS idx_wallpapers_author ON wallpapers(author);
