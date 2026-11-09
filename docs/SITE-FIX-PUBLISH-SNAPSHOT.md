# 站点侧三个必修问题（并行于插件测试）

> 背景：管理员在后台「发布 + 审核通过」后，前台/公开接口 5 分钟仍看不到新条目；
> 桌宠包入库后 `kind` 列仍是 `static`；前台桌宠分类是否渲染需验证。
> 铁律：不改现有公开字段、不加数据库列（除非确有必要并说明）、不发 npm、每项独立 commit + push。

---

## 问题 1（高优先）：发布/审核通过后，公开快照没有重建

### 现象
```
22:20 上传 whale-girl-refined.zip（zip，2.2MB）
22:2x 后台点「发布」→「审核通过」
D1 状态：status=published / review_status=approved / verified_at 有值 / storage_key 有值
公开接口：total 仍 113、desktop-pet 0（旧快照 20261109T142328Z，早于审核）
手动跑 tools/build-snapshot.mjs → items 115，等 5 分钟后 current.json 才切换
```

### 要做
```
1) 审计**所有会改变公开可见性的写路径**，每一条都必须触发快照重建
   （或至少标脏 + 由定时/异步任务重建）：
     · PATCH 单条：status / reviewStatus / verified / categoryId / kind
     · 批量修改（bulk patch）
     · 删除作品 / 删除变体 / 上传变体并发布
     · 分类 is_public 变更
     · 已有 rebuildSnapshotQuietly 的调用点要确认**真的被走到**（不是被 if/权限提前 return）
2) rebuildSnapshotQuietly 失败必须**可见**：
   · 记录一条 log（含原因），并在管理端状态接口里暴露"最近一次重建时间/结果"
   · 禁止静默吞错导致"数据已发布、前台永远旧"
3) 加测试：
   · 发布一条 draft → 断言快照 version 变化、公开列表 total +1
   · 审核通过 → 同上
   · 把分类设为隐藏 → 断言 total 减少
   · 删除 → 断言 total 减少
4) 线上复验：用一条草稿走完整流程，记录"点发布→公开列表可见"的耗时（目标 <60s，
   current.json 的 CDN 缓存最多 5 分钟，属于预期，但不应依赖人工跑脚本）
```

---

## 问题 2（中优先）：桌宠包入库后 `kind` 列仍是 `static`

### 现象
```
导入表单「放到哪个模块」选的是「壁纸」⇒ kind=static
但文件是 zip，服务端解析出 pet variant（pet.id=whale-girl-refined）
⇒ 列里 kind=static、mime=application/zip（自相矛盾）
公开 DTO 靠 variant 判成 kind='pet'（暂时正确），但任何按 kind 列过滤的地方都会漏
```

### 要做
```
1) 导入流程检测到 pet 包（variants 里有 kind='pet'）时**强制 kind='pet'**，
   忽略表单里的 static/dynamic 选择（并在报告里说明"已按桌宠包归档"）
2) kindMatchesMime 增加 pet 分支（pet 只接受 application/zip）
3) 迁移已有数据：把"mime=application/zip 且 variants 含 pet"但 kind≠pet 的行改成 kind='pet'
   （写一个可重复执行的 tools/fix-pet-kind.mjs，dry-run + 真写两档）
4) 加测试：导入 pet zip（kind 传 static）⇒ 入库后 kind='pet'
```

---

## 问题 3（中优先）：前台桌宠分类是否渲染 pet 条目

### 要做
```
1) 前台 gallery 的 mediaKind()：application/zip + pet variant ⇒ 归到"桌宠/资源包"展示，
   卡片显示 previewUrl（gif/webp），点开给 zip 下载
2) 前台分类页签：desktop-pet 出现在导航里，点进去能列出 pet 条目（不能是空白）
3) 验证：线上 desktop-pet 现在有 1 条（whale-girl-refined）
   · 页面 Ctrl+F5 后应能看到「鲸鱼娘（精致版）」卡片 + 动图
   · 点下载能拿到 zip，sha256 == 1b12ecf276042dedf74998f228da809a460dbc530bf716d3326b57bd8c8c68dc
4) 若前台走静态模式（/data/catalog.json），确认 build-static 也包含 pet 条目
```

---

## 验收（逐条贴证据）

```
1) 发布到公开可见耗时：__ 秒（截图/log 时间戳）
2) 快照重建失败可见：人为让 build 失败一次，管理端/日志能否看到原因
3) pet 导入：kind 列为 pet（贴 SQL 结果）
4) 前台：desktop-pet 页签可见 + 卡片带预览 + 下载 sha 一致
5) 回归：wallpaper 分类条数不变（贴前后数字）
6) 测试：npm test 全绿（当前基线 413）+ check-sql 0 失败
```

## 汇报模板

```
问题 N：commit=<hash> 改动=<文件> 测试=<X pass/0 fail> 线上证据=<…>
```
