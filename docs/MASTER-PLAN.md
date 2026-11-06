# Folia 素材库 + 插件：完整改造方案（v1）

> 目标读者：主开发机（DSH 会话）与协作者机器（DSH 会话）。
> 本文是唯一权威方案；与旧清单冲突时以本文为准。
> 起始 HEAD：`0aaa901`（站点）、插件 `8d2958d`（4.25.5）。

---

## 0. 定位（先定边界，否则会做错）

```
站点 = 【私有素材库】
  · 只服务：dsh-folia 插件、以后自研的其他助手
  · 不做：公开素材市场 / 对外售卖 / 第三方开发者接入
  · 后台仅本人可用；公开只读接口客观可读（插件要用），但不列表、不索引、不宣传

插件 = 【客户端】
  · 读素材、缓存、播放
  · 后续：上传入口、买断授权（支付墙）

支付 = 【卖插件授权】，不是卖素材
```

---

## 1. 目标架构

```
            ┌────────────── 写（仅后台） ──────────────┐
浏览器 ──分片──▶ Worker(上传/元数据/合规) ──▶ R2 桶(Folia-壁纸)
                                                    │
                                             D1（记录/变体/授权）
                                                    │
            ┌────────────── 读（公开，静态化） ───────┐
插件/助手 ──▶ CDN 静态快照（manifest/wallpapers/current.json）
                     │  未命中或快照缺失
                     └▶ Worker 兜底（读 D1，带 degraded 标记）
```

核心原则：
1. **写只走一条路**：`ingestAsset()`（R2 + D1 成对写入）
2. **读不碰数据库**：静态快照 + 版本指针（D1 只做兜底）
3. **大文件不过 Worker 直传**（国内不可达），走 **Worker 分片 multipart**
4. **原始件保留**，可播版本靠变体（30fps / 1080p）

---

## 2. 现状与已踩过的坑（不要重复）

| 问题 | 事实 | 结论 |
|---|---|---|
| D1 额度 | 免费 5M 行读/天，被"清单 60s TTL + 高频刷新"刷爆，站点 API 全 500、登录失败 | 必须静态化 + 长 TTL |
| Worker 请求体上限 | ~100MB | 大文件必须分片 |
| R2 S3 预签名 | 国内网络连不上 `r2.cloudflarestorage.com`（TLS 握手失败） | 放弃预签名，用 R2 绑定 multipart |
| 中文桶名 | 桶名为 `Folia-壁纸` | 只经绑定访问，不拼 S3 路径；不再新建桶 |
| 60fps | Worker 无 ffmpeg，合规直接 422 | 允许入库为 draft，本机转码后发布 |
| 播放进度状态 | 客户端乐观状态导致"缓存中但无进度" | 状态一律由服务端 jobStatus 派生（插件 4.25.5 已修） |
| 双 job | job 以 URL 为键，原画/变体各一条 | 已改 itemKey（插件 4.25.2） |

---

## 3. 关键决策（已定）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **单桶** `Folia-壁纸`，分片暂存用 `_tmp/<uploadId>/`；不启用新桶 `folia-upload`（建议删除空桶） | 少一处绑定/配置漂移；清理脚本单点覆盖 |
| D2 | 上传：**Worker 分片 multipart**（8MB/片，≤2GB，断点续传） | 绕过 100MB 与网络限制 |
| D3 | 60fps/超限素材：**允许入库为 draft**（needs_variant + reason），公开不可见；本机 `make-variants.mjs` 转 30fps 后自动 published | 保住原片，且不拖累播放入口 |
| D4 | 公开读：**静态快照 + 版本指针**（`current.json` → `snapshots/<version>/*.json`） | 读取 0 数据库，用户量无关 |
| D5 | 授权：**买断 + Ed25519 离线许可证** | 站点挂了用户照用；与渠道解耦 |
| D6 | 支付：**爱发电（认领码轮询）** 起步，后期换支付宝当面付；保留后台手动签发 | 个人可开通、可自动、可兜底 |
| D7 | 不做：对外 API 文档、多租户 key 分级、相似推荐、license/source 强制填写 | 私有库用不上 |

---

## 4. 数据模型

现有：`wallpapers`（含 codec/variants/fps/pix_fmt/has_audio/poster_key）、`variants`(JSON 列)、`api_keys`、`tag_aliases`、`media_audit`。

新增/变更：

```sql
-- schema/019_variant_queue.sql
ALTER TABLE wallpapers ADD COLUMN needs_variant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallpapers ADD COLUMN variant_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_wallpapers_needs_variant ON wallpapers(needs_variant) WHERE needs_variant=1;

-- schema/020_licenses.sql
CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  device_id TEXT NOT NULL,
  product TEXT NOT NULL,           -- 'lifetime'
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  migrate_count INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_device ON licenses(device_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  product TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  provider TEXT NOT NULL,          -- 'afdian' | 'manual'
  provider_txn TEXT,
  claim_code TEXT,                 -- 6 位认领码
  status TEXT NOT NULL,            -- pending | paid | failed | refunded
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_claim ON orders(claim_code);
```

