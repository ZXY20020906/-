# Folia 素材网 API v1 文档

> 机器可读契约：[`openapi.yaml`](openapi.yaml)（OpenAPI 3.1）。
> 旧路径兼容性说明与错误码表也在 [`api.md`](api.md)。

## 1. 基础信息

| 项 | 值 |
|---|---|
| Base URL | `https://folia-5ve.pages.dev/api/v1`（以实际部署域名为准） |
| 版本 | `v1`（URL 前缀；`manifest.json` 里也有 `apiVersion`） |
| 协议 | HTTPS + JSON（UTF-8） |
| 认证 | 公开只读，**不需要**登录；可选 API key 提升配额 |
| CORS | 所有公开响应带 `access-control-allow-origin: *` |

旧路径 `/api/public/*` **继续可用**：它是 v1 的兼容壳（`src/server/routes/public.js`
直接转发到 `routes/public-v1.js`），同一请求两边响应体逐字节相同。新接入请用 v1。

## 2. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/public/wallpapers` | 列表（分页 / 筛选 / facets） |
| `GET` | `/api/v1/public/wallpapers/:slug` | 详情（公开可读） |
| `GET` | `/api/v1/public/categories` | 公开分类（`publishedCount` 与列表 `total` 同口径） |
| `GET` | `/api/v1/public/tags` | 标签（可按 `category` 收窄；计数按 canonical 合并） |
| `GET` | `/api/v1/public/subtags` | 子标签（可按 `category` / `tag` 收窄） |
| `GET` | `/api/v1/public/manifest.json` | 全量快照（客户端同步用，ETag/304） |
| `GET` | `/media/:key` | 媒体直链（Range 支持；文本响应同源） |

可见性门槛：`status=published` + 有文件 + 上传回读已验证 + `review_status=approved`。
草稿 / 下线 / 未审核 / 缺文件的条目永远不会出现在 v1 里。

## 3. 列表参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `category` | string | 分类 slug（不是 id） |
| `kind` | `static` \| `dynamic` \| `pet` | 素材类型（`pet` = 桌宠包，门 1 新增） |
| `q` | string | 标题模糊搜索（≤60 字，`%` `_` 会被剔除） |
| `tag` | string | 标签精确匹配；逗号分隔多值 = OR；单值 ≤30 字、一次 ≤20 个；**alias 先归一**（`anime` → `动漫`） |
| `subtag` | string | 子标签精确匹配 |
| `aspect` | enum | `16:9` / `21:9` / `32:9` / `9:16` / `4:3` / `1:1`（容差 6%） |
| `license` | string | 许可证标识（小写，如 `cc0` / `cc-by` / `personal`）；空值不命中 |
| `minWidth` / `maxWidth` | int | 原画宽度范围（px）；宽度未知的条目不匹配 |
| `minHeight` / `maxHeight` | int | 原画高度范围（px） |
| `minDurationMs` / `maxDurationMs` | int | 时长范围（毫秒）；图片无时长 ⇒ 不匹配 |
| `minBytes` / `maxBytes` | int | 体积范围（字节） |
| `fpsMax` | int | 帧率上限；`fps` 未知的条目不匹配 |
| `playable` | `1080p30` \| `original` | 档位存在性（见下） |
| `audio` | `true`/`false`/`1`/`0` | 是否有音轨；`has_audio` 未知的条目不参与 |
| `featured` | `1` \| `true` | 只返回置顶 |
| `sort` | `recent`/`oldest`/`name`/`size`/`resolution` | 默认 `recent` |
| `limit` | int | 1–100，默认 24 |
| `page` | int | 页码（从 1 开始）；与 `cursor` 同时传时以 `page` 为准 |
| `cursor` | string | 上一页的 `nextCursor`（无限滚动） |

**`playable` 语义**：给定档位**存在且满足** 1920×1080@30 上限。

- `playable=1080p30`：原画满足，**或** `variants[]` 里存在一个 `width≤1920 && height≤1080
  && (fps 缺省或 ≤30)` 的变体；
- `playable=original`：原画自身满足 `width≤1920 && height≤1080 && fps≤30`；
- 变体缺 `fps` 时视为满足（ingest 只放行 ≤30fps 的变体；第一次回填前历史变体没有 fps）。

