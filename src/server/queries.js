/**
 * 全部 SQL 集中在这里。路由层只调 db 帮助函数，不拼字符串。
 * 好处：一份文件就能用 sqlite3 做语法/字段名校验（见 tools/check-sql.py）。
 *
 * 约定：占位符按出现顺序编号（? 或 ?N），参数个数与顺序必须和调用处一致。
 */

const PUBLIC_COLUMNS = `w.id, w.slug, w.title, w.description, w.subtag, w.category_id, w.kind, w.mime, w.bytes, w.width, w.height,
  w.duration_ms, w.tags, w.featured, w.sort_order, w.published_at, w.created_at, w.updated_at,
  w.sha256, w.storage_key, w.thumb_key,
  c.slug AS category_slug, c.name AS category_name`;

const PUBLIC_FILTERS = `w.status = 'published' AND w.storage_key IS NOT NULL
  AND w.verified_at IS NOT NULL
  AND w.review_status = 'approved'
  AND (?1 IS NULL OR c.slug = ?1)
  AND (?2 IS NULL OR w.kind = ?2)
  AND (?3 IS NULL OR w.title LIKE ?3)
  AND (?4 = 0 OR w.featured = 1)`;

/**
 * 列表额外筛选（Wallpaper Engine 那套）：标签 + 分辨率。
 * 用 ?8/?9 而不是把前面的重新编号——SQL 里编号可以乱序出现，
 * 这样新增筛选不用动已有游标参数，出错面小得多。
 */
const PUBLIC_EXTRA = `AND (?8 IS NULL OR w.tags LIKE ?8)
  AND (?9 IS NULL OR (w.width > 0 AND w.height > 0
    AND ABS((w.width * 1.0 / w.height) - ?9) < 0.06))
  AND (?11 IS NULL OR w.subtag = ?11)`;

/** 公开子标签列表：只统计已发布、有文件的 */
export const PUBLIC_SUBTAGS = `SELECT w.subtag AS name, COUNT(*) AS n FROM wallpapers w
  LEFT JOIN categories c ON c.id = w.category_id
  WHERE w.status = 'published' AND w.storage_key IS NOT NULL
    AND w.subtag IS NOT NULL AND w.subtag <> ''
    AND (?1 IS NULL OR c.slug = ?1)
    AND (?2 IS NULL OR w.tags LIKE ?2)
  GROUP BY w.subtag ORDER BY n DESC, w.subtag`;

