# 交接提示词（直接粘贴给另一台机器上的 DSH）

> 用途：把那台机器的 DSH 当协作者，让它按清单改站点。
> 先 `git pull --rebase`，再让 DSH 读 `docs/TASKS-MATERIAL-SITE.md`，然后粘贴下面的提示词。

---

你是这台机器上的开发代理，负责修改「Folia 素材库」站点代码。请严格遵守以下内容。

## 项目背景
- 站点 `https://folia-5ve.pages.dev` 是我们**私有素材库**：只给自研插件 `dsh-folia` 和未来自研助手提供素材。
- **不对外**：不做素材市场、不做对外售卖、不做第三方开发者接入。
- 技术栈：Cloudflare Pages + Functions、D1（`64761fc2-cd88-46f4-b08f-c2b08d5b667f`）、R2（桶名 `Folia-壁纸`）。
- 仓库：`folia-admin`（GitHub `ZXY20020906/-`），部署方式：push 到 main → Pages 自动构建部署。

## 开工第一步
```
git pull --rebase origin main
已读 docs/TASKS-MATERIAL-SITE.md（含第 11 节"私有素材库"定位）
```

## 任务顺序（一次只做一阶段，做完就提交并 push）
1. **阶段一：分片上传（P0）** — 浏览器 → Worker → R2 multipart，单文件 ≤2GB，8MB/片，断点续传，进度显示
2. **阶段二：60fps 原片入库 + 本机转码（P0）** — 允许 fps>30 入库为 draft（needsVariant），`tools/make-variants.mjs` 在本机用 ffmpeg 生成 30fps 变体并发布
3. **阶段三：公开读静态化（P0）** — 快照 + `current.json` 版本指针，公开读不再消耗 D1
4. **阶段四：TTL/缓存治理（P1）** — 清单 30 分钟、条件请求不回源、后台分页
5. **阶段五：管理端效率（P1）** — 批量上传、失败重试、重复检测（sha 相同复用）、批量改分类/标签、批量发布
6. **阶段六：巡检/备份/监控（P1）** — 每日巡检脚本、D1 导出备份、用量监控

（第 11 节里标 P2 的项：license/author 填写、相似推荐、对外 API 文档、多租户 key 分级 —— 不要花时间）

## 硬性技术约束
```
1) 上传用 R2 **绑定** multipart（env.R2.createMultipartUpload/uploadPart/complete/abort）
   绝对不要用 S3 预签名（国内网络连不上 r2.cloudflarestorage.com，实测 TLS 握手失败）
2) 入库必须复用 src/server/ingest.js 的 ingestAsset，不要另写一套写 R2/D1 的逻辑
3) Worker 里不能有 ffmpeg（内存/CPU 不允许）；视频参数用现有纯 JS MP4 box 解析
4) 不改 wrangler.toml 的绑定名；不删 R2 旧对象（迁移用复制+切换）
5) 不 force push；不在代码/日志/commit 里出现 token
6) 不要动 npm 上的插件包（本仓库只改站点）
```

## 每阶段完成标准（缺一不算完成）
```
1) 本地测试全绿：node tools/... 现有基线 316 pass / 0 fail；check-sql 0 失败
2) 新增测试覆盖该阶段（正常路径 + 边界 + 负对照）
3) node tools/smoke-public-api.mjs 通过
4) commit 信息格式：feat(upload): 分片上传（≤2GB）等
5) git push origin main → 等 Pages 部署 1–2 分钟 → 再跑一次 smoke 并贴结果
6) 汇报：改动文件清单、新增接口、测试数字、线上验证证据（状态码/大小/耗时）
```

## 验收要点（按阶段）
- 阶段一：传 120MB 合成视频（`ffmpeg -f lavfi -i testsrc=size=1920x1080:rate=30 -t 20 -c:v libx264`）成功入库；公开接口可见；媒体 200；中断后重选同文件能续传
- 阶段二：传 4K@60（≤2GB）→ 显示待转码（draft）→ 跑 `node tools/make-variants.mjs --all-draft` → 自动 published → 插件能播 30fps 版
- 阶段三：6 个公开端点仍 200 + 110 条 + facets 合计==total + manifest 304；D1 行读增量≈0

## 两台机器协作规则
```
1) 每次开工前 git pull --rebase；每次交完立即 push
2) 不要和另一台机器同时改同一文件（按阶段分工，阶段之间基本不重叠）
3) 发现冲突：先 git pull --rebase，手工解决后再继续，不要 force push
```

## 汇报格式（每次给我）
```
阶段：X
改动：文件列表 + 关键函数
接口：新增/变更的路径与方法
测试：X pass / Y fail（新增 N 条）
线上：端点状态码 / 上传大小与耗时 / 是否出现 degraded
commit：<hash>
遗留问题：（没有就写无）
```
