# 验收报告（A–G）· 2026-11-06

> 目标：**私有素材库**——传得进（4K@60、≤2GB、可续传）、播得出（自动转 30fps 变体）、
> 打不挂（公开读 0 数据库）、看得住（巡检/备份/额度告警）；插件不改代码即可正常用。
>
> 本文所有判据都对着**数据库 / R2 对象 / 响应头 / 退出码**，不采信自述。
> 线上基址：`https://folia-5ve.pages.dev` · 快照版本（验收结束时）：`20261106T102606Z-7d8a23c8`

## 结论

**可以开始批量传素材。** A–F 全部通过；G（24 小时观察）按派单约定异步进行，未到期，见 G 组。

验收过程中发现并修掉 3 个真问题（详见「问题记录」）：
快照对象没有 HTTP 出口、边缘缓存改写 immutable、`cleanup --dry-run` 名不副实。
三处都是**先写红测试再修**，修完重跑了受影响的分组。

## 一、逐条结果

### A 仓库与代码

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| A1 | PASS | `git statusMatrix` 相对 HEAD 改动文件 = **0** | 等价 `git status --porcelain` 为空 |
| A2 | PASS | `DEBUG_API` 只出现在 `app.js:377` 的**代码判定**里，未写入任何环境；`wrangler.toml` 里 `FOLIA_FAIL_PUBLISH = "0"` | 两个开关都需要显式设 `"1"` 才生效 |
| A3 | PASS | `node tools/run-tests.mjs` → **387 tests / 387 pass / 0 fail** | 阶段二基线 331 → 现在 387（+56） |
| A4 | PASS | `node tools/dump-queries.mjs && python tools/check-sql.py` → **checked 111 queries, 0 failure(s)** | 仓库里是 `tools/check-sql.py`（python）；`check-sql.mjs` 不存在，用等价命令执行 |
| A5 | PASS | `node tools/smoke-public-api.mjs` → **9/9 通过，SMOKE OK** | 部署后复跑同样 9/9 |
| A6 | PASS | 全仓 `ghp_` / `cfut_` / `npm_` 前缀扫描 → **0 命中** | 排除 `.git`、`node_modules`、`deploy/`、`build/`、`backups/` |
| A7 | PASS | `wrangler.toml` 最早提交 `2849e2c5` 与 HEAD `d55e3db3` 的绑定名逐字节相同：`binding="DB"` / `binding="BUCKET"` / `database_name="folia"` / `bucket_name="folia-wallpapers"` | 该文件历史上被改过 7 次，全部是 `[vars]`，绑定名一次没动 |
| A8 | PASS | `src/ tools/ functions/` 全量扫 `X-Amz` / `presign` / `aws-sdk` / `S3Client` → **0 命中** | 上传走 Worker 直传 R2 绑定，浏览器拿不到任何签名 URL |

### B 功能正确性（对照数据库）

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| B1 | PASS | 公开 `total=110`；D1 同谓词（`status='published' AND storage_key NOT NULL AND verified_at NOT NULL AND review_status='approved' AND 分类公开`）计数 = **110** | 两边跑的是同一条谓词 |
| B2 | PASS | 详情 `原神-钟离` → `[{label:"1080p", width:1920, height:960, fps:30, bytes:8667665, sha256:6be662fb…, url:https://…/6be662fbc05dd657.1080p.mp4}]`，七个字段齐全 | 列表同一条的 variants 与之**逐字段相同** |
| B3 | PASS | 造一条 `needs_variant=1` 的 draft（`verified_at` 也给了，故意让它"看起来合法"）：列表 `total=0`、详情 **404**、manifest 里**不存在** | 探针行跑完即删 |
| B4 | PASS | 详见下方「B4 专项」：4K@60 入库 → `draft + needs_variant=1 + reason=fps-60` → 转 1080p@30 → 上传变体 → 发布（`via=variant`）→ 公开可见、`?playable=1080p30` 命中 | 公开只下发 `approved`，发布后仍需审核通过（既定审核门） |
| B5 | PASS | 插件走 v1：匿名 `total=110` == 公开 110；legacy `/api/plugin/feed` 按 `docs/api.md` 裁决**需要会话**，带会话实测 `count=118`（= 已发布 + 有文件），比公开多 8 条**未审核**条目 | 面板可见、公开不可见，属审核门的预期差异 |
| B5b | PASS | `?playable=1080p30` 命中 31 条，其中 **21 条是靠变体入选**（原画超 1080p30） | 即"4K@60 走 30fps 变体可播" |

