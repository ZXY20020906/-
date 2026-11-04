# 媒体元数据变更审计

`media_audit` 记录 `wallpapers.storage_key` / `bytes` / `sha256` 三列**每一次**变化：
谁、什么时候、改了哪几列、旧值和新值。表里只存这三列的值，不复制 `mime` / `width` /
标题等字段，也不存 R2 对象本身。

- 迁移文件：`schema/015_media_audit.sql`（表 / 索引 / 触发器全部 `IF NOT EXISTS`，可重复执行）
- 应用层入口：`src/server/media-audit.js` 的 `setMediaIdentity()`
- 测试：`tests/media-audit.test.js`（真 `node:sqlite`）

> 线上 D1 已于 **2026-11-04** 执行 015，`sqlite_master` 里可见
> `media_audit`、`idx_media_audit_wp`、`trg_media_audit_insert`、`trg_media_audit_update`。

## 表结构

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 审计行 id，也是「最近一条」的排序依据 |
| `wallpaper_id` | TEXT NOT NULL | 对应 `wallpapers.id`；不建外键，作品删除后审计仍保留 |
| `slug` | TEXT | 变更当时的 slug（作品后来改名也能对回） |
| `changed_at` | INTEGER NOT NULL | 毫秒时间戳，与 `wallpapers.updated_at` 同单位 |
| `changed_by` | TEXT | 写入方标识；触发器写 `NULL`，由应用层补（见下） |
| `fields` | TEXT NOT NULL | 逗号分隔的变更列；`insert` 表示首次入库 |
| `old_storage_key` / `new_storage_key` | TEXT | R2 key 的旧值 / 新值 |
| `old_bytes` / `new_bytes` | INTEGER | 字节数的旧值 / 新值 |
| `old_sha256` / `new_sha256` | TEXT | sha256 的旧值 / 新值 |

索引：`idx_media_audit_wp(wallpaper_id, changed_at DESC)`，按作品查最近变更走索引。

`fields` 的取值顺序固定为 `storage_key,bytes,sha256`，例如：

| 场景 | fields |
|---|---|
| 只改 bytes | `bytes` |
| 同时改 bytes + sha256 | `bytes,sha256` |
| 换文件（三列都变） | `storage_key,bytes,sha256` |
| 首次入库 | `insert`（三值在 `new_*` 列，旧值为 `NULL`） |

## 为什么 changed_by 是应用层补的

SQLite 触发器拿不到「调用方」：触发器和 `UPDATE` 在同一个连接、同一个事务里执行，
没有 request context，也没有 `PRAGMA` 能拿到用户身份。所以分工是：

1. `AFTER UPDATE ON wallpapers` 触发器落事实：`changed_at`、`fields`、旧值、新值，
   `changed_by` 先写 `NULL`；
2. Web 写路径**统一走** `setMediaIdentity(env, id, { storageKey, bytes, sha256, actor, ... })`：
   先 `UPDATE wallpapers`，再把最近一条未标注的审计行补上 `changed_by`；
3. 外部工具 / 人工 SQL 改完三列后，用下面的「补标注」SQL 补一次。

`changed_by` 的约定取值：

| changed_by | 谁写的 |
|---|---|
| `admin-upload` | 后台首次上传文件 |
| `admin-replace` | 后台替换已有文件 |
| `tool:sha-resync` | 工具重算 sha256 / bytes（如 `D:\folia-recover\fix-d1-size.py` 类工具） |
| `cron:integrity` | 完整性巡检自动修复 |
| `NULL` | 触发器已记录，但应用层/工具还没补标注（外部 SQL 或 015 之前的历史行不会出现） |

补标注（改完立刻跑，别等下一次变更）：

```sql
UPDATE media_audit
SET changed_by = 'tool:sha-resync'
WHERE id = (
  SELECT id FROM media_audit
  WHERE wallpaper_id = 'wp_xxx' AND changed_by IS NULL
  ORDER BY changed_at DESC, id DESC
  LIMIT 1
);
```

已知边界：`setMediaIdentity()` 的「更新 + 补标注」不是同一事务。同一作品在同一秒被
两个请求改身份时，actor 可能标到相邻审计行；但 `changed_at` / 旧值 / 新值由触发器保证。
要彻底消除，只能让调用方自己显式插审计行，代价是每个写入口都要重复一遍。

