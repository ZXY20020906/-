/**
 * 前台壁纸库。所有内容来自 /api/public/*，图片和视频来自 R2（/media/* 或自定义域名）。
 * 页面本身不含任何壁纸资源 —— 换壁纸只动 R2 和 D1，不用重新部署。
 */
import {
  ASPECT_KEYS,
  FAVORITES_KEY,
  absoluteUrl,
  aspectKeyFor,
  downloadUrl,
  extensionForMime,
  formatBytes,
  formatDimensions,
  formatDuration,
  matchesAspect,
  mediaKind,
  cardBadge,
  isPetItem,
  parseFavoriteList,
  qualityLabel,
  stepIndex,
  toggleFavorite,
} from './gallery-core.js';

/** 每页多少张：由「当前列数 × 行数」决定，尽量填满，不留半截行 */
const PAGE_ROWS = 4;
const CARD_MIN_WIDTH = 260;
const CARD_MIN_WIDTH_COMPACT = 220;
const GRID_GAP = 14;
let activePageSize = 24;
const MAX_FAVORITES = 60;
/** 这个分类是「开机动画」模块，用竖屏卡片、强调时长与下载 */
const BOOT_CATEGORY = 'boot-animation';
/** 「喜欢」不是内容标签，是本地集合，用哨兵值当筛选条件 */
const FAVORITE_TAG = '__favorites__';
/** slug → 分类 slug，用来按模块统计喜欢数量（存在本机，避免每次刷新都重新解析） */
const FAVORITE_META_KEY = 'folia:favorite-meta';

