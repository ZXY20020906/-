# 阶段四 / 五 / 六 交接（那台机器按序做）

> 前提：阶段三（公开读静态化）已完成并线上验收通过。
> 顺序：四（TTL/缓存）→ 六（运维）→ 五（管理端效率）。
> 每阶段单独 commit + push + 部署后验证；一阶段不通不进下一阶段。

---

# 阶段四：TTL / 缓存治理（半天）

## 目标
后台列表与公开读都不再"每次刷新打数据库"。

## 做
1) **后台列表分页 + 短缓存**
   - `src/server/routes/wallpapers.js`（admin 列表）：默认 `limit=20`，`page` 参数；返回 `{items,total,page,limit}`
   - 列表读加 60s 内存缓存（按 query 的规范化 key），写操作（上传/编辑/发布/删除）后清除该缓存
2) **公开读缓存头复核**
   - `current.json`：300s
   - `snapshots/**`：immutable 1 年
   - `/api/v1/public/*`：300s（快照缺失直读 D1 时用 `no-store` + `degraded`）
3) **文档**
   - `docs/OPS.md` 增加「端点 TTL 表」与「如何立即失效（重建快照 / 清 admin 缓存）」

## 验收
```
· 后台连点 10 次「刷新」⇒ D1 行读增量 ≤ 20（tools/d1-usage.mjs 观察）
· 公开清单连点 10 次 ⇒ D1 行读增量 ≈ 0
· 上传后后台列表立即可见（写操作清缓存生效）
· npm test 全绿 + check-sql 0 失败 + smoke 通过
```

---

# 阶段六：运维三件套（1 天）

## 做
1) `tools/inspect-assets.mjs`
   - 检查：DB 记录对应对象是否存在（HEAD）、bytes 是否一致、sha 是否一致（抽样可 `--sample N`）
   - 检查：`_tmp/` 孤儿、无 DB 记录的 R2 对象（按前缀统计）
   - 检查：`needs_variant=1` 堆积数量、draft 超过 7 天的条目
   - 输出：表格 + `--json`，退出码 1 表示有异常
2) `tools/d1-usage.mjs`
   - 读 Cloudflare Analytics（需要 CF token，权限 Account Analytics: Read）
   - 输出：今日行读/行写/存储；使用率 >80% 打印警告并以退出码 2 表示
3) `tools/export-d1.mjs`
   - 导出 `wallpapers`（含 variants JSON 列）、`categories`、`tag_aliases`、`api_keys`（不含明文）、`licenses`、`orders`
   - 输出到 `backups/d1-YYYYMMDD-HHmm.json`（gitignore）
4) `docs/OPS.md`
   - 部署流程、回滚（git revert + 重新部署快照）、额度监控、故障处理（快照缺失/D1 不可用/上传失败）
5) 可选：`.github/workflows/daily-inspect.yml` 每天跑 inspect + usage（需 secrets）

## 验收
```
· 四个脚本本地都能跑通并输出可读报告
· 故意造一条"DB 有记录但对象缺失"⇒ inspect 报告出来且退出码 1
· d1-usage 能显示当天行读（<80% 时退出码 0）
· export-d1 产物能被 JSON.parse 且条目数与面板一致
```

---

# 阶段五：管理端效率（1 天）

## 做
1) **多选拖拽上传**：一次拖 N 个文件，串行 2 并发，复用阶段一分片接口；显示总进度 + 每文件状态
2) **失败重试**：失败项可「重试全部 / 重试单个」；失败原因可见（413/422/网络）
3) **重复检测**：上传前算 sha256（>40MB 用采样指纹），命中已有条目 ⇒ 提示"复用"并跳过上传
4) **批量操作**：多选后改分类/标签、发布、下架、软删
5) **列表信息**：待转码徽标 + reason、原片 fps/分辨率/大小、已有变体档位

## 验收
```
· 一次拖 10 个文件全部成功（或明确失败原因）
· 重复文件提示复用，不重复写 R2（对象数不增加）
· 批量改 5 条标签生效，且公开接口跟随（重建快照后）
· 待转码徽标与 `--all-draft` 数量一致
```

---

## 通用约束（三阶段都适用）
```
· 不改 wrangler.toml 绑定名；不删 R2 旧对象；不 force push；不提交 token
· 不绕过 ingestAsset 写 R2/D1；draft 不得出现在公开接口
· 每阶段：npm test 全绿 + check-sql 0 失败 + smoke 通过 + 部署后复跑 smoke
· 汇报：改动文件 / 新增脚本与命令 / 测试数字 / 验收证据 / commit
```
