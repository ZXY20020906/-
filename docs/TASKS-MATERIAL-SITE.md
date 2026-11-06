# 素材网改造任务清单（交接版）

> 给"另一台机器上的 DSH"执行。仓库：`https://github.com/ZXY20020906/-`
> 起始 HEAD：`f4fdbb5`。**开工第一件事：`git pull --rebase`**。

## 0. 现状（已完成，不要重做）

| 能力 | 状态 | 位置 |
|---|---|---|
| API v1（`/api/v1/public/*`）+ 旧路径兼容 | ✅ | `src/server/public-api.js`、`routes/public-v1.js` |
| 元数据 `fps/codec/pixFmt/hasAudio/posterUrl/license/source/author` | ✅ | `schema/016_metadata.sql`、`dto.js` |
| `variants[]` 带 `label/width/height/fps` | ✅ | `src/core/variant-label.js` |
| 标签别名归一（20 条） | ✅ | `schema/017_tag_aliases.sql`、`src/core/tag-vocabulary.js` |
| `manifest.json` + ETag/304 | ✅ | `routes/public-v1.js` |
| 筛选：尺寸/时长/体积/fpsMax/playable/audio | ✅ | `public-api.js`、`queries.js` |
| 公开 API key + 限流 | ✅ | `schema/018_api_keys.sql`、`api-keys.js` |
| 上传合规（≤30fps / ≤4K / H.264 / faststart） | ✅ | `src/server/media-compliance.js`、`ingest.js` |
| D1 额度兜底（快照降级） | ✅ | `public-snapshot.js`、`app.js` |
| 首帧海报 + 缩略图 | ✅ | `ingest.js`、`backfill-metadata.mjs` |

**已知边界**：上传单请求 ≤100MB（Worker 硬限制），60fps 素材会被 422 拒绝，公开读仍在压 D1 额度。

---

## 1. 交接规则（两台机器同时改的唯一安全方式）

```
1) 开工：git pull --rebase origin main
2) 每完成一个阶段：git add -A && git commit && git push（不要攒到最后）
3) 改之前先看有没有别人刚推的提交：git log --oneline -5
4) 不要强制推送（no --force）
5) 不要在两台机器同时改同一文件
6) npm 发布只在"主开发机"做，另一台只 push 代码
7) 敏感文件（CF token / npm token）各自本地保存，不进仓库
```

---

## 2. 阶段一：大文件分片上传（P0）

**目标**：浏览器可上传单文件最高 2GB，支持断点续传与进度。

- 新增 `src/server/routes/uploads.js`
  - `POST /api/admin/uploads/init` `{fileName,size,contentType}` → `{uploadId,key,partSize,maxParts}`
    - `size > 2GB` ⇒ `413 payload_too_large`
    - `partSize`：≤64MB 用 8MB；更大用 16MB
  - `PUT /api/admin/uploads/part?uploadId&part&key`（body 二进制）→ `{partNumber,etag}`
  - `POST /api/admin/uploads/complete` `{uploadId,key,parts[],meta}` → 校验总长度 → **复用 `ingestAsset`** 入库 → 返回 DTO
  - `POST /api/admin/uploads/abort` `{uploadId,key}` → 中止 + 清理
- 使用 **R2 绑定 multipart**（`env.R2.createMultipartUpload / uploadPart / complete / abort`），**不要用 S3 预签名**（国内网络连不上 `r2.cloudflarestorage.com`）
- 前端（`public/admin/`）：切片上传、进度条、`localStorage` 记录 `{uploadId,key,doneParts}` 实现断点续传、单片失败重试 3 次
- 上限提示：60MB → 2GB
- 测试 `tests/uploads-multipart.test.js`：正常多片、413、非法 part、etag 不符、complete 长度不符（要 abort）、断点续传跳过已传片
- 工具 `tools/cleanup-orphan-uploads.mjs`：清理 `_tmp/` 下 >24h 的对象

**验收**：传 120MB 合成视频（`ffmpeg -f lavfi -i testsrc`，30fps/H.264）成功；公开接口可见；媒体 200；中断后重选同一文件能续传。

---

## 3. 阶段二：60fps 原片入库 + 本机转码（P0）

**目标**：60fps / 超分辨率原片可以入库为「待转码」，本机一条命令生成可发布变体。

- 放宽 `media-compliance.js`：`fps>30`/`宽>3840`/`高>2160`/`像素>830万`/非 H.264 ⇒ **允许入库**但强制 `status='draft'` + `needsVariant=true` + `reason`
- 发布门槛不变：`published` 必须 ≤30fps 且分辨率在限内（或有满足的变体）
- 工具 `tools/make-variants.mjs`
  - `node tools/make-variants.mjs --id <id> | --all-draft [--dry-run]`
  - 拉原片 → 本机 ffmpeg 生成 30fps 变体（同分辨率优先；超限再缩 1080p）→ 上传变体 → 写 `variants` → 满足条件自动 `published`
  - 幂等（已有变体跳过）；ffmpeg 缺失/超时要有清晰报错