const state = {
  categories: [],
  tab: '',
  sort: 'recent',
  q: '',
  type: '',
  aspect: '',
  tag: '',
  subtag: '',
  subtags: [],
  tags: [],
  items: [],
  page: 1,
  pageCount: 0,
  total: 0,
  loading: false,
  favorites: [],
  favoriteMeta: {},
  cache: new Map(),
  viewerList: [],
  viewerIndex: -1,
  /** 登录成员 + 编辑模式：站点本身就是管理台，不再是两个页面 */
  user: null,
  editing: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const isMotionModule = () => state.tab === BOOT_CATEGORY;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toasts').appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

async function api(path, { method = 'GET' } = {}) {
  if (staticCatalog) return fromCatalog(path);
  const response = await fetch(`/api${path}`, {
    method,
    headers: { accept: 'application/json', 'x-folia-client': 'admin' },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok === false) {
    throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
  }
  return payload.data;
}

/**
 * 静态模式：站点没有后端（没有 D1）时，退回到一份 catalog.json。
 * 这样同一套前端既能跑完整后台，也能纯静态托管。
 */
let staticCatalog = null;

async function detectMode() {
  try {
    const response = await fetch('/api/meta', { headers: { accept: 'application/json' } });
    // Pages 会把未知路径回退成 index.html，所以必须看 content-type，不能只看 status
    const type = response.headers.get('content-type') ?? '';
    if (response.ok && type.includes('application/json')) {
      const payload = await response.json();
      if (payload && payload.ok) return;
    }
  } catch {
    /* 忽略，走静态 */
  }
  const response = await fetch('/data/catalog.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('站点没有可用的数据源');
  staticCatalog = await response.json();
}

function fromCatalog(path) {
  const [route, query] = path.split('?');
  const params = new URLSearchParams(query ?? '');

  if (route === '/public/categories') {
    return { categories: staticCatalog.categories };
  }

  if (route === '/public/tags') {
    const counts = new Map();
    for (const item of staticCatalog.wallpapers) {
      for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return {
      tags: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
        .map(([tag, count]) => ({ tag, count })),
      aspects: ASPECT_KEYS,
    };
  }

  if (route === '/public/wallpapers') {
    const category = params.get('category');
    const kind = params.get('kind');
    const keyword = params.get('q');
    const sort = params.get('sort') ?? 'recent';
    const limit = Number(params.get('limit') ?? 24) || 24;
    const requestedPage = Math.max(1, Math.trunc(Number(params.get('page'))) || 1);

    let items = staticCatalog.wallpapers.slice();
    if (category) items = items.filter((item) => item.category && item.category.slug === category);
    if (kind) items = items.filter((item) => item.kind === kind);
    if (keyword) items = items.filter((item) => item.title.includes(keyword));
    const tag = params.get('tag');
    if (tag) items = items.filter((item) => (item.tags ?? []).includes(tag));
    const aspect = params.get('aspect');
    if (aspect) items = items.filter((item) => matchesAspect(item, aspect));

    const score = (item) => (item.width ?? 0) * (item.height ?? 0);
    const order = {
      recent: (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
      oldest: (a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0),
      name: (a, b) => a.title.localeCompare(b.title, 'zh'),
      size: (a, b) => b.bytes - a.bytes,
      resolution: (a, b) => score(b) - score(a),
    }[sort] ?? (() => 0);
    items.sort(order);

    const total = items.length;
    const pageCount = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pageCount);
    const offset = (page - 1) * limit;
    return {
      items: items.slice(offset, offset + limit),
      total,
      hasMore: page < pageCount,
      nextCursor: null,
      page,
      pageSize: limit,
      pageCount,
      offset,
      sort,
    };
  }

  const single = /^\/public\/wallpapers\/(.+)$/.exec(route);
  if (single) {
    const slug = decodeURIComponent(single[1]);
    const item = staticCatalog.wallpapers.find((entry) => entry.slug === slug);
    if (!item) throw new Error('壁纸不存在或尚未发布');
    return { wallpaper: item };
  }

  throw new Error('静态模式不支持这个接口');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'ok');
    return;
  } catch {
    /* 老浏览器 / 非安全上下文走兜底 */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
    toast(message, 'ok');
  } catch {
    toast('复制失败，请手动复制地址栏', 'error');
  }
  area.remove();
}

// ------------------------------------------------------------------ 持久化
function persist() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
  syncHash();
}

function parseFavoriteMeta(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** 每条喜欢记一下它属于哪个分类，筛选栏角标才能按模块算。 */
function persistFavoriteMeta() {
  try {
    localStorage.setItem(FAVORITE_META_KEY, JSON.stringify(state.favoriteMeta));
  } catch {
    /* 隐私模式忽略 */
  }
}

function syncHash() {
  // 只改自己负责的参数，别把 ?page= 这类别的状态一起冲掉
  const params = new URLSearchParams(location.search);
  if (state.tab) params.set('cat', state.tab);
  else params.delete('cat');
  if (state.editing) params.set('edit', '1');
  else params.delete('edit');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// -------------------------------------------------------------------- 数据
function remember(items) {
  for (const item of items) state.cache.set(item.slug, item);
}

async function loadCategories() {
  const data = await api('/public/categories');
  state.categories = data.categories;
}

// --------------------------------------------------------- 编辑模式（前台即后台）
/** 能改内容的人才看到编辑入口；其余成员仍然只是浏览。 */
function canManageContent(user) {
  if (!user || !Array.isArray(user.capabilities)) return false;
  return user.capabilities.some((cap) => (
    cap === 'wallpaper:create' || cap === 'wallpaper:update:any' || cap === 'wallpaper:update:own'
  ));
}

/** 当前布局一行能放几张卡（和 site.css 里 auto-fill 的 minmax 规则保持一致）。 */
function gridColumns() {
  const grid = $('#grid');
  const width = grid ? grid.clientWidth : window.innerWidth;
  const min = isMotionModule() ? CARD_MIN_WIDTH_COMPACT : CARD_MIN_WIDTH;
  return Math.max(1, Math.floor((width + GRID_GAP) / (min + GRID_GAP)));
}

/** 每页 = 列数 × 行数；上限 100 是接口允许的最大 limit。 */
function pageSize() {
  return Math.min(100, Math.max(1, gridColumns() * PAGE_ROWS));
}

/**
 * 编辑模式下列表换成管理接口：草稿、下线的作品也要能看见，否则「改」无从谈起。
 * 管理接口本来就是 offset 分页，直接按页码取。
 */

async function setEditing(on) {
  state.editing = Boolean(on) && canManageContent(state.user);
  if (state.editing) {
    // 标签 / 分辨率筛选只有公开接口认，编辑模式下先清掉，免得界面显示的条件和结果对不上
    state.tag = '';
    state.aspect = '';
  }
  document.body.classList.toggle('editing', state.editing);
  renderTabs();
  renderFilters();
  renderModuleNote();
  // 进出编辑模式都留在当前页：翻到第 5 页再点编辑，不该被弹回第一页
  const page = state.page;
  const scrollY = window.scrollY;
  await loadList({ page });
  window.scrollTo({ top: scrollY, behavior: 'instant' });
}

/** 公开列表的查询参数。页码从 1 开始，每页固定 PAGE_SIZE。 */
function publicListParams(page) {
  const params = new URLSearchParams({
    sort: state.sort,
    limit: String(activePageSize),
    page: String(page),
  });
  if (state.tab) params.set('category', state.tab);
  if (state.q) params.set('q', state.q);
  if (state.type) params.set('kind', state.type);
  if (state.aspect) params.set('aspect', state.aspect);
  if (state.tag) params.set('tag', state.tag);
  if (state.subtag) params.set('subtag', state.subtag);
  return params;
}

async function fetchPublicList(page) {
  const data = await api(`/public/wallpapers?${publicListParams(page).toString()}`);
  remember(data.items);
  return data;
}

/**
 * 并发的列表请求不要互相踩：用令牌标记「最新一次」。
 * 之前是 state.loading 直接 return，快速点「喜欢」/切 tab 时，后一次会被静默丢掉，
 * 结果就是角标显示 2、列表却停在上一次的空白状态。
 */
let listToken = 0;

async function loadList({ page = state.page } = {}) {
  const token = ++listToken;
  state.loading = true;
  // 每次加载重新算一遍：列数变了（窗口缩放、模块切换）每页数量也要跟着变
  activePageSize = pageSize();
  state.page = Math.max(1, Math.trunc(Number(page)) || 1);
  state.items = [];
  renderSkeletons();
  renderPager();
  try {
    if (state.tag === FAVORITE_TAG) {
      await loadFavorites();
    } else if (state.editing) {
      // 编辑模式只用公开口径那张表（与画廊完全同源）：
      // 未上线/草稿/未审核不进前台，避免"编辑模式能看到 155 张、直观看只有 44 张"的错位。
      let data = await fetchPublicList(state.page);
      state.total = Number(data.total ?? data.items.length);
      state.pageCount = Math.max(1, Number(data.pageCount) || Math.ceil(state.total / activePageSize) || 1);
      if (!data.items.length && state.page > state.pageCount) {
        state.page = state.pageCount;
        data = await fetchPublicList(state.page);
      }
      // 公开列表没有 status 字段：能出现在这里就说明是已上线的，补一个标记让 canEditItem 通过
      state.items = data.items.map((item) => ({ ...item, status: 'published' }));
    } else {
      let data = await fetchPublicList(state.page);
      state.total = Number(data.total ?? data.items.length);
      state.pageCount = Math.max(1, Number(data.pageCount) || Math.ceil(state.total / activePageSize) || 1);
      // 页码超出（删图、筛选变化）时退到最后一页
      if (!data.items.length && state.page > state.pageCount) {
        state.page = state.pageCount;
        data = await fetchPublicList(state.page);
      }
      state.items = data.items;
    }
    if (token !== listToken) return;
    renderGrid();
    if (token !== listToken) return;
    renderGrid();
  } catch (error) {
    if (token !== listToken) return;
    state.items = [];
    state.total = 0;
    state.pageCount = 1;
    renderGrid(error.message);
  } finally {
    if (token === listToken) {
      state.loading = false;
      renderPager();
    }
  }
}

/** 收藏是按 slug 存的，这里逐条取；取不到的（已删除/下线）自动清理掉。 */
async function loadFavorites() {
  const slugs = state.favorites.slice(0, MAX_FAVORITES);
  const settled = await Promise.allSettled(
    slugs.map((slug) => api(`/public/wallpapers/${encodeURIComponent(slug)}`).then((data) => data.wallpaper)),
  );
  const items = [];
  const missing = new Set();
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) items.push(result.value);
    else missing.add(slugs[index]);
  });
  if (missing.size) {
    state.favorites = state.favorites.filter((slug) => !missing.has(slug));
    persist();
    renderFilters();
  }
  remember(items);
  // 顺手把每条喜欢归到它的分类下，角标和列表才按同一个口径算
  let metaChanged = false;
  for (const item of items) {
    const slug = item.category ? item.category.slug : '';
    if (state.favoriteMeta[item.slug] !== slug) {
      state.favoriteMeta[item.slug] = slug;
      metaChanged = true;
    }
  }
  if (metaChanged) persistFavoriteMeta();

  const keyword = state.q.trim().toLowerCase();
  state.items = items.filter((item) => {
    // 「喜欢」是模块的子筛选：在桌宠里只列桌宠的喜欢；别的分类的靠角标提示，
    // 未分类的（没有 category）哪个模块都列出来，免得它变得无处可见。
    if (state.tab && item.category && item.category.slug !== state.tab) return false;
    if (keyword && !item.title.toLowerCase().includes(keyword)) return false;
    if (state.type && item.kind !== state.type) return false;
    // FAVORITE_TAG 是「喜欢」的哨兵值，不是真实标签，不能拿去过滤 tags
    if (state.tag && state.tag !== FAVORITE_TAG && !(item.tags ?? []).includes(state.tag)) return false;
    if (!matchesAspect(item, state.aspect)) return false;
    return true;
  });
  state.total = state.items.length;
  // 收藏最多 60 张，一次全显示；页码栏在这个筛选下不出现
  state.page = 1;
  state.pageCount = 1;
  if (missing.size) toast(`有 ${missing.size} 张喜欢已不在库里，已清理`, 'info');
}

