# Folia SDK

两个**零依赖**的轻客户端：JavaScript（ESM）与 Python。它们只做四件事：
`list()` / `get()` / `manifest()` / `download()`，够素材网客户端/脚本直接用。

| 语言 | 文件 | 运行环境 |
|---|---|---|
| JavaScript (ESM) | [`js/folia-client.mjs`](js/folia-client.mjs) | Node ≥ 20（内置 fetch） |
| Python | [`python/folia_client.py`](python/folia_client.py) | Python ≥ 3.8（标准库） |

API 契约：[`docs/api.md`](../docs/api.md) / [`docs/openapi.yaml`](../docs/openapi.yaml) /
[`docs/API-V1.md`](../docs/API-V1.md)。

## 三行上手

```js
import { FoliaClient } from './sdk/js/folia-client.mjs';
const client = new FoliaClient({ baseUrl: 'https://folia-5ve.pages.dev' });
const page = await client.list({ category: 'wallpaper', limit: 24 });
```

```python
from folia_client import FoliaClient
client = FoliaClient("https://folia-5ve.pages.dev")
page = client.list(category="wallpaper", limit=24)
```

带 API key（配额更高，默认 600 次/分钟）：

```js
const client = new FoliaClient({ baseUrl: '...', apiKey: 'flk_...' });          // JS
```
```python
client = FoliaClient("...", api_key="flk_...")                                   # Python
```

## 方法

### `list(params)`

`GET /api/v1/public/wallpapers`。`params` 原样拼进查询串（数组会按逗号拼成多值），
返回 `data`：`items / total / hasMore / nextCursor / page / facets / filters`。

```js
const page = await client.list({
  category: 'wallpaper',
  kind: 'dynamic',
  tag: ['动漫', '游戏'],        // → ?tag=动漫,游戏（OR）
  minWidth: 1920,
  playable: '1080p30',
  audio: 'false',
  sort: 'recent',
  limit: 24,
});
```

支持的参数与语义见 [`docs/API-V1.md`](../docs/API-V1.md) 的「列表参数」表。

### `get(slug)`

`GET /api/v1/public/wallpapers/:slug` → 单个 wallpaper 对象（含 `tags` / `variants` /
`posterUrl` / `license` / `fps` / `codec` / `pixFmt` / `hasAudio`）。

### `manifest({ etag })`

`GET /api/v1/public/manifest.json` → 文档 `{ apiVersion, generatedAt, etag, total, items }`。
带 `etag` 且未变化时返回 `null`（HTTP 304），不重复传输。

```js
const doc = await client.manifest();
const unchanged = await client.manifest({ etag: `"${doc.etag}"` }); // null
```

```python
doc = client.manifest()
unchanged = client.manifest(etag=f'"{doc["etag"]}"')  # None
```

### `download(urlOrKey, dest, { verifySha })`

流式下载到 `dest`（先写 `.part` 临时文件再原子替换）。`urlOrKey` 可以是：
- 绝对 URL（manifest / 列表里的 `url`、`variants[].url`、`posterUrl`）；
- R2 key（自动拼 `${baseUrl}/media/`）。

`verifySha`：
- 传 **sha256 字符串** ⇒ 下载后校验，不一致抛错（`code = sha256_mismatch`）；
- 传 `true` ⇒ 只计算并返回；
- 缺省 ⇒ 不校验。

返回 `{ path, bytes, sha256 }`。

```js
const saved = await client.download(detail.url, 'out.mp4', { verifySha: detail.sha256 });
console.log(saved.bytes, saved.sha256);
```
```python
saved = client.download(detail["url"], "out.mp4", verify_sha=detail.get("sha256"))
```

## 错误

HTTP 非 2xx 抛 `FoliaError`（Python 同名），字段：`status` / `code` / `hint` / `details`。
错误码表见 [`docs/API-V1.md`](../docs/API-V1.md#错误码)（与 `docs/openapi.yaml` 的
`x-error-codes` 同源）。

## 限流

- 不带 key：每 IP 120 次/分钟；
- 带 key：按 key 的 `rpm`（默认 600 次/分钟）；
- 超限：`429` + `Retry-After`（秒）+ `x-ratelimit-*` 头。SDK 不自动重试，
  调用方按 `error.status === 429` 自行退避即可。

## 示例

```bash
node sdk/js/example.mjs
python sdk/python/example.py
```

两个示例都会：列 3 条 1080p 可播素材 → 取第一条详情 → 下载原文件并校验 sha256 →
对比 manifest 的 ETag。