数值参数对**条目自身**生效；未知值（NULL）一律不匹配 —— 不能证明满足就不能放行。

所有筛选参数都会参与 `facets` 聚合（与清单同源），非法值返回 `400 bad_request`。

## 4. 数据字段（Wallpaper）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `slug` / `title` | string | 稳定 id / URL slug / 标题 |
| `description` / `subtag` | string | 描述 / 子标签 |
| `kind` | `static`/`dynamic`/`pet` | 静态（图片）、动态（视频）、桌宠包（zip + pet.json，门 1 新增） |
| `mime` | string\|null | `image/png`、`video/mp4`、`application/zip` … |
| `bytes` | int | 文件体积 |
| `width` / `height` | int\|null | 原画尺寸 |
| `durationMs` | int\|null | 视频时长 |
| `fps` | number\|null | 帧率（纯 JS 探测 / ffprobe 回填） |
| `codec` | string\|null | `h264` / `hevc` / `vp9` / `av1` … |
| `pixFmt` | string\|null | 像素格式（`yuv420p`…）；Worker 里通常为 null，回填后写入 |
| `hasAudio` | boolean\|null | **三态**：true 有 / false 无 / null 未知（别当 false） |
| `tags` | string[] | 标签（原始存储值；筛选/面板按 canonical） |
| `featured` | boolean | 是否置顶 |
| `category` | object\|null | `{id, slug, name}` |
| `url` | string | 原文件直链 |
| `thumbUrl` | string\|null | 卡片缩略图 |
| `posterUrl` | string\|null | 首帧海报（1280 宽 WebP）；没有时客户端用 `thumbUrl` 兜底 |
| `license` / `source` / `author` | string\|null | 许可证 / 来源 / 作者 |
| `variants` | array | 降档变体，按 bytes 升序 |
| `sha256` | string\|null | 内容哈希（≤40MB 才有；大文件用采样指纹，此处为 null） |
| `updatedAt` / `publishedAt` / `createdAt` | int | 毫秒时间戳 |

### variants[]

```json
{
  "label": "1080p",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "bytes": 5237560,
  "sha256": "…",
  "url": "https://…/media/wallpapers/wp_x/9f3c….1080p.mp4"
}
```

`label` 规则（与 `src/core/variant-label.js` 同源）：`1080p`（降分辨率）/ `30fps`
（同分辨率降帧）/ `4K30` / `2K30` / `<height>p`（信息不足回落）。`width`、`fps` 是第一期新增，
老数据为 `null`。

### 桌宠包（`kind: "pet"`，门 1 新增）

桌宠包是**普通 zip 素材**，只是包里带一份 `pet.json`（`petManifestVersion: 2`）。
站点识别后，列表/详情/manifest 里的这条会多出 `kind:"pet"` 与 `pet` 对象；
**其余字段（url / bytes / thumbUrl / variants / sha256 …）与普通素材完全一致**。

```json
{
  "kind": "pet",
  "mime": "application/zip",
  "url": "https://…/media/wallpapers/wp_x/9f3c….zip",
  "sha256": "…",
  "bytes": 689324,
  "thumbUrl": "https://…/media/thumbs/wp_x/1a2b….webp",
  "variants": [],
  "pet": {
    "id": "whale-girl",
    "displayName": "鲸鱼娘",
    "frames": [8, 8, 8, 8, 8, 8, 8, 8, 8],
    "columns": 8,
    "tracks": ["idle", "running-right", "wave"],
    "previewUrl": "https://…/media/thumbs/wp_x/1a2b….webp"
  }
}
```

| 字段 | 说明 |
|---|---|
| `pet.id` | `pet.json` 里的 `id`（slug 风格） |
| `pet.displayName` | 展示名 |
| `pet.frames` | `sprite2d.frames`（每行帧数，长度 = 行数） |
| `pet.columns` | 雪碧图列数（缺省 8） |
| `pet.tracks` | 状态名列表；**一定含 `idle`** |
| `pet.previewUrl` | `previews/` 第一张（与 `thumbUrl` 同址） |

客户端按 `pet.id` 决定安装目录，`previewUrl` 当封面，`tracks` 决定能播哪些动作。
`kind` 只新增了 `pet` 这个取值，`static` / `dynamic` 的语义没变。

