# 开机动画模块

站点上的「开机动画」是一个独立模块：**存视频、按时长循环、能下载原片**。它和壁纸共用一套存储与权限，但展示逻辑不同。

素材既可以来自 DSH 的开机动画插件，也可以自己录屏或渲染——站点只负责存放和分发。

## 它和别的分类有什么不一样

| | 壁纸 | 开机动画 |
|---|---|---|
| 主要格式 | png / jpg / webp / avif | mp4 / webm |
| 长宽比 | 16:10 横版为主 | 9:16 竖版为主 |
| 关键信息 | 分辨率 | **循环时长** |
| 主要动作 | 用作壁纸（复制直链） | 下载到设备 |

所以在这个分类下，前台会切成竖屏网格（`9 / 16`），卡片徽标显示时长而不是「动态」，详情里的主按钮变成「下载视频」。

## 数据是怎么表示的

不新增表，也不新增 `kind`——开机动画就是 `kind = 'dynamic'` 的内容，挂在 `boot-animation` 分类下：

```
categories: slug = 'boot-animation', sort_order = 30   ← 排在「皮肤包」后面
wallpapers: kind = 'dynamic', duration_ms = 6000, mime = 'video/mp4'
```

`duration_ms` 是 004 迁移加上的字段。为什么不用新的 `kind`：`wallpapers.kind` 上有 `CHECK (kind IN ('static','dynamic'))`，SQLite/D1 改 CHECK 要重建整张表，代价远大于收益；而「是不是视频」本来就该由 `mime` 判断，`kind` 只表达"动不动"。

## 时长从哪来

上传时从 MP4 的 `moov/mvhd` 里读（`src/core/image-meta.js` 的 `readDurationMs`），不依赖 ffmpeg、不额外占内存：

```
mvhd（type 之后）：version+flags(4) → 时间戳(4 或 8) → timescale(4) → duration(4 或 8)
时长(ms) = duration / timescale × 1000
```

读不出来的情况会诚实地留空，前端显示「—」：

- **WebM**：需要解析 EBML 的 `Info/Duration`，没做；
- **分片 MP4（fMP4）**：`mvhd` 的 duration 就是 0，这是规范允许的；
- 时长超过 24 小时：判定为读到了假的 `mvhd`，直接放弃。

如果你以后想让 WebM 也有时长，在 `readDurationMs` 里加一个 EBML 分支即可，接口不变。

## 上传

后台 →「壁纸」→ 新增壁纸：

1. 类型选 **动态（视频 / 开机动画包）**
2. 分类选 **开机动画**
3. 拖入 mp4 / webm

限制：视频 ≤ 60MB，超了会 413。上传后列表会显示 `1080×1920 · 6.0s`，确认时长读对了再发布。

批量导入同一批片子（标题用文件名）：

```bash
FOLIA_URL=https://folia-5ve.pages.dev \
FOLIA_EMAIL=admin@example.com \
FOLIA_PASSWORD='******' \
node tools/import-wallpapers.mjs ./boot-clips --category boot-animation --publish
```

## 下载是怎么实现的

浏览器默认会把 mp4 直接播放，而不是存盘。所以 `/media/<key>` 支持一个参数：

```http
GET /media/wallpapers/wp_x/abc.mp4?download=DeepSeek%E5%BC%80%E6%9C%BA.mp4
→ Content-Disposition: attachment; filename="DeepSeek__.mp4"; filename*=UTF-8''DeepSeek%E5%BC%80%E6%9C%BA.mp4
```

前台「下载视频」按钮自动带上当前标题作为文件名。

如果配了 R2 自定义域名（`MEDIA_BASE`），直链不经过 Worker，带不了这个响应头。前端的处理是：**把自定义域名的路径还原成站内 `/media/...` 再下载**，所以下载功能不受影响；只有路径里认不出 `/wallpapers/` 时才退回原地址。

## 分享

`?cat=` 是深链，直接把某个模块发给别人：

```
https://folia-5ve.pages.dev/?cat=boot-animation
```

轮换列表仍然走 `#r=`，两者可以同时存在：

```
/?cat=boot-animation#r=deepseek-blue,deepseek-dark
```

## 设备侧怎么用

说实话的部分：**不是所有设备都吃 mp4**。

- 原生 Android 的开机动画是 `bootanimation.zip`（`desc.txt` + 帧序列），不认 mp4；
- 部分厂商固件（以及不少定制 ROM）支持 mp4 开机动画，路径和命名各不相同；
- 替换系统开机动画通常需要 root 或解锁 Bootloader。

所以这个模块只负责「把片子给你」，怎么刷进去要看设备。如果以后要支持 `bootanimation.zip`，上传链路已经允许 zip（`kind = 'dynamic'` 下），只是详情页会显示「开机动画包，无法预览」。

## 已知限制

- **列表页加载原片**：一段 1080×1920、6 秒的 mp4 往往 2–6MB，一屏 24 段就是几十 MB。竖屏网格里视频用 `preload="metadata"` 只拉首帧，但流量仍然不小。真上线前建议加封面图（单独存一张首帧，列表用它）。
- **时长只有 MP4 有**：WebM 留空。
- **没有多尺寸变体**：和壁纸模块一样，等问题真出现了再做（见 `docs/r2.md` 的技巧）。
