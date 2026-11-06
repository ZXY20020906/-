# 阶段三交接（给新会话直接粘贴）

> 用途：协作者机器开新会话时，把下面「提示词」整段粘贴进去即可无缝续做。
> 主文档：`docs/PHASE3-EXECUTION.md`（步骤 1–7）；本文补充已裁决事项与硬要求。

---

## 已裁决事项（不要重新讨论）

| # | 事项 | 结论 |
|---|---|---|
| 1 | 快照包含哪些条目 | **A 方案**：`status='published'` 且 `所属分类 categories.is_public=1`；不给 wallpapers 加 is_public 列 |
| 2 | 旧的 `src/server/public-snapshot.js` | **保留做 degraded 兜底**，不改、不删；新的 `src/server/snapshot.js` 只负责静态快照 |
| 3 | 筛选等价性 | 必须新增 `tests/snapshot-parity.test.js`，16 块逐块对拍（ids 排序后 / total / facets / sort） |
| 4 | 顺序 | 按 `PHASE3-EXECUTION.md` 的 1→7 一次做完，不推半成品 |
| 5 | 空桶 `folia-upload` | 不使用；单桶 + `_tmp/`；空桶删除或标注废弃 |
| 6 | 禁止 | 不改绑定名 / 不用 S3 预签名 / Worker 无 ffmpeg / 不绕过 ingestAsset / 不 force push / 不提交 token |

---

## 提示词（新会话直接粘贴）

```
仓库：folia-admin，先 git pull --rebase origin main。
任务：实现「阶段三 公开读静态化」，按 docs/PHASE3-EXECUTION.md 的 1→7 一次做完。

已裁决（不要再问）：
· 快照包含 status='published' 且 categories.is_public=1 的条目（A 方案，不加 is_public 列）
· 旧的 src/server/public-snapshot.js 保留做 degraded 兜底，不改不删
· 必须新增 tests/snapshot-parity.test.js：同一份数据分别走「快照内存筛选」与「D1 SQL」，
  16 块逐块对拍 ids（排序后）/ total / facets / sort，任何一块不一致都算失败
  （覆盖：无参 / category / kind / tag / subtag / q / aspect / featured /
    min+maxWidth / min+maxHeight / minDurationMs+maxDurationMs / minBytes+maxBytes /
    fpsMax / playable / audio / page+limit / 3–4 参数组合）

实现要点：
1) src/server/snapshot.js：computeVersion / buildSnapshot / publishSnapshot / readSnapshot
   · 复用 queries.js + dto.js（不新写 SQL、不复制 item 构造）
   · version = UTC紧凑时间戳 + sha256(wallpapers).slice(0,8)；内容未变不切换
   · R2：snapshots/<version>/{manifest,wallpapers}.json + current.json（覆盖写）
2) public-api.js：读取层快照优先 → 内存筛选/分页/排序 → 快照缺失回退 D1 + degraded:true
   15 个筛选参数与 sort 全部保持兼容；facets 直接用快照里的计数
3) public-v1.js：current.json 路由；缓存头 current=300s、snapshots=immutable 1 年；304 不回源
4) ingest.js 四个触发点：上传 complete / attachVariant / publishWallpaper / 下架编辑
   失败只记日志，不阻断主流程
5) tools/build-snapshot.mjs：--dry-run / --force，输出 version/items/耗时/是否切换
6) tests/snapshot.test.js 9 条（S1–S9，见执行文档）+ parity 16 块
7) 部署后线上验收 ①–⑦：
   ① 6 端点 200、total=110；② facets 合计==total；③ manifest ETag 稳定 + 304
   ④ 连点 10 次清单 D1 行读≈0（tools/d1-usage.mjs 或面板）
   ⑤ 传一条新素材 ⇒ current.json 版本变化 ⇒ 列表立即可见
   ⑥ 手动删一个快照对象 ⇒ 回退 D1 + degraded:true，不 500
   ⑦ 详情 variants 含 label/width/height/fps，与列表一致

约束：不改 wrangler.toml 绑定名；不删 R2 旧对象；不 force push；不提交 token；
      draft 不得出现在快照；全量测试与 check-sql 必须 0 失败；每次 commit 后 push 并等部署。

汇报：改动文件 + 新增测试条数 + 上述 ①–⑦ 证据 + commit hash。
```

---

## 我（主开发机）的复核清单

```
1) npm test 全绿（≥331 + 新增 snapshot/parity）
2) 连点 10 次清单：D1 行读增量≈0
3) 删一个快照对象：回退 D1、degraded:true、不 500
4) 上传新素材：current.json 版本变化、列表立即可见
5) 详情 variants 字段与列表一致（label/width/height/fps）
6) parity 测试抽查 3 块：手工构造参数组合，两条路径结果一致
```