**筛选**：`?kind=pet` 只返回桌宠包（2026-11-07 起可用；此前该值会 400）。
`?kind=static` / `?kind=dynamic` **不会**把桌宠包混进来——库里桌宠仍存 `kind='static'`，
对外按 `pet` 归类。传其它值仍然 400。

### 分类计数的口径

`/api/v1/public/categories` 的每个 `publishedCount` 与列表 `total` 用**同一条谓词**
（`published` + 有文件 + 已验证 + 已审核 + 分类公开），因此：

```
sum(categories[].publishedCount) + 未分类 == /api/v1/public/wallpapers 的 total
```

没有归到任何公开分类的条目会在 `categories` 末尾单列一项
`{ id: null, slug: "uncategorized", name: "未分类", publishedCount: N }`，
只有 N > 0 时才出现（分类覆盖完整时响应与旧版逐字节相同）。
`kind` 只新增了 `pet` 这个取值，`static` / `dynamic` 的语义没变。

## 5. manifest.json

```json
{
  "apiVersion": "v1",
  "generatedAt": 1761700000000,
  "etag": "cb1f9a…",
  "total": 110,
  "items": [
    {
      "id": "wp_x", "slug": "…", "kind": "dynamic",
      "url": "https://…/media/wallpapers/wp_x/abc.mp4",
      "bytes": 12345678, "sha256": "…",
      "width": 3840, "height": 2160, "fps": 60,
      "variants": [ /* 同上 */ ],
      "posterUrl": "https://…/media/posters/wp_x/….webp",
      "tags": ["动漫"], "license": "cc0", "updatedAt": 1761700000000
    }
  ]
}
```

- `generatedAt` = D1 里公开集合最新的 `updated_at`（**不是请求时间**）；同一批数据重复请求不变。
- `etag` 同时出现在 body 与响应头（响应头带引号）。带 `If-None-Match` 命中 ⇒ `304`（无 body）。
  ⚠️ 经 gzip/br 压缩传输时，CDN 可能把响应头改写成弱校验 `W/"…"`（内容被压缩后强 ETag 不再成立）；
  比较/回传时先去掉 `W/` 前缀即可，服务端也是这么归一化的。
- 全量快照上限 1000 条；不分页（当前 232 条量级）。

## 6. 错误码

错误体统一：

```json
{ "ok": false, "error": { "code": "bad_request", "message": "…", "hint": "…", "details": { } } }
```

| code | HTTP | 含义 | hint（默认） |
|---|---|---|---|
| `bad_request` | 400 | 参数不合法 | 检查字段名/类型/范围；`details.field` 指出具体字段 |
| `unauthorized` | 401 | 未登录（管理接口） | 公开接口不需要登录 |
| `site_locked` | 401 | 路径不在匿名白名单 | 用 `/api/v1/public/*` |
| `api_key_invalid` | 401 | API key 无效/停用 | 检查 `Authorization: Bearer` 或 `?key=` |
| `forbidden` | 403 | 权限不足 | 当前角色不含该动作 |
| `not_found` | 404 | 资源不存在 / 未发布 | 检查 slug/id 或发布状态 |
| `method_not_allowed` | 405 | 方法不支持 | 公开接口只读：GET/HEAD/OPTIONS |
| `conflict` | 409 | 重名 / 文件重复 | `details` 带已有条目 id |
| `payload_too_large` | 413 | 体积超限 | 图片≤20MB、视频≤60MB、资源包≤64MB |
| `unsupported_media_type` | 415 | 类型不支持 | png/jpeg/webp/avif/gif、mp4/webm、zip |
| `media_non_compliant` | 422 | 视频播不了 | 先跑 `tools/prepare-upload.mjs` |
| `import_incomplete` | 422 | 缺必填字段 | `details.missing` 列出缺的字段 |
| `too_many_requests` | 429 | 超限 | 按 `Retry-After` 秒数等待 |
| `storage-verify-failed` | 500 | R2 回读失败 | 重试；连续失败查 R2 绑定 |
| `internal_error` | 500 | 未预期异常 | `DEBUG_API=1` 带出真实异常 |

## 7. 限流

