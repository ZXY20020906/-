# 运维手册（阶段三起）

> 只记**会咬人**的东西：缓存、失效、回滚、触发点、怎么确认线上到底在读哪一层。

## 1. 公开读的三层结构

```
公开请求
  ├─ ① R2 动态快照  snapshots/<version>/{manifest,wallpapers}.json + current.json   ← 正常路径，0 次 D1 行读
  ├─ ② D1 实时查询  原来那套 SQL                                                    ← 快照缺失/损坏时，响应带 degraded:true
  └─ ③ 仓库内嵌快照 src/server/public-snapshot.js                                    ← D1 报可识别错误（额度/缺表/绑定失效）时
```

判定线上在读哪一层，看响应体里有没有 `degraded`：

| 现象 | 含义 | 处理 |
|---|---|---|
| 没有 `degraded` | 走的是 R2 快照（正常） | — |
| `degraded: true` | 回退 D1，说明快照缺失/损坏 | 跑 `node tools/build-snapshot.mjs` |
| `degraded: true` + `snapshotGeneratedAt` | 连 D1 都不可用，用的是仓库内嵌快照 | 查 D1 额度 / 绑定，见 §6 |

## 2. 缓存 TTL（端点级，阶段四复核）

| 端点 / 对象 | 缓存头 | 谁在缓存 |
|---|---|---|
| `GET /api/v1/public/current.json` | `public, max-age=300` | 边缘 + 浏览器 |
| R2 `snapshots/<version>/**` | `public, max-age=31536000, immutable` | 任何下游 |
| `GET /api/v1/public/wallpapers`（清单） | `public, max-age=300, stale-while-revalidate=3600` | 边缘（`app.js`） |
| `GET /api/v1/public/wallpapers/:slug` | 同上 | 边缘 |
| `GET /api/v1/public/categories` / `tags` / `subtags` | 同上 | 边缘 |
| `GET /api/v1/public/manifest.json` | 同上 + ETag | 边缘 |
| 旧路径 `/api/public/*` | 与 v1 完全一致 | 边缘（同一份 handler） |
| **任何 `degraded: true` 的公开响应** | `no-store, max-age=0` + `x-folia-degraded: 1` | **不缓存** |
| `GET /api/admin/wallpapers`（后台列表） | `no-store` | **进程内 60s**，见 §3.2 |
| `/api/admin/*` 其他接口 | `no-store` | 不缓存 |

**降级不缓存**（阶段四裁定）：`degraded: true` 表示这次是回源 D1（或用了仓库内嵌快照）才答出来的。
缓存 5 分钟会出现「快照已恢复、客户端还在看旧副本」，也会把真正的故障窗口藏起来。
实现上除了 `no-store`，还打 `x-folia-degraded: 1`；`app.js` 的边缘缓存看到它就跳过
（否则 Workers 的 `caches.default` 会把 200 一起存进去，覆盖掉 no-store 的意图）。

**不要**把 `current.json` 调成 immutable 或长于 5 分钟：发布新素材后最长要等这么久才切过去。

## 3. 失效

### 3.1 公开读：重建快照

自动触发（`SNAPSHOT_AUTO !== '0'`，默认开）——失败只记日志，不阻断主流程：

1. 上传完成（`ingestAsset`，含批量导入与「换文件」）
2. 大文件流式入库完成（`ingestStreamedAsset`）
3. 变体写入（`attachVariant`）/ 变体删除（`deleteVariant`）
4. 发布（`publishWallpaper`）
5. 后台编辑作品（PATCH）/ 删除作品（DELETE）
6. 编辑分类（`is_public` 决定分类下的作品是否公开，A 方案）

手动 / 定时（建议每小时跑一次兜底，见 §7）：

```bash
# 需要 CF_API_TOKEN + CF_ACCOUNT_ID；database_id / bucket 从 wrangler.toml 读
node tools/build-snapshot.mjs --status            # 看线上当前是哪一版
node tools/build-snapshot.mjs                     # 构建并切 current.json
node tools/build-snapshot.mjs --dry-run           # 只算 version / 条目数，不写
node tools/build-snapshot.mjs --force             # 内容没变也写新版本（排障用）
```

