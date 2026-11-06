# 阶段三执行细则：公开读静态化（照此实现）

> 目标：公开读 **0 次 D1 行读**。所有公开接口从 CDN 上的静态快照应答；快照缺失才回源 D1（带 `degraded`）。
> 前置：阶段一/二已完成（HEAD 最新为 `fd25009`）。测试基线 331 pass。

---

## 1. 文件与职责

| 文件 | 作用 | 新建/修改 |
|---|---|---|
| `src/server/snapshot.js` | 构建快照、写 R2、切 `current.json` | 新建 |
| `src/server/public-api.js` | 列表/详情从快照读，参数在内存里筛 | 修改 |
| `src/server/routes/public-v1.js` | `current.json` 路由 + 缓存头 | 修改 |
| `src/server/ingest.js` | 发布/变体/下架后触发快照重建 | 修改（只加一行调用） |
| `tools/build-snapshot.mjs` | 手动/定时重建（本地或 CI） | 新建 |
| `tests/snapshot.test.js` | 单测 | 新建 |
| `docs/OPS.md` | 记录 TTL、失效方式、回滚 | 新建/追加 |

---

## 2. `src/server/snapshot.js` 接口

```js
export const SNAPSHOT_PREFIX = 'snapshots';

// 计算版本号：内容哈希前 8 位 + UTC 时间戳（内容不变则不变）
export async function computeVersion(env, payload) -> string

// 构建快照体（禁止新写 SQL，复用 queries.js）
export async function buildSnapshot(env) -> { version, manifest, wallpapers }

// 写 R2 + 原子切换 current.json
export async function publishSnapshot(env) -> { version, wrote:boolean, ms }

// 读取：先 current.json，再对应 version 文件
export async function readSnapshot(env) -> { version, manifest, wallpapers, source:'snapshot' } | null
```

### 2.1 快照内容规则

```
· 只含 status='published' AND is_public=1
· 字段与 /api/v1/public/wallpapers 完全一致（复用 dto.js 的 toPublicItem）
· wallpapers.facets 计数与 items 同源（分类/标签/子标签/朝向/kind）
· manifest.items 沿用现有 manifest 字段（14 个）
```

### 2.2 R2 对象

```
snapshots/<version>/manifest.json      Content-Type: application/json
snapshots/<version>/wallpapers.json    Content-Type: application/json
current.json                           覆盖写，body={"version","generatedAt"}
```

### 2.3 版本号

```
version = `${utcCompact}-${sha256(wallpapersJson).slice(0,8)}`
utcCompact 形如 20261106T131500Z
内容未变（同一 hash）⇒ 直接返回现有 version，不写新对象（避免无意义切换）
```

---

## 3. 读取改造（`public-api.js`）

```
入口统一走 readSnapshot(env)：
  1) 命中 ⇒ 用快照体在内存里筛选/分页/排序：
       · 参数全部保持兼容：category/kind/tag/subtag/q/aspect/featured/
         minWidth/maxWidth/minHeight/maxHeight/minDurationMs/maxDurationMs/
         minBytes/maxBytes/fpsMax/playable/audio/limit/page/sort
       · facets 直接用快照里的计数（不要重算 SQL）
  2) 未命中 / 快照缺文件 ⇒ 回退现有 D1 路径 + `degraded:true`
  3) 详情：快照内按 slug 查；未命中 ⇒ 查 D1；都没有 ⇒ 404 not_found
  4) manifest：优先快照文件（保持既有字段与 ETag 生成方式）
```

### 缓存头（`routes/public-v1.js`）

```
current.json        Cache-Control: public, max-age=300
snapshots/**        Cache-Control: public, max-age=31536000, immutable
/api/v1/public/*    Cache-Control: public, max-age=300（未静态化直连 D1 时仍按现有降级头）
```

`If-None-Match` 一律按现有 ETag 逻辑返回 304，不回源 D1。

---

## 4. 触发点（全部要调 `publishSnapshot`，失败只记日志不阻断主流程）

```
1) 上传 complete 成功（ingestAsset 返回后）
2) 变体写入成功（attachVariant）
3) 发布（publishWallpaper）
4) 下架 / 软删 / 编辑标题标签等影响公开字段的操作
5) 定时兜底：tools/build-snapshot.mjs（可手动，或 GitHub Action 每小时）
```

实现建议：在 `ingest.js` 的三个返回点后调用；用 `env.SNAPSHOT_AUTO !== '0'` 控制（默认开）。

---

## 5. `tools/build-snapshot.mjs`

```
node tools/build-snapshot.mjs                 # 构建并切换
node tools/build-snapshot.mjs --dry-run       # 只算 version 与条目数，不写
node tools/build-snapshot.mjs --force         # 内容未变也写新 version（排障用）
输出：version / items / 写入耗时 / 是否发生切换
```

---

## 6. 测试（`tests/snapshot.test.js`）

```
S1 buildSnapshot：110 条公开 ⇒ items=110，facets 合计==total
S2 内容不变 ⇒ 二次 publishSnapshot 不写新对象（wrote=false）
S3 内容变化 ⇒ version 变化、current.json 指向新版本
S4 列表：读快照时参数筛选正确（category/kind/tag/minWidth/playable 各 1 例）
S5 详情：快照命中 / 未命中回源 / 都不存在 ⇒ 404
S6 快照缺失 ⇒ 回退 D1 且响应带 degraded:true
S7 manifest ETag 稳定；If-None-Match ⇒ 304
S8 draft 条目不出现在快照（先造一条 draft 再构建）
S9 缓存头断言（current 300 / snapshots immutable）
```

---

## 7. 验收（线上）

```
① 6 个公开端点 200，total=110（公开数，当前 46 wallpaper + 61 skin + 3 boot）
② facets 合计 == total
③ manifest ETag 稳定；条件请求 304
④ 连点 10 次清单：D1 行读增量 ≈ 0（用 tools/d1-usage.mjs 观察，或 Cloudflare 面板）
⑤ 上传一条新素材 ⇒ current.json 版本变化 ⇒ 列表立即可见
⑥ 手动删除一个快照对象 ⇒ 访问列表 ⇒ 回退 D1 + degraded:true，且不 500
⑦ 详情 variants 含 label/width/height/fps（与列表一致）
```

---

## 8. 风险与处理

| 风险 | 处理 |
|---|---|
| 快照构建慢（110 条无问题，几千条时） | 只构建一次并复用；>2000 条时改分片快照（按分类/页） |
| 构建失败 | 保留旧 current.json；记录失败原因；主流程不阻断 |
| 快照与 D1 不一致（发布后未及时切） | 所有写操作都触发；另加每小时兜底重建 |
| R2 写次数 | 只有内容变化才写（S2 保证） |
| 回滚 | 不删旧快照；把 current.json 指回上一个 version 即可 |

---

## 9. 完成后状态

```
· 公开读 0 D1 行读 ⇒ 额度与用户量解耦
· 插件无需改动（接口与字段不变）
· 阶段四可在此基础上把 current.json 缓存加长、后台列表分页
```