## 怎么查

### 某条壁纸最近被谁改了什么

```sql
SELECT
  a.id,
  datetime(a.changed_at / 1000, 'unixepoch', '+8 hours') AS changed_at_cst,
  a.changed_by,
  a.fields,
  a.old_storage_key, a.new_storage_key,
  a.old_bytes, a.new_bytes,
  a.old_sha256, a.new_sha256
FROM media_audit a
WHERE a.wallpaper_id = 'wp_xxx'
ORDER BY a.changed_at DESC, a.id DESC
LIMIT 5;
```

带上当前标题，方便肉眼核对：

```sql
SELECT w.slug, w.title, a.*
FROM media_audit a
LEFT JOIN wallpapers w ON w.id = a.wallpaper_id
WHERE a.wallpaper_id = 'wp_xxx'
ORDER BY a.changed_at DESC, a.id DESC
LIMIT 5;
```

### 最近 24 小时全站媒体变更

```sql
SELECT a.changed_at, a.wallpaper_id, w.slug, a.changed_by, a.fields,
       a.old_bytes, a.new_bytes
FROM media_audit a
LEFT JOIN wallpapers w ON w.id = a.wallpaper_id
WHERE a.changed_at >= (CAST(strftime('%s','now') AS INTEGER) - 86400) * 1000
ORDER BY a.changed_at DESC, a.id DESC;
```

### 还没标注 actor 的行

```sql
SELECT id, wallpaper_id, fields, changed_at
FROM media_audit
WHERE changed_by IS NULL
ORDER BY changed_at DESC
LIMIT 50;
```

正常 Web 上传不会留下 `NULL`；出现就说明是外部 SQL 或工具改的。

## 保留策略

建议保留 **90 天**。审计表只存三列值，一条约几百字节；按每天几十次变更估算，
90 天也就几 MB，不构成 D1 容量压力。

清理 SQL（**不自动执行**，先数一下再删）：

```sql
-- 1) 先看会删多少
SELECT COUNT(*) AS n
FROM media_audit
WHERE changed_at < (CAST(strftime('%s','now') AS INTEGER) - 90 * 86400) * 1000;

-- 2) 确认后手动执行
DELETE FROM media_audit
WHERE changed_at < (CAST(strftime('%s','now') AS INTEGER) - 90 * 86400) * 1000;
```

建议按月手动跑，或放进独立的运维定时任务；**不要**塞进上传/读接口路径。
`idx_media_audit_wp` 不含 `changed_at` 前导列，按时间清理会扫全表——当前量级
（几百条/月）无所谓；真到百万级再补：

```sql
CREATE INDEX IF NOT EXISTS idx_media_audit_changed ON media_audit(changed_at);
```

## 设计取舍

- **为什么 INSERT 也要审计**：作品行第一次带 `storage_key` 时就是「首次入库」，
  之后才能对照「谁第一次把它写进来」。没有媒体的草稿（`storage_key`/`sha256` 为
  `NULL`、`bytes = 0`）不记，否则新建草稿会刷一条无意义的审计；那种创建动作在
  `audit_log` 里已有 `wallpaper.create`。
- **为什么不做 DELETE 审计**：删除不是「媒体元数据变更」，且 `audit_log` 已有
  `wallpaper.delete`（带 actor）。`media_audit` 故意不建外键，作品删掉后历史审计
  仍保留，用于取证；真要审计删除，应扩 `audit_log` 而不是在这张表里猜。
- **为什么只存三列**：审计表要能长期保留。存整行快照会让表随标题/描述一起膨胀，
  也会把「媒体变更」和「文案变更」混在一起。

## 迁移与验证

```bash
# 线上执行（幂等，可重复跑）
npx wrangler d1 execute folia --file=./schema/015_media_audit.sql --remote

# 确认表 / 触发器
npx wrangler d1 execute folia --remote --command \
  "SELECT type, name FROM sqlite_master WHERE name LIKE '%media_audit%' ORDER BY type, name"

# 本地测试
node tools/run-tests.mjs
```
