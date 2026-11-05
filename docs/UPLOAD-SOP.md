# 上传操作规程（UPLOAD SOP）

给「以后要往 R2 + D1 里放资源的人」用：壁纸图片、动态视频、皮肤包 zip、开机动画、1080p 变体。

原理、桶结构、事故复盘在 [`docs/r2.md`](r2.md)，**这里不重复原理**，只有：可执行步骤 + 验收命令 + 禁止项。
2026-11-04 那次「同址双版本」（145 个 URL 里 3 条皮肤包坏掉）就是跳过第 5 步、违反第 4 节造成的。

## 0. 上传前必做：视频先跑本地转码

**从 2026-11 起，视频上传会在服务端过「播放合规体检」，不合规直接 422 拒绝入库。**
Cloudflare Workers / Pages Functions 里**没有 ffmpeg**，服务端只能拒、不能转——
所以动手传之前，先在本机把文件转成合规规格：

```powershell
node tools/prepare-upload.mjs <源文件或目录> --out .\prepared
# 可选：--fps 30（默认） --max-pixels 8294400（默认 = 3840×2160） --dry-run（只体检不转码）
```

它干这些事：

1. 用 ffprobe 探测宽高 / 帧率 / 编码 / 时长，并自己按 box 头判断 faststart（ffprobe 不报这个）；
   **机器上没有 ffprobe 时自动退回解析 `ffmpeg -i` 的 stderr**，不用额外装。
2. 超规格 ⇒ 转码：等比缩进 3840×2160 框、`fps=30`、`libx264 -crf 20 -preset veryfast`、
   `-pix_fmt yuv420p`、`-movflags +faststart`、`-an`（壁纸不需要音轨）。
3. 只差 faststart ⇒ `-c copy -movflags +faststart` 无损重封装，**不重新编码、不损画质**。
4. 生成 1080p 变体（`-crf 23`，装进 1920×1080 框；源不高于 1080p 时跳过）。
5. 生成 1280 宽 webp 封面（优先第 1 秒，片子太短退回首帧）。
6. 写 `prepared/prepare-upload.manifest.json`：原始规格、处理后规格、每个产物的 `sha256` 与 `bytes`。

跑完最后一行是 `可以直接上传：N 个文件；不合规项已修正`，然后按下面的**第 2 步**拿清单里的
`sha256` 算 key。判合规用的是**站点同一个函数**（`src/server/media-compliance.js`），
所以「本地通过 = 服务端一定收」，不会出现工具放行、上传 422。

### 目标规格（工具与服务端共用一份）

| 项 | 原画 | 1080p 变体 |
|---|---|---|
| 宽 | ≤ 3840 px | ≤ 1920 px |
| 高 | ≤ 2160 px | —（生成时按框锁定，通常 1080） |
| 像素总量 | ≤ 8,294,400（= 3840×2160） | 同左 |
| 帧率 | ≤ 30 fps | ≤ 30 fps |
| 编码 | H.264（`avc1`） | H.264（`avc1`） |
| 封装 | MP4 + faststart（moov 前置） | 同上（更严：不接受「无法确认」） |
| 体积 | ≤ 25 MB（超了只 warn，不拒） | ≤ 8 MB（超了只 warn，不拒） |

### 违规码对照表（`422 media_non_compliant` → `details.violations[].code`）

| 码 | 含义 | 后果 | 怎么修 |
|---|---|---|---|
| `too-wide` | 宽 > 3840（变体 > 1920） | 拒绝入库 | 工具转码自动缩 |
| `too-tall` | 高 > 2160 | 拒绝入库 | 工具转码自动缩 |
| `too-many-pixels` | 宽×高 > 8,294,400 | 拒绝入库 | 工具转码自动缩 |
| `fps-too-high` | 帧率 > 30（含 0.5 容差） | 拒绝入库 | 工具 `fps=30` 重编码 |
| `codec-unsupported` | 不是 H.264（如 HEVC） | 拒绝入库 | 工具 `libx264` 重编码 |
| `not-faststart` | moov 在文件尾 / 无法确认 | **自动转封装**（4.23.18 起）；转封装失败（结构不认识 / 偏移溢出）才拒绝入库 | 一般不用管；仍被拒就用工具 `-c copy -movflags +faststart` |
| `probe-failed` | 宽高或编码探测不出来 | 拒绝入库 | 源文件可能损坏，重导出 |