/** 未知 / 未分类的喜欢先算进每个模块，免得解析完之前角标闪一下 0。 */
function favoriteInTab(slug, tab) {
  const category = state.favoriteMeta[slug];
  if (!category) return true;
  return category === tab;
}

function favoriteCountForTab() {
  if (!state.tab) return state.favorites.length;
  return state.favorites.filter((slug) => favoriteInTab(slug, state.tab)).length;
}

/**
 * 喜欢改成按账号存在 D1 之后，启动时以服务端为准；
 * 本机 localStorage 里如果还有老版本的记录，顺手推上去（一次性搬家）。
 */
async function syncLikes() {
  const localSlugs = parseFavoriteList(localStorage.getItem(FAVORITES_KEY));
  let server;
  try {
    server = (await api('/likes')).likes ?? [];
  } catch {
    // 离线 / 未登录：继续用本地缓存
    return;
  }
  const known = new Set(server.map((item) => item.slug));
  const pending = localSlugs.filter((slug) => !known.has(slug)).slice(0, MAX_FAVORITES);
  if (pending.length) {
    await Promise.all(pending.map((slug) => (
      api(`/likes/${encodeURIComponent(slug)}`, { method: 'PUT' }).catch(() => null)
    )));
    try {
      server = (await api('/likes')).likes ?? server;
    } catch {
      /* 拉不回来就先用旧列表，下次启动再补 */
    }
  }
  state.favorites = server.map((item) => item.slug);
  state.favoriteMeta = {};
  for (const item of server) state.favoriteMeta[item.slug] = item.categorySlug ?? '';
  persistFavoriteMeta();
  persist(); // 顺手写回本地做离线缓存
}

