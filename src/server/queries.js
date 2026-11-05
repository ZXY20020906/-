/**
 * 全部 SQL 集中在这里。路由层只调 db 帮助函数，不拼字符串。
 * 好处：一份文件就能用 sqlite3 做语法/字段名校验（见 tools/check-sql.py）。
 *
 * 约定：占位符按出现顺序编号（? 或 ?N），参数个数与顺序必须和调用处一致。
 *
 * 复用的三条规则（**不要再抄第四份**）：
 *   - 片段一律写成「接收占位符编号、返回 SQL 文本」的小函数（tagMatch / aspectMatch /
 *     extraFilters / adminWallpaperFilters）。这样同一段业务规则只有一份定义，
 *     而各条查询仍能保留自己的编号（编号一改，路由层的 bind 顺序就得跟着改，出错面大）。
 *   - 阈值（宽高比 0.06）从 core/media-limits.js 来，不写字面量。
 */
import { ASPECT_TOLERANCE } from '../core/aspects.js';

const PUBLIC_COLUMNS = `w.id, w.slug, w.title, w.description, w.subtag, w.category_id, w.kind, w.mime, w.bytes, w.width, w.height,
  w.duration_ms, w.tags, w.featured, w.sort_order, w.published_at, w.created_at, w.updated_at,
  w.sha256, w.storage_key, w.thumb_key, w.variants,
  c.slug AS category_slug, c.name AS category_name`;

/**
 * 「公开可见」的硬门槛：已发布 + 有文件 + 上传回读已验证 + 已审核。
 *
 * 清单 / 计数 / facets 三处都从这里取同一段 SQL，**不要**在别处再抄一遍：
 * 一旦某处少了 verified_at 或 review_status，就会出现「列表 total=110，面板计数合计却更少」
 * 的自相矛盾。tests/public-facets.test.js 还有一条断言直接守 `sum(facets.categories) == total`。
 */
const PUBLIC_VISIBLE = `w.status = 'published' AND w.storage_key IS NOT NULL
  AND w.verified_at IS NOT NULL
  AND w.review_status = 'approved'`;

const PUBLIC_FILTERS = `${PUBLIC_VISIBLE}
  AND (?1 IS NULL OR c.slug = ?1)
  AND (?2 IS NULL OR w.kind = ?2)
  AND (?3 IS NULL OR w.title LIKE ?3)
  AND (?4 = 0 OR w.featured = 1)`;

/**
 * 标签匹配（多值 OR）。
 *
 * 参数是 JSON 数组文本，比如 `["动漫","游戏"]`；命中**任意一个**即算匹配。
 * 为什么不用 `w.tags LIKE '%"动漫"%'`：
 * - 多值要么动态拼 SQL（占位符个数会变，测试和 D1 都更难对），要么反复 LIKE；
 * - json_each 让多值只占**一个**占位符，SQL 文本与既有编号都不变，
 *   旧调用方传单个值时行为完全一致（原先的 LIKE 语义本来就是「整项相等」）。
 * 语义差别只有一处：LIKE 对 ASCII 大小写不敏感，这里是逐字节相等（更符合「标签精确匹配」）。
 */
const tagMatch = (placeholder) => `EXISTS (SELECT 1 FROM json_each(w.tags) j
    WHERE j.value IN (SELECT value FROM json_each(${placeholder})))`;

/**
 * 宽高比匹配（容差见 core/media-limits.js 的 ASPECT_TOLERANCE）。
 * 清单 / facets / 计数三处原来各抄了一遍这段 ABS(...) < 0.06，现在只有这里一份。
 */
const aspectMatch = (placeholder) => `(w.width > 0 AND w.height > 0
    AND ABS((w.width * 1.0 / w.height) - ${placeholder}) < ${ASPECT_TOLERANCE})`;

/**
 * 列表额外筛选（Wallpaper Engine 那套）：标签 + 分辨率 + 子标签。
 *
 * 参数是**占位符编号**而不是值：PUBLIC_EXTRA 用 ?8/?9/?11（前面还有游标 ?5/?6/?7），
 * 而 publicCount 用 ?5/?6/?7。同一段规则、不同编号，所以只能传编号进来。
 * 用 ?N 而不是把前面的重新编号——SQL 里编号可以乱序出现，这样新增筛选不用动已有
 * 游标参数，出错面小得多。
 */
function extraFilters({ tag, aspect, subtag }) {
  return `AND (${tag} IS NULL OR ${tagMatch(tag)})
  AND (${aspect} IS NULL OR ${aspectMatch(aspect)})
  AND (${subtag} IS NULL OR w.subtag = ${subtag})`;
}

const PUBLIC_EXTRA = extraFilters({ tag: '?8', aspect: '?9', subtag: '?11' });

