# 私人站点：只有管理员能进

站点不再有“共享口令”。任何人打开链接都只能看到登录页，**只有 role=admin 的账号**登录成功后才能浏览壁纸、接口和媒体。编辑（editor）账号即使密码正确也进不来，登录会被直接拒绝并销毁会话。

登录页的标题是 **欢迎回家**。

## 它怎么工作

```
浏览器 ──► Pages Functions 根中间件 (functions/_middleware.js)
             │
             ├─ 路径是 /__gate ──► 登录页 / 提交登录 / 退出
             │
             ├─ 有效会话且 role=admin ──► 照常返回页面 / 接口 / 媒体
             │
             ├─ 有会话但不是管理员 ──► 销毁会话，回登录页并提示
             │
             ├─ /api/auth/*、/api/meta ──► 放行（它们自己校验身份）
             │
             ├─ GET/HEAD /api/public/wallpapers 与 /media/* ──► 放行（插件只读白名单）
             │
             └─ 其它 ──► 页面(401 登录页) · /api(401 site_locked) · /media(403)
```

## 插件只读白名单

桌面插件要在不登录的情况下拉清单、显示封面、下载皮肤包，所以门里留了一个**精确**的口子：

```js
const PUBLIC_READ_PATHS = new Set(['/api/public/wallpapers']);
const PUBLIC_READ_PREFIXES = ['/media/'];
// 只认 GET / HEAD，其余路径与方法照旧走会话校验
```

- 放开的只有「已发布」数据：`/api/public/wallpapers` 本来就不会返回草稿和下线作品。
- `/media/*` 的 key 形如 `wallpapers/<wp_id>/<内容哈希前16位>.<ext>`，既不可枚举，换内容还会换 key。
- 写接口一个都没放：POST/PATCH/DELETE 仍然要管理员会话，`/api/public/categories`、`/api/plugin/feed` 这些也**没有**顺手放开。
- 这两个路由的 CORS 是 `*`（只读、无 Cookie 身份），所以插件从任意源 fetch 都能读。

如果哪天要把口子收得更紧（比如只允许某个分类），在 `isPublicRead()` 里加一层 `category` 白名单即可。

- 登录复用后台同一套逻辑（`attemptLogin`）：PBKDF2 校验、每账号 15 分钟 5 次限流、审计日志、旧哈希自动升级，全部一致。
- 会话 Cookie `folia_session`（HttpOnly + SameSite=Lax + Secure）**不带 Max-Age，是浏览器会话级 Cookie**：关掉浏览器就没了，下次必须重新登录。服务端记录在 D1 的 `sessions` 表里，7 天后兜底过期；退出/停用账号立即失效。
- **设备绑定**：登录时还会下发第二枚 `folia_device` Cookie，库里只存它的 sha256。请求必须同时带上两枚且哈希匹配——只复制 `folia_session` 用不了。
- **闲置超时**：`last_seen_at` 超过 **60 分钟**没有请求就要求重新登录（`SESSION_IDLE_MS`）；有活动时最多每分钟续期一次，避免每个静态资源都写库。
- 媒体响应改成 `cache-control: private`，只允许浏览器自己缓存，CDN 或代理不会把它转给别人。
- 页面右上角「退出」= `/__gate?logout=1`：删库里的会话 + 清 Cookie。

## 为什么放行 `/api/auth/*`

登录页本身要能提交登录，后台会话过期后也要能重新登。这几个接口自己会校验身份：

| 放行的接口 | 原因 |
|---|---|
| `/api/auth/login` | 登录入口 |
| `/api/auth/logout` | 退出 |
| `/api/auth/me` | 后台启动时探测会话，未登录返回 401 |
| `/api/meta` | 判断站点是否已初始化 |

除此之外的 `/api/*` 一律要求会话。

## 谁来都进不去，除了管理员

- 没有注册入口，账号只能在后台「成员」里由管理员创建。
- 停用成员（`active = 0`）后，他的下一次请求就会被拒——会话查库，不是纯 Cookie 判定。
- **编辑（editor）账号不能进站**：登录时直接 403 并销毁刚建的会话；万一手里有旧会话，也会被中间件清掉并提示“只对管理员开放”。
- 所以「成员」里新建账号时要把角色选成**管理员**，否则对方进不了站点。

## 常用操作

| 想做的事 | 怎么做 |
|---|---|
| 加一个能看站的人 | 后台「成员」→ 新增成员，角色必须选「管理员」 |
| 收回某人的访问 | 后台「成员」→ 停用或删除该账号（立即生效） |
| 忘记密码 | 用另一个管理员账号在后台重置；只剩一个账号时用 `wrangler d1 execute` 改库，或重新初始化 |
| 临时公开整站 | 删掉 `functions/_middleware.js` 重新部署 |
| 清理旧口令变量 | `npx wrangler pages secret delete SITE_PASSWORD --project-name folia`（`GATE_SECRET` 同理），新代码已不用它们 |

## 已知边界

- **会话随浏览器关闭失效**：Cookie 是 session cookie，关掉浏览器进程就没了。注意 Chrome/Edge 的“恢复上次会话”会把会话 Cookie 一起恢复，想彻底避免就关掉该选项，或用退出按钮。服务端记录仍有 7 天兜底过期（`src/server/session.js` 的 `SESSION_TTL_MS`）。
- **闲置 60 分钟要重新登录**：`SESSION_IDLE_MS`，改小/改大只动这一个常量。
- **每个请求一次 D1 读**（查会话）。私人站点访问量小，这点成本可以忽略；要省可以加 isolate 内缓存，代价是停用账号最多延迟几十秒生效。
- **已经缓存过的媒体**：登录前看过的图仍在浏览器本地缓存里；锁只管新请求。
- **跨域调用**：需要登录的 `/api/*` 跨域 fetch 仍然会拿到 401；只有插件白名单里的 `GET /api/public/wallpapers` 和 `/media/*` 是匿名 + `Access-Control-Allow-Origin: *`。
- **白名单的代价**：媒体文件一旦被拿到直链就能匿名下载。key 里带 id 和内容哈希，不能被枚举，但**分享出去的链接谁都能打开**——这是插件能装皮肤的前提，接受不了就只能给插件单独做个带签名的下载接口。

## 回滚

```bash
npx wrangler pages deployment list --project-name folia
npx wrangler pages deployment rollback <deployment-id> --project-name folia
```

或者删掉 `functions/_middleware.js` 重新部署，回到公开状态（三个 gate 模块留着不影响）。
