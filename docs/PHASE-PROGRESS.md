# 阶段进度看板

> 更新：2026-11-06。每完成一个阶段勾选并 push，不要攒到最后。

## 总览

| 阶段 | 内容 | 状态 | commit |
|---|---|---|---|
| 阶段一 | 分片上传（≤2GB，multipart + 断点续传 + 清理工具） | ✅ 已完成并线上验收 | `4668895b` / `91b0bfc3` / `e2c8fa6d` |
| 阶段二 | 60fps/超限原片先入库后转码（needs_variant + make-variants） | ✅ 已完成并线上验收 | `8fdb3319` / `ee50739a` / `b35b1f1b` / `fd25009` |
| 阶段三 | 公开读静态化（snapshot.js + current.json + parity） | ⬜ 未开始 | — |
| 阶段四 | 后台分页 + 短缓存 + TTL 文档 | ⬜ 未开始 | — |
| 阶段六 | 运维三件套（inspect-assets / d1-usage / export-d1） | ⬜ 未开始 | — |
| 阶段五 | 管理端效率（批量上传 / 重试 / 去重 / 批量改标签） | ⬜ 未开始 | — |

## 阶段三调研结论（只读，未改代码）

`src/server/public-api.js` 已有一套 **snapshot 命名**的实现，需要先分清它和阶段三的关系：

```
snapshotFallbackEnabled(env)     判断是否启用
parseSnapshotFilters(url)        把 URL 参数解析成内存筛选条件
snapshotItemMatches(item, filters)  内存过滤
snapshotCompare / snapshotAfterCursor  排序与游标
snapshotFacets(items)            内存 facets
snapshotWallpapersPayload({url}) 用快照体拼响应
snapshotCategoriesPayload / snapshotTagsPayload / snapshotSubtagsPayload
snapshotWallpaperPayload({params})  详情
```

结论：这套是**旧的 degraded 兜底**（数据源 = `src/server/public-snapshot.js` 那份 181KB 内嵌 JSON），
**不是**阶段三要的动态快照（R2 `snapshots/<version>/…` + `current.json`）。
阶段三要做的仍然是：把「快照优先」接到 R2 动态快照上，兜底链变成
`R2 快照 → D1 → 旧内嵌快照`，并补齐 16 块 parity 对拍。

> 未完成的前置调研：把 15 个筛选参数逐条映射到 `queries.js` 的 SQL 条件
> （public-api.js 里已有内存实现可作参照，但需核对是否与 SQL 完全等价）。

## 缺失文档

派单里提到的 `docs/SITE-CHARTER.md` 与 `docs/PHASE-PROGRESS.md` 在仓库中**不存在**
（本文件即为新建的进度看板）。`docs/PHASE4-6-HANDOFF.md` 存在（3991 字节）。

## 下一步（按派单顺序）

1. 阶段三：对照表 → snapshot.js → public-api 读取层 → current.json → 触发点 → 工具 → 9+16 测试 → 线上 ①–⑦
2. 阶段四、阶段六、阶段五依次进行，每阶段独立验收后再进下一阶段

## 中断说明（2026-11-06）

阶段三在「只读调研」完成后中断：本会话已先后完成阶段一/二并做多轮真机验收，
剩余上下文不足以安全重写 `public-api.js` 的公开读筛选（15 参数需与 SQL 逐条对拍）。
为避免公开列表半改的风险，按规则 5 收尾：只提交调研结论与本看板，不改运行代码。

## 已知风险

- `public-api.js` 已有 snapshot 兜底路径，接入动态快照时要避免两套筛选逻辑漂移
- `public-snapshot.js` 是单行大 JSON，禁止 grep/less 直接打印（会刷屏）
- 另一台机器仍在向 main 提交（本轮同步时远端已到 `e9276d84`），开工前必须 pull
