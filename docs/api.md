# API 参考

统一前缀 `/api`。所有响应都是 JSON。

**成功**

```json
{ "ok": true, "data": { ... } }
```

**失败**

```json
{ "ok": false, "error": { "code": "forbidden", "message": "缺少权限：wallpaper:publish", "details": { "required": "wallpaper:publish", "role": "editor" } } }
```

`details` 只在有帮助时出现（字段名、冲突的壁纸 id、分类下壁纸数等）。

## 约定

- **认证**：`folia_session` Cookie，`HttpOnly` + `SameSite=Lax`，7 天有效。服务端只存令牌的 SHA-256。
- **CSRF**：所有 `POST/PUT/PATCH/DELETE` 必须带 `X-Folia-Client: admin`；若带 `Origin`，还必须与站点同源。
- **错误码**：400 参数问题 / 401 未登录 / 403 权限不足 / 404 不存在 / 409 冲突（重名、文件重复、分类非空）/ 413 过大 / 415 类型不支持 / **422 内容不符合播放规格** / 429 限流 / 500 内部错误。
- **公开接口**带 CORS（`access-control-allow-origin`），只读，不需要登录。

## 认证

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/meta` | 公开 | `initialized` / 可用 `kinds`、`sorts` |
| `POST` | `/api/setup` | 公开（仅一次） | 用 `BOOTSTRAP_TOKEN` 创建第一位管理员 |
| `POST` | `/api/auth/login` | 公开 | `{email, password}` → 设 Cookie |
| `POST` | `/api/auth/logout` | 公开 | 清 Cookie |
| `GET` | `/api/auth/me` | 登录 | 当前用户 + `capabilities` 数组 |
| `POST` | `/api/auth/password` | 登录 | `{currentPassword, newPassword}`，成功后重置所有会话 |

`/api/auth/me` 返回：

```json
{
  "ok": true,
  "data": {
    "user": {
      "id": "usr_...", "email": "a@b.co", "name": "站长",
      "role": "admin", "roleLabel": "管理员", "active": true,
      "capabilities": ["audit:read", "category:create", "..."]
    }
  }
}
```

## 壁纸（需登录）

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/api/admin/wallpapers` | `wallpaper:read` |
| `POST` | `/api/admin/wallpapers` | `wallpaper:create` |
| `GET` | `/api/admin/wallpapers/:id` | `wallpaper:read` |
| `PATCH` | `/api/admin/wallpapers/:id` | `wallpaper:update`（编辑仅限自己的） |
| `PUT` | `/api/admin/wallpapers/:id/asset` | `asset:upload` + `wallpaper:update` |
| `PUT` | `/api/admin/wallpapers/:id/thumb` | `asset:upload` + `wallpaper:update` |
| `POST` | `/api/admin/wallpapers/import` | `asset:upload` + `wallpaper:create`（批量入口用，见下） |
| `DELETE` | `/api/admin/wallpapers/:id` | `wallpaper:delete` |
| `POST` | `/api/admin/wallpapers/reorder` | `wallpaper:reorder` |

列表查询参数：`status` / `kind` / `categoryId` / `tag` / `liked=1` / `mine=1` / `q` / `limit`(≤200) / `offset`。`tag` 按标签名精确匹配（匹配 `tags` JSON 数组里的整项）；`liked=1` 只返回**当前账号喜欢过**的作品（对应后台「类型 → 喜欢」）。

## 喜欢（需登录，按账号存 D1）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/likes` | `{likes:[{slug,title,categorySlug,createdAt}]}` |
| `PUT` | `/api/likes/:slug` | 喜欢 |
| `DELETE` | `/api/likes/:slug` | 取消喜欢 |

前台仍先写本地缓存，再异步同步；失败会回滚并提示。换设备登录后以服务端为准。

新建：

```http
POST /api/admin/wallpapers
Content-Type: application/json
X-Folia-Client: admin

{ "title": "夜雨霓虹", "kind": "static", "categoryId": "cat_dynamic", "tags": ["夜景"] }
```

返回草稿行（`status: "draft"`，`hasAsset: false`）。**先拿到 id，再传文件**：

```http
PUT /api/admin/wallpapers/wp_xxx/asset
Content-Type: image/png
X-Folia-Client: admin

<原始二进制>
```

服务端只看文件头判断类型，校验：
- 静态壁纸只收 png / jpeg / webp / avif / gif（≤20MB）
- 动态壁纸收 mp4 / webm（≤60MB）或 bootanimation.zip（≤80MB）
- 视频会顺带解析 `moov/mvhd` 写入 `duration_ms`（WebM 与分片 MP4 留空）
- 按 SHA-256 去重，重复会 409 并带上已有壁纸的 `id` 和 `title`
- **视频还要过播放合规体检**（见下一节），不合规 422、**一个字节都不落盘**
- **能纯 JS 修的先修**：moov 在尾部时自动转封装前置（4.23.18 起，不再 422）
- 图片没传缩略图时用原图当缩略图；`width/height` 探测不出来直接 422（`import_incomplete`）

