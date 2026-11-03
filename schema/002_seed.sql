-- 种子数据：四个模块 + 四种标签。
-- 「全部」是前端筛选的复位状态，不是标签。
-- 执行：wrangler d1 execute <db> --file=./schema/002_seed.sql --remote

INSERT INTO categories (id, slug, name, description, sort_order, is_public, created_by, created_at, updated_at)
VALUES
  ('cat_wallpaper',      'wallpaper',      '壁纸',     '静态与动态壁纸',      10, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('cat_bootanim',       'boot-animation', '开机动画', '手机 / 平板开机动画', 20, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('cat_assistant_skin', 'assistant-skin', '助手皮肤', '助手 / 客户端皮肤包', 30, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('cat_desktop_pet',    'desktop-pet',    '桌宠',     '桌面宠物与形象',      40, 1, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000)
ON CONFLICT DO NOTHING;
