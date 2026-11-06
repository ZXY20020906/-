# 开会话用的提示词（按顺序复制）

> 用法：每次新开会话，只粘对应的那一段。所有细节都在仓库 docs/ 里，不需要翻历史。
> 顺序：当前会话收尾 → 阶段三 → 阶段四+六 → 阶段五。

---

## 0. 当前会话收尾（只在"上下文快用尽"的会话里粘）

```
收到，你的判断正确，按你说的收尾，不要硬推。

现在只做三件事，然后结束：
1) 确认工作区干净：git status 无未提交改动
   · 若有半成品 ⇒ git checkout -- . 回滚
   · 检查无残留调试开关（FOLIA_FAIL_PUBLISH、DEBUG_API 等）
2) 确认已把当前状态写进 docs/PHASE-PROGRESS.md
3) git add -A && git commit -m "docs(progress): 记录阶段三调研进度与中断原因" && git push origin main

不要动 public-api.js、不要新建 snapshot.js、不改任何线上行为。
汇报一句：最终 HEAD + 工作区是否干净，即可结束。
```

---

## A. 阶段三：公开读静态化（独占一个会话）

```
仓库 folia-admin。先 git pull --rebase origin main。

目标：只做「阶段三 公开读静态化」，一次做到底，不碰阶段四/五/六。
必读：docs/PHASE-PROGRESS.md、docs/PHASE3-EXECUTION.md、docs/PHASE3-HANDOFF.md、docs/SITE-CHARTER.md

顺序：
1) 先补「15 个筛选参数 ↔ queries.js SQL ↔ 内存筛选实现」对照表
   写到 docs/PHASE3-PARITY-MAP.md（只读调研，不改代码）
2) 按 PHASE3-EXECUTION.md 的 1–7 实现：
   · src/server/snapshot.js：computeVersion / buildSnapshot / publishSnapshot / readSnapshot
     （复用 queries.js + dto.js，不新写 SQL、不复制 item 构造）
   · public-api.js：快照优先 → 内存筛选/分页/排序 → 快照缺失回退 D1 + degraded:true
   · public-v1.js：current.json 路由；缓存头 current=300s、snapshots=immutable 1 年；304 不回源
   · ingest.js 四个触发点：上传 complete / attachVariant / publishWallpaper / 下架编辑
     （失败只记日志，不阻断主流程）
   · tools/build-snapshot.mjs：--dry-run / --force
   · tests/snapshot.test.js 9 条 + tests/snapshot-parity.test.js 16 块（不一致即红）

已裁决（不要再问）：
· 快照含 status='published' 且 categories.is_public=1（A 方案，不给 wallpapers 加列）
· 旧 src/server/public-snapshot.js 保留做 degraded 兜底，不改不删

约束：
· 不改 wrangler.toml 绑定名 / 不用 S3 预签名 / 不绕过 ingestAsset / 不 force push / 不提交 token
· draft 不得出现在公开接口和快照里
· 快照构建失败 ⇒ 保留旧 current.json，不切换

完成标准（缺一不算）：
· npm test 全绿（≥331 + 新增）、check-sql 0 失败、smoke 通过
· push 后等 Pages 部署 → 线上 ①–⑦：
  ① current.json 200 且 {version,generatedAt}
  ② 6 端点 200、total=110、facets 合计==total
  ③ manifest ETag 稳定 + If-None-Match 304
  ④ 连点 10 次清单：D1 行读增量≈0
  ⑤ 传一条新素材：version 变化、列表立即可见
  ⑥ 手删一个快照对象：回退 D1 + degraded:true，不 500
  ⑦ 详情 variants 含 label/width/height/fps，与列表一致
· 更新 docs/PHASE-PROGRESS.md 勾选 + commit + push

汇报：改动文件、新增测试条数、①–⑦ 证据（状态码/条目数/行读增量）、commit hash。
```

---

## B. 阶段四 + 阶段六（合并一个会话）

```
仓库 folia-admin。先 git pull --rebase origin main。

目标：只做「阶段四（TTL/缓存治理）」+「阶段六（运维三件套）」，不碰读取层重构、不碰后台 UI 改版。
必读：docs/PHASE4-6-HANDOFF.md、docs/PHASE-PROGRESS.md、docs/SITE-CHARTER.md

阶段四：
· 后台列表：默认 limit=20 + page 参数 + 60s 内存缓存（按规范化 query key）；写操作后清缓存
· 公开读缓存头复核：current=300s、snapshots=immutable、快照缺失直读 D1 时 no-store + degraded
· docs/OPS.md 增加「端点 TTL 表」与「如何立即失效」
验收：后台连点 10 次刷新 D1 行读增量 ≤20；公开清单连点 10 次 ≈0；上传后列表立即可见

阶段六：
· tools/inspect-assets.mjs：对象存在性/bytes/sha 抽样、_tmp 孤儿、无 DB 记录的 R2 对象、
  needs_variant 堆积、draft>7 天；支持 --json、异常退出码 1
· tools/d1-usage.mjs：今日行读/行写/存储；>80% 警告并退出码 2
· tools/export-d1.mjs：导出 wallpapers/categories/tag_aliases/licenses/orders 到 backups/（gitignore）
· docs/OPS.md：部署流程、回滚（git revert + 重建快照）、额度监控、故障处理
验收：造一条"DB 有记录但对象缺失"⇒ inspect 报红（退出码 1）；d1-usage 能显示当天行读；
      export 产物可 JSON.parse 且条目数与面板一致

约束：不改绑定名 / 不删 R2 对象 / 不 force push / 不提交 token
每完成一部分就 commit + push；最后更新 docs/PHASE-PROGRESS.md 勾选

汇报：改动文件、脚本用法、测试数字、验收证据（行读增量/退出码/条目数）、commit。
```

---

## C. 阶段五：管理端效率（独占一个会话）

```
仓库 folia-admin。先 git pull --rebase origin main。

目标：只做「阶段五 管理端效率」，不动公开读层、不改接口契约。
必读：docs/PHASE4-6-HANDOFF.md（阶段五部分）、docs/PHASE-PROGRESS.md、docs/SITE-CHARTER.md

做：
1) 多选拖拽上传：一次 N 个文件，2 并发，复用阶段一分片接口；总进度 + 每文件状态
2) 失败重试：失败项「重试全部 / 重试单个」，原因可见（413/422/网络）
3) 重复检测：上传前算 sha256（>40MB 用采样指纹），命中已有条目 ⇒ 提示"复用"并跳过上传
4) 批量操作：多选后改分类/标签、发布、下架、软删
5) 列表信息：待转码徽标 + reason、原片 fps/分辨率/大小、已有变体档位

验收：
· 一次拖 10 个文件全部成功（或明确失败原因）
· 重复文件提示复用，R2 对象数不增加
· 批量改 5 条标签生效，重建快照后公开接口跟随
· 待转码徽标数量 == needs_variant=1 数量

约束：不改绑定名 / 不删对象 / 不 force push / 不提交 token / 不动公开契约
完成：测试全绿 + check-sql + smoke + 更新 docs/PHASE-PROGRESS.md + push

汇报：改动文件、新增测试、验收证据、commit。
```

---

## 备选：最短开场白（每阶段通用）

```
git pull --rebase；读 docs/PHASE-PROGRESS.md 与 docs/SITE-CHARTER.md，
接着做「下一个未完成阶段」，按对应 docs/PHASE*.md 执行，完成后勾选进度并 push。
```