只有警告的情况**照常入库**，但会在 `audit_log` 留一条 `action = wallpaper.asset_compliance_warn`：

| 警告码 | 含义 |
|---|---|
| `original-too-large` | 原画 > 25 MB（不拒绝，弱网用户会等很久） |
| `variant-too-large` | 1080p 变体 > 8 MB |
| `container-webm` | WebM 容器：能直接播，但不在 1080p 变体管线里 |
| `fps-unknown` | 探测不到帧率（没有 stts / DefaultDuration），可能漏放 >30fps |
| `codec-unknown` | WebM 的 CodecID 不在文件头，无法确认编码 |

> 为什么 `fps-too-high` 是**拒绝**而不是警告：60fps 浏览器能播，但它顶穿站点的
> 解码/体积预算（1080p 变体 ≤8MB 基本不可能），而本地工具一条 `fps=30` 就能修好。
> 硬拒才能保证「先跑工具」是唯一路径。

## 1. 三条铁律

1. **键名由最终入库内容的 sha256 前 16 位生成**：`wallpapers/<wp_id>/<sha16>.<ext>`；
   1080p 变体再加一段后缀，位置在扩展名之前：`wallpapers/<wp_id>/<sha16>.1080p.mp4`。
2. **内容一变必须换新键；禁止覆盖已存在的 key。**
   `/media/<key>` 带 `cache-control: public, max-age=31536000, immutable`，
   同名覆盖 ⇒ 边缘缓存（旧字节）与源站（新字节）长期并存 ⇒ 多连接 / Range 下载把两版拼成坏包。
3. **D1 的 `bytes` 与 `sha256` 必须来自同一份已校验的文件，成对更新。**
   禁止「按 HEAD 长度改 `bytes`、`sha256` 留旧值」——那是把真实故障伪装成「记录不准」，比不修更糟。

> 位数口径：**已统一 16 位**——`src/server/storage.js` 的 `assetKey()` / `thumbKey()` 是
> `slice(0, 16)`（常量 `HASH_PREFIX_LEN`），本文件按 16 位写。历史 12 位对象**保留不动**，
> 不做批量改名、也不指回旧键；`docs/r2.md` 里那三条被污染的历史 key 是 12 位，属于既成事实。

## 2. 标准流程（七步）

### 第 1 步 准备文件

- **视频**：先跑第 0 节的 `tools/prepare-upload.mjs`——合规规格是 H.264 + `-movflags +faststart`
  （moov 在文件头才能边下边播，`readVideoInfo` 会把 codec/faststart/帧率记进库），
  宽 ≤3840、高 ≤2160、像素 ≤8,294,400、帧率 ≤30，开机动画通常还有竖屏 1080×1920 与 ≤60MB 的上限。
  手工转码（不推荐，容易漏掉 faststart 或缩放）：
  ```bash
  ffmpeg -i in.mov -c:v libx264 -profile:v high -pix_fmt yuv420p -c:a aac -movflags +faststart out.mp4
  ```
- **皮肤包 zip**：用 `node tools/pack-we-project.mjs <作品目录> <输出.zip>` 打包——它把作品目录里的
  `project.json` / `scene.pkg` / 图片**平铺**到 zip 根，并附一份 `README.txt`。
  别用系统右键「压缩到 zip」：会多套一层目录名，用户解压后 Wallpaper Engine 找不到工程。
- **先定稿，再算哈希**。算完 sha256 之后又动了文件（重新导出、重新打包、改了一个文件）就必须回到第 2 步重来。

### 第 2 步 算 sha256 + bytes

```powershell
$file = ".\out\demo.mp4"
$sha  = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()
$size = (Get-Item -LiteralPath $file).Length
"$sha  $size"
```

这两个值就是后面 D1 要写的数，**不要再算第二遍**（第二遍的文件可能已经不是同一份）。

