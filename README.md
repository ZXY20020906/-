# Folia 壁纸库 · 管理 / 分类 / 权限模块

给你的 `folia-5ve.pages.dev` 加一层能用的后台：**谁能加壁纸、谁能改分类、谁能发布上线**。

现在的线上站是纯展示（全部 / 动态 / 收藏 / 皮肤包 四个 tab，没有写入口）。这个目录现在是一个**能直接跑的整站**：前台壁纸库 + 后台管理 + R2 存储，领域逻辑与框架无关。

```
壁纸：新增 → 传文件 → 选分类 → 管理员发布
分类：增删改 + 拖动排序 + 前台可见开关
模块：壁纸 / 皮肤包 / 开机动画（竖屏视频，带循环时长与下载）
权限：管理员 / 编辑 两种角色，服务端逐请求校验
存储：文件全在 R2，页面零本地图片，换壁纸不用重新部署
```

## R2 模式

仓库和构建产物里**不放任何壁纸文件**：

```
浏览器 → Pages（HTML/CSS/JS，几百 KB）
       → /api/public/*（D1：标题、宽高、体积、R2 key）
       → /media/<key> 或 https://img.example.com/<key>（R2：原图/视频）
```

- key 规则 `wallpapers/<id>/<sha256前12位>.<ext>`，内容一变 key 就变，所以能放心给一年 `immutable` 缓存。
- 换 R2 自定义域名只改一个变量 `MEDIA_BASE`，代码不动。
- 视频支持 `Range`（206），拖进度条不重下整段。

细节、成本估算、迁移和备份见 [`docs/r2.md`](docs/r2.md)。

## 能力一览

| 能力 | 管理员 | 编辑 |
|---|:--:|:--:|
| 浏览/搜索所有壁纸 | ✅ | ✅ |
| 新增壁纸（上传图片/视频） | ✅ | ✅ |
| 改**自己**上传的标题/分类/标签 | ✅ | ✅ |
| 改**别人**上传的壁纸 | ✅ | ❌ |
| 发布 / 下线 | ✅ | ❌ |
| 删除壁纸（连 R2 文件） | ✅ | ❌ |
| 新建 / 改名 / 删除分类、排序 | ✅ | ❌ |
| 选择分类（给壁纸归类） | ✅ | ✅ |
| 管理成员与角色 | ✅ | ❌ |
| 查看审计日志 | ✅ | ❌ |

编辑上传的是**草稿**，管理员审过再发布——这是「增加权限」最省心的默认值。想让编辑直接发布，把 `wallpaper:publish` 加进 `EDITOR_CAPS`（见 `docs/permission-matrix.md`）。

## 目录结构

```
folia-admin/
├─ functions/               ← Cloudflare Pages Functions（薄壳）
│  ├─ api/[[path]].js        /api/* 全部交给 app.js
│  └─ media/[[path]].js      /media/* 从 R2 出图，支持视频 Range
├─ src/
│  ├─ core/                  与平台无关的纯逻辑（可单测）
│  │  ├─ permissions.js      ★ 权限矩阵唯一真相
│  │  ├─ validate.js         入参校验
│  │  ├─ image-meta.js       只看文件头判断类型/宽高（无依赖）
│  │  ├─ slug.js             中文标题 → 稳定 slug
│  │  ├─ ordering.js         重排的集合一致性校验
│  │  └─ pagination.js       游标分页
│  └─ server/                D1 / R2 / 会话 / 路由
├─ public/index.html         前台壁纸库（R2 模式，零本地图片）
├─ public/assets/            前台 JS / CSS（原生 ESM，无构建）
├─ public/admin/             后台界面（原生 JS，无构建）
├─ schema/                   D1 建表 + 种子数据
├─ tests/                    79 个测试
├─ tools/                    校验脚本、SQL 检查、批量导入
└─ docs/                     开机动画、R2 模式、权限矩阵、接入步骤、API、前台对接
```

## 上线五步