响应里的 `url` 就是 `/media/wallpapers/...`，可直接给 `<img>`。

> 真正的实现只有一处：`src/server/ingest.js` 的 `ingestAsset()`。
> `PUT /asset`、`POST /import`（批量入口）、批量的「立即扫描 / 添加目录」全走它，
> 所以不可能出现「某条入口绕过体检」的第二种行为。

### 批量入口：`POST /api/admin/wallpapers/import`

后台「立即扫描 / 添加目录」与「批量导入本地文件」用的就是这条（一个文件一枪）。
`multipart/form-data`：`file`（必填）+ 可选 `thumb`（浏览器 canvas 生成的 WebP）、
可重复的 `variant`（1080p 变体）+ `title` / `kind` / `categoryId` / `tags`(JSON) / `publish`(0|1) / `reportId`。

**HTTP 200 + 导入报告**（某一条失败是数据不是异常）：

```json
{
  "ok": true,
  "data": {
    "item": { "title": "星空", "status": "imported", "wallpaperId": "wp_…",
              "autoFixes": ["thumb", "thumbFromOriginal"], "warnings": [], "reason": null },
    "report": { "ok": true, "reportId": "report_…", "imported": 1, "reused": 0, "failed": 0,
                "skipped": 0, "items": [ /* 同上 */ ] }
  }
}
```

失败条目的 `code` 与单条上传的错误码一致（`media_non_compliant` / `import_incomplete` /
`unsupported_media_type` / `payload_too_large`），并且**不会留在库里**（服务端会回滚刚建的草稿）。
同一文件重复导入 ⇒ `status: "reused"`，不产生第二条。字段与报告口径见
[`UPLOAD-SOP.md`](UPLOAD-SOP.md) §9。

### 422：视频不符合播放规格

Cloudflare Workers 里没有 ffmpeg，服务端只做「体检 + 拒绝」，不转码——转码在本机用
`tools/prepare-upload.mjs` 做（规格与违规码见 [`UPLOAD-SOP.md`](UPLOAD-SOP.md) §0）。
判定函数：`src/server/media-compliance.js` 的 `checkVideoCompliance()`（与本地工具共用同一份规则）。

```http
PUT /api/admin/wallpapers/wp_xxx/asset
Content-Type: video/mp4

<原始二进制>
```

```json
{
  "ok": false,
  "error": {
    "code": "media_non_compliant",
    "message": "视频不符合播放规格：宽度 5916px 超过上限 3840px；像素总量 5916×2530=14967480 超过上限 8294400（=3840×2160）。请先用 tools/prepare-upload.mjs 处理后再上传",
    "details": {
      "mime": "video/mp4",
      "width": 5916,
      "height": 2530,
      "fps": 30,
      "codec": "h264",
      "faststart": false,
      "bytes": 15987935,
      "violations": [
        { "code": "too-wide", "message": "宽度 5916px 超过上限 3840px" },
        { "code": "too-many-pixels", "message": "像素总量 5916×2530=14967480 超过上限 8294400（=3840×2160）" }
      ],
      "warnings": [],
      "hint": "请先用 tools/prepare-upload.mjs 处理后再上传"
    }
  }
}
```

违规码（`details.violations[].code`）：

| 码 | 判定 |
|---|---|
| `too-wide` | 宽 > 3840 px |
| `too-tall` | 高 > 2160 px |
| `too-many-pixels` | 宽 × 高 > 8,294,400（= 3840×2160） |
| `fps-too-high` | 帧率 > 30 fps（留 0.5 容差，29.97/30 不误杀） |
| `codec-unsupported` | 编码不是 H.264（如 HEVC）；WebM 只接受 vp8/vp9/av1 |
| `not-faststart` | moov 不在 mdat 之前，或无法确认位置（4.23.18 起服务端会先自动转封装；转封装失败才报这条） |
| `probe-failed` | 宽高或编码探测不出来（moov 缺失/文件损坏） |

- **422 是拒绝入库**：返回时还没 `putAsset`、没算 sha256、没记账，R2 与 D1 都不会被改。
- **只有警告的情况照常 200 入库**，响应里带 `compliance.warnings`，同时写一条
  `audit_log.action = wallpaper.asset_compliance_warn`（体积超限 / WebM 容器 / 帧率探测不到）。
- 图片、zip（皮肤包 / 开机动画包）**不受影响**，仍走原来的类型与体积校验。
- 开机动画的 mp4 与壁纸视频走同一套体检（同一个上传接口）。

