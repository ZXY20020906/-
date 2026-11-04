# 接入步骤

目标：在不改动现有前台展示的前提下，先把后台跑通，再慢慢把前台数据源切到 API。

## 0. 先确认三件事

```bash
# 站点是 Git 集成还是直接上传？
# Cloudflare 后台 → Pages → 你的项目 → Settings → Build configuration
```

| 判断 | 影响 |
|---|---|
| Build output directory 是 `public` / `dist` / `out` | `functions/` 必须放在**仓库根目录**，和它同级 |
| 用的是 `next-on-pages` | 你的 `functions/` 会被 Next 接管，见下面「框架特殊情况」 |
| Build command 为空（纯静态直传） | 直接把 `functions/` 和 `public/admin/` 合并到上传目录 |

先开一个分支，别直接改 main：

```bash
git checkout -b feat/admin-permissions
```

## 1. 建 D1 和 R2

```bash
npx wrangler d1 create folia
npx wrangler r2 bucket create folia-wallpapers
```

`d1 create` 会打印 `database_id`，复制下来填到 `wrangler.toml`。

## 2. 建表

```bash
npx wrangler d1 execute folia --file=./schema/001_init.sql --remote
npx wrangler d1 execute folia --file=./schema/002_seed.sql --remote
npx wrangler d1 execute folia --file=./schema/003_boot_animation.sql --remote
npx wrangler d1 execute folia --file=./schema/004_boot_animation_duration.sql --remote
```

验证：

```bash
npx wrangler d1 execute folia --command "SELECT slug,name,sort_order FROM categories" --remote
# 期望三行：dynamic/动态/10、skin-pack/皮肤包/20、boot-animation/开机动画/30
```

种子只建了 `动态`、`皮肤包`、`开机动画`——`全部` 是"不过滤"，`收藏` 是本地状态，都不该建成分类。

## 3. 合并 wrangler 配置

**不要覆盖你现有的 `wrangler.toml`**。把这三段合并进去：

```toml
[[d1_databases]]
binding = "DB"
database_name = "folia"
database_id = "你刚才拿到的 id"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "folia-wallpapers"

[vars]
PUBLIC_ORIGIN = "https://folia-5ve.pages.dev"
```

`binding` 的名字必须是 `DB` 和 `BUCKET`，代码里写死了（`env.DB` / `env.BUCKET`）。想换名字就全局替换，别只改配置。

## 4. 设初始化令牌

```bash
npx wrangler pages secret put BOOTSTRAP_TOKEN --project-name folia
# 输入一串随机值，比如 openssl rand -hex 24 的输出
```

这个令牌只在"创建第一位管理员"时用一次。初始化完成后它就失效了（接口会因为已有用户直接返回 409），但建议还是留着，方便灾难恢复时手动清空 `users` 表重来。

## 5. 放文件

```
仓库根/
├─ functions/          ← 从 folia-admin/functions 复制
├─ src/                ← 从 folia-admin/src 复制（core + server）
├─ schema/             ← 建表脚本，部署不需要但建议入库
├─ wrangler.toml       ← 合并后的
└─ （你的现有前端目录）
```

后台页面放在**构建输出目录**下，路径是 `/admin/`：

```bash
# 以构建产物是 public/ 为例
mkdir -p public/admin public/assets
cp folia-admin/public/admin/{index.html,styles.css,app.js} public/admin/
cp folia-admin/public/index.html public/
cp folia-admin/public/assets/* public/assets/
```

`.dev.vars` 两个变量：`BOOTSTRAP_TOKEN`（必填）、`MEDIA_BASE`（可选，见第 7 步）。

> **自带前台和现有站点怎么共存？** 三种做法，选一个：
>
> 1. **全量替换**：`public/index.html` 接管 `/`，旧前端下线。最简单，但你会丢掉现有设计。
> 2. **只要后台**：不复制 `public/index.html` 和 `public/assets/`，`/admin/` 照常工作，前台你慢慢改。
> 3. **现有站点 + 新数据源**：保留旧页面骨架，只把数据请求换成 `/api/public/*`（见 `docs/frontend.md`）。这是推荐的渐进路线，但需要你动前端代码。
>
> 下面默认按做法 1 验证；如果你选 2 或 3，第 6 步里"打开首页"那项跳过即可。

> 如果你用 Next.js：把这三个文件放进 `public/admin/`，Next 会把 `public/` 原样复制到产物里，`/admin/` 就能访问。但 `index.html` 在 Next 里可能被路由拦截——稳妥做法是改成 `app/admin/page.tsx` 或放到 `public/admin/index.html` 并确认 `/admin/index.html` 可访问。

## 6. 部署并验证

只走 push 到 `main`：Cloudflare Pages 项目 `folia` 已接入本仓库，push 后自动构建（构建命令为空、输出目录 `public`）。**不要**在本地执行 `npx wrangler pages deploy ... --project-name folia` 直传——那会用本地工作树覆盖线上、与仓库不一致、也无法回滚。详见 README「部署纪律」。

按顺序验这 5 个点：

