# 站点改造执行手册（详细版 · 仅站点侧）

> 读者：协作者机器（另一台 DSH）。执行前先 `git pull --rebase`。
> 总纲见 `docs/MASTER-PLAN.md`；本文是可照着敲的执行细则。
> 起始 HEAD：`0aaa901`（之后可能有 `c0ce621`/`8b2ff59` 两个 docs 提交待同步）。

## 0. 环境与前提

```
仓库：folia-admin（GitHub ZXY20020906/-）
部署：push main → Cloudflare Pages 自动构建（1–2 分钟）
存储：D1 64761fc2-cd88-46f4-b08f-c2b08d5b667f；R2 单桶 `Folia-壁纸`
绑定：src/server 里 env.DB / env.R2（既有，不要改名）
测试：npm test（基线 316，阶段一完成后 323）/ node tools/check-sql.mjs（107 条）
Node：ELECTRON_RUN_AS_NODE=1 + DSH Desktop.exe（协作者机器同）
```

**每阶段流程（固定）**

```
1) git pull --rebase
2) 写代码 + 测试
3) npm test 全绿；node tools/check-sql.mjs 0 失败
4) node tools/smoke-public-api.mjs 通过
5) git add -A; git commit -m "feat(...)"; git push origin main
6) 等 Pages 部署（看 Actions/Deployments 或 1–2 分钟后直接验证）
7) 再跑一次 smoke，贴结果
8) 汇报（格式见文末）
```

---

# 阶段一：分片上传（已完成，勿重做）

**现状**：已上线；120MB 上传验证通过（120MB → 公开可见 → media 200 → Range 206）；323 tests / smoke 9/9。

上线内容（供后续参考）：

| 方法 | 路径 |
|---|---|
| POST | `/api/admin/uploads/init` |
| PUT | `/api/admin/uploads/part?uploadId&part&key` |
| POST | `/api/admin/uploads/complete` |
| POST | `/api/admin/uploads/abort` |
| GET | `/api/admin/uploads/status?uploadId` |

参数：`partSize` 8MB（≤64MB）/16MB（更大）；`maxSize` 2GB；暂存前缀 `_tmp/<uploadId>/`。

**遗留待补**：
- [ ] `_tmp/` 24h 清理：`tools/cleanup-orphan-uploads.mjs`（含 `--dry-run`）+ README 写明每周跑一次
- [ ] 空桶 `folia-upload`（14:12 创建）删除；或文档标注"废弃"
- [ ] 前端：断点续传（localStorage `{uploadId,key,partSize,doneParts}`）+ 单片失败重试 3 次 + 进度条「x%（a/b MB · 剩余 N 秒）」

---

# 阶段二：60fps / 超限素材「先入库、后转码」

## 2.1 迁移 `schema/019_variant_queue.sql`

```sql
ALTER TABLE wallpapers ADD COLUMN needs_variant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallpapers ADD COLUMN variant_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_wallpapers_needs_variant ON wallpapers(needs_variant) WHERE needs_variant = 1;
```

执行：`node tools/d1-apply-schema.mjs schema/019_variant_queue.sql`（已有工具；幂等）。

## 2.2 放宽入库规则

文件：`src/server/media-compliance.js`、`src/server/ingest.js`

```
现状：fps>30 / 宽>3840 / 高>2160 / 像素>8.29M / 非 H.264 ⇒ 422
改为：以上情况 ⇒ 允许入库，但：
  · status = 'draft'
  · needs_variant = 1
  · variant_reason = 'fps-60' | 'oversize' | 'codec' | 'probe-failed'
  · 仍要拒绝真正不可用的输入：非 mp4/webm 容器、未 faststart 且无法 remux、体积 0
发布门槛（硬编码常量，集中一处）：
  playable = fps<=30 && width<=3840 && height<=2160 && (w*h)<=8300000 && codec in ('h264','avc1')
```