---

## 5. API 契约

### 5.1 上传（管理端，需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/uploads/init` | `{fileName,size,contentType}` → `{uploadId,key,partSize,maxParts}`；`size>2GB` ⇒ 413 |
| PUT | `/api/admin/uploads/part?uploadId&part&key` | body=二进制片 → `{partNumber,etag}` |
| POST | `/api/admin/uploads/complete` | `{uploadId,key,parts[],meta}` → 校验总长 → `ingestAsset` → DTO |
| POST | `/api/admin/uploads/abort` | `{uploadId,key}` → 中止 + 清 `_tmp/` |
| GET | `/api/admin/uploads/status?uploadId` | 已传片列表（断点续传用） |

参数：`partSize` 8MB（≤64MB 文件）/16MB（更大）；`maxParts` 1024；单账号每日 `UPLOAD_DAILY_BYTES`（默认 1GiB，可 env 调）。

### 5.2 变体（管理端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/wallpapers?needsVariant=1` | 待转码列表 |
| POST | `/api/admin/wallpapers/:id/variants` | 写入变体（工具调用，需 admin token） |
| POST | `/api/admin/wallpapers/:id/publish` | 发布（校验存在合规变体） |

### 5.3 公开读（静态化后）

| 方法 | 路径 | 缓存 |
|---|---|---|
| GET | `/api/v1/public/current.json` | 5 分钟，`{version, generatedAt}` |
| GET | `/api/v1/public/snapshots/<version>/manifest.json` | 不可变，1 年 |
| GET | `/api/v1/public/snapshots/<version>/wallpapers.json` | 不可变，1 年（全量 110 条含 facets 计数） |
| GET | `/api/v1/public/wallpapers` | 读当前快照（保留旧参数，服务端在内存里筛选） |
| GET | `/api/v1/public/wallpapers/:slug` | 快照内查；未命中回源 D1 + `degraded` |

旧路径 `/api/public/*` 行为不变（转发同一实现）。

### 5.4 授权

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/licenses/claim` | `{deviceId, claimCode}` → 查询订单并签发许可证（幂等） |
| GET | `/api/v1/licenses/status?deviceId=` | `{state:'none'|'pending'|'issued', license?}`（边缘缓存 60s） |
| POST | `/api/v1/licenses/migrate` | `{licenseId, newDeviceId}` → 限次数（3/年） |

许可证载荷：`{v:1,id,device,product,issuedAt}` + `sig`（Ed25519，私钥仅在服务端 secret）。

---

## 6. 上传链路（时序）

```
插件/浏览器            Worker                         R2
  │ POST init            │                              │
  │─────────────────────▶│ createMultipartUpload(_tmp)  │
  │                      │─────────────────────────────▶│
  │◀─ uploadId/partSize ─│                              │
  │ PUT part 1..N        │                              │
  │─────────────────────▶│ uploadPart                   │
  │◀──── etag ───────────│─────────────────────────────▶│
  │ POST complete        │                              │
  │─────────────────────▶│ head(总长校验) → complete     │
  │                      │──────────────▶ 复制到正式 key │
  │                      │ ingestAsset(R2+D1, 合规/海报) │
  │◀── DTO ──────────────│ 删除 _tmp/                    │
```

断点续传：客户端 `localStorage` 保存 `{uploadId,key,partSize,doneParts}`；重选同一文件（name+size+lastModified）时先 `GET status` 取已传片，跳过。
清理：`tools/cleanup-orphan-uploads.mjs` 扫 `_tmp/` 中 >24h 对象；有 R2 生命周期规则就同时配规则。

---

## 7. 转码链路（60fps → 可发布）

```
上传 4K@60（≤2GB）
  → 合规放宽：入库 status=draft, needs_variant=1, variant_reason='fps-60'
  → 公开接口不可见

本机：node tools/make-variants.mjs --all-draft
  1) 列出 needs_variant=1
  2) 拉原片（站点或 R2）
  3) ffmpeg：优先同分辨率 fps=30；超限则 scale 到 1080p；crf 23–26
  4) 上传变体（走同一 ingest 的变体写入 API）
  5) 写 variants（label/width/height/fps/bytes/sha）
  6) 满足"存在合规变体" ⇒ status=published
  7) 幂等：已有合规变体跳过
```

发布门槛（写死）：`published` 当且仅当存在 `fps≤30 && 宽≤3840 && 高≤2160 && 像素≤8.29M` 的变体或原片。

---

## 8. 公开读静态化

```
发布动作（上传 complete / 编辑 / 下架 / 转码完成）
  → 生成新快照：snapshots/<version>/manifest.json + wallpapers.json
  → version = 时间戳 + 内容哈希前 8 位（不可变）
  → 原子更新 current.json
