-- 分类体系迁移：壁纸 / 开机动画 / 助手皮肤 / 桌宠
-- 旧分类（动态、皮肤包）会被合并掉，内容不丢：动态→壁纸，皮肤包→助手皮肤。
--   wrangler d1 execute folia --file=./schema/005_taxonomy.sql --remote

-- 1. 新分类（已存在的跳过）
INSERT INTO categories (id, slug, name, description, sort_order, is_public, created_by, created_at, updated_at)
VALUES
  ('cat_wallpaper',      'wallpaper',      '壁纸',     '静态与动态壁纸',       10, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('cat_assistant_skin', 'assistant-skin', '助手皮肤', '助手 / 客户端皮肤包',  30, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('cat_desktop_pet',    'desktop-pet',    '桌宠',     '桌面宠物与形象',       40, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;

-- 2. 开机动画排到第二位（它原本在 30）
UPDATE categories SET sort_order = 20 WHERE slug = 'boot-animation';

-- 3. 把旧分类里的内容搬过去
UPDATE wallpapers SET category_id = 'cat_wallpaper'      WHERE category_id = 'cat_dynamic';
UPDATE wallpapers SET category_id = 'cat_assistant_skin' WHERE category_id = 'cat_skinpack';

-- 4. 删掉旧分类（此时已经没有内容指向它们）
DELETE FROM categories WHERE slug IN ('dynamic', 'skin-pack');

-- 5. 标签归一：只保留四个词表内的标签，其余清空后按分类给默认值
UPDATE wallpapers SET tags = '["动漫"]'     WHERE category_id = 'cat_bootanim';
UPDATE wallpapers SET tags = '["自然风景"]' WHERE category_id = 'cat_wallpaper';
UPDATE wallpapers SET tags = '["动漫"]'     WHERE category_id = 'cat_assistant_skin' AND tags = '["示例"]';

-- 6. 桌宠暂时没有内容，标签留空即可
