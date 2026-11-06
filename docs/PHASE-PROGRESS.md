# 阶段进度看板

> 更新：2026-11-06。每完成一个阶段勾选并 push，不要攒到最后。

## 总览

| 阶段 | 内容 | 状态 | commit |
|---|---|---|---|
| 阶段一 | 分片上传（≤2GB，multipart + 断点续传 + 清理工具） | ✅ 已完成并线上验收 | `4668895b` / `91b0bfc3` / `e2c8fa6d` |
| 阶段二 | 60fps/超限原片先入库后转码（needs_variant + make-variants） | ✅ 已完成并线上验收 | `8fdb3319` / `ee50739a` / `b35b1f1b` / `fd25009` |
| 阶段三 | 公开读静态化（snapshot.js + current.json + parity） | ✅ 已完成并线上验收 | `6d44af03` / `3b946955` |
| 阶段四 | 后台分页 + 短缓存 + TTL 文档 | ⬜ 未开始 | — |
| 阶段六 | 运维三件套（inspect-assets / d1-usage / export-d1） | ⬜ 未开始 | — |
| 阶段五 | 管理端效率（批量上传 / 重试 / 去重 / 批量改标签） | ⬜ 未开始 | — |

---

## 阶段三：公开读静态化（已完成，2026-11-06）

### 做了什么

| 文件 | 作用 |
|---|---|
| `src/server/snapshot.js`（新） | `computeVersion` / `buildSnapshot` / `publishSnapshot` / `readSnapshot`，写 `snapshots/<version>/{manifest,wallpapers}.json` + 原子切 `current.json` |
| `src/server/public-filter.js`（新） | 快照路径的**内存筛选**：与 `queries.js` 的 SQL 逐条等价（15 个筛选参数 + 5 种排序 + facets + 游标） |
| `src/server/public-api.js` | 三层读取链：**R2 快照 → D1（`degraded:true`）→ 内嵌快照**；详情/分类/标签/子标签/manifest 全部走同一套 |
| `src/server/routes/public-v1.js` | `GET /api/v1/public/current.json`；`current` 300s、`snapshots/**` immutable |
| `src/server/ingest.js` | 四个触发点：上传完成 / 流式入库完成 / 变体写入 / 发布（失败只记日志，不阻断） |
| `src/server/routes/wallpapers.js`、`categories.js` | 编辑 / 删除 / 删变体 / 改分类（`is_public`）后同样触发重建 |
| `tools/build-snapshot.mjs`（新） | `--dry-run` / `--force` / `--status`；REST 直连生产 D1 + R2，或用 `--sqlite` 跑本地导出 |
| `tests/snapshot.test.js`（新） | 13 条：S1–S9 + computeVersion / force / 对象被删自愈 / 内嵌兜底链 |
| `tests/snapshot-parity.test.js`（新） | **17 块对拍**（派单口径 16 块，细则列了 17 条，全做）：同一份数据，快照路径与 D1 路径的 items 全文 / ids 序列 / total / facets / 分页字段 / 排序键全部相等，不一致即红 |
| `docs/PHASE3-PARITY-MAP.md`（新） | 15 个筛选参数 ↔ SQL ↔ 内存实现对照表 + 8 条已知边界差异 |
| `docs/OPS.md`（新） | TTL / 失效 / 回滚 / 故障速查 / 定时兜底 / 换媒体域名必须重建 |

### 裁决落实

- **A 方案（不加列）**：快照只收 `status='published'` **且** 分类 `is_public=1`（未分类保持公开）。
  为了让两条读路径同口径，`PUBLIC_FILTERS` / `publicManifest` / `PUBLIC_SUBTAGS` 都补了
  `(w.category_id IS NULL OR c.is_public = 1)`；线上 110 条全部落在公开分类，现网 total 不变。
- **旧 `public-snapshot.js` 保留**：一行未改，仍是 D1 彻底不可用时的最后兜底（`degraded` +
  `snapshotGeneratedAt`）。

### 测试基线

`npm test`：**361 pass / 0 fail**（阶段二基线 331，新增 30 条）。
`check-sql`：111 条查询 0 失败。`check-syntax` / `check-ui`：通过。

### 线上验收 ①–⑦（2026-11-06，快照版本 `20261106T083707Z-7d8a23c8`）