> 注意：>40MB 的文件走后台上传时不算完整 sha256（Worker 的 CPU 预算装不下这个 digest，
> 改用首尾 1MB 采样指纹做 key，并打一条 `upload: sha256 skipped (>40MB)` 的 warn），
> 此时 D1 的 `sha256` 为 `NULL`。这类记录第 3 节第 3 条不适用，只能靠手算的 `$sha` 自己比对。

### 第 3 步 生成 key

```powershell
$wpId = "wp_3f9a1c27ab9e4d05b8c6"      # D1 wallpapers.id
$ext  = "mp4"                            # 按真实类型定，不看扩展名
$key  = "wallpapers/$wpId/$($sha.Substring(0,16)).$ext"

# 1080p 变体：同一规则，后缀插在扩展名前
# $key = "wallpapers/$wpId/$($sha.Substring(0,16)).1080p.mp4"

$key
```

生成后先确认这个 key 在 R2 里**不存在**（HEAD 404）。存在就说明你在踩铁律 2，停下来核对。

### 第 4 步 PUT 到 R2

对象必须同时带两样东西：真实的 `Content-Type`、以及 `Cache-Control: public, max-age=31536000, immutable`。

推荐走管理后台上传（见第 7 节），它已经把这些写死了。手工 PUT 只用于迁移/修复历史对象，
且必须自己补元数据：`wrangler r2 object put` 用 `--content-type` / `--cache-control` 写对象元数据
（参数名以 `npx wrangler r2 object put --help` 为准），走 S3 API 就是同名的 HTTP 头。

### 第 5 步 HEAD 回读校验长度

```powershell
$origin = "https://folia-5ve.pages.dev"     # 或 MEDIA_BASE 指向的自定义域名
$url    = "$origin/media/$key"

$headLen = [int64](Invoke-WebRequest -Method Head -Uri $url -UseBasicParsing).Headers['Content-Length']
$headLen
$headLen -eq $size                          # 必须 True
```

不等于 ⇒ **停，不要写库**：要么对象没落盘（404 / 0），要么被截断。换个新 key 重传。
（"R2 put 返回成功" 不等于 "对象真的落盘、大小一致"，这正是后台上传里 `verifyAsset` 存在的理由。）

### 第 6 步 通过后才写 D1

`storage_key`、`bytes`、`sha256` 三个值在**同一条 UPDATE 里**写，且都来自第 2 步的同一份文件。

```sql
UPDATE wallpapers SET storage_key = ?, bytes = ?, sha256 = ?, updated_at = ? WHERE id = ?;
```

变体写到 `variants` 列（见第 5 节）。写库前任何一步失败，都不许先写库再补校验。

### 第 7 步 上传后验收

跑第 3 节的四条命令，全部通过才算上传完成。**没跑就宣布完成 = 违反第 6 节第 5 条。**

## 3. 上传后验收（四条，逐条跑）

```powershell
# 先填这三个：来自第 2 步的记录
$key         = "wallpapers/wp_3f9a1c27ab9e4d05b8c6/9f3c1a2b3c4d5e6f.mp4"
$expectBytes = 17509106
$expectSha   = "9f3c1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f"
$slug        = "demo-slug"
$origin      = "https://folia-5ve.pages.dev"
$url         = "$origin/media/$key"
```

**① HEAD 的 content-length == D1.bytes**

```powershell
$headLen = [int64](Invoke-WebRequest -Method Head -Uri $url -UseBasicParsing).Headers['Content-Length']
"HEAD=$headLen  D1=$expectBytes  " + ($headLen -eq $expectBytes)
```

**② `Range: bytes=0-0` 的 Content-Range 总量 == HEAD 长度（专抓「同址双版本」）**

```powershell
$r = Invoke-WebRequest -Uri $url -Headers @{ Range = 'bytes=0-0' } -UseBasicParsing
$r.StatusCode                                  # 期望 206
$rangeTotal = [int64]($r.Headers['Content-Range'] -split '/')[-1]
"RANGE=$rangeTotal  HEAD=$headLen  " + ($rangeTotal -eq $headLen)
```