要点：`ingestAsset()` 已经是唯一写入点，把"合规判定"与"是否可发布"分开：
- `checkCompliance()` 返回 `{ok, reason, playable}`；`ok=false` 才是 422
- `published` 只在 `playable=true` 或"已有合规变体"时允许

## 2.3 变体写入/发布接口

```
GET  /api/admin/wallpapers?needsVariant=1         → 待转码列表（id/title/reason/size/分辨率/fps）
POST /api/admin/wallpapers/:id/variants           → 写变体（label/width/height/fps/bytes/sha256/url）
POST /api/admin/wallpapers/:id/publish            → 校验存在合规变体后置 published
```

## 2.4 本机工具 `tools/make-variants.mjs`

```
node tools/make-variants.mjs --id wp_xxx
node tools/make-variants.mjs --all-draft [--dry-run] [--limit N]

流程：
1) 取 needs_variant=1 的条目
2) 下载原片到 %TEMP%
3) ffmpeg（参数复用 tools/prepare-upload.mjs 的口径）：
   同分辨率优先：-vf fps=30 -c:v libx264 -crf 23 -movflags +faststart
   超限再缩：-vf "fps=30,scale='min(1920,iw)':-2"
4) 上传变体 → POST :id/variants
5) 校验产物 fps/分辨率 → 满足门槛则 POST :id/publish
6) 幂等：已存在合规变体 ⇒ 跳过；ffmpeg 缺失/超时 ⇒ 明确报错并继续下一条
输出：处理 N 条 / 跳过 M / 失败 K（列失败原因）
```

## 2.5 验收

```
· 传一条 4K@60（≤2GB）⇒ 入库成功、status=draft、needs_variant=1、reason=fps-60、公开接口看不到
· node tools/make-variants.mjs --all-draft ⇒ 生成 30fps 变体 ⇒ 自动 published
· 公开接口能看到该条；插件选 30fps 变体播放（用 media 字段验证）
· 重跑 --all-draft ⇒ 全部跳过（幂等）
```

---

# 阶段三：公开读静态化（P0，防额度）

## 3.1 快照格式

```
/api/v1/public/current.json                      → {"version":"20261106T131500Z-3f2a9c1b","generatedAt":1793...}
/api/v1/public/snapshots/<version>/manifest.json → {"apiVersion":"v1","generatedAt":...,"total":N,"items":[...]}
/api/v1/public/snapshots/<version>/wallpapers.json →
  {"ok":true,"data":{"items":[...],"total":N,"facets":{"categories":[...],"tags":[...],"aspects":[...],"kinds":[...]}}}
```

- 快照只含 `published` 且 `is_public=1` 的条目
- 每个 item 字段与现在 `/api/v1/public/wallpapers` 完全一致（含 variants/fps/codec/posterUrl）
- `version` = `UTC时间戳 + 内容哈希前 8 位`（内容不变则版本不变，避免无意义切换）

## 3.2 生成器

```
新增 src/server/snapshot.js：
  buildSnapshot(env) → { version, manifest, wallpapersJson }
  · 查询复用 src/server/queries.js（不要新写 SQL）
  · 写入 R2：snapshots/<version>/manifest.json、wallpapers.json
  · 更新 current.json（覆盖写，短缓存）

触发点（都要调）：
  · 上传 complete 成功之后
  · 变体写入 / publish / 下架 / 编辑
  · 定时兜底：每天一次（可先手动）
```

## 3.3 读取改造

文件：`src/server/public-api.js`、`src/server/routes/public-v1.js`

```
1) 读 current.json（边缘缓存 5 分钟）
2) 命中 ⇒ 读 snapshots/<ver>/wallpapers.json，在内存里做筛选/分页/排序
   · 参数保持兼容：category/kind/tag/subtag/q/aspect/featured/minWidth…/playable/audio/limit/page
   · facets 直接用快照里的计数
3) 未命中/快照缺失 ⇒ 回退现有 D1 路径 + degraded:true
4) 详情：先快照内查找；未命中再查 D1；都无 ⇒ 404 not_found
5) manifest.json：优先返回快照文件（内容与旧格式一致 + ETag）
```