export const Q = {
  // ------------------------------------------------------------------ users
  countUsers: `SELECT COUNT(*) AS n FROM users`,
  countActiveAdmins: `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`,
  userByEmail: `SELECT * FROM users WHERE email = ? LIMIT 1`,
  userById: `SELECT * FROM users WHERE id = ? LIMIT 1`,
  listUsers: `SELECT id, email, name, role, active, created_at, updated_at, last_login_at
              FROM users ORDER BY active DESC, CASE role WHEN 'admin' THEN 0 ELSE 1 END, email`,
  insertUser: `INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateUserProfile: `UPDATE users SET email = ?, name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?`,
  deleteUser: `DELETE FROM users WHERE id = ?`,
  updateUserPassword: `UPDATE users SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = ? WHERE id = ?`,
  touchUserLogin: `UPDATE users SET last_login_at = ? WHERE id = ?`,

  // --------------------------------------------------------------- sessions
  insertSession: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  sessionByToken: `SELECT s.token_hash, s.expires_at, s.created_at, s.device_hash, s.last_seen_at,
                    u.id, u.email, u.name, u.role, u.active
                   FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ? LIMIT 1`,
  touchSession: `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`,
  deleteSession: `DELETE FROM sessions WHERE token_hash = ?`,
  deleteUserSessions: `DELETE FROM sessions WHERE user_id = ?`,
  deleteExpiredSessions: `DELETE FROM sessions WHERE expires_at < ?`,

  // ------------------------------------------------------------- categories
  listCategories: `SELECT c.id, c.slug, c.name, c.description, c.sort_order, c.is_public, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM wallpapers w WHERE w.category_id = c.id) AS wallpaper_count,
      (SELECT COUNT(*) FROM wallpapers w WHERE w.category_id = c.id AND w.status = 'published') AS published_count
    FROM categories c ORDER BY c.sort_order, c.name`,
  listPublicCategories: `SELECT c.id, c.slug, c.name, c.description, c.sort_order,
      c.is_public, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM wallpapers w WHERE w.category_id = c.id
        AND w.status = 'published' AND w.storage_key IS NOT NULL) AS count
    FROM categories c WHERE c.is_public = 1 ORDER BY c.sort_order, c.name`,
  categoryById: `SELECT * FROM categories WHERE id = ? LIMIT 1`,
  categoryBySlug: `SELECT * FROM categories WHERE slug = ? LIMIT 1`,
  categoryByName: `SELECT id, name FROM categories WHERE name = ? LIMIT 1`,
  maxCategorySort: `SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories`,
  insertCategory: `INSERT INTO categories (id, slug, name, description, sort_order, is_public, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateCategory: `UPDATE categories SET name = ?, description = ?, is_public = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
  deleteCategory: `DELETE FROM categories WHERE id = ?`,
  countWallpapersInCategory: `SELECT COUNT(*) AS n FROM wallpapers WHERE category_id = ?`,
  detachWallpapersFromCategory: `UPDATE wallpapers SET category_id = NULL, updated_at = ? WHERE category_id = ?`,
  moveWallpapersToCategory: `UPDATE wallpapers SET category_id = ?, updated_at = ? WHERE category_id = ?`,
  updateCategorySort: `UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?`,

  // ------------------------------------------------------------- wallpapers
  wallpaperById: `SELECT * FROM wallpapers WHERE id = ? LIMIT 1`,
  wallpaperBySlug: `SELECT * FROM wallpapers WHERE slug = ? LIMIT 1`,
  wallpaperSlugTaken: `SELECT id FROM wallpapers WHERE slug = ? LIMIT 1`,
  wallpaperShaTaken: `SELECT id, title FROM wallpapers WHERE sha256 = ? LIMIT 1`,
  insertWallpaper: `INSERT INTO wallpapers
      (id, slug, title, description, subtag, review_status, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
       tags, featured, sort_order, created_by, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateWallpaper: `UPDATE wallpapers SET slug = ?, title = ?, description = ?, subtag = ?, category_id = ?, kind = ?, status = ?,
      review_status = ?, tags = ?, featured = ?, sort_order = ?, updated_at = ?, published_at = ? WHERE id = ?`,
  updateWallpaperAsset: `UPDATE wallpapers SET storage_key = ?, mime = ?, bytes = ?, width = ?, height = ?,
      duration_ms = ?, sha256 = ?, kind = ?, updated_at = ? WHERE id = ?`,
  updateWallpaperThumb: `UPDATE wallpapers SET thumb_key = ?, updated_at = ? WHERE id = ?`,
  /** 上传回读成功后记账：verified_at + 编码信息 */
  /** 批量审核：把待审核的已发布作品一次性标记为已审核 */
  approvePendingPublished: `UPDATE wallpapers SET review_status = 'approved', updated_at = ?
    WHERE review_status <> 'approved' AND status = 'published'`,
  markWallpaperVerified: `UPDATE wallpapers SET verified_at = ?, codec = ?, faststart = ? WHERE id = ?`,
  /** 对账发现问题时标记（公开接口据此过滤） */
  markWallpaperBroken: `UPDATE wallpapers SET verified_at = NULL, missing_reason = ? WHERE id = ?`,
  clearWallpaperAsset: `UPDATE wallpapers SET storage_key = NULL, mime = NULL, bytes = 0, width = NULL,
      height = NULL, sha256 = NULL, status = 'draft', updated_at = ? WHERE id = ?`,
  deleteWallpaper: `DELETE FROM wallpapers WHERE id = ?`,
  maxWallpaperSort: `SELECT COALESCE(MAX(sort_order), 0) AS m FROM wallpapers`,
  updateWallpaperSort: `UPDATE wallpapers SET sort_order = ?, updated_at = ? WHERE id = ?`,
  listWallpaperIdsInCategory: `SELECT id FROM wallpapers WHERE category_id IS ? ORDER BY sort_order, created_at, id`,
  listAllWallpaperIds: `SELECT id FROM wallpapers ORDER BY sort_order, created_at, id`,
  /** 后台「子标签」输入框的历史提示 */
  listSubtags: `SELECT DISTINCT subtag FROM wallpapers WHERE subtag IS NOT NULL AND subtag <> '' ORDER BY subtag`,
  /** 某个标签下出现过的子标签：不同标签各管各的 */
  listSubtagsByTag: `SELECT DISTINCT subtag FROM wallpapers
    WHERE subtag IS NOT NULL AND subtag <> '' AND (?1 IS NULL OR tags LIKE ?1) ORDER BY subtag`,

  // ------------------------------------------------------- subtags（字典）
  listSubtagsAdmin: `SELECT s.id, s.name, s.tag_id, s.sort_order, t.name AS tag_name
    FROM subtags s LEFT JOIN tags t ON t.id = s.tag_id
    ORDER BY (s.tag_id IS NULL), s.sort_order, s.name`,
  subtagById: `SELECT * FROM subtags WHERE id = ? LIMIT 1`,
  subtagByName: `SELECT id FROM subtags WHERE tag_id IS ? AND name = ? LIMIT 1`,
  maxSubtagSort: `SELECT COALESCE(MAX(sort_order), 0) AS m FROM subtags WHERE tag_id IS ?`,
  insertSubtag: `INSERT INTO subtags (id, tag_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`,
  updateSubtagTag: `UPDATE subtags SET tag_id = ?, sort_order = ? WHERE id = ?`,
  deleteSubtag: `DELETE FROM subtags WHERE id = ?`,

  adminListWallpapers: `SELECT w.*, c.slug AS category_slug, c.name AS category_name, u.email AS creator_email
    FROM wallpapers w
    LEFT JOIN categories c ON c.id = w.category_id
    LEFT JOIN users u ON u.id = w.created_by
    WHERE (?1 IS NULL OR w.status = ?1)
      AND (?2 IS NULL OR w.category_id = ?2)
      AND (?3 IS NULL OR w.kind = ?3)
      AND (?4 IS NULL OR w.created_by = ?4)
      AND (?5 IS NULL OR w.title LIKE ?5)
      AND (?6 IS NULL OR w.tags LIKE ?6)
      AND (?9 IS NULL OR EXISTS (SELECT 1 FROM likes l WHERE l.wallpaper_id = w.id AND l.user_id = ?9))
      AND (?10 IS NULL OR w.review_status = ?10)
      AND (?11 IS NULL OR w.subtag = ?11)
      AND (?12 IS NULL
        OR (?12 = 'video' AND w.mime LIKE 'video/%')
        OR (?12 = 'zip' AND w.mime = 'application/zip')
        OR (?12 = 'image' AND w.mime LIKE 'image/%'))
    ORDER BY w.updated_at DESC, w.id DESC
    LIMIT ?7 OFFSET ?8`,
  adminCountWallpapers: `SELECT COUNT(*) AS n FROM wallpapers w
    WHERE (?1 IS NULL OR w.status = ?1)
      AND (?2 IS NULL OR w.category_id = ?2)
      AND (?3 IS NULL OR w.kind = ?3)
      AND (?4 IS NULL OR w.created_by = ?4)
      AND (?5 IS NULL OR w.title LIKE ?5)
      AND (?6 IS NULL OR w.tags LIKE ?6)
      AND (?7 IS NULL OR EXISTS (SELECT 1 FROM likes l WHERE l.wallpaper_id = w.id AND l.user_id = ?7))
      AND (?8 IS NULL OR w.review_status = ?8)
      AND (?9 IS NULL OR w.subtag = ?9)
      AND (?10 IS NULL
        OR (?10 = 'video' AND w.mime LIKE 'video/%')
        OR (?10 = 'zip' AND w.mime = 'application/zip')
        OR (?10 = 'image' AND w.mime LIKE 'image/%'))`,

  // ------------------------------------------------------------ public feed
  publicRecent: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${PUBLIC_EXTRA}
      AND (?5 IS NULL OR (COALESCE(w.published_at, w.created_at) < ?5
        OR (COALESCE(w.published_at, w.created_at) = ?5 AND w.id < ?6)))
    ORDER BY COALESCE(w.published_at, w.created_at) DESC, w.id DESC LIMIT ?7 OFFSET ?10`,

  publicOldest: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${PUBLIC_EXTRA}
      AND (?5 IS NULL OR (COALESCE(w.published_at, w.created_at) > ?5
        OR (COALESCE(w.published_at, w.created_at) = ?5 AND w.id > ?6)))
    ORDER BY COALESCE(w.published_at, w.created_at) ASC, w.id ASC LIMIT ?7 OFFSET ?10`,

  publicByName: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${PUBLIC_EXTRA}
      AND (?5 IS NULL OR (w.title COLLATE NOCASE > ?5
        OR (w.title COLLATE NOCASE = ?5 AND w.id > ?6)))
    ORDER BY w.title COLLATE NOCASE ASC, w.id ASC LIMIT ?7 OFFSET ?10`,

  publicBySize: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${PUBLIC_EXTRA}
      AND (?5 IS NULL OR (w.bytes < ?5 OR (w.bytes = ?5 AND w.id < ?6)))
    ORDER BY w.bytes DESC, w.id DESC LIMIT ?7 OFFSET ?10`,

  publicByResolution: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${PUBLIC_EXTRA}
      AND (?5 IS NULL OR ((COALESCE(w.width, 0) * COALESCE(w.height, 0)) < ?5
        OR ((COALESCE(w.width, 0) * COALESCE(w.height, 0)) = ?5 AND w.id < ?6)))
    ORDER BY (COALESCE(w.width, 0) * COALESCE(w.height, 0)) DESC, w.id DESC LIMIT ?7 OFFSET ?10`,

  publicCount: `SELECT COUNT(*) AS n FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      AND (?5 IS NULL OR w.tags LIKE ?5)
      AND (?6 IS NULL OR (w.width > 0 AND w.height > 0
        AND ABS((w.width * 1.0 / w.height) - ?6) < 0.06))
      AND (?7 IS NULL OR w.subtag = ?7)`,

  /** 标签云：Wallpaper Engine 左侧那一列标签，按出现次数排序 */
  publicTags: `SELECT t.value AS tag, COUNT(*) AS n
    FROM wallpapers w, json_each(w.tags) t
    WHERE w.status = 'published' AND w.storage_key IS NOT NULL
    GROUP BY t.value ORDER BY n DESC, t.value LIMIT 40`,

  /** 后台用：不限状态地统计每个标签用了多少次 */
  adminTagStats: `SELECT t.value AS tag, COUNT(*) AS n
    FROM wallpapers w, json_each(w.tags) t
    GROUP BY t.value ORDER BY n DESC, t.value`,

  // ------------------------------------------------------------------ tags
  listTags: `SELECT * FROM tags ORDER BY sort_order, name`,
  /** 某个分类下能用的标签：全局标签（category_id 为空） + 该分类专属标签 */
  listTagsForCategory: `SELECT * FROM tags WHERE category_id IS NULL OR category_id = ? ORDER BY sort_order, name`,
  tagById: `SELECT * FROM tags WHERE id = ? LIMIT 1`,
  tagByName: `SELECT id, name FROM tags WHERE name = ? LIMIT 1`,
  maxTagSort: `SELECT COALESCE(MAX(sort_order), 0) AS m FROM tags`,
  insertTag: `INSERT INTO tags (id, name, sort_order, category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  updateTag: `UPDATE tags SET name = ?, sort_order = ?, category_id = ?, updated_at = ? WHERE id = ?`,
  deleteTag: `DELETE FROM tags WHERE id = ?`,
  updateTagSort: `UPDATE tags SET sort_order = ?, updated_at = ? WHERE id = ?`,
  countWallpapersWithTag: `SELECT COUNT(*) AS n FROM wallpapers w, json_each(w.tags) t WHERE t.value = ?`,

  // ----------------------------------------------------------------- likes
  likesForUser: `SELECT w.slug, w.title, c.slug AS category_slug, l.created_at
    FROM likes l JOIN wallpapers w ON w.id = l.wallpaper_id
    LEFT JOIN categories c ON c.id = w.category_id
    WHERE l.user_id = ? ORDER BY l.created_at DESC`,
  insertLike: `INSERT INTO likes (user_id, wallpaper_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, wallpaper_id) DO NOTHING`,
  deleteLike: `DELETE FROM likes WHERE user_id = ? AND wallpaper_id = ?`,

  publicBySlug: `SELECT ${PUBLIC_COLUMNS} FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE w.slug = ?1 AND w.status = 'published' AND w.storage_key IS NOT NULL LIMIT 1`,

  // ------------------------------------------------------------------ audit
  insertAudit: `INSERT INTO audit_log (at, actor_id, actor_email, actor_role, action, target_type, target_id, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  listAudit: `SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?`,

  // ------------------------------------------------------------ 插件专用
  /**
   * 插件用的精简清单：只挑已发布且有文件的条目。
   * 不 JOIN 分类、不带 tags —— 插件用不上，结果集越小越快。
   */
  pluginFeed: `SELECT w.id, w.slug, w.title, w.mime, w.bytes, w.width, w.height,
      w.duration_ms, w.storage_key, w.thumb_key, w.updated_at
    FROM wallpapers w
    WHERE w.status = 'published' AND w.storage_key IS NOT NULL
    ORDER BY w.published_at DESC, w.id DESC
    LIMIT 300`,
};

/** sort 名称 → 查询语句 */
export const PUBLIC_LIST_BY_SORT = Object.freeze({
  recent: Q.publicRecent,
  oldest: Q.publicOldest,
  name: Q.publicByName,
  size: Q.publicBySize,
  resolution: Q.publicByResolution,
});