- `HEAD`（不带 Range）可能命中**边缘缓存**，反映"被缓存那一刻"的版本；
- `GET + Range: bytes=0-0` **一定回源 R2**，反映源站当前版本。

**③ 全量下载后 sha256 == D1.sha256**

```powershell
$tmp = Join-Path $env:TEMP ("verify-" + [guid]::NewGuid().ToString('N') + ".bin")
$bust = "?nocache=" + [guid]::NewGuid().ToString('N')   # 绕开边缘缓存，强制回源
Invoke-WebRequest -Uri "$url$bust" -OutFile $tmp -UseBasicParsing
$got = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLower()
Remove-Item -LiteralPath $tmp -Force
"GOT=$got" ; "EXP=$expectSha" ; ($got -eq $expectSha)
```

> 若该记录 `sha256` 为 `NULL`（>40MB 文件，服务端不算完整 sha256，只在日志里留
> `upload: sha256 skipped (>40MB), integrity verification unavailable`），第③条不适用：
> 必须用 ①+② 双长度检查兜底，并在后台记录里标注「无 sha256，仅长度校验」。

**④ API（加 `_ts` 绕缓存）已返回新 url 与新 bytes**

```powershell
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$w  = (Invoke-RestMethod "$origin/api/public/wallpapers/$slug`?_ts=$ts").data.wallpaper
$w.url                         # 必须是新 key 的 URL，不能还是旧 key
$w.bytes -eq $expectBytes      # 必须 True
$w.sha256 -eq $expectSha       # 大文件（sha256 为 NULL）跳过这条
```

### 判读

| 现象 | 含义 | 处理 |
|---|---|---|
| ① 不等 | 对象没落盘或被截断 | 不写库，换新 key 重传 |
| ② 总量 ≠ ① 长度 | **同址双版本** | **立刻停用该 URL**（下线/置草稿），换新 key 重传，按第 8 节四步处理 |
| ② 返回 200 而非 206 | Range 被忽略（可能打到了别的层） | 换回源域名/加 `nocache` 重跑，别当通过 |
| ③ sha256 不等 | 库里的记录不是这份文件 | 停用；**不要**拿下载到的 sha256 去改库迁就 |
| ④ url / bytes 没变 | API 缓存或库没写 | 加 `_ts` 重试；仍旧相同 → 查 D1 那一条 |

## 4. 皮肤包「重新打包」的特别提醒（本次事故即由此产生）

改了包内容——**哪怕只增删一个文件**（事故里就是删掉了 `dsh-market.provenance.json`）——沿用旧 key 重传：

1. 边缘已经把旧版按 `immutable` 缓存成"一年不变"；
2. 源站被 PUT 成新版；
3. 同一个 URL 上两个版本并存，多连接 / Range 下载把两版拼成坏包。

规矩：

- 重新打包 = 新内容 = 新 sha256 = **新 key**。先打定稿、再算哈希、再传。
- **不要**在旧 key 上"补传一版"；旧 key 保留不删（取证 / 回滚用，见第 8 节）。
- 包内"多一个少一个文件"都算新内容；打完后先本地解压抽查（`Expand-Archive`），
  确认 zip 根就是作品根目录、没有多套一层，再去算哈希。

## 5. 变体（1080p / 同分辨率 30fps）

变体分两档，按**源**的规格二选一（判据见第 5.1 节）：

| 档 | 触发条件 | 画面 | key 后缀 | `label` |
|---|---|---|---|---|
| **1080p** | 宽 >3840 或 高 >2160 或 像素 >8,294,400 | 装进 1920×1080 框，`fps=30` | `.1080p.mp4` | `1080p` |
| **30fps**（同分辨率降帧） | 分辨率在限内、只有 `fps>30`（如 4K@60） | **分辨率不变**，`fps=30` | `.30fps.mp4` | `4K30`（4K 及以上的 30fps 档；其它写 `30fps`） |

- 独立对象、独立 key、**独立 sha256 与独立 bytes**；不要复用原片的 sha256。
- key 形如 `wallpapers/<wp_id>/<sha16>.1080p.mp4` / `wallpapers/<wp_id>/<sha16>.30fps.mp4`，同样遵守三条铁律。
- 用 `tools/prepare-upload.mjs` 生成时，变体一并产出（`<name>.1080p.mp4`），
  缩放装进 **1920×1080 框**、`fps=30`、`-crf 23`、`+faststart`，清单里带 sha256。
  为什么不写 `scale=-2:1080`：对 2000×1124 这类源它会产出 **1922 宽**，违反「变体 ≤1920 宽」的规格
  （线上存量里已有 29 条这种 1922 宽对象，属于历史产物，**保留不动**）。
- 变体同样要过服务端的变体口径：**宽 ≤1920（1080p 档）、H.264、faststart 必须为真**。
  服务端上传闸门只校验原画（变体由工具/脚本直写 R2 + `variants` 列），
  但 `checkVideoCompliance(..., { role: 'variant' })` 就是这条口径，脚本自检请用它。
- 写 D1 的 `variants` 列（JSON 数组文本，按 `bytes` 升序）：

  ```json
  [{"label":"4K30","height":2160,"width":3840,"bytes":2015122,"sha256":"…","key":"wallpapers/wp_xxx/5d6ec151effcc0ec.30fps.mp4"},
   {"label":"1080p","height":1080,"width":1920,"bytes":523756,"sha256":"…","key":"wallpapers/wp_xxx/9f3c1a2b3c4d5e6f.1080p.mp4"}]
  ```

  **`label` 是选档依据，必须写**：`variantsDto` 会把它原样透传给客户端（不再用 `height` 反算），
  客户端据此区分「降分辨率」与「只降帧率」——两者 `height` 可能相同（3840×2160 的 30fps 档
  `height` 也是 2160），只靠 `height` 分不出来。缺 `label` 的老记录仍按 `${height}p` 兜底。
  同一条可以有多个档（既有 1080p 又有 4K30），**保留其它档、只替换同 label 的那一档**。

- 变体同样要过第 5 步 HEAD（以及第 3 节 ①②）；失败就**整条不加变体**，不要写半条脏 JSON。
  脏数据会被 `variantsDto` 过滤掉，但用户那边就看不到 1080p，等于白干。
- 换原片 ≠ 换变体：两个 key 各自独立，要换都换。

### 5.1 该出哪一档（顺序即优先级，先满足就停）

1. **分辨率在限内、`fps ≤ 30`** ⇒ 不需要变体（原画直接播，最高画质）。
2. **分辨率在限内、`fps > 30`** ⇒ 只出 **30fps 档**（同分辨率）。**不许**顺手降到 1080p：
   4K@60 的瓶颈是像素吞吐，砍帧率即可，砍分辨率是把画质白白扔掉。
3. **宽 >3840 或 高 >2160 或 像素 >8,294,400** ⇒ 出 **1080p 档**，并把 `fps` 一并降到 30。
4. 已存在同 label 且**实测合规**（分辨率对、≤30fps、H.264、yuv420p、moov 前置）的档 ⇒ 跳过，
   不重复上传；不合规才重做（新 key，旧对象保留）。

> 存量修复脚本与幂等上线脚本：`D:\folia-recover\variants-1080p\apply-pending.ps1`
> （按清单 PUT + 三条回读 + 写 `variants`，可重复执行）。

## 6. 禁止清单（6 条）

1. **用时间戳 / 随机数做 key**（`Date.now()`、`uuid`）。每次上传都是一个新对象，R2 里只堆垃圾，且换不来"内容变 key 变"的保证。
2. **覆盖同名 key**——包括"内容只改了一点点，直接再 PUT 一次"。要改内容就换 key。
3. **只改 `bytes` 或只改 `sha256`**。两个字段必须成对更新，来自同一份文件。
4. **跳过 HEAD 回读校验就往 D1 写**。先写库后校验 = 用户点开就是 404。
5. **传完不跑 HEAD vs Range 检查就宣布完成**。① 与 ② 不等时，单看任何一个都会骗你。
6. **本地 `wrangler pages deploy` 直传**。线上只认 push 到 `main`，原因见 README「部署纪律」。

## 7. 推荐做法

走**管理后台上传接口**，不要手工 curl 覆盖 key：

```
PUT /api/admin/wallpapers/:id/asset     原始二进制 body，需登录会话
```

它内部顺序（`src/server/routes/wallpapers.js` → `upload()` → `src/server/ingest.js` 的 `ingestAsset()`）
正好是这份规程：

**播放合规体检**（`media-compliance.js`，违规 422 直接返回，此步之前不写盘、不写库）→
**纯 JS 能修的先修**（moov 前置转封装 / 只降帧）→ 算 sha256 去重（>40MB 改采样指纹）→
`assetKey()` 生成键 → `putAsset()`（contentType + immutable）→ `verifyAsset()` HEAD 回读 →
通过才 `updateWallpaperAsset`（`storage_key`/`bytes`/`sha256` 同一条 UPDATE）→
删旧 key → 缩略图（有就传自己的，没有时图片用原图）→ 1080p 变体（超规格才生成/校验后写 `variants`）→
写审计（有 warning 时多写一条 `wallpaper.asset_compliance_warn`）。

前端 `↑ 上传`、后台 `/admin/` 都走这条链路。手工 PUT 只在两种场合用：历史对象修复、批量迁移脚本；
这两种场合请自己把第 5 步、第 3 节补齐。

## 8. 故障处置

发现 **HEAD 长度 ≠ Range 总量**（即"同址双版本"）：按 [`docs/r2.md`](r2.md) 的「对象一致性守则」四步处理：

1. 以 D1 的 `sha256` 对应那一版为 canonical；
2. 上传到**从未对外服务过**的新 key；
3. 对新 URL 三验（HEAD 长度 / Range 0-99 的 `content-range` 总量 / 全量下载 sha256）；
4. 再改 D1 的 `storage_key` / `bytes`（`sha256` 不变）。

补充两条：

- **先停用再修**：把该条置下线/草稿，别等修好才停。
- **回滚 = 用留档文件重新上传到新 key**。把 D1 的 `storage_key` 指回旧 key **不算**回滚——
  旧 key 在源站可能已经是被覆盖后的版本，指回去就是重新制造"记录与文件不一致"。

## 9. 批量导入 / 目录扫描（与单条上传等价）

后台两个批量入口：

| 入口 | 位置 | 做什么 |
|---|---|---|
| **A · 立即扫描 / 添加目录** | 作品页顶部 `import-strip`（`public/admin/app.js` 的 `scanImportDirs()`） | 授权一个本机目录（Wallpaper Engine 创意工坊 / 任意壁纸文件夹），按 `project.json` 认作品，扫到的新东西直接进草稿 |
| **B · 批量导入本地文件** | 作品页右上「批量导入本地文件」（`openLocalImport()`） | 多选图片（png/jpg/webp/avif/gif）或视频（mp4/webm，单个 ≤55MB），标题取文件名，导入后存草稿 |

**两条入口点的是同一个接口，与单条上传走同一个入库管线：**

```
POST /api/admin/wallpapers/import     multipart/form-data，一个文件一枪
  file         必填，一个媒体文件
  thumb        可选，浏览器 canvas 生成的 WebP（1280 宽）
  variant      可选、可重复，1080p 变体（名字形如 xxx.1080p.mp4）
  title / kind / categoryId / tags(JSON) / publish(0|1) / reportId