| 请求类型 | 配额 | 计数键 |
|---|---|---|
| 无 key | **120 次/分钟** | `pub:<client-ip>` |
| 有 key | key 的 `rpm`（默认 **600 次/分钟**） | `key:<key-id>` |

- 超限：HTTP `429` + `Retry-After`（秒）+ `x-ratelimit-limit` / `x-ratelimit-remaining` /
  `x-ratelimit-window`；响应带 CORS，浏览器可读。
- 计数是 **isolate 内存滑动窗口**（`src/server/rate-limit.js`），不是全局精确配额；
  真正抗打要在 Cloudflare 控制台给 `/api/v1/public/*` 配 Rate Limiting 规则。
- 无效 key 返回 401，**不会**静默降级成匿名（否则配额形同虚设）。
- key 只存在服务端 `sha256(key)`；明文只在创建时输出一次
  （`node tools/create-api-key.mjs --label=... --rpm=600`）。

## 8. 示例

### 列表 + 筛选

```bash
curl -s "https://folia-5ve.pages.dev/api/v1/public/wallpapers?category=wallpaper&playable=1080p30&minWidth=1920&limit=5" | jq '.data.items[] | {id,title,fps,posterUrl}'
```

```bash
# 标签（alias 归一：anime 与 动漫 等价）
curl -s "https://folia-5ve.pages.dev/api/v1/public/wallpapers?tag=anime" | jq '.data.total'
```

### 详情

```bash
curl -s "https://folia-5ve.pages.dev/api/v1/public/wallpapers/<slug>" | jq '.data.wallpaper'
```

### manifest + 304

```bash
ETAG=$(curl -sI "https://folia-5ve.pages.dev/api/v1/public/manifest.json" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ETAG" \
  "https://folia-5ve.pages.dev/api/v1/public/manifest.json"
# → 304
```

### 带 key

```bash
curl -s -H "Authorization: Bearer flk_…" \
  "https://folia-5ve.pages.dev/api/v1/public/wallpapers?limit=1" | jq '.data.total'
```

### SDK（三行）

```js
import { FoliaClient } from './sdk/js/folia-client.mjs';
const page = await new FoliaClient({ baseUrl: 'https://folia-5ve.pages.dev' }).list({ limit: 24 });
```

```python
from folia_client import FoliaClient
page = FoliaClient("https://folia-5ve.pages.dev").list(limit=24)
```

完整用法见 [`../sdk/README.md`](../sdk/README.md)。

## 9. 新旧路径兼容性

| 旧路径 | v1 | 关系 |
|---|---|---|
| `/api/public/wallpapers` | `/api/v1/public/wallpapers` | 旧路径转发 v1 |
| `/api/public/wallpapers/:slug` | `/api/v1/public/wallpapers/:slug` | 同上（v1 详情额外进匿名白名单） |
| `/api/public/categories` | `/api/v1/public/categories` | 同上 |
| `/api/public/tags` | `/api/v1/public/tags` | 同上 |
| `/api/public/subtags` | `/api/v1/public/subtags` | 同上 |
| — | `/api/v1/public/manifest.json` | v1 新增 |

验证方式（自动化）：`tests/api-v1.test.js` 的「兼容性」用例对同一请求分别打旧路径与 v1，
断言响应体**逐字节相同**、ETag 相同、CORS 头相同。门禁行为保持不变：
旧详情路径匿名仍受登录门，v1 详情匿名可读（`tests/api-v1.test.js` 的门禁用例）。

## 10. 变更记录

| 期 | 内容 |
|---|---|
| 第一期 | `/api/v1/public/*` 版本化 + 旧路径转发；统一错误体 `hint`；schema/016 元数据（fps/codec/pix_fmt/has_audio/poster/license/source/author）；`variants[].width/label/fps`；`license=` 筛选；OpenAPI |
| 第二期 | `tag_aliases` 治理（写入/检索归一、facets 按 canonical）；manifest 快照 + ETag/304 + generatedAt 对齐；尺寸/时长/体积/fpsMax/playable/audio 筛选与 facets 联动 |
| 第三期 | `api_keys`（哈希、rpm、last_used_at）；Bearer / `?key=`；两档配额 + 429 头；JS/Python SDK；本文档 |