| # | 项 | 证据 |
|---|---|---|
| ① | `current.json` 200 且 `{version, generatedAt}` | `HTTP 200 · {"version":"20261106T083707Z-7d8a23c8","generatedAt":1793852953675}` · `cache-control: public, max-age=300` |
| ② | 6 端点 200、`total=110`、facets 合计 == total | 清单 110 / facets 合计 110；详情 `原神-4`；分类 4；标签 4；子标签 4；manifest 110；旧路径与 v1 逐字节相同 |
| ③ | manifest ETag 稳定 + `If-None-Match` 304 | 两次都是 `W/"fb2e57605d40138287200b35"`；条件请求 `304` + 0 字节 body |
| ④ | 连点 10 次清单：D1 行读增量 ≈ 0 | 10/10 `degraded` 为空、`x-folia-edge: MISS`（每次都回源）；**该窗口 D1 analytics 没有任何分片 ⇒ rowsRead = 0**（对照：部署前同类清单请求是 1047 行/次量级） |
| ⑤ | 传新素材 ⇒ version 变化、列表立即可见 | 建草稿→上传（走 `ingestAsset`）：version 不变（草稿不进快照）；PATCH 发布：`20261106T083510Z-7d8a23c8` → `20261106T083702Z-a37a0f59`，`q=阶段三验收` 立刻命中；删除后回到 `20261106T083707Z-7d8a23c8`、total 回到 110 |
| ⑥ | 手删快照对象 ⇒ 回退 D1 + `degraded:true`，不 500 | 删 `snapshots/<v>/wallpapers.json` 后并发 6 次清单：6/6 `HTTP 200 · total=110 · degraded=true`（0 个 500），该窗口 D1 rowsRead = 16690；随后 Worker 用 `ctx.waitUntil` 在 ~2s 内自愈 |
| ⑦ | 详情 variants 含 label/width/height/fps，与列表一致 | `原神-钟离` → `[{label:"1080p",width:1920,height:960,fps:30}]`，与列表逐字段相同 |

### 验证过程中发现并修掉的缺口

`publishSnapshot` 原来只按内容哈希判断「没变化就不写」。⑥ 一删对象就暴露了后果：
`current.json` 还在、对象没了，于是每一轮重建都判定「内容没变」，**永远不补**，
公开读会一直停在 D1。现在内容没变时额外 HEAD 两个对象，缺任何一个就按「需要重写」处理
（沿用原版本号修复现场）—— 见 `3b946955` 与用例「附加：快照对象被删 ⇒ 重建会补回来」。

### 运维入口

```bash
node tools/build-snapshot.mjs --status     # 线上当前是哪一版
node tools/build-snapshot.mjs              # 重建并切 current.json
node tools/build-snapshot.mjs --dry-run    # 只看会生成什么
node tools/build-snapshot.mjs --force      # 内容没变也写新版本（排障）
```

细节见 `docs/OPS.md`（TTL / 失效 / 回滚 / 故障速查）。

---

## 缺失文档

派单里提到的 `docs/SITE-CHARTER.md` 在仓库中**不存在**（`docs/PHASE-PROGRESS.md` 即本文件）。

## 下一步（按派单顺序）

1. 阶段四：后台分页 + 短缓存 + TTL 文档（有了快照，`current.json` 的 TTL 可以放心拉长）
2. 阶段六：运维三件套（inspect-assets / d1-usage / export-d1）
3. 阶段五：管理端效率（批量上传 / 重试 / 去重 / 批量改标签）
   每阶段独立验收后再进下一阶段。

## 已知风险

- 内存筛选与 SQL 不等价 ⇒ 全站公开列表错乱。现在由 `tests/snapshot-parity.test.js`
  的 17 块对拍守着，改任何一边的筛选语义都必须先让它绿。
- `public-snapshot.js` 是单行大 JSON，禁止 grep/less 直接打印（会刷屏）。
- 另一台机器仍在向 main 提交，开工前必须 `git pull --rebase origin main`。
- 快照里存的是**构建时**的媒体绝对 URL：改 `MEDIA_BASE` / `PUBLIC_ORIGIN` 之后必须
  `node tools/build-snapshot.mjs --force`，否则线上还是旧域名。