/** 公开子标签列表：只统计已发布、有文件的 */
export const PUBLIC_SUBTAGS = `SELECT w.subtag AS name, COUNT(*) AS n FROM wallpapers w
  LEFT JOIN categories c ON c.id = w.category_id
  WHERE w.status = 'published' AND w.storage_key IS NOT NULL
    AND w.subtag IS NOT NULL AND w.subtag <> ''
    AND (?1 IS NULL OR c.slug = ?1)
    AND (?2 IS NULL OR ${tagMatch('?2')})
  GROUP BY w.subtag ORDER BY n DESC, w.subtag`;

/**
 * 公开清单的筛选面板数据（facets）：一次聚合查询返回三类计数。
 *
 * 为什么是「一条 SQL」而不是三条：D1 每次 prepare/执行都是一次往返，
 * 面板每次翻页都要这份数据，三次往返比一次贵得多；而按条目逐条查（N+1）更要避免。
 * 三个分支共用同一个 CTE `base`（当前的全部筛选条件 + 与清单同源的 PUBLIC_VISIBLE 门槛），
 * 所以三份计数天然一致，也天然对得上清单的 total：
 * - category：跟当前 category/kind/tag/... 过滤走，某个分类下 0 条就不会出现；
 * - tag / subtag：只对命中过滤的作品聚合（GROUP BY 只会产出 count ≥ 1 的组）。
 * 排序与 50 条上限在路由层做（SQL 里 ORDER BY 只保证稳定输出，不承担业务上限）。
 */
export const PUBLIC_FACETS = `WITH base AS (
    SELECT w.id, w.category_id, w.subtag, w.tags
    FROM wallpapers w LEFT JOIN categories c ON c.id = w.category_id
    WHERE ${PUBLIC_FILTERS}
      ${extraFilters({ tag: '?5', aspect: '?6', subtag: '?7' })}
  )
  SELECT 'category' AS facet, b.category_id AS id, c.slug AS slug, c.name AS name,
      NULL AS value, COUNT(*) AS n
    FROM base b JOIN categories c ON c.id = b.category_id AND c.is_public = 1
    GROUP BY b.category_id
  UNION ALL
  SELECT 'tag', NULL, NULL, NULL, j.value, COUNT(*)
    FROM base b, json_each(b.tags) j
    GROUP BY j.value
  UNION ALL
  SELECT 'subtag', NULL, NULL, NULL, b.subtag, COUNT(*)
    FROM base b
    WHERE b.subtag IS NOT NULL AND b.subtag <> ''
    GROUP BY b.subtag`;

/**
 * 后台列表 / 计数的**同一套筛选条件**（原来抄了两份，改一处忘另一处就会让
 * 「列表 12 条、总数 15 条」对不上）。
 *
 * 为什么参数是四个编号而不是从 1 排起：`adminListWallpapers` 的 ?7/?8 已经被
 * `LIMIT/OFFSET` 占了，所以后四条筛选往后挪到 ?9..?12；而 count 没有分页，正好是 ?7..?10。
 * 编号不同、规则相同，所以由调用方把编号传进来。
 */
function adminWallpaperFilters({ likes, review, subtag, media }) {
  return `(?1 IS NULL OR w.status = ?1)
      AND (?2 IS NULL OR w.category_id = ?2)
      AND (?3 IS NULL OR w.kind = ?3)
      AND (?4 IS NULL OR w.created_by = ?4)
      AND (?5 IS NULL OR w.title LIKE ?5)
      AND (?6 IS NULL OR w.tags LIKE ?6)
      AND (?${likes} IS NULL OR EXISTS (SELECT 1 FROM likes l WHERE l.wallpaper_id = w.id AND l.user_id = ?${likes}))
      AND (?${review} IS NULL OR w.review_status = ?${review})
      AND (?${subtag} IS NULL OR w.subtag = ?${subtag})
      AND (?${media} IS NULL
        OR (?${media} = 'video' AND w.mime LIKE 'video/%')
        OR (?${media} = 'zip' AND w.mime = 'application/zip')
        OR (?${media} = 'image' AND w.mime LIKE 'image/%'))`;
}

/**
 * 标签计数（后台标签云 / 公开标签云）：同一段 FROM + json_each + GROUP BY，
 * 只有 WHERE 和 LIMIT 不同。原来两份几乎逐字相同，这里只留一份。
 */
