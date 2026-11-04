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
- **错误码**：400 参数问题 / 401 未登录 / 403 权限不足 / 404 不存在 / 409 冲突（重名、文件重复、分类非空）/ 413 过大 / 415 类型不支持 / 429 限流 / 500 内部错误。
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

响应里的 `url` 就是 `/media/wallpapers/...`，可直接给 `<img>`。

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

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/public/categories` | 只返回 `is_public = 1` 的分类，带已发布数量 |
| `GET` | `/api/public/tags?category=<slug>` | 全局标签 + 该分类专属标签；不带 `category` 返回全部 |
| `GET` | `/api/public/wallpapers` | 只返回已发布且有文件的壁纸 |
| `GET` | `/api/public/wallpapers/:slug` | 单张详情 |

**标签按分类拆分**：`tags` 表有 `category_id`，为空是全局标签（所有分类可见）。后台 `POST/PATCH /api/admin/tags` 接受 `categoryId`（`null` = 全局），作品页的标签下拉会跟着选中分类过滤。

`/api/public/wallpapers` 参数：

| 参数 | 说明 |
|---|---|
| `category` | 分类 slug（不是 id） |
| `kind` | `static` / `dynamic` |
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
    "sort": "recent"
  }
}
```

`page` / `pageSize` / `pageCount` / `offset` 在传 `page` 时最有用（`page` 不传时 `page` 为 `null`，`pageCount` 仍按 `total` 算）。用游标时继续看 `nextCursor` / `hasMore`，两者不要混用。

## 媒体

`GET /media/<key>` — 从 R2 直出。`Cache-Control: public, max-age=31536000, immutable`（key 含内容哈希）。视频支持 `Range`，返回 206。

> immutable 的前提是 **key 由最终入库内容的 sha256 生成、且永不覆盖同名 key**；`PUT /asset` 走 `assetKey()` 自动满足，但脚本/手工补传必须自己遵守。
> 若在同一个 key 上覆盖上传，边缘缓存（旧字节）与源站（新字节）会长期并存，`Range` 与全量下载拼出坏包。检测与处置见 [`r2.md`](r2.md) 的「对象一致性守则」。

加 `?download=<文件名>` 会以附件形式返回（`Content-Disposition: attachment`），文件名支持中文（RFC 5987 编码）。开机动画的「下载视频」按钮用的就是这个。

如果配置了 `MEDIA_BASE`（R2 自定义域名），所有 `url` 会直接指向那个域名，不再经过 Worker。两种形式都是绝对可粘贴的直链。