内容没变时**不会**写新对象（`wrote=false`）：版本号是 `utcCompact-sha256(wallpapers.json)[0..8]`，
同一份内容永远是同一个版本，客户端 ETag 不会无端变化。

### 3.2 后台列表：60s 进程内短缓存

后台列表（`GET /api/admin/wallpapers`）有 60 秒的**进程内**缓存，
键 = 登录人 + 全部筛选参数 + 分页（`actor.id` 必须在键里，否则会串号）。

- 任何 `/api/admin/*` 写操作成功后，`app.js` 统一清空该缓存（不是每个 handler 自己清，漏不掉）；
- 想彻底关掉：`env.ADMIN_LIST_CACHE_MS=0`（Pages 环境变量）；
- **已知局限**：缓存只在当前 isolate 内。Cloudflare 会在不同 colo 起多个 isolate，
  跨 isolate 的失效最多等 60s（与 `rate-limit.js` 的进程内计数同一类限制）。
  公开读的一致性靠快照，不靠这个缓存。

### 3.3 D1 用量观测

```bash
CF_API_TOKEN=… CF_ACCOUNT_ID=… node tools/d1-usage.mjs          # 今日行读/行写/使用率
node tools/d1-usage.mjs --days 7 --json                          # 按日趋势，机器可读
```

使用率 > 80% 时退出码 2（可以直接挂到定时任务里告警）；缺权限退 3。
免费额度口径写在 `tools/d1-usage.mjs` 的 `FREE_TIER`。

## 4. 回滚

快照对象**永不删除**（版本号带内容哈希，天然不可变）。回滚 = 把 `current.json` 指回上一版：

```bash
# 1) 找到上一版
node tools/build-snapshot.mjs --status
# 2) 直接把 current.json 覆盖成旧版本（R2 REST，或在 Workers 里跑一次 put）
#    对象结构：{"version":"<旧 version>","generatedAt":<旧 generatedAt>}
```

更省事的办法：`env.SNAPSHOT_AUTO=0`（Pages 环境变量）先冻结自动重建，再手工切 `current.json`。
最坏情况下还可以把整个快照功能关掉——公开读会回落到 D1（带 `degraded`），功能不中断。

## 5. 快照构建失败时会发生什么

- `current.json` **不会被改写**（写顺序：先写 `snapshots/<version>/…`，最后才写指针）；
- 线上继续读上一版完整快照，只是内容旧一点；
- 日志里有 `[snapshot] … 后重建快照失败（保留旧 current.json）`；
- 上传/发布本身**不会失败**（触发点是 `rebuildSnapshotQuietly`，吞掉异常）。

## 6. 故障速查

| 症状 | 先看什么 |
|---|---|
| 公开接口 500 | `/api/meta` 是否 500；D1 额度（`d1_usage`）；`PUBLIC_SNAPSHOT_FALLBACK` 是否被设成 `0` |
| 公开接口全部 `degraded:true` 且 `snapshotGeneratedAt` 有值 | D1 挂了，正在用仓库内嵌快照 |
| 新素材发布后线上看不到 | `current.json` 的 version 有没有变；`SNAPSHOT_AUTO` 是否为 `0`；触发点日志 |
| 列表 total 与 facets 合计对不上 | 跑对拍：`node tools/run-tests.mjs`（`tests/snapshot-parity.test.js` 会红） |
| 详情有、列表没有 | 条目所在分类被设成私有（A 方案），或快照没重建 |

## 7. 定时兜底（建议）

GitHub Actions（每小时）：

```yaml
name: snapshot
on:
  schedule: [{ cron: '17 * * * *' }]
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: node tools/build-snapshot.mjs
        env:
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

> 注意：仓库里 `.github/` 目前是空的（上一阶段删掉过一个越权的 workflow）。
> 要启用就按上面这份重建，并确认 Secrets 只给 D1 读 + R2 写。

## 8. 改媒体域名时

快照里存的是**构建时**的绝对 URL（`MEDIA_BASE` / `PUBLIC_ORIGIN`）。换域名后必须重建：

```bash
node tools/build-snapshot.mjs --force
```
