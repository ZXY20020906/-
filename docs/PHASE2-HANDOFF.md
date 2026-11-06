# 阶段二交接（2.2–2.5 未开工）

> 状态：`schema/019` 已建并在线执行（needs_variant / variant_reason / 索引），代码未动。
> 下一轮从这里开始，按顺序做，一次提交。

## 铁律（来自派单）

1. 软/硬边界写死在 `src/core/variant-reason.js`：
   - 软（→ draft + needs_variant=1 + reason）：`fps-too-high` / `too-wide` / `too-tall` / `too-many-pixels` / `codec-unsupported`
   - 硬（→ 422，不写 R2）：非 mp4/webm、faststart 重封装失败、`probe-failed`、0 字节、>2GB
2. 发布门槛只留一处 `isPlayable()`：`fps<=30 && width<=3840 && height<=2160 && w*h<=8_300_000 && codec∈{h264,avc1}`
3. 所有 R2/D1 写入只在 `src/server/ingest.js`；路由只做参数校验与调用
4. draft 必须验证看不见：公开列表 / 详情 / manifest 都不含；后台可见且带 reason
5. `tools/make-variants.mjs`：`--id` / `--all-draft` / `--dry-run` / `--limit N`；`FOLIA_FFMPEG` 覆盖；
   幂等跳过；输出「处理 N / 跳过 M / 失败 K」；自动 publish，发布失败要回滚变体记录

## 实施顺序

### 2.2 放宽入库
- 新增 `src/core/variant-reason.js`（`SOFT_*` / `HARD_*` / `variantReasonFor()` / `isPlayable()`）
- `ingest.js`：
  - 合规失败时先 `variantReasonFor(violations)`：非 null ⇒ 不抛错，记 `softReason`
  - 写库后跑 `Q.setWallpaperVariantQueue(1, reason, 'draft', now, id)`；`fields.status` 返回 `draft`
  - `ingestStreamedAsset` 同样处理
- `queries.js`：新增 `setWallpaperVariantQueue`（需要 `status='draft'` 一起写）

### 2.3 接口
- `GET /api/admin/wallpapers?needsVariant=1` → `Q.listNeedsVariant`
- `POST /api/admin/wallpapers/:id/variants` → 调 `ingest.attachVariant()`（写 variants JSON）
- `POST /api/admin/wallpapers/:id/publish` → 调 `ingest.publishWallpaper()`（`isPlayable` 校验，清 needs_variant）
- 变体文件上传：复用 `/api/admin/uploads/*`，`complete` 的 meta 增加 `variantLabel`，
  由 `ingestVariantAsset()` 流式复制到 `variantKey(...)`

### 2.4 工具
- `tools/make-variants.mjs`：
  - 登录 → `?needsVariant=1` → 下载原片 → ffmpeg（`-vf fps=30`，超限加 `scale`）
  - multipart 上传变体（label 1080p/原分辨率）→ publish → 失败回滚变体记录

### 2.5 验收命令
```bash
# 1) 4K@60 入库
ffmpeg -f lavfi -i testsrc2=size=3840x2160:rate=60 -t 20 -c:v libx264 -pix_fmt yuv420p -movflags +faststart 4k60.mp4
node output/accept-multipart.mjs 4k60.mp4        # 期望 200 + draft + needs_variant=1 + reason=fps-60
# 2) draft 不可见
curl -s "$BASE/api/public/wallpapers?limit=100" | grep <slug>   # 应无
curl -s "$BASE/api/public/wallpapers/<slug>"                    # 应 404
curl -s "$BASE/api/v1/public/manifest.json" | grep <slug>       # 应无
# 3) 转码发布
node tools/make-variants.mjs --all-draft
# 4) 公开可见 + variants
curl -s "$BASE/api/v1/public/wallpapers/<slug>" | grep 1080p
# 5) 幂等
node tools/make-variants.mjs --all-draft     # 全部跳过
```

## 顺手遗留
- `public/admin/app.js` 上传进度补「x%（a/b MB · 剩余 N 秒）」
- README 加一行「每周跑一次 `node tools/cleanup-orphan-uploads.mjs`」