**B4 专项证据**（`tools/ffmpeg` 现造 3840×2160@60 源片）：

```
B4-1 入库 status=draft · needs_variant=1 · reason=fps-60 · 探测 3840×2160@60fps
B4-2 发布前公开列表命中=0
B4-3 上传变体 HTTP 200 · variants=[{label:"1080p", w:1920, h:1080, fps:30}]
B4-4 发布 HTTP 200 · via=variant · status=published     ← 变体可播 ⇒ publishWallpaper 放行
B4-5 审核通过 updated=1
B4   发布后公开列表命中=1 · 详情 variants 同上 · ?playable=1080p30 命中=1
```

### C 静态化真的生效（核心）

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| C1 | PASS | `GET /api/v1/public/current.json` → **200** `{"version":"20261106T102606Z-7d8a23c8","generatedAt":1793852953675}` | `cache-control: public, max-age=300, stale-while-revalidate=3600` |
| C2 | PASS | `GET /api/v1/public/snapshots/20261106T102606Z-7d8a23c8/wallpapers.json` → **200**，`total=110`，111,415 字节 | 该路由是本次验收补的（见问题 ①） |
| C3 | PASS | `current.json` → `max-age=300`；快照对象 → `public, max-age=31536000, immutable` | 边缘缓存不再改写 immutable（见问题 ②） |
| C4 | PASS | `manifest.json` ETag `W/"fb2e57605d40138287200b35"`；带 `If-None-Match` → **304，body 0 字节** | 两次取值 ETag 相同 |
| C5 | PASS | 连点 10 次清单（每次换 `limit` 换缓存键，保证都回源）：**D1 rowsRead = 0**（该秒级窗口内**没有任何 D1 分片**） | 阈值 ≤10；对照：阶段三实测一次 D1 回退请求约 1000+ 行 |
| C6 | PASS | 传素材 → 发布+审核：R2 `current.json` `…101002Z-7d8a23c8` → `…102506Z-b85aee35`；HTTP 侧同值；公开列表命中 = 1 | `current.json` 走 CDN 缓存 5 分钟，HTTP 侧用 `limit=随机` 换键才看得到即时值 |
| C7 | PASS | 详情 variants 与列表同条 **逐字段相同**（`JSON.stringify` 相等） | — |

### D 故障与降级（实测）

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| D1 | PASS | 删 `snapshots/<current>/wallpapers.json`（HTTP 200）→ 立刻打清单：**200 + `degraded:true` + total=110 + items 正常返回**；随后 Worker 用 `ctx.waitUntil` 自愈，`degraded` 回到 `null` | 并发 3 次时第 3 次已被自愈接回快照（比预期更好，不是失败） |
| D2 | PASS | 库里存在「有记录、R2 无对象」的条目时，公开清单/详情**均 200**（不 500）；`inspect-assets` 能逐条报出（见 E1） | 用真实探针行验证 |
| D3 | PASS | 故意用坏 database id 跑 `tools/build-snapshot.mjs` → **退出码 1**，`current.json` 版本**未变**，公开读仍 **200** | 构建失败保留旧指针，线上无感 |
| D4 | PASS | 28.1MB 文件 → `init(partSize=8MB, maxParts=4)` → 传第 1 片后**中断** → 复用同一 `uploadId` 重传第 1 片（etag 一致）+ 其余 3 片 → `complete` **200**，`mode=inline`，落库 `storage_key=wallpapers/…`，合并对象 29,504,688 字节 | 合并后 `_tmp/` 里对象已被删；`_tmp` 残留清理见 E4 |

