-- 017：标签别名表（第二期标签治理）
--   npx wrangler d1 execute folia --file=./schema/017_tag_aliases.sql --remote
--
-- 用途：
--   1. 写入/检索归一：`src/core/tag-vocabulary.js` 的 normalizeTag() 与这里同一套词表；
--   2. facets 聚合：`queries.js` 用 `LEFT JOIN tag_aliases` 把 alias 行的计数并到 canonical，
--      于是「动漫 + anime」在筛选面板里是一行。
--
-- 约束：
--   - alias 是**主语**（PRIMARY KEY），一个写法只能指向一个 canonical；
--   - canonical 本身不能再是 alias（词表里不出现 A→B→C 的链）；
--   - 本文件只做「种子里已有的别名」，后续运营新增别名用 INSERT OR IGNORE 追加即可。
--
-- 幂等：表 / 索引 / 种子全部 IF NOT EXISTS / INSERT OR IGNORE，可重复执行。
CREATE TABLE IF NOT EXISTS tag_aliases (
  alias      TEXT PRIMARY KEY,
  canonical  TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tag_aliases_canonical ON tag_aliases(canonical);

INSERT OR IGNORE INTO tag_aliases (alias, canonical, created_at) VALUES
  ('anime', '动漫', 0),
  ('动画', '动漫', 0),
  ('動漫', '动漫', 0),
  ('game', '游戏', 0),
  ('games', '游戏', 0),
  ('遊戲', '游戏', 0),
  ('nature', '自然风景', 0),
  ('自然', '自然风景', 0),
  ('star', '明星', 0),
  ('idol', '明星', 0),
  ('偶像', '明星', 0),
  ('glass', '玻璃', 0),
  ('translucent', '半透明', 0),
  ('dynamic', '动态', 0),
  ('skin', '皮肤', 0),
  ('skins', '皮肤', 0),
  ('sky', '天空', 0),
  ('bubble', '气泡', 0),
  ('grass', '草地', 0),
  ('ice-blue', '冰蓝', 0);