// -------------------------------------------------------------------- 渲染
function renderTabs() {
  // 只有四个模块，「全部」不再作为入口——默认落在第一个模块
  // 数量取 DTO 里的 publishedCount（= 已发布且有文件的条数），不是 category.count
  $('#tabs').innerHTML = state.categories.map((category) => {
    const count = Number(category.publishedCount ?? category.wallpaperCount ?? 0);
    const active = category.slug === state.tab;
    const hint = category.description ? ` title="${esc(category.description)}"` : '';
    return `<button class="tab" type="button" role="tab" id="tab-${esc(category.slug)}"
      aria-selected="${active}" aria-controls="grid" tabindex="${active ? '0' : '-1'}"
      data-tab="${esc(category.slug)}"${hint}>${esc(category.name)}${
      count ? `<span class="n">${count}</span>` : ''
    }</button>`;
  }).join('');
}

/** 筛选栏：类型 / 分辨率 / 标签，照 Wallpaper Engine 创意工坊那三栏做的 */
function chipHtml(filter, value, label, active) {
  return `<button class="chip${active ? ' active' : ''}" type="button"
    data-filter="${filter}" data-value="${esc(value)}" aria-pressed="${active ? 'true' : 'false'}">${esc(label)}</button>`;
}

function filtersHtml() {
  const favoriteChip = `<button class="chip chip-fav${state.tag === FAVORITE_TAG ? ' active' : ''}" type="button"
    data-filter="tag" data-value="${FAVORITE_TAG}" aria-pressed="${state.tag === FAVORITE_TAG ? 'true' : 'false'}">♥ 喜欢 ${
    favoriteCountForTab()}</button>`;

  const tagRow = [
    chipHtml('tag', '', '全部', !state.tag),
    ...state.tags.map((tag) => chipHtml('tag', tag, tag, state.tag === tag)),
    // 收藏不是标签：用分隔线隔开，免得和恰好叫「收藏」的标签混在一起
    '<span class="filter-sep" aria-hidden="true"></span>',
    favoriteChip,
  ].join('');

  // 子标签：选了标签之后才出现，只列这个标签下有的
  const subtagRow = state.subtags.length
    ? `<div class="filter-row"><span class="filter-label">子标签</span>${[
      chipHtml('subtag', '', '全部', !state.subtag),
      ...state.subtags.map((entry) => chipHtml('subtag', entry.name, `${entry.name} ${entry.count}`, state.subtag === entry.name)),
    ].join('')}</div>`
    : '';

  return `<div class="filter-row"><span class="filter-label">标签</span>${tagRow}</div>${subtagRow}`;
}

function renderFilters() {
  const host = $('#filters');
  if (host) host.innerHTML = filtersHtml();
}

async function loadSubtags() {
  try {
    const params = new URLSearchParams();
    if (state.category) params.set('category', state.category);
    if (state.tag && state.tag !== FAVORITE_TAG) params.set('tag', state.tag);
    const data = await api(`/public/subtags?${params.toString()}`);
    state.subtags = data.subtags ?? [];
  } catch {
    state.subtags = [];
  }
}

async function loadTags() {
  try {
    // 标签现在按分类拆分：全局标签 + 当前模块专属标签（category 为空就返回全部）
    const data = await api('/public/tags?category=' + encodeURIComponent(state.tab || ''));
    state.tags = (data.tags ?? []).map((entry) => entry.tag);
  } catch {
    state.tags = [];
  }
}

function renderSkeletons() {
  $('#grid').classList.toggle('compact', isMotionModule());
  $('#grid').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
  $('#result-count').textContent = state.page > 1 ? `正在加载第 ${state.page} 页…` : '正在加载…';
}

/** 只有「开机动画」模块才显示的那段说明 */
function renderModuleNote() {
  const note = $('#module-note');
  if (!note) return;
  note.hidden = !isMotionModule();
  note.textContent = isMotionModule()
    ? '开机动画视频：每段是一个循环，时长就是循环长度。点开可以下载原片，替换设备上的开机动画文件。'
    : '';
}

function bundleTile(item) {
  return `
    <span class="bundle-tile" aria-hidden="true">
      <span class="bundle-mark">ZIP</span>
      <span class="bundle-note">资源包</span>
      <span class="bundle-size">${esc(formatBytes(item.bytes))}</span>
    </span>`;
}