```bash
# 1. 建库和桶（名字随意，但要和 wrangler.toml 对上）
npx wrangler d1 create folia
npx wrangler r2 bucket create folia-wallpapers

# 2. 建表 + 分类（动态 / 皮肤包 / 开机动画）+ 时长字段
npx wrangler d1 execute folia --file=./schema/001_init.sql --remote
npx wrangler d1 execute folia --file=./schema/002_seed.sql --remote
npx wrangler d1 execute folia --file=./schema/003_boot_animation.sql --remote
npx wrangler d1 execute folia --file=./schema/004_boot_animation_duration.sql --remote

# 3. 初始化令牌（只用来创建第一位管理员）
npx wrangler pages secret put BOOTSTRAP_TOKEN

# 4. 合并 wrangler.toml 的 DB / BUCKET 绑定（别覆盖你现有的配置）

# 5. push 到 main 触发 Pages 部署（见「部署纪律」），然后打开 /admin/ 用令牌创建管理员
```

详细步骤和回滚方式见 `docs/integration.md`。

## 私人站点（只允许管理员）

`functions/_middleware.js` 把整站变成“只有 admin 能看”：没会话时页面只有登录页（标题「欢迎回家」），`/api/*` 返回 `401 site_locked`，`/media/*` 返回 `403`。用的是后台的 `folia_session`，并且**校验角色**——editor 账号登录会被 403 拒绝并销毁会话，旧会话也会被清掉。加人、停人直接在后台「成员」里做，停用立即生效。

留了一个**插件只读白名单**：`GET/HEAD /api/public/wallpapers` 和 `/media/*` 不需要登录（桌面插件要拉清单、显示封面、下载皮肤包）。只放已发布数据、只放读，写接口和其它 `/api/*` 照旧要会话。

部署只走仓库：push 到 `main`，Cloudflare Pages 自动构建。**不要**在本地跑 `wrangler pages deploy` 直传，原因见下一节「部署纪律」。

登录页在 `/__gate`，复用后台同一套登录逻辑（PBKDF2 + 限流 + 审计）。细节与边界见 [`docs/private-site.md`](docs/private-site.md)。

## 前台即后台（编辑模式）

站点不是「画廊 + 另一个后台」，而是同一张页面：

- 有写权限的成员（管理员 / 编辑）右上角会看到「编辑」按钮；没有权限的人看不到，编辑器代码也**不会加载**（`editor.js` 只在鉴权通过后动态 `import`）。
- 打开编辑模式后列表改用 `/api/admin/wallpapers`：草稿、已下线的作品也看得见，卡片上直接长出 ✎（改标题 / 分类 / 标签）、↑↓（发布 / 下线）、✕（删除）。
- 底部工具条：**上传**（多选文件，浏览器生成封面后一起传）、**分类**（改名 / 排序 / 前台可见 / 删除，删除时可以把作品迁移到其他分类）、**高级**（跳 `/admin/`）。
- 所有写操作仍走 `/api/admin/*`，权限在服务端逐请求判定——按钮只是「少显示」，不是安全边界。

`/admin/` 继续保留：成员管理、审计日志、批量导入这些低频操作在那里更顺手。后台右上角有「← 前台」、侧栏底部有「← 返回前台」，点 logo 也能回画廊——不会进去出不来。

## 前台怎么接

`public/index.html` 是自带的前台，已经接好了：tab 从 `/api/public/categories` 来，壁纸从 `/api/public/wallpapers` 来，图片/视频直接吃 R2 直链。

如果你想保留现有页面的设计、只换数据源，改两处就够：

```js
// 拿分类渲染 tab（公开接口，无需登录，已带 CORS）
const { data } = await (await fetch('/api/public/categories')).json();
// data.categories → [{ slug: 'dynamic', name: '动态', count: 12 }, ...]

// 按分类取壁纸
const page = await (await fetch('/api/public/wallpapers?category=dynamic&sort=recent&limit=24')).json();
// page.data.items[i].url → /media/... 或 R2 自定义域名，可直接当 <img src>
```

