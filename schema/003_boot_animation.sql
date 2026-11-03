-- 新增「开机动画」分类，紧跟在「皮肤包」之后（sort_order 30 > 20）。
-- 已有部署直接执行这一份即可，不会影响原有数据。
--   wrangler d1 execute folia --file=./schema/003_boot_animation.sql --remote

INSERT INTO categories (id, slug, name, description, sort_order, is_public, created_by, created_at, updated_at)
VALUES (
  'cat_bootanim',
  'boot-animation',
  '开机动画',
  '手机 / 平板开机动画：mp4、webm，或 bootanimation.zip',
  20,
  1,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT DO NOTHING;