function cardHtml(item, index) {
  const kind = mediaKind(item);
  const video = kind === 'video';
  const bundle = kind === 'bundle';
  // 桌宠也是 zip 资源包，但展示上要能一眼区分（问题 3）：徽标写「桌宠」，
  // 预览优先用 pet.previewUrl（有的历史数据只有 pet 里带预览、thumbUrl 为空）。
  const pet = item && item.pet && typeof item.pet === 'object' ? item.pet : null;
  const duration = formatDuration(item.durationMs);
  // 徽标统一走 gallery-core 的 cardBadge（桌宠 > 资源包），其余按视频/清晰度
  const badge = cardBadge(item)
    || (video ? (isMotionModule() && duration ? duration : '动态') : qualityLabel(item.width, item.height));
  const favorite = state.favorites.includes(item.slug);
  const spec = pet
    ? [pet.displayName || item.title, pet.tracks ? `${pet.tracks.length} 状态` : '', formatBytes(item.bytes)].filter(Boolean).join(' · ')
    : bundle
      ? formatBytes(item.bytes)
      : [formatDimensions(item.width, item.height), duration, formatBytes(item.bytes)].filter(Boolean).join(' · ');
  const cover = (pet && pet.previewUrl) || item.thumbUrl;
  let media;
  if ((bundle || pet) && cover) {
    // 资源包/桌宠有封面图就显示封面，别用通用 ZIP 磁贴盖住作品本身
    media = `<img src="${esc(cover)}" alt="${esc(item.title)}" loading="lazy" decoding="async">`;
  } else if (bundle || pet) media = bundleTile(item);
  else if (video && item.thumbUrl) {
    // 有封面图就不要再下整段视频了
    media = `<img src="${esc(item.thumbUrl)}" alt="${esc(item.title)}" loading="lazy" decoding="async"
        ${item.width ? `width="${Number(item.width)}" height="${Number(item.height)}"` : ''}>`;
  } else if (video) media = `<video src="${esc(item.url)}" muted playsinline preload="metadata"></video>`;
  else {
    media = `<img src="${esc(item.thumbUrl || item.url)}" alt="${esc(item.title)}" loading="lazy" decoding="async"
        ${item.width ? `width="${Number(item.width)}" height="${Number(item.height)}"` : ''}>`;
  }
  const ratio = item.width && item.height ? `${item.width}/${item.height}` : '';
  return `
    <button class="card" type="button" data-index="${index}" data-slug="${esc(item.slug)}"
      aria-label="${esc(item.title)}，${esc(spec)}"${ratio ? ` style="--ar:${ratio}"` : ''}>
      ${media}
      ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
      <span class="like-btn${favorite ? ' active' : ''}" role="button" tabindex="0"
        data-action="like" data-slug="${esc(item.slug)}"
        aria-label="${favorite ? '取消喜欢' : '喜欢'}">${favorite ? '♥' : '♡'}</span>
      <span class="card-meta">
        <span class="card-title">${esc(item.title)}</span>
        <span class="card-spec">${esc(spec)}</span>
      </span>
    </button>`;
}

function notifyGrid() {
  // 编辑器靠这个事件给卡片挂操作按钮，画廊本身不知道编辑器存在
  document.dispatchEvent(new CustomEvent('folia:grid', { detail: { items: state.items } }));
}

function renderGrid(errorMessage) {
  const grid = $('#grid');
  grid.classList.toggle('compact', isMotionModule());
  if (errorMessage) {
    grid.innerHTML = `<p class="empty">加载失败：${esc(errorMessage)}<br>刷新页面试试。</p>`;
    $('#result-count').textContent = '';
    notifyGrid();
    return;
  }
  if (!state.items.length) {
    const inTab = favoriteCountForTab();
    const message = state.tag === FAVORITE_TAG
      ? (!state.favorites.length
        ? '还没有喜欢的壁纸。点任意一张卡片右上角的 ♡，它就会出现在这里。'
        : inTab > 0
          ? '没有符合条件的喜欢，试着放宽筛选。'
          : `这个分类还没有喜欢的。你在其他分类喜欢了 ${state.favorites.length} 张，切到对应模块就能看到。`)
      : (state.q || state.type || state.aspect || state.tag)
        ? '没有符合条件的壁纸，试着放宽筛选。'
        : state.editing
          ? '这个分类还没有作品。点下面的「上传」把第一张放进来。'
          : '这个分类还没有壁纸。';
    grid.innerHTML = `<p class="empty">${esc(message)}</p>`;
    $('#result-count').textContent = state.tag === FAVORITE_TAG ? '0 张喜欢' : '0 张';
    notifyGrid();
    return;
  }
  grid.innerHTML = state.items.map(cardHtml).join('');
  const paged = state.pageCount > 1 && state.tag !== FAVORITE_TAG;
  $('#result-count').textContent = `共 ${state.total} 张${state.tag === FAVORITE_TAG ? '喜欢' : ''}${
    paged ? ` · 第 ${state.page} / ${state.pageCount} 页` : ''
  }`;
  // 视频缩略图在多数浏览器里要等元数据才出首帧
  $$('img, video', grid).forEach((node) => {
    if (node.complete || node.readyState >= 1) node.classList.add('loaded');
    node.addEventListener('load', () => node.classList.add('loaded'), { once: true });
    node.addEventListener('loadeddata', () => node.classList.add('loaded'), { once: true });
  });
  notifyGrid();
}