原来的四个 tab 里，`全部` 是"不过滤"、`收藏` 是本地状态，只有 `动态` / `皮肤包` 是真实分类——种子数据就按这个建的。更多（无限滚动、搜索、排序）见 `docs/frontend.md`。

## 本地校验

```bash
node tools/run-tests.mjs     # 92 个测试：权限 / 上传校验 / 时长解析 / 轮换收藏 / 分页 / HTTP 层
node tools/check-ui.mjs      # 前台 + 后台的 id、按钮动作、接口路径是否都对得上
node tools/check-syntax.mjs  # 模块加载与语法检查
node tools/dump-queries.mjs && python tools/check-sql.py   # 用真 sqlite3 编译全部 55 条 SQL
```

当前状态：**92 个测试全通过；55 条 SQL 全部通过 sqlite3 编译；4 个迁移脚本可按序执行。**

## 部署纪律（必须遵守）

- 线上站点 = `https://folia-5ve.pages.dev`，Cloudflare Pages 项目 `folia` 已接入本仓库 `main` 分支：
  **只有 push 到 main 才会部署**（构建命令为空、输出目录 `public`）。
- **禁止**在本地执行 `wrangler pages deploy` 直传：那会用本地工作树覆盖线上，
  与仓库不一致、也无法回滚（历史事故：本地直传导致的版本漂移）。
- 部署前必做：`git pull` → `git rev-parse --short HEAD` 与 `origin/main` 一致 → 再改。
- `wrangler.toml` 里的 `PUBLIC_ORIGIN` 必须是 `https://folia-5ve.pages.dev`；
  写成其他域名会让所有媒体直链指向不可用主机（旧配置曾指向已下线域名）。
- 数据库迁移（`schema/*.sql`）只在线上执行一次；`ALTER TABLE` 不可重复跑。
- 媒体对象一律用内容哈希命名（`<sha256前12>.ext`），**换内容必须换 key**，
  否则一年 immutable 缓存会让用户长期看到旧文件。
- 1080p 变体：4K/2K 视频上传后应生成 `variants`（1080p），写入 D1 的 `variants` 列，
  由 `/api/public/wallpapers` 输出；插件按链路情况自动选择。
- **上传资源请先看 [`docs/UPLOAD-SOP.md`](docs/UPLOAD-SOP.md)**：键名规则、七步流程、
  上传后四条验收命令（HEAD / Range / 全量 sha256 / API）、六条禁止项。

## 设计取舍

- **权限在服务端逐请求判定**，前端按钮只是"少显示"，不是安全边界。改别人壁纸、发布、删分类，全部在 API 层拒绝。
- **发布权默认只给管理员**。编辑能传、能归类、能改自己的稿子，但上线要过一道人工。
- **文件类型看文件头**，不看扩展名；`readMediaMeta` 顺手把宽高写库，前台不用等图加载完才排版。
- **上传按 SHA-256 去重**，同一张图重复上传会返回 409 并告诉你它在哪一条。
- **分类是扁平的**（一级），因为壁纸站的分类本质是 tab；要树状再改 schema，别硬套。
- **删除分类默认阻止**：当分类下还有壁纸时返回 409，前端会弹框让你选「迁移到另一个分类」还是「改为未分类再删」；迁移与删除在同一个 batch 里完成。
- **登录限流是 per-isolate 内存计数**，能挡小规模爆破，但不是精确全局限流。要严格就接 Durable Object 或 Turnstile。
- **R2 key 里带内容哈希**，所以 `/media/*` 可以给一年 immutable 缓存；换图会换 key，不会读到旧图。

## 已知边界

- 没有做图片压缩/多尺寸缩略图。壁纸站迟早要，但那是 R2 + Images 的另一件事，别混进来。
- 没有做软删除/回收站。删除是真的删（R2 + D1），前端有二次确认。
- 没有做邮件（邀请、找回密码）。成员密码由管理员设置、本人登录后自改。
- 后台界面没做 i18n，中文写死。