缓存头：

```
current.json：Cache-Control: public, max-age=300
snapshots/**：Cache-Control: public, max-age=31536000, immutable
```

## 3.4 验收

```
· 6 个公开端点 200；total=110（公开条目数）；facets 合计 == total
· manifest ETag 稳定；If-None-Match ⇒ 304
· 上传一条新素材 ⇒ 生成新 version ⇒ current 切换 ⇒ 列表立即能看到
· 连续 10 次请求同一清单：D1 行读增量 ≈ 0（可用 tools/d1-usage.mjs 观察）
· 快照缺失（手动删对象）⇒ 自动回退 D1 且响应带 degraded:true
```

---

# 阶段四：TTL / 缓存治理

```
1) 后台列表：分页（默认 20）+ 短缓存（60s），避免"导入后刷新"全量读
2) 公开读：静态快照后按 3.3 的缓存头；不要再让条件请求回源 D1
3) 文档 docs/OPS.md 记录每个端点的 TTL 与失效方式
验收：连点 10 次「刷新列表」⇒ D1 行读增量 ≤ 20
```

---

# 阶段五：管理端效率（P1）

```
1) 多选拖拽上传（复用阶段一分片接口，串行/并发 2）
2) 失败重试队列：失败项可"重试全部"
3) 重复检测：上传前算 sha256 → 已存在则提示"复用已有条目"（不重复写 R2）
4) 批量操作：改分类/标签、发布、下架、删除（软删）
5) 列表显示：待转码徽标 + reason、原片 fps/分辨率/大小、已有变体档位
验收：一次拖 10 个文件全部成功；重复文件提示复用；批量改标签生效
```

---

# 阶段六：运维三件套（P1）

```
tools/inspect-assets.mjs     每天：404 检查、sha 比对、孤儿对象、draft 堆积 → 输出报告
tools/export-d1.mjs          每周：D1 → JSON 备份到本地
tools/d1-usage.mjs           每天：行读用量（<80% 正常 / >80% 警告）
tools/cleanup-orphan-uploads.mjs  每周：_tmp/ >24h 清理
docs/OPS.md：部署流程、回滚方式、额度监控、故障处理
验收：四个脚本都能本地跑通并输出可读报告
```

---

# 阶段七：授权与支付（P2，需先定价）

```
schema/020：licenses / orders
接口：POST /api/v1/licenses/claim、GET /api/v1/licenses/status、POST /api/v1/licenses/migrate
爱发电：站点定时（60s）轮询订单 → 按 claim_code 匹配 → orders.paid → 签发 license
兜底：后台"输入订单号签发"
许可证：Ed25519（私钥在 Pages secret），载荷 {v,id,device,product,issuedAt} + sig
验收：认领码付款 → 60s 内签发 → 插件离线验签通过；后台手动签发同样可用
```

⚠️ 该阶段不动公开读接口，不影响插件现有功能。

---

# 全局约束

```
1) 不改 wrangler.toml 既有绑定名（新增绑定先确认）
2) 禁止 S3 预签名（国内不可达）
3) Worker 内禁止 ffmpeg
4) 不绕过 ingestAsset 写 R2/D1
5) draft 素材不得出现在公开接口
6) 不删 R2 旧对象；不 force push；不提交 token
```

# 汇报格式（每次）

```
阶段：X
改动：文件清单 + 关键函数
接口：新增/变更（方法 + 路径 + 请求/响应示例）
迁移：schema 文件名 + 执行结果
测试：X pass / Y fail（新增 N 条）；check-sql 结果
线上：端点状态码 / 上传大小与耗时 / 是否 degraded
commit：<完整 hash>
遗留：…
```