/**
 * 分页条：首/末、上一页/下一页，加一个「跳到第 N 页」的输入框。
 * 页数多的时候不再把页码全铺开，直接输数字最省地方。
 */
function renderPager() {
  const pager = $('#pager');
  if (!pager) return;

  const visible = state.pageCount > 1 && state.tag !== FAVORITE_TAG;
  pager.hidden = !visible;
  if (!visible) return;

  const input = $('#pager-input');
  if (input) {
    input.max = String(state.pageCount);
    // 正在输入时别被重绘覆盖
    if (document.activeElement !== input) input.value = String(state.page);
  }
  const total = $('#pager-total');
  if (total) total.textContent = String(state.pageCount);

  const prev = $('.pager-step[data-page="prev"]', pager);
  const next = $('.pager-step[data-page="next"]', pager);
  const first = $('.pager-step[data-page="first"]', pager);
  const last = $('.pager-step[data-page="last"]', pager);
  prev.disabled = state.loading || state.page <= 1;
  next.disabled = state.loading || state.page >= state.pageCount;
  if (first) first.disabled = prev.disabled;
  if (last) last.disabled = next.disabled;
}

function goToPage(target) {
  if (state.loading) return;
  const page = Math.max(1, Math.min(Math.trunc(Number(target)) || 1, Math.max(1, state.pageCount)));
  if (page === state.page && state.items.length) return;
  loadList({ page }).then(() => {
    syncPageUrl(state.page);
    const grid = $('#grid');
    if (!grid) return;
    const top = grid.getBoundingClientRect().top + window.scrollY - 76;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
}

/** 页码写进 URL：刷新或分享链接都能停在同一页；用 replaceState，不塞满后退历史。 */
function syncPageUrl(page) {
  const params = new URLSearchParams(location.search);
  if (page > 1) params.set('page', String(page));
  else params.delete('page');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// ------------------------------------------------------------------ 详情层
function specLine(item) {
  // 桌宠：把"几只/几行×几列/多少状态"说清楚（它也是 zip，但不止是资源包）
  if (item && item.pet && typeof item.pet === 'object') {
    const pet = item.pet;
    const shape = Array.isArray(pet.frames) && pet.frames.length ? `${pet.frames.length} 行 × ${pet.columns || 0} 列` : '';
    const states = Array.isArray(pet.tracks) && pet.tracks.length ? `${pet.tracks.length} 状态` : '';
    return [formatBytes(item.bytes), pet.displayName || item.title, shape, states, '桌宠 ZIP'].filter(Boolean).join(' · ');
  }
  if (mediaKind(item) === 'bundle') {
    return [formatBytes(item.bytes), item.category ? item.category.name : '未分类', 'ZIP 包'].join(' · ');
  }
  const parts = [
    qualityLabel(item.width, item.height),
    formatDimensions(item.width, item.height),
    formatDuration(item.durationMs),
    formatBytes(item.bytes),
    item.category ? item.category.name : '未分类',
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderViewer() {
  const item = state.viewerList[state.viewerIndex];
  if (!item) return;
  const stage = $('#viewer-stage');
  const kind = mediaKind(item);
  const bundle = kind === 'bundle';

  if (bundle) {
    stage.innerHTML = `
      <div class="bundle-preview">
        <span class="bundle-mark">ZIP</span>
        <p>资源包，不能在线预览</p>
        <p class="muted">${esc(formatBytes(item.bytes))} · 下载后按说明解压使用</p>
      </div>`;
  } else if (kind === 'video') {
    stage.innerHTML = `<video src="${esc(item.url)}" controls autoplay muted loop playsinline></video>`;
  } else {
    stage.innerHTML = `<img src="${esc(item.url)}" alt="${esc(item.title)}">`;
  }

  $('#viewer-title').textContent = item.title;
  const viewerDesc = $('#viewer-desc');
  if (viewerDesc) {
    viewerDesc.textContent = item.description || '';
    viewerDesc.hidden = !item.description;
  }
  $('#viewer-spec').textContent = `${specLine(item)}${state.viewerList.length > 1
    ? `　·　${state.viewerIndex + 1} / ${state.viewerList.length}` : ''}`;

  const favorite = state.favorites.includes(item.slug);
  $('#viewer-favorite').textContent = favorite ? '★ 已喜欢' : '☆ 喜欢';


  // 包和开机动画都要能"下载到设备"，按钮文案要说清楚
  const applyButton = $('[data-action="apply"]');
  const openButton = $('[data-action="open-original"]');
  if (applyButton) applyButton.textContent = bundle ? '复制下载直链' : '应用（复制直链）';
  if (openButton) {
    if (bundle) openButton.textContent = isPetItem(item) ? '下载桌宠包' : '下载文件';
    else if (kind === 'video' && isMotionModule()) openButton.textContent = '下载视频';
    else openButton.textContent = '打开原图';
  }
}

function openViewer(list, index) {
  if (!list.length) return;
  state.viewerList = list;
  state.viewerIndex = Math.max(0, Math.min(index, list.length - 1));
  renderViewer();
  const dialog = $('#viewer');
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeViewer() {
  const dialog = $('#viewer');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  $('#viewer-stage').innerHTML = '';
}

function stepViewer(delta) {
  if (state.viewerIndex < 0) return;
  const next = stepIndex(state.viewerList.length, state.viewerIndex, delta);
  if (next < 0) return;
  state.viewerIndex = next;
  renderViewer();
}

async function openBySlug(slug) {
  let item = state.cache.get(slug);
  if (!item) {
    try {
      const data = await api(`/public/wallpapers/${encodeURIComponent(slug)}`);
      item = data.wallpaper;
      remember([item]);
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
  }
  // 轮换列表已移除：详情层永远跟着当前列表走
  const list = state.items;
  const index = list.findIndex((entry) => entry.slug === slug);
  openViewer(index >= 0 ? list : [item], index >= 0 ? index : 0);
}

// -------------------------------------------------------------------- 动作
function toggleLike(slug, { refreshViewer = false } = {}) {
  if (!slug) return false;
  const result = toggleFavorite(state.favorites, slug);
  state.favorites = result.list;
  // 记下它属于哪个分类，角标才能按模块算
  if (result.added) {
    const item = state.cache.get(slug);
    state.favoriteMeta[slug] = item && item.category ? item.category.slug : (state.favoriteMeta[slug] ?? '');
  } else {
    delete state.favoriteMeta[slug];
  }
  persist();
  persistFavoriteMeta();
  renderFilters();

  // 同步到服务端（按账号存）；失败就回滚本地，避免这边显示已喜欢、换台设备又没了
  api(`/likes/${encodeURIComponent(slug)}`, { method: result.added ? 'PUT' : 'DELETE' }).catch((error) => {
    // 回滚到请求前的状态
    state.favorites = toggleFavorite(state.favorites, slug).list;
    if (result.added) delete state.favoriteMeta[slug];
    persist();
    persistFavoriteMeta();
    renderFilters();
    if (state.tag === FAVORITE_TAG) loadList({ page: 1 });
    else renderGrid();
    toast(`喜欢没同步成功：${error.message}`, 'error');
    return false;
  });

  if (refreshViewer) renderViewer();
  if (state.tag === FAVORITE_TAG) loadList({ page: 1 });
  else renderGrid();
  toast(result.added ? '已喜欢' : '已取消喜欢', 'ok');
  return result.added;
}

function toggleCurrentFavorite() {
  const item = state.viewerList[state.viewerIndex];
  if (item) toggleLike(item.slug, { refreshViewer: true });
}

function switchTab(tab) {
  if (tab === state.tab) return;
  state.tab = tab;
  renderTabs();
  renderModuleNote();
  renderFilters(); // 「喜欢」角标按模块算，切 tab 要跟着变
  // 标签也按分类走：这个模块可能有自己的标签
  loadTags().then(renderFilters).catch(() => {});
  syncHash();
  loadList({ page: 1 });
}

/**
 * 前台即后台：站点本来就是「登录才能看」，所以这里直接问一句「我是谁」，
 * 有写权限的人就把编辑器挂上来。没有后台权限的成员看到的还是纯画廊。
 */
async function detectUser() {
  try {
    const data = await api('/auth/me');
    state.user = data.user ?? null;
  } catch {
    state.user = null;
  }
  if (!canManageContent(state.user)) return;
  try {
    const mod = await import('./editor.js');
    mod.mountEditor(createFacade());
  } catch (error) {
    console.warn('[editor] 编辑器加载失败', error);
  }
}

/** 给编辑器的最小接口：它不碰内部实现，只通过这几个口子改状态。 */
function createFacade() {
  return {
    state,
    toast,
    esc,
    formatBytes,
    setEditing,
    refresh: () => loadList({ page: state.page }),
    refreshCategories: async () => {
      await loadCategories();
      renderTabs();
    },
    canManage: () => canManageContent(state.user),
    has: (cap) => Boolean(state.user && state.user.capabilities.includes(cap)),
    currentCategory: () => state.categories.find((item) => item.slug === state.tab) ?? null,
  };
}

function boot() {
  state.favorites = parseFavoriteList(localStorage.getItem(FAVORITES_KEY));
  state.favoriteMeta = parseFavoriteMeta(localStorage.getItem(FAVORITE_META_KEY));

  // /?cat=boot-animation 这样的深链，可以直接把某个模块发给别人
  const requestedTab = new URLSearchParams(location.search).get('cat');
  if (requestedTab) state.tab = requestedTab;

  // /?page=3 深链：刷新或分享时停在同一页
  const requestedPage = Math.trunc(Number(new URLSearchParams(location.search).get('page'))) || 1;
  if (requestedPage > 1) state.page = requestedPage;

  // 我是谁？有写权限就把编辑器挂上来（在数据加载之后再动界面，避免闪一下）
  detectUser();

  detectMode()
    .then(() => loadCategories())
    .then(async () => {
      if (state.tab && !state.categories.some((category) => category.slug === state.tab)) {
        state.tab = '';
      }
      // 没有「全部」入口了，默认进第一个模块
      if (!state.tab) state.tab = state.categories[0]?.slug ?? '';
      renderTabs();
      renderModuleNote();
      await loadTags();
      // 喜欢以服务端为准；本机老记录会顺手搬上去
      await Promise.race([
        syncLikes(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      renderFilters();
      return loadList({ page: state.page }).then(() => syncPageUrl(state.page));
    })
    .catch((error) => {
      $('#grid').innerHTML = `<p class="empty">加载失败：${esc(error.message)}</p>`;
      $('#result-count').textContent = '';
    });

  // ---- 委托事件 ----
  document.addEventListener('click', (event) => {
    // 筛选栏
    const chipEl = event.target.closest('.chip[data-filter]');
    if (chipEl) {
      const key = chipEl.dataset.filter;
      const value = chipEl.dataset.value ?? '';
      if (key === 'type') state.type = value;
      else if (key === 'aspect') state.aspect = value;
      else if (key === 'tag') {
        state.tag = value;
        state.subtag = '';
        loadSubtags().then(renderFilters).catch(() => {});
      } else if (key === 'subtag') state.subtag = value;
      renderFilters();
      loadList({ page: 1 });
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action) {
      const name = action.dataset.action;
      if (name === 'copy-link') {
        copyText(location.href, '链接已复制');
        return;
      }
      if (name === 'help') {
        const dialog = $('#help-dialog');
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        return;
      }
      if (name === 'like') {
        event.stopPropagation();
        toggleLike(action.dataset.slug);
        return;
      }
      if (name === 'prev') { stepViewer(-1); return; }
      if (name === 'next') { stepViewer(1); return; }
      if (name === 'close-viewer') { closeViewer(); return; }
      if (name === 'favorite') { toggleCurrentFavorite(); return; }
      if (name === 'apply') {
        const item = state.viewerList[state.viewerIndex];
        if (item) copyText(absoluteUrl(item.url, location.origin), '直链已复制');
        return;
      }
      if (name === 'open-original') {
        const item = state.viewerList[state.viewerIndex];
        if (!item) return;
        const kind = mediaKind(item);
        const shouldDownload = kind === 'bundle' || (kind === 'video' && isMotionModule());
        if (shouldDownload) {
          const ext = extensionForMime(item.mime);
          const filename = ext ? `${item.title}.${ext}` : item.title;
          window.location.href = downloadUrl(item.url, location.origin, filename);
        } else {
          window.open(absoluteUrl(item.url, location.origin), '_blank', 'noopener');
        }
        return;
      }
      return;
    }

    const tab = event.target.closest('.tab');
    if (tab) {
      switchTab(tab.dataset.tab ?? '');
      return;
    }

    const card = event.target.closest('.card');
    if (card) {
      const index = Number(card.dataset.index);
      openViewer(state.items, Number.isInteger(index) ? index : 0);
      return;
    }

    const rot = event.target.closest('.rot-item');
    if (rot) openBySlug(rot.dataset.slug);
  });

  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    loadList({ page: 1 });
  });

  let searchTimer = null;
  $('#search').addEventListener('input', (event) => {
    const value = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = value;
      loadList({ page: 1 });
    }, 260);
  });

  $('#pager').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button || button.disabled) return;
    const value = button.dataset.page;
    if (value === 'prev') goToPage(state.page - 1);
    else if (value === 'next') goToPage(state.page + 1);
    else if (value === 'first') goToPage(1);
    else if (value === 'last') goToPage(state.pageCount);
    else goToPage(Number(value));
  });

  // 跳页输入框：回车或失焦生效
  const pagerInput = $('#pager-input');
  if (pagerInput) {
    const jump = () => {
      const value = Number(pagerInput.value);
      if (!Number.isFinite(value) || value < 1) return;
      goToPage(value);
    };
    pagerInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      jump();
      pagerInput.blur();
    });
    pagerInput.addEventListener('change', jump);
  }

  // 窗口宽度变了，每页张数跟着变；列数没变就不重新加载
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (pageSize() !== activePageSize) goToPage(1);
    }, 250);
  });

  document.addEventListener('keydown', (event) => {
    if ($('#viewer').open) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepViewer(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepViewer(1); }
      return;
    }
    // 分类 tab：← → 切换，Home / End 跳到首尾（和原生 tablist 的键盘习惯一致）
    const tab = event.target.closest && event.target.closest('#tabs .tab');
    if (!tab) return;
    const tabs = $$('#tabs .tab');
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const slug = tabs[next].dataset.tab ?? '';
    switchTab(slug);
    const fresh = $$('#tabs .tab').find((node) => node.dataset.tab === slug);
    if (fresh) fresh.focus();
  });

  $('#viewer').addEventListener('close', () => {
    $('#viewer-stage').innerHTML = '';
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