function tagCounts(where, tail = '') {
  return `SELECT t.value AS tag, COUNT(*) AS n
    FROM wallpapers w, json_each(w.tags) t
    ${where} GROUP BY t.value ORDER BY n DESC, t.value${tail}`;
}

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
  /**
   * 批量导入的幂等兜底（>40MB 没有完整 sha256 时）：同名 + 同字节数。
   * 只用于「拒绝重复建条目」，不参与任何对外字段。
   */
  wallpaperTitleBytesTaken: `SELECT id, title FROM wallpapers WHERE title = ? AND bytes = ? LIMIT 1`,
  insertWallpaper: `INSERT INTO wallpapers
      (id, slug, title, description, subtag, review_status, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
       tags, featured, sort_order, created_by, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateWallpaper: `UPDATE wallpapers SET slug = ?, title = ?, description = ?, subtag = ?, category_id = ?, kind = ?, status = ?,
      review_status = ?, tags = ?, featured = ?, sort_order = ?, updated_at = ?, published_at = ? WHERE id = ?`,
  updateWallpaperAsset: `UPDATE wallpapers SET storage_key = ?, mime = ?, bytes = ?, width = ?, height = ?,
      duration_ms = ?, sha256 = ?, kind = ?, updated_at = ? WHERE id = ?`,
  /** 只改媒体三列（工具重算 sha256/bytes 用）；不碰 mime/width/height/kind。 */
  updateMediaIdentity: `UPDATE wallpapers SET storage_key = ?, bytes = ?, sha256 = ?, updated_at = ? WHERE id = ?`,
  /**
   * schema/015：媒体审计的 actor 只能应用层补（触发器看不到调用方）。
   * 只改最近一条「还没标注」的行，且限定在本次 UPDATE 的时间窗内，
   * 避免把更早的、由外部工具写下的 NULL 行误算到这次上传头上。
   */
  mediaAuditAnnotate: `UPDATE media_audit SET changed_by = ?
    WHERE id = (SELECT id FROM media_audit
      WHERE wallpaper_id = ? AND changed_by IS NULL AND changed_at >= ?
      ORDER BY changed_at DESC, id DESC LIMIT 1)`,
  updateWallpaperThumb: `UPDATE wallpapers SET thumb_key = ?, updated_at = ? WHERE id = ?`,
  /**
   * 1080p 变体清单（schema/014 的 variants 列，JSON 数组）。
   * 每项 `{label,height,width,key,bytes,sha256}`：key 是 R2 对象，sha256 是**变体自己的**哈希
   * （插件的 resolveMediaExpectation 靠它给变体设内容判据）。
   */
  updateWallpaperVariants: `UPDATE wallpapers SET variants = ?, updated_at = ? WHERE id = ?`,
  /** 批量导入时「直接发布」：媒体已落盘并回读通过才允许走到这（见 ingest.js） */
  publishWallpaper: `UPDATE wallpapers SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`,
  /** 上传回读成功后记账：verified_at + 编码信息 */
  /** 批量审核：把待审核的已发布作品一次性标记为已审核 */
  approvePendingPublished: `UPDATE wallpapers SET review_status = 'approved', updated_at = ?
    WHERE review_status <> 'approved' AND status = 'published'`,
  markWallpaperVerified: `UPDATE wallpapers SET verified_at = ?, codec = ?, faststart = ? WHERE id = ?`,
  /** 对账发现问题时标记（公开接口据此过滤） */
  markWallpaperBroken: `UPDATE wallpapers SET verified_at = NULL, missing_reason = ? WHERE id = ?`,
  /** 探测 codec/faststart 列是否已迁移：返回 2 行表示都在。 */
  pragmaWallpaperColumns: `SELECT name FROM pragma_table_info('wallpapers') WHERE name IN ('codec', 'faststart')`,
  /** 通用列探测（schema/013 的 content_fingerprint 用）：有行=列在 */
  wallpaperColumnExists: `SELECT name FROM pragma_table_info('wallpapers') WHERE name = ? LIMIT 1`,
  /** 通用表探测（schema/013 的 upload_usage 用）：有行=表在 */
  tableExists: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  /** 大文件内容指纹：仅当 content_fingerprint 列存在时才查/写 */
  wallpaperFingerprintTaken: `SELECT id, title FROM wallpapers WHERE content_fingerprint = ? LIMIT 1`,
  updateWallpaperFingerprint: `UPDATE wallpapers SET content_fingerprint = ?, updated_at = ? WHERE id = ?`,
  /** 上传配额计数（schema/013 的 upload_usage）：按天 + 账号累加字节数 */
  uploadUsageGet: `SELECT bytes FROM upload_usage WHERE day = ? AND actor_id = ? LIMIT 1`,
  uploadUsageAdd: `INSERT INTO upload_usage (day, actor_id, bytes) VALUES (?, ?, ?)
    ON CONFLICT(day, actor_id) DO UPDATE SET bytes = bytes + excluded.bytes`,
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
    WHERE ${adminWallpaperFilters({ likes: 9, review: 10, subtag: 11, media: 12 })}
    ORDER BY w.updated_at DESC, w.id DESC
    LIMIT ?7 OFFSET ?8`,
  adminCountWallpapers: `SELECT COUNT(*) AS n FROM wallpapers w
    WHERE ${adminWallpaperFilters({ likes: 7, review: 8, subtag: 9, media: 10 })}`,

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
      ${extraFilters({ tag: '?5', aspect: '?6', subtag: '?7' })}`,

  /** 标签云：Wallpaper Engine 左侧那一列标签，按出现次数排序 */
  publicTags: tagCounts(
    `WHERE w.status = 'published' AND w.storage_key IS NOT NULL`,
    ' LIMIT 40',
  ),

  /** 后台用：不限状态地统计每个标签用了多少次 */
  adminTagStats: tagCounts(''),

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
