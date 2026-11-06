# 阶段三 · 筛选参数 ↔ SQL ↔ 内存筛选 对照表

> 这份表是阶段三的**风险清单**：快照接管公开读之后，同一组筛选参数会走两条路径——
> 线上静态快照（`src/server/snapshot.js` + `public-api.js` 内存筛选）与 D1（`queries.js` 的 SQL）。
> 两条路径只要有一处语义不等价，全站公开列表就会在没有报错的情况下错乱。
> 所以先逐条列清楚，再由 `tests/snapshot-parity.test.js` 的 16 块对拍把结论钉死。

**图例**

| 记号 | 含义 |
|---|---|
| SQL | `src/server/queries.js` 里的条件片段 |
| MEM | `src/server/public-api.js` 里的内存实现 |
| ✓ | 已逐条核对等价，且被测试覆盖 |
| ⚠ | 等价但有边界差异（下面「已知边界差异」逐条写清） |

**通用前提（两条路径共用）**

| 项 | SQL | MEM |
|---|---|---|
| 可见性门槛 | `<code>PUBLIC_VISIBLE</code>：`status='published'` AND `storage_key IS NOT NULL` AND `verified_at IS NOT NULL` AND `review_status='approved'` | 快照构建时用同一条 SQL 取行，所以条目集合天然相同 |
| 分类公开 | `AND (w.category_id IS NULL OR c.is_public = 1)` | 构建时用 `Q.listPublicCategories` 过滤；`category_id IS NULL` 保留 |
| 参数解析 | `public-api.js` 的 `parse*`（同一份函数，两条路径共用） | 同左 |
| 参数顺序/编号 | `PUBLIC_EXTRA`（清单 `?8…?23`）、`PUBLIC_COUNT_EXTRA`（计数 `?5…?19`） | 不涉及 |

---

## 一、15 个筛选参数逐条对照

| # | 参数 | 解析/校验 | SQL 条件（`queries.js`） | 内存实现（`public-api.js`） | 结论 |
|---|---|---|---|---|---|
| 1 | `tag` | `parseTagFilter()`：逗号分隔多值、**OR** 语义；每值过 `normalizeTag()`；单值 ≤30 字、≤20 个，超限 400 | `EXISTS (SELECT 1 FROM json_each(w.tags) j LEFT JOIN tag_aliases a ON a.alias = j.value WHERE COALESCE(a.canonical, j.value) IN (SELECT value FROM json_each(?8)))` | `item.tags.map(t => aliases[t] ?? t)`，`values.some(v => tags.includes(v))` | ✓ |
| 2 | `aspect` | `parseAspect()`：只认 `16:9 / 21:9 / 32:9 / 9:16 / 4:3 / 1:1`，其它值**当作不过滤** | `w.width > 0 AND w.height > 0 AND ABS((w.width*1.0/w.height) - ?9) < 0.06` | 同式：`w>0 && h>0 && Abs(w/h - ratio) < ASPECT_TOLERANCE` | ✓ |
| 3 | `subtag` | 去 `%_\`、trim、≤40 字；空 → 不过滤 | `(?11 IS NULL OR w.subtag = ?11)` | `item.subtag === filters.subtag` | ✓ |
| 4 | `license` | `parseLicense()`：小写、`[a-z0-9][a-z0-9._-]*`、≤40 字，非法 400 | `LOWER(COALESCE(w.license,'')) = ?12` | `String(item.license ?? '').toLowerCase() === filters.license` | ✓ |
| 5 | `minWidth` | `parseOptionalInt` 0–100000，整数，非法 400 | `(?13 IS NULL OR w.width >= ?13)` | `within(item.width, min, null)`，null 值 → 不匹配 | ✓ |
| 6 | `maxWidth` | 同上 | `(?14 IS NULL OR w.width <= ?14)` | 同左 | ✓ |
| 7 | `minHeight` | 同上 | `(?15 IS NULL OR w.height >= ?15)` | 同左 | ✓ |
| 8 | `maxHeight` | 同上 | `(?16 IS NULL OR w.height <= ?16)` | 同左 | ✓ |
| 9 | `minDurationMs` | 0–86400000 | `(?17 IS NULL OR w.duration_ms >= ?17)` | `item.durationMs` 同上 | ✓ |
| 10 | `maxDurationMs` | 0–86400000 | `(?18 IS NULL OR w.duration_ms <= ?18)` | 同左 | ✓ |
| 11 | `minBytes` | 0–`Number.MAX_SAFE_INTEGER` | `(?19 IS NULL OR w.bytes >= ?19)` | `item.bytes` 同上 | ✓ |
| 12 | `maxBytes` | 同上 | `(?20 IS NULL OR w.bytes <= ?20)` | 同左 | ✓ |
| 13 | `fpsMax` | 1–1000（`0` 直接 400） | `(?21 IS NULL OR w.fps <= ?21)`，`fps IS NULL` → 不匹配 | `item.fps` 为 null → 不匹配，否则 `<=` | ✓ |
| 14 | `playable` | 只认 `original` / `1080p30` | `original`：`width/height/fps` 全非 NULL 且 ≤1920/≤1080/≤30；`1080p30`：原画满足 **或** `EXISTS(json_each(w.variants))` 里某档 `width/height` 非 NULL 且 ≤1920/≤1080 且（`fps` NULL 或 ≤30） | `snapshotOriginalPlayable()` + `snapshotPlayable()`，变体照同一套判据 | ⚠ 见边界 ① ② |
| 15 | `audio` | `parseAudio()`：`true/1` → 1，`false/0` → 0，其它 400 | `(?23 IS NULL OR w.has_audio = ?23)`，`has_audio IS NULL` → 不匹配 | `item.hasAudio === (filters.audio === 1)`，null 三态天然不匹配 | ✓ |

> 说明：`minWidth=0` / `audio=0` 这类「假值」不会让条件消失——`extraFilters()` 收到的是**占位符编号**（`'?13'` 这种字符串），
> 不是参数值，所以 `if (minWidth)` 判断的是「这条 SQL 有没有这个片段」，运行时再由 `?N IS NULL` 决定是否生效。

## 二、非 15 参数里的筛选/排序（同样要对拍）

| 参数 | SQL | MEM | 结论 |
|---|---|---|---|
| `category` | `(?1 IS NULL OR c.slug = ?1)` | `item.category?.slug === filters.category` | ✓ |
| `kind` | `(?2 IS NULL OR w.kind = ?2)` | `item.kind === filters.kind` | ✓ |
| `q` | `(?3 IS NULL OR w.title LIKE ?3)`，`likePattern()` 先剔 `% _ \`、压空白、截 60 | `title.toLowerCase().includes(needle)` | ⚠ 见边界 ③ |
| `featured` | `(?4 = 0 OR w.featured = 1)` | `featuredOnly && item.featured === true` | ✓ |
| `sort=recent` | `ORDER BY COALESCE(published_at, created_at) DESC, w.id DESC` | `cursorKey('recent')` 同式，降序，同键按 id 降序 | ✓ |
| `sort=oldest` | `... ASC, w.id ASC` | 同式升序 | ✓ |
| `sort=name` | `w.title COLLATE NOCASE ASC, w.id ASC` | `title.toLowerCase()` 比较 | ⚠ 见边界 ④ |
| `sort=size` | `w.bytes DESC, w.id DESC` | `Number(bytes)` 降序，同键 id 降序 | ✓ |
| `sort=resolution` | `(COALESCE(width,0)*COALESCE(height,0)) DESC, w.id DESC` | 同式 | ✓ |
| `cursor` | `(?5 IS NULL OR (key < ?5 OR (key = ?5 AND id < ?6)))` | `snapshotAfterCursor()`：同式三元比较 | ✓ |
| `page` / `limit` | `LIMIT ?7 OFFSET ?10`，取 `limit+1` 行判 hasMore | 切片 + `offset + len < total` | ✓ |
| `total` | `SELECT COUNT(*)`（同一套筛选） | `filtered.length` | ✓ |
| `facets.categories` | `base JOIN categories c ON c.id=b.category_id AND c.is_public=1 GROUP BY category_id` | 按 `item.category.id` 分桶（快照只含公开分类） | ✓ |
| `facets.tags` | `COALESCE(a.canonical, j.value) GROUP BY`，排序 + 上限 50 在路由层 | 同口径分桶 + `byCount` 排序 + 截 50 | ✓ |
| `facets.subtags` | `WHERE subtag IS NOT NULL AND subtag <> '' GROUP BY subtag` | `typeof subtag === 'string' && subtag` 才计入 | ✓ |

## 三、已知边界差异（都写清、都被测试或文档兜住）

| # | 场景 | SQL 行为 | 内存行为 | 处理 |
|---|---|---|---|---|
| ① | 变体项缺 `key` 或 `bytes=0` | 仍参与 `playable` 判定（`json_each(w.variants)` 只看 width/height/fps） | 不参与（快照里的 `variants` 是 `variantsDto()` 的输出，已经过滤掉这类脏项） | 记录在案：`attachVariant()` 只写带 key 的变体，历史脏数据由 `tools/backfill-*` 修；不放宽 |
| ② | 变体的 width/height 是字符串（`"1920"`） | SQLite 里 TEXT 与 INTEGER 比较恒为「TEXT 更大」⇒ 不满足 `<= 1920` | `Number("1920")` ⇒ 1920，满足 | 记录在案：`attachVariant()` 一律写数字；脏数据同样走回填 |
| ③ | `q` 命中非 ASCII 的大小写 | SQLite `LIKE` 只对 ASCII 做大小写折叠 | JS `toLowerCase()` 折叠全 Unicode | 记录在案：站点标题以中文为主，中文无大小写；ASCII 两侧一致 |
| ④ | `sort=name` 且标题含非 ASCII 大写字母 | SQLite `COLLATE NOCASE` 只折叠 ASCII | JS `toLowerCase()` 折叠全 Unicode | 同上 |
| ⑤ | `w.tags` 是坏 JSON | `json_each` 抛错 ⇒ 该查询 500 | `safeJsonParse` → `[]` ⇒ 不匹配 | 记录在案：坏 JSON 是数据事故，不应被内存实现「修好」 |
| ⑥ | id 含非 ASCII（排序 tie-break） | SQLite `BINARY` 按 UTF-8 字节序 | JS 按 UTF-16 码元序 | 记录在案：id 由 `newId()` 生成，纯 ASCII |
| ⑦ | `/api/v1/public/subtags` 的**无参**口径 | `PUBLIC_SUBTAGS` 只要求 `published + storage_key`（118 条口径） | 快照里存的就是这条 SQL 的结果（同一口径）；**带筛选**时才按快照条目重算 | 记录在案：筛选态与无参态本来就是两套口径，两条路径一致即可 |
| ⑧ | `MEDIA_BASE` / `PUBLIC_ORIGIN` 变更 | 每次查询现算 URL | 快照里存的是构建时的绝对 URL | 运维约定：改媒体域名后必须重建快照（`node tools/build-snapshot.mjs --force`），写进 `docs/OPS.md` |

## 四、验证方式

| 层 | 文件 | 守什么 |
|---|---|---|
| 单元 | `tests/snapshot.test.js`（9 条） | `computeVersion` / `buildSnapshot` / `publishSnapshot` / `readSnapshot` 的行为，缓存头，draft 不入境 |
| 对拍 | `tests/snapshot-parity.test.js`（16 块） | 同一份 sqlite 数据，**快照路径**与 **D1 路径**的 `ids 序列 / total / facets / 排序键` 逐字段相同；不一致即红 |
| 线上 | `tools/smoke-public-api.mjs` + ①–⑦ 手工探针 | 快照真的接管了线上读、D1 行读增量 ≈ 0 |

16 块覆盖：无参 / category / kind / tag / subtag / q / aspect / featured / minWidth+maxWidth /
minHeight+maxHeight / minDurationMs+maxDurationMs / minBytes+maxBytes / fpsMax / playable / audio /
page+limit / 组合 3–4 个（命名 S10a…S10p）。

## 五、变动记录

| 日期 | 变更 | 理由 |
|---|---|---|
| 2026-11-06 | `PUBLIC_FILTERS` 增加 `AND (w.category_id IS NULL OR c.is_public = 1)` | A 方案（快照只收 `categories.is_public=1`）必须两条路径同口径，否则切快照当天 total 会变；线上 110 条全部落在公开分类，改动对现网 total 无影响（`facets.categories` 合计 110 == total 已核） |
| 2026-11-06 | 新增 `Q.listTagAliases`（`SELECT alias, canonical FROM tag_aliases ORDER BY alias`） | 内存筛选需要与 `LEFT JOIN tag_aliases` 完全相同的 alias→canonical 映射，不能另抄一份词表 |
