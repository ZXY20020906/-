# 阶段三交接（公开读静态化）

> 状态：**未实现**。本文只固化裁决与实施清单，供新会话直接开工。
> 开工第一件事：`git pull --rebase origin main`，再读 `docs/PHASE3-EXECUTION.md`。

## 已裁决（不要再问）

1. **快照范围**：`status='published'` **且** 所属分类 `categories.is_public = 1`（A 方案）
   - 不给 `wallpapers` 加列；分类改公开/隐藏 ⇒ 重建快照即生效
2. **新旧分工**
   - `src/server/snapshot.js`（新）= 静态快照，正常路径，0 D1 行读
   - `src/server/public-snapshot.js`（旧，181KB 单行 JSON）= D1 不可用时的 degraded 兜底
   - 两条互不替代，**不重命名、不删除**
3. **必须新增 `tests/snapshot-parity.test.js`**：同一份数据两条路径对拍
   - 断言：排序后的 ids 序列、total、facets 完全一致；排序键（updatedAt/publishedAt/featured）也要对拍
   - 覆盖 16 块：无参 / category / kind / tag / subtag / q / aspect / featured /
     minWidth+maxWidth / minHeight+maxHeight / minDurationMs+maxDurationMs /
     minBytes+maxBytes / fpsMax / playable / audio / page+limit / 组合 3–4 个
   - 命名建议 S10a…S10p；任何不一致 ⇒ 红，不许放宽断言

## 实施顺序

1. **先读** `src/server/public-api.js`（筛选实现）与 `src/server/queries.js`（对应 SQL）——
   这是全部风险所在，未读完不要动读取层
2. `src/server/snapshot.js`
   - `SNAPSHOT_PREFIX = 'snapshots'`
   - `computeVersion(env, payload)`：`utcCompact + '-' + sha256(wallpapersJson).slice(0,8)`，内容不变返回原 version
   - `buildSnapshot(env)`：复用 queries + dto，产出 `{version, manifest, wallpapers}`
   - `publishSnapshot(env)`：写 `snapshots/<version>/{manifest,wallpapers}.json` + 覆盖 `current.json`
   - `readSnapshot(env)`：先 `current.json`，再对应版本文件；缺失返回 null
3. `public-api.js`：`readSnapshot` 命中 ⇒ 内存筛选/分页/排序（参数与 SQL 全等价）；
   未命中 ⇒ 现有 D1 路径 + `degraded: true`；详情先快照后 D1
4. `routes/public-v1.js`：`GET /api/v1/public/current.json`；
   `current.json` → `public, max-age=300`；`snapshots/**` → `public, max-age=31536000, immutable`
5. `ingest.js` 四个触发点（上传 complete / attachVariant / publishWallpaper / 下架编辑），
   用 `env.SNAPSHOT_AUTO !== '0'` 控制，失败只记日志不阻断主流程
6. `tools/build-snapshot.mjs`：`--dry-run` / `--force`
7. 测试：`tests/snapshot.test.js` 9 条 + `tests/snapshot-parity.test.js` 16 块
8. 线上验收 ①–⑦

## 风险提示

- 内存筛选与 SQL 不等价 ⇒ **全站公开列表错乱**，必须先有 parity 测试再切读取层
- 构建失败要保留旧 `current.json`；不要删旧快照（回滚 = 把 current 指回上一版）
- `public-snapshot.js` 是单行大 JSON，**不要用 grep/less 直接打印**（会刷屏）

## 后续阶段

`docs/PHASE4-6-HANDOFF.md`（阶段四 TTL / 阶段五 管理端效率 / 阶段六 运维三件套）——
按派单顺序：阶段三 → 阶段四 → 阶段六 → 阶段五，每阶段独立验收后再进下一阶段。
