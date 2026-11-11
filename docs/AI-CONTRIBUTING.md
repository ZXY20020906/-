# AI 贡献者须知（站点仓库）

> 本文件给"在另一台机器上改本站点"的 AI/人用。**开工前先读，交付前逐条对照。**
> 仓库：`ZXY20020906/-`（本地目录 `folia-admin`）。技术栈：Cloudflare Pages + Functions + D1 + R2。
> 铁律一句话：**公开契约只增不改；改可见性必须重建快照；交付必须自证。**

---

## 一、动手前：必须先读的三处

```
1) src/server/routes/*.js      —— 同类实现的鉴权、错误码、快照重建、分页写法
2) src/server/queries.js       —— 所有 SQL 常量（禁止内联拼 SQL）
3) tests/                      —— 已有测试怎么起 host、怎么造数据
```

```
另外：改公开接口前，先跑 `npm run smoke` 存一份改动前的响应，
改完再跑一遍，对比"只增不改"。
```

---

## 二、红线（碰了等于白干）

```
1) 公开契约
   · /api/public/* 与 /api/v1/public/* 必须逐字节相同（有测试守着）
   · 现有字段不许改名 / 删除 / 改类型；新增字段必须可空，老客户端读不到也不能崩
   · kind='pet' 之类的新值走 DTO 派生，不许改数据库 kind 列的历史值

2) 公开可见性 = 必须重建快照
   任何会改变"能不能被公开看到"的写操作都要触发 rebuildSnapshotQuietly（或标脏）：
     · PATCH 单条：status / review_status / verified / category_id / kind
     · 批量修改（bulk patch）
     · 删除作品 / 删除变体 / 上传变体并发布
     · 分类 is_public 变更
   · 快照重建失败必须 log 出来，并在管理端状态里可见 —— 禁止静默吞错
     （历史事故：发布成功但快照没重建 ⇒ 前台 5 分钟看不到新条目）

3) 数据库
   · 只许新增可空列（带默认值）+ 写迁移；禁止 DROP / 重命名 / 改类型
   · SQL 一律走 queries.js 常量；`npm run check:sql` 要过

4) 安全
   · /api/admin/** 必须 assertCan；不许新增免鉴权写接口；CSRF 逻辑不许绕
   · 密钥、token、cookie 一律不进代码、不进日志、不进提交

5) 存储与缓存语义
   · R2 的 key 规则不许改（老素材全靠它拼 URL）
   · /media/<key> 的 CORS / Range(206/416) / 1y immutable 不许改
   · 软删 = status='hidden'（保留行 + 保留 R2 对象）；硬删才删对象

6) 前端
   · admin 的 api() 里 FormData 分支（raw:true 必须把 body 原样交给 fetch）不许改回
     （改回会直接导致批量导入 400）
```

---

## 三、提交什么 / 不提交什么

### 必须提交

```
src/**             源码
public/**          前台 + 后台静态资源
functions/**       Pages Functions（如涉及）
schema/**          新增迁移（按现有编号顺序）
tests/**           测试（新功能必须带测试）
docs/**            行为变化 / 运维步骤
tools/**           新增或修改的工具脚本
```

### 绝对不要提交

```
node_modules/  deploy/  .wrangler/  build/     ← 已在 .gitignore
.dev.vars  *.log  .DS_Store
任何密钥 / token / cookie
0 字节占位文件（历史事故：被当成真文件误用）
>10MB 的素材（走 R2，不进 git）
```

> `deploy/` 是 `sync-deploy.mjs` 生成物，部署时临时生成，**不入库**。

---

## 四、文件格式（仓库没有 .editorconfig，按同目录现有文件照抄）

```
· 编码：UTF-8，不带 BOM
· 换行：与同文件现有风格一致（不要整文件转换 LF/CRLF）
· 缩进：js 2 空格；CSS/HTML/JSON 跟随同目录现有文件
· 不许跑全文件格式化工具：只改你动过的行，避免 diff 爆炸（review 时看不出真改动）
· 中文文案保持中文；英文注释保持英文，不要中英混排乱改
```

---

## 五、commit 规范（照仓库现有风格）

```
格式：<type>(<scope>): <中文，一句话说清改了什么/为什么>

type：feat | fix | docs | test | chore | refactor
scope：admin | site | api | snapshot | pet | import | ops | deploy

示例：
  fix(site): 发布/审核后自动重建快照 —— 修复前台 5 分钟仍看不到新条目
  test(snapshot): 补 3 条快照触发测试（发布 / 审核 / 软删）
  docs(ops): 写清 wrangler 回滚步骤

要求：
  · 一个逻辑一件事一个 commit（别把三件事揉成一个）
  · push 前 git status 检查，别把 deploy/、日志、临时文件带进去
  · push 前先 git pull --rebase origin main；**禁止 force push**
  · commit 后贴 hash + 改动文件列表
```

---

## 六、交付验收（每次改完都跑，缺一项算没交付）

```
① npm test                  → 期望 413+ 全绿，贴条数
② npm run check             → 语法 + UI 检查通过
③ npm run snapshot          → 贴新快照 version（时间戳必须变）
④ npm run deploy            → 贴 wrangler 输出的部署 URL
⑤ npm run smoke             → 期望 9/9
⑥ 线上真实 curl 一条        → 证明数据真的变了（贴返回片段）
⑦ git push 后             → 贴 commit hash + 改动文件列表
```

```
补充：快照 current.json 有最长 5 分钟的 CDN 缓存。
验收时要区分"没生效"和"还没到时间"：
  · 先看快照 version 是否已更新（③）
  · 再看 `/api/v1/public/manifest.json` 的 etag 是否变化
  · 都变了但页面还旧 ⇒ 是 CDN 缓存，属于预期，不是失败
```

---

## 七、交付时必须自答的 5 个问题

```
1) 改动里哪些会改变"公开可见性"？对应哪一处 rebuildSnapshot 调用？
2) 有没有可能让 /api/public/* 与 /api/v1/public/* 不一致？怎么证明一致？
3) 新增字段/字段值，老客户端读不到时会发生什么？给一句结论
4) diff 里有没有格式化噪音（整文件换行/缩进）？怎么保证没有？
5) 回滚这次改动要几步？命令是什么？
```

---

## 八、部署与回滚

```
部署（当前手动）：
  npm run snapshot                       # 重建公开快照（必做）
  npm run deploy                         # sync-deploy + wrangler pages deploy
  npm run smoke                          # 线上冒烟

回滚：
  · 把出问题的 commit revert 后再走一遍 snapshot + deploy
  · 或在 Cloudflare Pages 里回滚到上一个部署（需账号权限，操作完要重启快照版本核对）
```

---

## 九、常见事故对照表（都是踩过的）

| 事故现象 | 真因 | 正确做法 |
|---|---|---|
| 发布了，前台看不到 | 只 deploy 没重建快照 | 改可见性后必须 rebuildSnapshot |
| 批量导入报 400 非 multipart | admin `api()` 漏传 body | raw:true 要把 body 原样给 fetch |
| 桌宠包入库后分类错 | kind 未派生 | DTO 用 pet ? 'pet' : row.kind |
| 上传被 422「桌宠包不合法」 | 缺 pet.json 或 manifest 不合法 | 先 `parsePetPackage` 自检再传 |
| 前台与 v1 接口响应不一致 | 两条路径各写一套 | 复用同一 DTO，smoke 会逐字节比对 |
| 另一台机器 push 覆盖了别人的提交 | 没 rebase、直接强推 | 先 `pull --rebase`，禁止 force push |
