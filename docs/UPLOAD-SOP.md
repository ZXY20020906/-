# 上传操作规程（UPLOAD SOP）

给「以后要往 R2 + D1 里放资源的人」用：壁纸图片、动态视频、皮肤包 zip、开机动画、1080p 变体。

原理、桶结构、事故复盘在 [`docs/r2.md`](r2.md)，**这里不重复原理**，只有：可执行步骤 + 验收命令 + 禁止项。
2026-11-04 那次「同址双版本」（145 个 URL 里 3 条皮肤包坏掉）就是跳过第 5 步、违反第 4 节造成的。

## 1. 三条铁律

1. **键名由最终入库内容的 sha256 前 16 位生成**：`wallpapers/<wp_id>/<sha16>.<ext>`；
   1080p 变体再加一段后缀，位置在扩展名之前：`wallpapers/<wp_id>/<sha16>.1080p.mp4`。
2. **内容一变必须换新键；禁止覆盖已存在的 key。**
   `/media/<key>` 带 `cache-control: public, max-age=31536000, immutable`，
   同名覆盖 ⇒ 边缘缓存（旧字节）与源站（新字节）长期并存 ⇒ 多连接 / Range 下载把两版拼成坏包。
3. **D1 的 `bytes` 与 `sha256` 必须来自同一份已校验的文件，成对更新。**
   禁止「按 HEAD 长度改 `bytes`、`sha256` 留旧值」——那是把真实故障伪装成「记录不准」，比不修更糟。

> 位数口径：`docs/r2.md` 记录的历史是「新建 12 位、修被污染的旧 key 用 16 位」。
> 从现在起**统一 16 位**。`src/server/storage.js` 的 `assetKey()` 目前仍是 `slice(0, 12)`，
> 改成 16 位是**待执行**的代码改动；在它切换前，后台上传产出的是 12 位键，
> 别手工造一个 16 位键去顶替同一条记录——要么都等切换，要么都用 16 位手工补齐后再改 D1。

## 2. 标准流程（七步）

### 第 1 步 准备文件

- **视频**：H.264 + `-movflags +faststart`（moov 在文件头才能边下边播，`readVideoInfo` 会把 codec/faststart 记进库）。
  开机动画通常是竖屏 1080×1920、视频 ≤60MB。
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

> 注意：>40MB 的文件走后台上传时不算完整 sha256（Worker 内存限制，改用首尾 1MB 采样指纹做 key），
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

## 5. 变体（1080p）

- 独立对象、独立 key、**独立 sha256 与独立 bytes**；不要复用原片的 sha256。
- key 形如 `wallpapers/<wp_id>/<sha16>.1080p.mp4`，同样遵守三条铁律。
- 写 D1 的 `variants` 列（JSON 数组文本）：

  ```json
  [{"height":1080,"key":"wallpapers/wp_xxx/9f3c1a2b3c4d5e6f.1080p.mp4","bytes":6710886,"sha256":"…"}]
  ```

- 变体同样要过第 5 步 HEAD（以及第 3 节 ①②）；失败就**整条不加变体**，不要写半条脏 JSON。
  脏数据会被 `variantsDto` 过滤掉，但用户那边就看不到 1080p，等于白干。
- 换原片 ≠ 换变体：两个 key 各自独立，要换都换。

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

它内部顺序（`src/server/routes/wallpapers.js` → `upload()`）正好是这份规程：

算 sha256 去重 → `assetKey()` 生成键 → `putAsset()`（contentType + immutable）→
`verifyAsset()` HEAD 回读 → 通过才 `updateWallpaperAsset`（`storage_key`/`bytes`/`sha256` 同一条 UPDATE）→
删旧 key → 写审计。

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

## 9. 相关文档

- [`docs/r2.md`](r2.md) — R2 模式、桶结构、缓存与 Range、事故复盘与「对象一致性守则」
- [`docs/integration.md`](integration.md) — 接入步骤、建表、部署验证清单
- [`README.md`](../README.md)「部署纪律」 — 只 push `main`、禁止本地直传