### E 运维脚本

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| E1 | PASS | 插入一条 `storage_key` 指向不存在对象的记录 → `inspect-assets` 输出 `[missing] wp_inspect_probe wallpapers/wp_inspect_probe/000000000000.mp4`，**退出码 1**；删掉后回到 **0** | 探针已清理，库仍 235 行 |
| E2 | PASS | `d1-usage`：今日 894,362 / 5,000,000（**17.9%**）→ **退出码 0**；`--warn-at 0.1` 复现阈值分支 → **退出码 2** | 用 `--warn-at` 复现「>80% 退 2」的代码路径（当前实际未到 80%） |
| E3 | PASS | `export-d1` → 6 张表 / 268 行 / 340.9KB；`JSON.parse` 成功；`wallpapers=235` 与 D1 `COUNT(*)=235` 一致；`api_keys` 列不含 `key_hash` | 产物落 `backups/`（已 gitignore） |
| E4 | PASS | 线上 `cleanup --dry-run` → `扫描 0 个临时对象，会删除 0 个`、退出码 0（线上确实没有残留，空列表证明不了"不删"）；因此补了单测：假桶造一个 48h 前的对象 → dry-run `wouldDelete=1 / deleted=0 / bucket.delete 未被调用`，非 dry-run 才删且只删超过 24h 的 | 本轮把 `--dry-run` 从"只登录"改成"真列清单"（问题 ③） |

### F 管理端

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| F1 | PASS | 一次拖 10 个文件（2 并发，UI 同一套请求）：**10/10 imported**，无失败 | R2 对象 +10 |
| F2 | PASS | 同一个文件再传：`duplicate-check` 命中 `matchedBy=sha256` ⇒ 跳过上传，**R2 对象数 657 → 657 不变** | 绕过前端再传一次，服务端也回 `reused` |
| F3 | PASS | 一次 `POST /batch` 改 5 条（发布+审核+标签）→ `updated=5`；公开 `?tag=…` **total=5**；`current.json` 换版本 | 批量与单条 PATCH 共用同一份落库逻辑 |
| F4 | PASS | 造 2 条 `needs_variant=1`：D1 计数 **2** == `?needsVariant=1` 接口 **2** 条 == 列表渲染徽标 **2** 行 | 跑完即删 |

### G 24 小时观察（异步，未到期）

| 编号 | 结果 | 证据 | 备注 |
|---|---|---|---|
| G | PENDING | 今日（UTC）D1 行读 894,362 / 5,000,000（17.9%），行写 1,000 量级；R2 对象 647 个；`inspect-assets` 连续两次退出码 0（11-06 18:02 与 18:24 各一次） | 派单写明"可异步"：完整 24h 趋势需要明天复跑 `tools/d1-usage.mjs --days 2` 与 `tools/inspect-assets.mjs` |

## 二、问题记录（问题 → 根因 → 修法 → 复测）

### ① C2：快照对象没有 HTTP 出口 —— **已修**

- **现象**：`GET /api/v1/public/snapshots/<version>/wallpapers.json` → 404。C2 无法通过。
- **根因**：阶段三只把对象写进 R2 并给了 immutable 元数据，**没做 HTTP 路由**；裁决里那句
  "`snapshots/** → immutable`" 一直只是对象的元数据，不是可访问的 URL。属实现缺口，不是回归。
- **修法**：新增 `GET /api/v1/public/snapshots/:version/:file`，只放行
  `wallpapers.json` / `manifest.json` + 合法版本号形状（其余一律 404，避免变成 R2 读取器）；
  不查 D1、不查 current.json。
- **复测**：先写红测试（"快照对象本身可公开读取"，红）→ 实现 → 绿；线上 C2/C3 通过。

### ② 边缘缓存把 immutable 改写成 300s —— **已修**