| 检查 | 期望 |
|---|---|
| `GET /api/meta` | `{"ok":true,"data":{"initialized":false,...}}` |
| `GET /api/public/categories` | 两个分类，`count` 都是 0 |
| 打开 `/` | 前台壁纸库能加载，显示"这个分类还没有壁纸" |
| 打开 `/admin/` | 出现"创建管理员"表单，而不是登录表单 |
| 创建管理员 | 成功后进入壁纸页，左侧只有「壁纸」「分类」 |
| 用新账号重开 `/admin/` | 显示登录表单（说明已经不是首次初始化） |

如果 `/api/meta` 返回 404：`functions/` 没放在根目录，或者部署的输出目录选错了。
如果返回 500 且日志里是 `D1_ERROR`：`database_id` 填错，或建表语句没执行到 remote。

### 可选：给 R2 绑自定义域名（建议正式站做）

默认 `/media/<key>` 由 Worker 出图，每张图算一次 Workers 请求（免费额度 10 万/天）。壁纸站一屏 24 张，很容易穿。

```
Cloudflare → R2 → folia-wallpapers → Settings → Custom Domains → 连接 img.example.com
```

然后在 `wrangler.toml` 里：

```toml
[vars]
MEDIA_BASE = "https://img.example.com"
```

重新部署后，`/api/public/wallpapers` 返回的 `url` 就会直接指向这个域名，不再经过 Worker。没有域名或暂时不想切，就留空——功能完全一样，只是多花请求数。

## 7. 建分类 + 导壁纸

先建你需要的分类（比如「极简」「赛博」「风景」），再批量导入本地图库：

```bash
FOLIA_URL=https://folia-5ve.pages.dev \
FOLIA_EMAIL=你的管理员邮箱 \
FOLIA_PASSWORD='你的密码' \
node tools/import-wallpapers.mjs ./wallpapers --category dynamic --publish
```

先加 `--dry-run` 看清单，确认无误再去掉。文件多的时候建议分批（`--limit 20`），一边传一边看后台。

## 8. 切前台数据源

见 `docs/frontend.md`。核心就两件事：

- 分类 tab 从 `/api/public/categories` 读，不要再写死；
- 壁纸列表从 `/api/public/wallpapers` 读，`url` 直接当 `<img src>`。

`收藏` 仍然是 `localStorage`，和后台无关。

## 回滚

这个模块不改你现有表，只新增四个表（`users`/`sessions`/`categories`/`wallpapers`/`audit_log`）。回滚 = 删掉 `functions/`、`src/`、`public/admin/`，把 `wrangler.toml` 里那三段去掉，重新部署。

数据库可以先留着（不占用线上流量），确认不要了再：

```bash
npx wrangler d1 execute folia --command "DROP TABLE IF EXISTS audit_log; DROP TABLE IF EXISTS wallpapers; DROP TABLE IF EXISTS categories; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;" --remote
npx wrangler r2 bucket delete folia-wallpapers
```

## 框架特殊情况

**next-on-pages**：`/api/*` 会先进 Next 的 handler。你需要把 `src/server/app.js` 的 `handle()` 包成一个 Next Route Handler（`app/api/[...path]/route.ts`），而不是用 Pages Functions。逻辑不用改，只改入口那 5 行。

**Astro / Vite 静态导出**：`functions/` 直传可用，`public/admin/` 会原样进产物。

**已经有 `functions/` 目录**：把 `api/` 和 `media/` 两个子目录复制进去即可，`_middleware.js` 之类的不要覆盖。

## 常见问题

**登录或初始化返回 500，错误信息里是 `Pbkdf2 failed: iteration counts above 100000 are not supported`**
Cloudflare Workers 的 WebCrypto 对 PBKDF2 迭代次数**硬上限是 100000**，超过直接抛错。`src/server/password.js` 里的 `MAX_SUPPORTED_ITERATIONS` 就是 100000，`clampIterations()` 会把任何更大的值压回去。不要在 `wrangler.toml` 或环境变量里把它调大——调了也只会在运行时抛异常。

**部署后 `/api/*` 返回 HTML（首页内容）**
Pages 会把未知路径回退成 `index.html`。前端 `detectMode()` 因此按 `content-type` 判断，而不是只看状态码；你自己写探活逻辑时也要这样。

**`wrangler.toml` 里的 `[vars]` 会覆盖面板上设的环境变量**
用 Git 集成构建（push 到 `main`）时，`[vars]` 是权威来源，面板里手动加的明文变量会被冲掉（secret 不受影响）。要加的变量写进 toml。

**上传 413**
Cloudflare 免费版请求体上限 100MB，但这个模块自己限了图片 20MB / 视频 60MB。改 `src/core/image-meta.js` 的 `MAX_IMAGE_BYTES` 和 `MAX_VIDEO_BYTES`。

**登录后刷新又变回登录页**
Cookie 是 `HttpOnly; Secure; SameSite=Lax`。如果你在 `http://localhost` 调试，Secure 不会生效（代码按协议自动判断），但要确保不是 `http://` 访问线上域名——那会导致 Cookie 丢失。

**写操作全返回 403「缺少 X-Folia-Client 请求头」**
这是 CSRF 防护。后台页面自己带了这个头；你用 curl 测接口时要手动加 `-H "X-Folia-Client: admin"`。

**图片打不开，`/media/...` 404**
R2 桶名和 `bucket_name` 不一致，或者对象在预览环境而非生产环境（R2 不会跟随 Pages 的分支预览隔离）。