- 管理端：列表显示「待转码」徽标 + 原因；详情显示原片参数与现有档位
- 测试：60fps 上传 ⇒ draft；发布被拒；生成变体后 ⇒ published 且公开可见；重跑幂等
- 文档：`docs/UPLOAD-SOP.md` 增加"60fps 素材：传原片 → 本机转码 → 发布"

**验收**：上传 4K@60（≤2GB）→ 显示待转码 → 本机跑 `--all-draft` → 自动发布 → 插件能播 30fps 版。

---

## 4. 阶段三：公开读静态化 + 版本指针（P0，防额度）

**目标**：公开读不再消耗 D1 行读（现在 5M/天会被用户量吃光）。

- 生成静态快照（构建或发布时脚本生成，写入 Pages 静态资源）
  - `/api/v1/public/snapshots/<version>/manifest.json`（不可变，长缓存）
  - `/api/v1/public/snapshots/<version>/wallpapers.json`（全量清单，含 facets 所需计数）
  - `/api/v1/public/current.json`（极小：`{version, generatedAt}`，短缓存 5 分钟）
- 公开 API 改为读静态快照（`current.json` → 对应 version 文件），保留现有字段与 `{ok,data}` 形状
- 上传/下架/编辑后：重建快照（新 version）→ 原子切换 `current.json`
- 旧路径 `/api/public/*` 行为保持不变（转发到同一实现）
- 降级：快照缺失时回退 D1（现有 `degraded` 逻辑）

**验收**：用 `tools/smoke-public-api.mjs` 检查 6 个端点 200 + 110 条 + facets 合计 == total + manifest 304；D1 查询日志确认公开读为 0。

---

## 5. 阶段四：缓存与 TTL 治理（P1）

- 边缘缓存 TTL：清单 5 分钟 → **30 分钟**（静态化后按 version 缓存可更长）
- 条件请求（`If-None-Match`）一律由边缘缓存应答，不回源 D1
- 后台列表分页 + 短缓存（避免"导入后刷新"吃额度）
- 文档记录每个端点的 TTL 与失效方式

**验收**：连续 10 次请求同一清单，D1 行读增量 ≈ 0。

---

## 6. 阶段五：素材网能力补齐（P1）

- `license` / `source` / `author` 真正填写：后台编辑 + 批量导入支持这三列
- 受控标签：把 `tag_aliases` 扩到覆盖现有全部标签（当前 20 条）
- 搜索：`q` 支持拼音/别名（至少别名归一）
- 相似素材：按标签交集推荐（`/api/v1/public/wallpapers/:slug/related`）
- 播放能力字段：`playableTiers: ["1080p","4k30"]` 便于调用方选择

**验收**：每个端点有测试；`docs/API-V1.md` 同步更新。

---

## 7. 阶段六：运维与监控（P1）

- `tools/smoke-public-api.mjs` 扩展：静态化后检查 `current.json` 与快照一致性
- D1 用量监控脚本：`tools/d1-usage.mjs`（读 Cloudflare Analytics，超 80% 打印警告）
- 备份：`tools/export-d1.mjs`（导出 JSON 到本地，每周一次）
- 文档：`docs/OPS.md`（部署流程、回滚方式、额度监控、故障处理）

**验收**：README 增加"每次部署后跑 smoke"的固定步骤。

---

## 8. 阶段七：支付（P2，最后做）

- 爱发电轮询 + 认领码（6 位，买家付款备注填写）
- 许可证：Ed25519 离线签名（插件内置公钥）
- 后台手动签发兜底
- 详见 `docs/PAYMENT-DESIGN.md`（待写）

---

## 9. 全局禁止事项

```
1) 不要改 wrangler.toml 的绑定名
2) 不要删除 R2 旧对象（迁移要用复制+切换）
3) 不要引入 ffmpeg 到 Worker（内存/CPU 不允许）
4) 不要用 S3 预签名（国内不可达）
5) 不要绕过 ingestAsset 写 R2/D1
6) 不要提交 token / 密钥
7) 不要 force push
```

## 10. 每阶段交付标准

```
· 本地测试全绿（当前基线 316 pass / 0 fail；check-sql 0 失败）
· `node tools/smoke-public-api.mjs` 通过
· commit 信息格式：`feat(upload): 分片上传（≤2GB）` 等
· push 后等 Pages 自动部署（约 1–2 分钟），再跑一次 smoke
· 汇报：改动文件、接口、测试数字、线上验证结果
```