发布：`PATCH {"status":"published"}`，需要 `wallpaper:publish`，且必须已上传文件。首次发布会写 `published_at`，之后重复发布不会顶到"最近添加"第一位。

## 分类（需登录）

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/api/admin/categories` | `category:read` |
| `GET` | `/api/admin/category-options` | `category:read`（下拉框专用精简版） |
| `POST` | `/api/admin/categories` | `category:create` |
| `PATCH` | `/api/admin/categories/:id` | `category:update` |
| `DELETE` | `/api/admin/categories/:id?strategy=block\|detach\|move[&to=<id>]` | `category:delete` |
| `POST` | `/api/admin/categories/reorder` | `category:reorder` |

- `name` 唯一（409）。
- 删除时若分类下还有壁纸，三种收尾方式：
  - `block`（默认）→ 409，`details` 里带 `wallpaperCount` 与可用的 `strategies`；
  - `detach` → 这些壁纸改成「未分类」，再删分类；
  - `move&to=<分类 id>` → 这些壁纸迁到目标分类，再删分类。目标必须存在且不能是自己（400 / 404），迁移与删除在同一个 batch 里，不会出现「删了分类壁纸却没了」的中间态。
- 返回 `{deleted, id, detached, moved, to}`：`moved` 是迁走的数量，`detached` 是转未分类的数量。
- 重排必须提交**全部**分类 id，顺序即前台 tab 顺序。

## 成员（仅管理员）

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/api/admin/members` | `member:manage` |
| `POST` | `/api/admin/members` | `member:manage` |
| `PATCH` | `/api/admin/members/:id` | `member:manage` |

`POST` 需要 `{email, name, role, password}`。`PATCH` 接受 `name` / `role` / `active` / `password` 的任意组合：

- 改自己角色 → 400
- 停用自己 → 400
- 降级或停用最后一位启用管理员 → 409
- `password` 会立即注销该成员所有会话

## 审计（仅管理员）

| 方法 | 路径 | 权限 |
|---|---|---|
| `GET` | `/api/admin/audit?limit=100` | `audit:read` |

## 公开接口（无需登录）

这几个接口对匿名请求开放（站点门里只有它们和 `/media/*` 是白名单，见 [`private-site.md`](private-site.md)）。
只认 `GET` / `HEAD`（外加跨域预检 `OPTIONS`），写接口一律仍要管理员会话。

