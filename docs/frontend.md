# 前台对接

> 如果你直接用自带的 `public/index.html`，这一页可以跳过——它已经按下面的方式接好了。
> 这里写的是：**保留你现有页面骨架**，只把数据源换过来的做法。

现有的四个 tab：`全部` / `动态` / `收藏` / `皮肤包`。接 API 后只有两件事要变。

## 1. 分类 tab 不要写死

`全部` 是"不过滤"，`收藏` 是本地状态，`动态` / `皮肤包` 是真实分类——后者以后会变成五个、八个，所以从接口读：

```js
const res = await fetch('/api/public/categories');
const { data } = await res.json();

const tabs = [
  { slug: '', name: '全部' },
  ...data.categories.map((c) => ({ slug: c.slug, name: c.name, count: c.count })),
  { slug: 'favorites', name: '收藏' },
];
```

`slug` 直接塞进 URL 的 `?category=`，刷新、分享都能还原视图。**不要用分类名**——运营改个名字链接就废了。

## 2. 壁纸列表换成接口

```js
async function loadWallpapers({ category = '', sort = 'recent', q = '', page = 1 } = {}) {
  const params = new URLSearchParams({ limit: '24', sort, page: String(page) });
  if (category) params.set('category', category);
  if (q) params.set('q', q);

  const res = await fetch(`/api/public/wallpapers?${params}`);
  const { data } = await res.json();
  return data; // { items, total, page, pageCount, pageSize, hasMore }
}
```

每张壁纸你需要的字段：

```js
for (const item of data.items) {
  item.url;                    // /media/... 直接当 <img src> 或 <video src>
  item.width; item.height;     // 已在入库时读好，可以提前留位避免布局跳动
  item.category?.slug;         // 可能为 null（未分类）
  item.tags;                   // string[]
  item.mime.startsWith('video/') // 动态壁纸判断，别再看 kind
}
```

用 `mime` 判断视频比用 `kind` 稳——`kind` 是运营选择的意图，`mime` 是文件的真实类型。

## 3. 页码翻页 / 无限滚动

自带页面用的是「1 2 3 4」页码，直接传 `page`：

```js
let page = 1;

async function goToPage(next) {
  const data = await loadWallpapers({ category: currentTab, page: next });
  page = data.page;
  render(data.items);
  renderPager(data.page, data.pageCount); // 共 4 页就画 4 个数字
}
```

切换分类、排序、搜索时把 `page` 重置成 1。`pageCount` 由 `total / limit` 算好，不用自己猜。

如果更想要「加载更多」的无限滚动，继续用 `nextCursor`（复合游标，不要自己拆）：

```js
let cursor = null;

async function loadMore() {
  const data = await loadWallpapers({ category: currentTab, cursor });
  render(data.items);
  cursor = data.nextCursor;
  hasMore = data.hasMore;
}
```

两种模式不要混用：`page` 是 offset 分页，新增壁纸会让后面的页码整体后移；`cursor` 不会。页码模式适合有明确页数、需要跳页的场景。

## 4. 收藏仍然是本地的

`收藏` tab 不需要后端：

```js
const KEY = 'folia:favorites';
const favorites = new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'));

function toggleFavorite(id) {
  favorites.has(id) ? favorites.delete(id) : favorites.add(id);
  localStorage.setItem(KEY, JSON.stringify([...favorites]));
}
```

如果以后要跨设备同步收藏，那需要真正的用户体系（访客账号），别复用后台的 `users` 表——后台账号是管理员/编辑，不该和访客混在一起。

## 5. "复制轮换链接"这类功能

现有页面上的轮换列表是纯前端状态（最多 20 张）。切到 API 后，把轮换列表里存的从"文件名"改成 `item.id` 或 `item.slug`，链接里编码 id 列表即可，后端不需要新接口。

## 6. 缩略图提醒

现在 `/media/*` 出的是原图。壁纸动辄 4K，一屏 24 张会吃掉几十 MB。上线前值得做一件事：

- 要么 `Cloudflare Images` 给出 `?width=480` 变体；
- 要么上传时用 `sharp` 生成一份 480w 的 WebP 存到 R2 的 `thumbs/` 前缀。

在没做之前，列表用 `loading="lazy"` + `decoding="async"` 先顶着，并且把 `width`/`height` 写进 `<img>`，避免 CLS。

## 7. 切流量的顺序

1. 后台先跑起来，导一批图，确认 `/api/public/wallpapers` 有数据；
2. 前台新加一个隐藏开关（比如 `?source=api`），用它渲染，肉眼对比；
3. 一致了再把默认数据源切过去，删掉旧的写死数组；
4. 旧数组先留一个版本，出问题能一键回退。

不要一次同时改数据源和布局——出问题会分不清是谁的锅。

## 8. 编辑模式的接入契约

画廊和编辑器是两个文件，靠一个事件 + 一个门面沟通，互不 import：

- `gallery.js` 在 `renderGrid()` 结束时派发 `folia:grid`（`detail.items` 是当前列表）；
- `gallery.js` 把 `{ state, toast, setEditing, refresh, refreshCategories, has(cap), currentCategory() }` 交给 `mountEditor()`；
- `editor.js` 只在 `/api/auth/me` 证明有 `wallpaper:create|update` 权限后才被动态 `import`——没权限的成员连这段代码都不会下载。

编辑器自己负责卡片操作条、上传、分类管理；它不直接改 `#grid` 的 HTML，只往卡片里追加 `.card-admin` / `.admin-status`。所以以后重做卡片布局，只要还派发 `folia:grid`，编辑功能不会跟着碎。