- **现象**：C3 要求快照对象 `immutable`，但 `app.js` 回源写缓存时无条件把
  `cache-control` 覆盖成 `public, max-age=300, …`。
- **根因**：第 4 期加"公开读统一 5 分钟"时，写入逻辑没区分"带内容哈希的不可变对象"。
- **修法**：抽出 `edgeCacheControl(existing)`：带 `immutable` 的原样保留，其余仍是 5 分钟。
- **复测**：4 条单测断言 + 线上 `snapshots/**.json` 返回 `max-age=31536000, immutable`。

### ③ `cleanup --dry-run` 名不副实 —— **已修**

- **现象**：E4 要求"只列不删"，脚本的 `--dry-run` 只做了一次登录检查，什么都不列。
- **根因**：服务端 `cleanup` 只有"删"一种模式，脚本只能这样写。
- **修法**：服务端支持 `?dryRun=1`（返回 `wouldDelete` 列表、`deleted:0`）；脚本 `--dry-run`
  真的列清单；顺带支持 `FOLIA_SESSION_COOKIE`（CI 免存管理员密码）。
- **复测**：单测两条（dry-run 不删 / 非 dry-run 只删超 24h 的）+ 线上 dry-run 退出码 0。

### ④ 验收方法本身的两个坑（不是产品缺陷，记录备查）

- **边缘缓存只认白名单参数**：`?t=<随机>` 会被丢掉，同一 `q/limit` 组合的第二次请求命中缓存，
  于是"发布后看不到"其实是看到了 5 分钟前的空结果。→ 所有"验证状态变化"的探针都改成换
  `limit`（白名单内）。
- **D1 analytics 按秒分片、落盘延迟 2–13 分钟不定**：窗口内查不到分片时不能判 FAIL，
  要区分"没有分片（= 0 行）"与"还没落盘"。→ C5 改为先轮询到窗口有数据；本轮实测窗口内
  **完全没有分片**，即 0 行读。

## 三、commit 列表（按时间）

| commit | 内容 |
|---|---|
| `6d44af03` | 阶段三：公开读静态化（snapshot/public-filter/public-api/current.json/触发点/工具/测试） |
| `3b946955` | 阶段三修复：对象被删但 current.json 仍在时，重建必须补写 |
| `38d4f7aa` | 阶段三进度看板 + ①–⑦ 证据 |
| `4c5061a0` | 阶段三交接文档标记完成 |
| `1fa27774` | 阶段四：后台分页 + 60s 短缓存 + 公开读 TTL 复核 |
| `56f3478a` | 阶段四进度看板 + 证据 |
| `2aac2db3` | 阶段六：inspect-assets / export-d1 + OPS 扩充（d1-usage 阶段四已落地） |
| `7317446a` | 阶段六进度看板 + 证据 |
| `36b8091f` | 阶段五：拖拽批量上传 / 失败重试 / 查重 / 批量操作 / 待转码徽标 |
| `e7ccf916` | 阶段五进度看板 + 证据 |
| `d55e3db3` | **本轮**：补快照对象 HTTP 出口（C2）+ cleanup dryRun/会话认证（E4） |
| `05aff4f5` | **本轮**：边缘缓存不改写 immutable（C3） |
| `<本报告>` | docs(acceptance)：A–G 验收报告 + cleanup dry-run 单测 |

## 四、遗留与建议（不影响开工）

1. **G 组**：明天复跑 `node tools/d1-usage.mjs --days 2` + `node tools/inspect-assets.mjs`，
   观察行读是否平稳、R2 是否只随素材增长。
2. **审核门容易被忽略**：新上传默认 `review_status=pending`，公开接口只下发 `approved`。
   批量导入后记得点「全部通过审核」（或批量操作里带 `reviewStatus`）。
3. **`/api/plugin/feed` 需要会话**（按 `docs/api.md` 的裁决）。若还有老插件在匿名调用它，
   会拿到 401 —— 现代插件走 `/api/v1/public/*`，匿名可用。