**匿名可读接口清单**

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/meta` | 站点是否已初始化、可用 `kinds` / `sorts` |
| `GET` | `/api/public/categories` | 只返回 `is_public = 1` 的分类，带已发布数量 |
| `GET` | `/api/public/tags?category=<slug>` | 全局标签 + 该分类专属标签；不带 `category` 返回全部 |
| `GET` | `/api/public/subtags?category=<slug>&tag=<标签>` | 出现过的子标签（按当前分类/标签收窄） |
| `GET` | `/api/public/wallpapers` | 只返回已发布且有文件的壁纸；带筛选面板数据 `facets` |
| `GET` | `/api/public/wallpapers/:slug` | 单张详情 |
| `GET` | `/media/*` | 媒体直链，key 含内容哈希、不可枚举 |

`/api/public/*` 都带 `access-control-allow-origin: *`，插件从任意源 fetch 都能读；它们不接受 Cookie 身份，所以不存在把会话暴露给别的源的问题。
`/api/plugin/feed` **不在**白名单里，仍然需要管理员会话（它服务站内插件面板，用的是会话身份）。

**标签按分类拆分**：`tags` 表有 `category_id`，为空是全局标签（所有分类可见）。后台 `POST/PATCH /api/admin/tags` 接受 `categoryId`（`null` = 全局），作品页的标签下拉会跟着选中分类过滤。

`/api/public/wallpapers` 参数：

| 参数 | 说明 |
|---|---|
| `category` | 分类 slug（不是 id） |
| `kind` | `static` / `dynamic` |
| `tag` | 标签名精确匹配；**支持逗号分隔多值，语义是 OR**（`tag=动漫,游戏` → 带其中任意一个标签即命中）。单个标签最长 30 字，一次最多 20 个 |
| `subtag` | 子标签名精确匹配 |
| `aspect` | 宽高比档位：`16:9` / `21:9` / `32:9` / `9:16` / `4:3` / `1:1`（容差 6%） |
| `q` | 标题模糊搜索（≤60 字，`%` `_` 会被剔除） |
| `sort` | `recent`(默认) / `oldest` / `name` / `size` / `resolution` |
| `featured=1` | 只要置顶的 |
| `limit` | 1–100，默认 24 |
| `page` | 页码，从 1 开始；给页码翻页用。`page` 和 `cursor` 同时传时以 `page` 为准 |
| `cursor` | 上一页返回的 `nextCursor`；无限滚动用 |

响应：

```json
{
  "ok": true,
  "data": {
    "items": [{
      "id": "wp_...", "slug": "夜雨霓虹", "title": "夜雨霓虹",
      "kind": "static", "mime": "image/png", "bytes": 812345,
      "width": 3840, "height": 2160, "durationMs": null, "tags": ["夜景"],
      "featured": false,
      "category": { "id": "cat_dynamic", "slug": "dynamic", "name": "动态" },
      "url": "/media/wallpapers/wp_abc/9f3c1a2b3c4d.png",
      "publishedAt": 1761700000000, "createdAt": 1761690000000
    }],
    "total": 42, "hasMore": true, "nextCursor": "eyJ0Ijo...",
    "page": 2, "pageSize": 24, "pageCount": 2, "offset": 24,
    "sort": "recent",
    "facets": {
      "categories": [{ "id": "cat_wallpaper", "slug": "wallpaper", "name": "壁纸", "count": 61 }],
      "tags": [{ "name": "动漫", "count": 33 }, { "name": "游戏", "count": 12 }],
      "subtags": [{ "name": "原神", "count": 9 }]
    }
  }
}
```

### `data.facets`（筛选面板数据）

给「分类 / 标签 / 子标签」下拉框直接喂数据和角标，**纯增量字段**：旧的 `items` / `total` / 分页字段与参数语义完全没变，老客户端忽略它即可。

- **统计口径与当前筛选条件一致**：`category`、`kind`、`tag`、`subtag`、`aspect`、`q`、`featured` 有的都算进去（分页参数不参与，永远针对整个筛选结果）。所以「点开某分类后的角标」和「切回全部后的角标」都是对的，前端不需要自己算。
- **可见性门槛与清单同源**：两处都取自 `src/server/queries.js` 的同一个 `PUBLIC_VISIBLE`（`published` + 有文件 + `verified_at` 非空 + `review_status = 'approved'`）。因此同一筛选条件下 `sum(facets.categories[].count)` **恒等于**清单的 `total`。唯一例外：`category_id` 为 `NULL` 的未分类作品会进清单与 tags/subtags，但没有分类可归，所以不计入 `categories` 分组（合计比 `total` 少这几条）。回归测试见 `tests/public-facets.test.js` 的「一致性」用例。
- **`categories`**：`{id, slug, name, count}`。跟当前筛选走 —— 带了 `category` 时只剩该分类；某个分类下 0 条就不会出现（未分类的作品也不会出现在这里）。
- **`tags`**：`{name, count}`，只含 `count > 0` 的标签，按 `count` 降序，最多 **50** 个。
- **`subtags`**：`{name, count}`，同上（空子标签不计）。
- 三个数组共用**一条**聚合 SQL（`GROUP BY` + `json_each`），不是按条目逐条查；单次清单请求固定 3 条 SQL（列表 / 计数 / facets）。
- **旧接口的 count 口径更宽，可能与 facets 不同**：`/api/public/tags` 与 `/api/public/subtags` 是历史接口，它们的 `count` 只要求「已发布 + 有文件」，**不看** `verified_at` / `review_status`（未审核或未验证的条目也会被算进去）。所以两个数可能对不上：**筛选面板一律以 `facets` 为准**，旧接口的 count 只当参考。
- `tag` 参数清洗后没有有效值时（例如 `tag=`、`tag=,,,`）等价于「不过滤」，清单与 facets 都回到全量 —— 与 JSON 数组为空时走 `?N IS NULL` 是同一个分支。

`/api/public/subtags` 的 `tag` 参数同样支持逗号分隔多值（OR）。

`page` / `pageSize` / `pageCount` / `offset` 在传 `page` 时最有用（`page` 不传时 `page` 为 `null`，`pageCount` 仍按 `total` 算）。用游标时继续看 `nextCursor` / `hasMore`，两者不要混用。

## 媒体

`GET /media/<key>` — 从 R2 直出。`Cache-Control: public, max-age=31536000, immutable`（key 含内容哈希）。视频支持 `Range`，返回 206。

> immutable 的前提是 **key 由最终入库内容的 sha256 生成、且永不覆盖同名 key**；`PUT /asset` 走 `assetKey()` 自动满足，但脚本/手工补传必须自己遵守。
> 若在同一个 key 上覆盖上传，边缘缓存（旧字节）与源站（新字节）会长期并存，`Range` 与全量下载拼出坏包。检测与处置见 [`r2.md`](r2.md) 的「对象一致性守则」。

加 `?download=<文件名>` 会以附件形式返回（`Content-Disposition: attachment`），文件名支持中文（RFC 5987 编码）。开机动画的「下载视频」按钮用的就是这个。

如果配置了 `MEDIA_BASE`（R2 自定义域名），所有 `url` 会直接指向那个域名，不再经过 Worker。两种形式都是绝对可粘贴的直链。