```

- 生成器：`src/server/snapshot.js` + `tools/build-snapshot.mjs`（本地/CI 调用也可）
- 失败策略：保留上一版快照；current.json 不切换
- 降级：快照缺失 ⇒ Worker 读 D1 + `degraded:true`（现有逻辑保留）
- 缓存：`current.json` 5 分钟；快照文件 `immutable` 1 年

---

## 9. 插件侧改造（本机负责）

| # | 项 | 依赖 | 验收 |
|---|---|---|---|
| P1 | 清单 TTL 60s → 30 分钟；304 不刷新 UI | 无 | 1 小时内站点请求 ≤ 2 次 |
| P2 | 新素材提示：面板显示"清单更新于 X 分钟前 + 刷新" | 无 | 文案可见、点刷新生效 |
| P3 | 增量同步：每 5 分钟拉 `current.json`，版本变才拉全量 | 站点阶段三 | 版本不变时零清单请求 |
| P4 | 插件内上传页（复用分片接口） | 站点阶段一 | 传 120MB 成功、显示进度、可续传 |
| P5 | 支付墙 + 许可证（买断） | 定价确认 | 未解锁受限、支付后解锁、离线可用 |
| P6 | 错误上报（错误码+素材 id，不含隐私） | 无 | 后台可见最近失败列表 |

播放相关（4.25.5 已具备）：itemKey 去重、下载完再播、进度由服务端派生、选档按 fps/codec、posterUrl 封面。

---

## 10. 授权与支付

```
买断语义：一次付费，永久可用
许可证：Ed25519 签名（私钥仅服务端 env），插件内置公钥验签，本地存储，离线宽限 30 天
设备绑定：1 个许可证默认 1 台；可迁移 3 次/年（migrate API）
```

支付流程（爱发电）：
```
插件点解锁 → 生成认领码(6 位) → 显示爱发电二维码 + "备注填写该码"
用户付款（爱发电电铺）→ 站点每 60s 轮询爱发电订单 → 按备注匹配认领码
→ orders.paid → 签发 license → 插件轮询 status（≤30s）→ 解锁
兜底：后台输入订单号手动签发
后期：换支付宝当面付 = 只替换 provider 适配器，许可证不变
```

---

## 11. 运维

| 项 | 频率 | 工具 |
|---|---|---|
| 公开接口冒烟（6 端点/110 条/facets/manifest 304） | 每次部署后 | `tools/smoke-public-api.mjs`（已有，需扩展快照检查） |
| 一致性巡检（文件 404 / sha 不符 / 孤儿对象 / 草稿堆积） | 每天 | `tools/inspect-assets.mjs`（新增） |
| D1 导出备份 | 每周 | `tools/export-d1.mjs`（新增） |
| D1 用量监控（>80% 告警） | 每天 | `tools/d1-usage.mjs`（新增） |
| 孤儿分片清理 | 每周 | `tools/cleanup-orphan-uploads.mjs`（新增） |

回滚：
```
· Pages：git revert + push（自动部署上一版）
· D1：迁移只加列/表，不做破坏性修改；回滚靠代码兼容旧列
· R2：不删旧对象；新 key 不使用旧 key
```

---

## 12. 阶段计划与验收

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 分片上传（≤2GB、续传、进度） | ✅ 已完成（120MB 线上验证通过、323 tests） |
| 二 | 60fps draft + `make-variants.mjs` + 发布门槛 + schema/019 | 进行中 |
| 三 | 静态化 + 版本指针 + 降级 | 未开始（P0） |
| 四 | TTL/缓存治理（30 分钟、条件请求不回源、后台分页） | 未开始 |
| 五 | 管理端效率（批量/重试/去重/批量改标签） | 未开始 |
| 六 | 运维三件套（巡检/备份/用量） | 未开始 |
| 七 | 授权与支付（爱发电 + 许可证） | 未开始（需定价） |
| 八 | 插件 P1–P6 | 与站点并行 |

---

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| D1 额度再次耗尽 | 阶段三静态化 + 阶段四 TTL + 用量监控告警 |
| 大文件上传中断 | 分片 + 续传 + 单片重试；`_tmp/` 清理 |
| 传输中文名桶/路径 | 只经绑定访问，不拼 S3 URL |
| 60fps 无法播放 | draft + 变体；客户端选档按 fps/codec |
| 平台跑路（爱发电/面包多） | 许可证离线验签；后台手动签发兜底；到账即提现 |
| 两台机器冲突 | 一阶段一提交、先 pull 后 push、不 force push |
| 站点故障 | 插件用本地缓存清单继续可用；快照降级 |

---

## 14. 禁止事项

```
1) 不改 wrangler.toml 既有绑定名（新增绑定需先确认）
2) 不删 R2 旧对象（迁移=复制+切 key）
3) Worker 内不引入 ffmpeg
4) 不使用 S3 预签名（国内不可达）
5) 不绕过 ingestAsset 写 R2/D1
6) 不提交 token/密钥；不 force push
7) draft 素材不得出现在公开接口
```