```

服务端处理顺序与第 7 节的 `PUT /asset` **完全相同**（两处都调 `src/server/ingest.js` 的
`ingestAsset()`），差别只有两点，都是为了批量场景：

1. **建行 + 入库在同一次调用里**：失败会**回滚刚建的草稿**，不会像老写法那样在库里留一条没文件的僵尸记录；
2. **返回导入报告**（HTTP 200，失败是数据不是异常，见下）。

### 会自动做什么（报告里的 `autoFixes`）

| 码 | 含义 | 需要什么 |
|---|---|---|
| `faststart` | moov 在尾部 ⇒ **纯 JS 转封装前置**（只改字节顺序，不重编码、画质与体积不变） | 无（Worker 里就能做，`src/server/mp4-remux.js`） |
| `fps30` | 只有帧率超标（如 4K@60）⇒ 同分辨率重编码到 30fps（**降帧优先，不降画质**） | 视频编码器（`env.MEDIA_TOOLS.transcodeOriginal`） |
| `variant1080p` | 源 `width>1920` 或 `height>1080` 或 `fps>30` ⇒ 生成/收录 1080p 变体并写 `variants` 列 | 预置 `xxx.1080p.mp4` 一起导入，或 `env.MEDIA_TOOLS.transcodeVariant` |
| `thumb` | 缩略图：浏览器 canvas 抽帧（视频 0.5s、1280 宽 WebP）或解码器抽帧 | 浏览器即可 |
| `thumbFromOriginal` | 图片没有独立缩略图 ⇒ **用原图当缩略图**（不写就留空，卡片会没图） | 无 |
| `sampleFingerprint` | 单文件 >40MB ⇒ 不算完整 `sha256`，改记 `content_fingerprint`（首尾 1MB 采样） | 无 |

⚠️ **Workers 里没有 ffmpeg**，所以「重编码」类修正（`fps30` / `variant1080p`）需要注入
`env.MEDIA_TOOLS`（本地 Node 运行时用 ffmpeg，测试用确定性替身）。什么都没注入时：
能纯 JS 修的照修，其余**老实拒绝并写进报告**——绝不假装修好。
> 所以今天的实操口径是：4K@60 / HEVC 这类先用 `tools/prepare-upload.mjs` 转好再导入
> （`xxx.mp4` 与 `xxx.1080p.mp4` **一起多选**，前端会自动配对成变体）；快start 与缩略图
> 不用管，服务端/浏览器会补。

### 失败报告怎么看

报告形状（接口 `data.report`，界面弹窗同一份数据）：

```json
{
  "ok": false,
  "reportId": "report_m2xk9a_1f3c",
  "imported": 1, "reused": 0, "failed": 1, "skipped": 0,
  "items": [
    { "title": "星空", "status": "imported", "wallpaperId": "wp_…",
      "autoFixes": ["thumb", "thumbFromOriginal"],
      "fields": { "url": "/media/wallpapers/wp_…/….png", "bytes": 18342, "sha256": "…",
                  "width": 3840, "height": 2160, "thumbUrl": "/media/…", "variants": 0 } },
    { "title": "原神 绫华 4K60", "status": "failed",
      "code": "media_non_compliant",
      "reason": "视频不符合播放规格：帧率 60fps 超过上限 30fps。请先用 tools/prepare-upload.mjs 处理后再上传",
      "details": { "violations": [{ "code": "fps-too-high", "message": "…" }] } }
  ]
}
```

- `status`：`imported`（新入库）/ `reused`（同一文件已在库里，直接复用，不产生第二条）/ `failed` / `skipped`（前端预检就挡掉的：超 55MB、低清图、场景包）；
- `failed` 的 `code` 与单条 `PUT /asset` 的错误码一一对应：
  `media_non_compliant`（422 播放规格）/ `import_incomplete`（422 缺必填字段，`details.missing` 是缺的列）/
  `unsupported_media_type`（415）/ `payload_too_large`（413）；
- **失败条目不入库**（行会回滚），所以「报告里有几条 failed」=「库里没多出几条脏记录」；
- `items[].fields` 是**写进 D1 的实际值**，可直接拿去跑第 3 节的四条验收。

### 必填字段门

`kind / category / url / bytes / width / height` 缺任一 ⇒ 该条失败进报告，**不静默入库**。
`width/height` 探测不出来是最常见的一种（文件头损坏、moov 不在前/后 2MB 内）——
这类记录一旦进库，插件侧 `width/height` 为 `null`，`decodeLimitHit()` 的解码上限预判直接失效。

> zip 资源包（开机动画 / 皮肤包）没有宽高，豁免这一条：它本来就不是逐帧画面。

## 10. 相关文档

- [`docs/r2.md`](r2.md) — R2 模式、桶结构、缓存与 Range、事故复盘与「对象一致性守则」
- [`docs/integration.md`](integration.md) — 接入步骤、建表、部署验证清单
- [`README.md`](../README.md)「部署纪律」 — 只 push `main`、禁止本地直传
