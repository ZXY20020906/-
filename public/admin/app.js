/* Folia 壁纸管理后台 —— 无构建、无依赖，直接由 Pages 静态托管。 */
(() => {
  'use strict';

  const state = {
    user: null,
    view: 'wallpapers',
    categories: [],
    wallpapers: { items: [], total: 0 },
    members: [],
    audit: [],
    filters: { q: '', status: '', review: '', categoryId: '', tag: '', subtag: '', format: '', needsVariant: false },
    tagVocabulary: [],
    tags: [],
    subtags: [],
    tagModule: '',
    importDirs: [],
    booted: false,
  };

  // --------------------------------------------------------------- 基础工具
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

  const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,application/zip,.zip';

  function isBundleAsset(item) {
    return item && item.mime === 'application/zip';
  }

  function thumbHtml(item) {
    if (!item.url) return '<div class="thumb-empty">无文件</div>';
    // 有封面就显示封面，资源包和视频都一样
    const cover = item.thumbUrl && item.thumbUrl !== item.url ? item.thumbUrl : null;
    if (cover) return `<img class="thumb" src="${esc(cover)}" alt="" loading="lazy">`;
    if (isBundleAsset(item)) return '<div class="thumb-bundle">ZIP</div>';
    if (item.mime && item.mime.startsWith('video/')) {
      return `<video class="thumb" src="${esc(item.url)}" muted playsinline preload="metadata"></video>`;
    }
    return `<img class="thumb" src="${esc(item.url)}" alt="" loading="lazy">`;
  }

  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
    return `${Math.floor(value / 60_000)}:${String(Math.round((value % 60_000) / 1000)).padStart(2, '0')}`;
  }

  function formatBytes(n) {
    const value = Number(n || 0);
    if (!value) return '—';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatTime(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  const STATUS_LABEL = { published: '已发布', draft: '草稿', hidden: '已下线' };
  /** 创意工坊的标签 → 站内标签名（没映射到的就丢掉） */
  const WE_TAG_MAP = {
    Anime: '动漫',
    Cartoon: '动漫',
    Game: '游戏',
    Girls: '明星',
    Girl: '明星',
    Fantasy: '自然风景',
    Nature: '自然风景',
    Abstract: '自然风景',
    Landscape: '自然风景',
  };
  const ROLE_LABEL = { admin: '管理员', editor: '编辑' };
  const AUDIT_LABEL = {
    'auth.login': '登录',
    'auth.login_failed': '登录失败',
    'auth.logout': '退出',
    'auth.password_changed': '修改密码',
    'auth.setup': '初始化',
    'wallpaper.create': '新建壁纸',
    'wallpaper.update': '更新壁纸',
    'wallpaper.asset_upload': '上传文件',
    'wallpaper.delete': '删除壁纸',
    'wallpaper.reorder': '壁纸排序',
    'category.create': '新建分类',
    'category.update': '更新分类',
    'category.delete': '删除分类',
    'category.reorder': '分类排序',
    'member.create': '新增成员',
    'member.update': '更新成员',
    'member.delete': '删除成员',
  };

  const isAdmin = () => Boolean(state.user && state.user.capabilities.includes('member:manage'));
  const canPublish = () => Boolean(state.user && state.user.capabilities.includes('wallpaper:publish'));

  // ------------------------------------------------------------------ 请求
  async function api(path, options = {}) {
    const { method = 'GET', body, raw = false, headers = {} } = options;
    const init = {
      method,
      credentials: 'same-origin',
      headers: { 'x-folia-client': 'admin', ...headers },
    };
    if (body !== undefined && !raw) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`/api${path}`, init);
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status === 401) {
      state.user = null;
      showAuth('login');
      throw new Error('登录已过期，请重新登录');
    }
    if (!response.ok || !payload || payload.ok === false) {
      const error = new Error((payload && payload.error && payload.error.message) || `请求失败（${response.status}）`);
      error.status = response.status;
      error.details = payload && payload.error ? payload.error.details : null;
      error.code = payload && payload.error ? payload.error.code : null;
      throw error;
    }
    return payload.data;
  }

  // ------------------------------------------------------------------ 上传前查重（阶段五）
  /**
   * 多大的文件改走「采样指纹」。与 `core/media-limits.js` 的 HASH_LIMIT_BYTES 同一个数：
   * 40MB 以内整文件算 sha256，超过就只取首尾各 1MB —— Worker 那边 128MB 内存同样装不下。
   */
  const HASH_LIMIT_BYTES = 40 * 1024 * 1024;

  async function sha256HexOf(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 文件摘要：小文件整段 sha256，大文件首尾各 1MB 的采样指纹。
   * 口径必须和服务端一致，否则「查重说没有、导入说重复」会来回打脸：
   *   sha256       ↔ ingest 的 `sha256Bytes()`
   *   fingerprint  ↔ ingest 的 `sampleFingerprint()`
   */
  async function fileDigest(file) {
    if (file.size <= HASH_LIMIT_BYTES) {
      return { mode: 'sha256', value: await sha256HexOf(await file.arrayBuffer()) };
    }
    const chunk = 1024 * 1024;
    const head = new Uint8Array(await file.slice(0, chunk).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - chunk)).arrayBuffer());
    const merged = new Uint8Array(head.length + tail.length);
    merged.set(head, 0);
    merged.set(tail, head.length);
    return { mode: 'fingerprint', value: await sha256HexOf(merged) };
  }

  /**
   * 问服务端「这个文件是不是已经有了」。命中就直接复用，一个字节都不传。
   * 查重失败按「没重复」处理：它是优化项，不能把正常上传卡死。
   */
  async function findDuplicate(entry) {
    try {
      const digest = entry.digest || await fileDigest(entry.file);
      entry.digest = digest;
      const data = await api('/admin/wallpapers/duplicate-check', {
        method: 'POST',
        body: {
          sha256: digest.mode === 'sha256' ? digest.value : undefined,
          fingerprint: digest.mode === 'fingerprint' ? digest.value : undefined,
          bytes: entry.file.size,
          title: entry.title,
        },
      });
      return data.duplicate;
    } catch (error) {
      console.warn('[dedupe] 查重失败，按未重复处理', error.message);
      return null;
    }
  }

  /** 把接口异常翻译成「人话」，批量导入的失败原因直接展示这一句。 */
  function describeImportError(error) {
    const status = error && error.status;
    if (status === 413) return '文件太大（413）';
    if (status === 422) return `体检未通过（422）：${error.message}`;
    if (status === 403) return '没有权限（403）';
    if (status === 401) return '登录已过期（401）';
    if (status === 429) return '太频繁了（429），稍后再试';
    if (!status) return `网络中断：${error && error.message ? error.message : '连接失败'}`;
    return `${status}：${error.message || '导入失败'}`;
  }

  /**
   * 缩略图：Worker 里没有图像解码能力，所以在浏览器用 canvas 生成。
   * 图片直接缩放；视频抓 0.5 秒处的一帧（列表页就不用下整段 mp4 了）。
   *
   * 4.23.18 起统一到 **1280 宽**：批量入口（目录扫描 / 批量导入）与服务端
   * `ingestAsset()` 的 THUMB_WIDTH 是同一个口径，2x 屏的卡片也不会糊。
   */
  const THUMB_WIDTH = 1280;

  function drawThumb(source, maxWidth = THUMB_WIDTH) {
    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    if (!sw || !sh) return Promise.resolve(null);
    const scale = Math.min(1, maxWidth / sw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.82));
  }

  async function videoFrame(file, maxWidth = THUMB_WIDTH) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    try {
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('视频无法解码'));
        setTimeout(() => reject(new Error('视频读取超时')), 8000);
      });
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
        setTimeout(resolve, 2500);
      });
      return await drawThumb(video, maxWidth);
    } catch (error) {
      console.warn('[thumb] 视频抽帧失败', error.message);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function makeThumbnail(file, maxWidth = THUMB_WIDTH) {
    if (!file) return null;
    if (file.type.startsWith('video/')) return videoFrame(file, maxWidth);
    if (!file.type.startsWith('image/')) return null;
    try {
      const bitmap = await createImageBitmap(file);
      const blob = await drawThumb(bitmap, maxWidth);
      if (bitmap.close) bitmap.close();
      return blob;
    } catch {
      return null;
    }
  }

  async function putThumb(wallpaperId, blob) {
    if (!blob) return false;
    try {
      const response = await fetch(`/api/admin/wallpapers/${encodeURIComponent(wallpaperId)}/thumb`, {
        method: 'PUT',
        headers: { 'x-folia-client': 'admin', 'content-type': blob.type || 'image/webp' },
        body: blob,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || `HTTP ${response.status}`);
      }
      return true;
    } catch (error) {
      console.warn('[thumb] 上传失败', error.message);
      return false;
    }
  }

  /** 传完原图顺手把缩略图也传上去；大文件走分片并跳过浏览器抽帧 */
  async function putAssetWithThumb(wallpaperId, file, onProgress) {
    const large = file.size > MULTIPART_THRESHOLD;
    const thumb = large ? null : await makeThumbnail(file);
    if (large) await putAssetChunked(wallpaperId, file, onProgress);
    else await putAsset(wallpaperId, file, onProgress);
    if (thumb) await putThumb(wallpaperId, thumb);
    return thumb ? thumb.size : 0;
  }

  // ------------------------------------------------------------------ 批量入库
  /**
   * 批量入口（「立即扫描 / 添加目录」+「批量导入本地文件」）**只走一个接口**：
   *   POST /api/admin/wallpapers/import   （multipart：file + thumb + variant + 元数据）
   *
   * 服务端那一步是 `src/server/ingest.js` 的 ingestAsset()——和单条 `PUT /asset`
   * **同一个入库管线**：合规体检（422 的那道闸门）、sha256/采样指纹、HEAD 回读、
   * 缩略图、1080p 变体、必填字段门。所以批量入口不可能再「绕过体检」把 4K@60 塞进库。
   *
   * 与老写法（先 POST 建草稿、再 PUT /asset）的两个差别：
   *   1. **失败不留空草稿**：服务端在同一次调用里建行 + 入库，失败会回滚行；
   *   2. **返回导入报告**：每条的成功/失败原因/自动修正项，界面直接列出来。
   */
  const IMPORT_AUTOFIX_LABEL = {
    faststart: '转封装（moov 前置）',
    fps30: '降帧到 30fps',
    variant1080p: '生成 1080p 变体',
    thumb: '生成缩略图',
    thumbFromOriginal: '缩略图用原图',
    sampleFingerprint: '改用采样指纹',
  };
  /** 准备上传时一起给的 1080p 变体命名：`xxx.1080p.mp4` / `xxx.720p.webm` */
  const VARIANT_NAME_RE = /\.(\d{3,4})p\.(mp4|webm)$/i;
  const variantBase = (name) => String(name).replace(VARIANT_NAME_RE, '').replace(/\.(mp4|webm)$/i, '');

  async function importEntry(entry, { categoryId, publish, reportId }) {
    const form = new FormData();
    form.append('title', entry.title);
    form.append('kind', entry.kind || 'static');
    form.append('categoryId', categoryId || '');
    form.append('tags', JSON.stringify(entry.tags || []));
    form.append('publish', publish ? '1' : '0');
    form.append('reportId', reportId);
    form.append('file', entry.file, entry.file.name);
    // 缩略图在浏览器生成（Worker 没有解码器）：1280 宽 WebP，视频抓 0.5s 的一帧
    const thumb = await makeThumbnail(entry.file, THUMB_WIDTH).catch(() => null);
    if (thumb) form.append('thumb', thumb, 'thumb.webp');
    for (const variant of entry.variants || []) {
      if (variant && variant.name) form.append('variant', variant, variant.name);
    }
    const data = await api('/admin/wallpapers/import', { method: 'POST', raw: true, body: form });
    return data.item;
  }

  function summarizeImport(reportId, items) {
    return {
      ok: items.every((item) => item.status !== 'failed'),
      reportId,
      imported: items.filter((item) => item.status === 'imported').length,
      reused: items.filter((item) => item.status === 'reused').length,
      failed: items.filter((item) => item.status === 'failed').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      items,
    };
  }

  /** 并发度：2 个文件同时传。再高会把上行带宽切成碎片，单条反而更慢。 */
  const IMPORT_CONCURRENCY = 2;

  /**
   * 并发跑一组导入任务（阶段五重写）。
   *
   * 三条规则：
   *   1. **先查重再上传**：命中已有条目直接标「复用」，一个字节都不传（老流程是传完再由
   *      服务端 sha 去重，40MB 的 mp4 白传一次）；
   *   2. **单条失败只影响自己**：失败原因翻译成人话记进报告，其余条目继续跑；
   *   3. **每个 entry 都留状态**：`onEntry` 每次状态变化回调一次，界面据此逐行刷新，
   *      失败项还能拿同一份 entry 直接重试（retry 不需要重新选文件）。
   */
  async function runImportQueue(entries, { categoryId, publish = false, skipped = [], onProgress, onEntry, skipDuplicateCheck = false } = {}) {
    const reportId = `report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const items = [...skipped];
    const total = entries.length;
    let done = 0;
    const publishEntry = (entry, patch) => {
      Object.assign(entry, patch);
      if (onEntry) onEntry(entry, patch);
    };

    const runOne = async (entry) => {
      try {
        publishEntry(entry, { state: 'hashing', detail: '计算摘要…' });
        if (!skipDuplicateCheck) {
          const duplicate = await findDuplicate(entry);
          if (duplicate) {
            entry.result = { title: entry.title, status: 'reused', reason: `已存在：${duplicate.title}`, autoFixes: [] };
            items.push(entry.result);
            publishEntry(entry, { state: 'reused', detail: `已存在：${duplicate.title}（${duplicate.status}）` });
            return;
          }
        }
        publishEntry(entry, { state: 'uploading', detail: '上传中…' });
        const item = await importEntry(entry, { categoryId, publish, reportId });
        entry.result = item;
        items.push(item);
        publishEntry(entry, {
          state: item.status === 'reused' ? 'reused' : 'done',
          detail: item.status === 'reused' ? '服务端判定重复，已复用' : '完成',
        });
      } catch (error) {
        // 网络/权限/体检层的失败：进报告 + 留在 entry 上，供「重试」复用
        const reason = describeImportError(error);
        entry.result = { title: entry.title, status: 'failed', reason, autoFixes: [] };
        items.push(entry.result);
        publishEntry(entry, { state: 'failed', detail: reason });
      } finally {
        done += 1;
        if (onProgress) onProgress(done, total);
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, total) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        await runOne(entries[index]);
      }
    });
    await Promise.all(workers);

    const report = summarizeImport(reportId, items);
    report.failedEntries = entries.filter((entry) => entry.state === 'failed');
    report.entries = entries;
    console.info('[import] 导入报告', report.reportId, report);
    return report;
  }

  /**
   * 跳过原因归类：把「因为具体数值而不同」的 reason 归成一条，
   * 这样顶部的汇总才读得懂（否则 267 条能给你列出 267 种原因）。
   */
  function skipReasonKind(reason) {
    const text = String(reason || '');
    if (/场景包/.test(text)) return '场景包（只有 .pkg 场景 / 低清预览，需要录屏或转 mp4）';
    if (/超过单文件上限|超限/.test(text)) return '超过单文件上限（图片/视频 55MB、zip 64MB）';
    if (/低于 1600px|低清/.test(text)) return '图片宽度不足 1600px（拿不到高清原图）';
    if (/扫描失败/.test(text)) return '目录扫描失败（授权或读取异常）';
    return text || '未说明原因';
  }

  /**
   * 导入报告弹窗：成功 N / 复用 M / 失败 K / 跳过 J。
   *
   * 2026-11-07 修：以前「跳过」那一行只显示「跳过 · 无需修正」，**原因根本没渲染**，
   * 于是「扫描上传 0 条成功」时完全看不出为什么 —— 267 条跳过等于 267 个谜。
   * 现在失败和跳过都把 `reason` 打出来，顶部再加一行按原因归类的汇总。
   */
  function showImportReport(report) {
    const failures = report.items.filter((item) => item.status === 'failed');
    const fixes = new Map();
    for (const item of report.items) {
      for (const code of item.autoFixes || []) fixes.set(code, (fixes.get(code) || 0) + 1);
    }
    const fixLine = [...fixes.entries()]
      .map(([code, count]) => `${IMPORT_AUTOFIX_LABEL[code] || code} × ${count}`)
      .join('；');
    const skipped = report.items.filter((item) => item.status === 'skipped');

    // 跳过原因汇总：按类别计数，按条数降序
    const skipBuckets = new Map();
    for (const item of skipped) {
      const kind = skipReasonKind(item.reason);
      skipBuckets.set(kind, (skipBuckets.get(kind) || 0) + 1);
    }
    const skipLine = [...skipBuckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} × ${count}`)
      .join('；');

    const row = (item) => {
      const badge = item.status === 'skipped' ? '跳过'
        : item.status === 'reused' ? '已存在'
          : item.status === 'failed' ? '失败' : '成功';
      // 失败与跳过都必须给原因；成功给自动修正项
      const detail = (item.status === 'failed' || item.status === 'skipped')
        ? esc(item.reason || (item.status === 'failed' ? '导入失败' : '未导入'))
        : esc((item.autoFixes || []).map((code) => IMPORT_AUTOFIX_LABEL[code] || code).join('、') || '无需修正');
      return `<li class="wep-item ${item.status === 'failed' ? 'failed' : item.status === 'skipped' ? 'skipped' : ''}">
        <span class="wep-title" title="${esc(item.title || '')}">${esc(item.title || '(未命名)')}</span>
        <span class="wep-meta">${badge} · ${detail}</span>
      </li>`;
    };
    const body = report.items.length
      ? `<ul class="wep-items">${report.items.map(row).join('')}</ul>`
      : '<p class="hint">这次没有新条目。</p>';
    openDialog(`
      <h3>导入报告</h3>
      <p class="hint">报告号 ${esc(report.reportId)}<br>
        成功 ${report.imported} · 复用 ${report.reused} · 失败 ${report.failed}${skipped.length || report.skipped ? ` · 跳过 ${report.skipped || skipped.length}` : ''}</p>
      ${skipLine ? `<p class="hint"><strong>跳过的原因</strong>：${esc(skipLine)}</p>` : ''}
      ${fixLine ? `<p class="hint">自动修正：${esc(fixLine)}</p>` : ''}
      ${failures.length ? `<p class="hint">失败 ${failures.length} 条 —— 原因列在下面；这些条目**没有**入库。</p>` : ''}
      ${body}
      <footer><button type="button" class="btn primary" data-close>知道了</button></footer>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
    });
  }

  function putAsset(wallpaperId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/admin/wallpapers/${encodeURIComponent(wallpaperId)}/asset`);
      xhr.setRequestHeader('x-folia-client', 'admin');
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload && payload.ok) {
          resolve(payload.data);
        } else {
          const message = (payload && payload.error && payload.error.message) || `上传失败（${xhr.status}）`;
          const error = new Error(message);
          error.status = xhr.status;
          error.details = payload && payload.error ? payload.error.details : null;
          reject(error);
        }
      };
      xhr.onerror = () => reject(new Error('网络中断，上传失败'));
      xhr.send(file);
    });
  }

  // ---------------------------------------------------------- 大文件分片上传
  /** 超过这个尺寸走分片（4×8MB 以内一次 PUT 最稳） */
  const MULTIPART_THRESHOLD = 55 * 1024 * 1024;
  const RESUME_PREFIX = 'folia-upload:';

  const resumeKey = (wallpaperId, file) =>
    `${RESUME_PREFIX}${wallpaperId}:${file.name}:${file.size}:${file.lastModified || 0}`;

  function loadResume(wallpaperId, file) {
    try {
      const raw = localStorage.getItem(resumeKey(wallpaperId, file));
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || !state.uploadId || !state.key) return null;
      return state;
    } catch {
      return null;
    }
  }

  function saveResume(wallpaperId, file, state) {
    try {
      localStorage.setItem(resumeKey(wallpaperId, file), JSON.stringify(state));
    } catch { /* 配额满了就退化成不能续传，不影响本次上传 */ }
  }

  function clearResume(wallpaperId, file) {
    try { localStorage.removeItem(resumeKey(wallpaperId, file)); } catch { /* ignore */ }
  }

  async function jsonRequest(url, options) {
    const response = await fetch(url, {
      ...options,
      headers: { 'x-folia-client': 'admin', ...(options?.headers || {}) },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.details = payload?.error?.details ?? null;
      throw error;
    }
    return payload.data;
  }

  /**
   * 分片上传：init → 逐片 PUT（失败重试 3 次）→ complete。
   * localStorage 记录 {uploadId,key,doneParts}，刷新/断网后选同一个文件可以接着传。
   */
  async function putAssetChunked(wallpaperId, file, onProgress) {
    let state = loadResume(wallpaperId, file);
    if (!state) {
      const info = await jsonRequest('/api/admin/uploads/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, size: file.size, contentType: file.type }),
      });
      state = { uploadId: info.uploadId, key: info.key, partSize: info.partSize, done: [] };
      saveResume(wallpaperId, file, state);
    }

    const partSize = state.partSize || 8 * 1024 * 1024;
    const totalParts = Math.max(1, Math.ceil(file.size / partSize));
    const doneMap = new Map((state.done || []).map((item) => [item.partNumber, item.etag]));
    let sentBytes = Math.min(file.size, doneMap.size * partSize);
    if (onProgress) onProgress(sentBytes / file.size);

    const uploadPart = async (partNumber, attempt = 1) => {
      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(file.size, start + partSize));
      try {
        const response = await fetch(
          `/api/admin/uploads/part?uploadId=${encodeURIComponent(state.uploadId)}&part=${partNumber}&key=${encodeURIComponent(state.key)}`,
          { method: 'PUT', headers: { 'x-folia-client': 'admin', 'content-type': 'application/octet-stream' }, body: blob },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          const error = new Error(payload?.error?.message || `分片 ${partNumber} 上传失败（${response.status}）`);
          error.status = response.status;
          throw error;
        }
        return payload.data.etag;
      } catch (error) {
        // 上传会话失效（服务端重启/过期）⇒ 重新 init 再来
        if (error.status === 404 || error.status === 400) throw error;
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        return uploadPart(partNumber, attempt + 1);
      }
    };

    for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      if (doneMap.has(partNumber)) continue;
      const etag = await uploadPart(partNumber);
      doneMap.set(partNumber, etag);
      state.done = [...doneMap.entries()].map(([num, tag]) => ({ partNumber: num, etag: tag }));
      saveResume(wallpaperId, file, state);
      sentBytes += Math.min(partSize, file.size - (partNumber - 1) * partSize);
      if (onProgress) onProgress(Math.min(1, sentBytes / file.size));
    }

    const parts = [...doneMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, etag]) => ({ partNumber, etag }));
    try {
      const result = await jsonRequest('/api/admin/uploads/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: state.uploadId, key: state.key, parts, meta: { wallpaperId, size: file.size } }),
      });
      clearResume(wallpaperId, file);
      return result;
    } catch (error) {
      // etag 对不上/合并失败：清掉会话，下次从头来
      if (error.status && error.status < 500) clearResume(wallpaperId, file);
      throw error;
    }
  }

  // ------------------------------------------------------------------ 提示
  function toast(message, kind = 'info', ttl = 4000) {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    $('#toasts').appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 200);
    }, ttl);
  }

  function reportError(error) {
    if (!error || !state.user) return;
    toast(error.message || '操作失败', 'error', 6000);
  }

  // ------------------------------------------------------------------ 弹窗
  function openDialog(html, onMount) {
    const dialog = $('#dialog');
    dialog.innerHTML = html;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (onMount) onMount(dialog);
    return dialog;
  }

  function closeDialog() {
    const dialog = $('#dialog');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    dialog.innerHTML = '';
  }

  // ------------------------------------------------------------------ 认证
  function showAuth(mode) {
    $('#boot').classList.add('hidden');
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    const isSetup = mode === 'setup';
    $('#login-form').classList.toggle('hidden', isSetup);
    $('#setup-form').classList.toggle('hidden', !isSetup);
    $('#auth-hint').textContent = isSetup
      ? '第一次使用：创建第一位管理员。令牌就是你在 Cloudflare 设置的 BOOTSTRAP_TOKEN。'
      : '用管理员或编辑账号登录';
    const focus = isSetup ? $('#setup-token') : $('#login-email');
    if (focus) focus.focus();
  }

  async function boot() {
    try {
      const meta = await api('/meta');
      if (!meta.initialized) {
        showAuth('setup');
        return;
      }
    } catch {
      /* 探测失败就按已初始化处理，让登录报错更直接 */
    }
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      await enterApp();
    } catch {
      showAuth('login');
    }
  }

  async function doLogin(event) {
    event.preventDefault();
    const button = $('#login-form button[type="submit"]');
    button.disabled = true;
    button.textContent = '登录中…';
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { email: $('#login-email').value.trim(), password: $('#login-password').value },
      });
      state.user = data.user;
      $('#login-password').value = '';
      await enterApp();
    } catch (error) {
      toast(error.message, 'error', 5000);
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  }

  async function doSetup(event) {
    event.preventDefault();
    const button = $('#setup-form button[type="submit"]');
    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const data = await api('/setup', {
        method: 'POST',
        body: {
          token: $('#setup-token').value.trim(),
          email: $('#setup-email').value.trim(),
          name: $('#setup-name').value.trim(),
          password: $('#setup-password').value,
        },
      });
      state.user = data.user;
      toast('管理员已创建', 'ok');
      await enterApp();
    } catch (error) {
      toast(error.message, 'error', 6000);
    } finally {
      button.disabled = false;
      button.textContent = '创建管理员';
    }
  }

  async function enterApp() {
    state.booted = true;
    $('#auth').classList.add('hidden');
    $('#boot').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#who-name').textContent = state.user.name || state.user.email;
    $('#who-role').textContent = `${ROLE_LABEL[state.user.role] || state.user.role} · ${state.user.email}`;
    $$('.nav-item[data-admin-only]').forEach((node) => {
      node.classList.toggle('hidden', !isAdmin());
    });
    // 标签词表现在在数据库里，从公开接口取一次给编辑弹窗用
    await loadTagVocabulary();
    await loadCategories();
    await switchView('wallpapers');
  }

  async function doLogout() {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      /* 退出失败也让本地回到登录页 */
    }
    state.user = null;
    showAuth('login');
  }

  function openPasswordDialog() {
    openDialog(`
      <form id="password-form">
        <h3>修改密码</h3>
        <p class="hint">修改后所有设备都需要重新登录。</p>
        <label>当前密码<input id="pw-current" type="password" autocomplete="current-password" required></label>
        <label>新密码<input id="pw-new" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>再输一次<input id="pw-confirm" type="password" autocomplete="new-password" required minlength="10"></label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">保存</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#password-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        if ($('#pw-new').value !== $('#pw-confirm').value) {
          toast('两次输入的新密码不一致', 'error');
          return;
        }
        try {
          await api('/auth/password', {
            method: 'POST',
            body: { currentPassword: $('#pw-current').value, newPassword: $('#pw-new').value },
          });
          closeDialog();
          toast('密码已更新', 'ok');
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  // ------------------------------------------------------------------ 导航
  async function switchView(view) {
    if (!state.booted) return;
    if ((view === 'members' || view === 'audit') && !isAdmin()) {
      toast('只有管理员可以进入这一页', 'error');
      return;
    }
    state.view = view;
    $$('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
    const titles = { wallpapers: '作品', categories: '分类', members: '成员', audit: '审计日志' };
    $('#view-title').textContent = titles[view] || view;
    $('#view-actions').innerHTML = '';
    $('#view').innerHTML = '<p class="muted">加载中…</p>';
    try {
      if (view === 'wallpapers') await mountWallpapers();
      else if (view === 'categories') await mountCategories();
      else if (view === 'members') await mountMembers();
      else if (view === 'audit') await mountAudit();
    } catch (error) {
      $('#view').innerHTML = `<p class="empty">${esc(error.message)}</p>`;
    }
  }

  // ------------------------------------------------------------------ 分类数据
  async function loadTagVocabulary() {
    try {
      // 标签现在带 categoryId：null = 全局，否则只属于某个分类
      const vocabulary = await api('/admin/tags');
      state.tags = vocabulary.tags ?? [];
      state.tagVocabulary = state.tags.map((entry) => entry.name);
    } catch {
      state.tagVocabulary = [];
    }
  }

  async function loadCategories() {
    const data = await api('/admin/categories');
    state.categories = data.categories;
    return state.categories;
  }

  function categoryOptions(selectedId) {
    const rows = state.categories.map(
      (category) => `<option value="${esc(category.id)}"${category.id === selectedId ? ' selected' : ''}>${esc(category.name)}</option>`,
    );
    return `<option value=""${selectedId ? '' : ' selected'}>未分类</option>${rows.join('')}`;
  }

  // ------------------------------------------------------------------ 自动导入
  /**
   * 把本机目录（Wallpaper Engine 创意工坊 / 任意壁纸文件夹）挂到后台：
   * 授权一次，目录句柄存在浏览器里，之后每次打开作品页自动扫描，
   * 新东西直接以「草稿」入库，不弹窗。
   *
   * 前提：浏览器读不了任意路径，首次必须在系统选目录框里点一次「允许」。
   */
  const IMPORT_DIR_KEY = 'import-dirs';
  /**
   * 高清线：宽度低于它的图片不进库。
   * Wallpaper Engine 的 preview.jpg 只有 192–1024px，那是缩略图不是作品原图；
   * 拿它当 url 用，铺到桌面必然是糊的。
   */
  const MIN_IMAGE_WIDTH = 1600;

  async function imageWidth(file) {
    if (!/^image\//.test(file.type)) return 0;
    try {
      const bitmap = await createImageBitmap(file);
      const width = bitmap.width || 0;
      if (bitmap.close) bitmap.close();
      return width;
    } catch {
      return 0;
    }
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('folia-admin', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const request = db.transaction('handles', 'readonly').objectStore('handles').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function walkDirectory(dirHandle, prefix = '', out = []) {
    for await (const [name, handle] of dirHandle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') await walkDirectory(handle, path, out);
      else {
        const file = await handle.getFile();
        try {
          Object.defineProperty(file, '_rel', { value: path, configurable: true });
        } catch { /* 忽略 */ }
        out.push(file);
      }
    }
    return out;
  }

  async function loadImportDirs() {
    const rows = await idbGet(IMPORT_DIR_KEY).catch(() => null);
    state.importDirs = Array.isArray(rows) ? rows : [];
    return state.importDirs;
  }

  async function saveImportDirs() {
    await idbSet(IMPORT_DIR_KEY, state.importDirs).catch(() => {});
  }

  /** 一个目录 → 若干待入库条目（workshop 按 project.json 认，普通目录按文件认） */
  async function scanDirectory(handle) {
    const files = await walkDirectory(handle);
    const projects = files.filter((file) => file.name === 'project.json');
    const entries = [];

    if (projects.length) {
      for (const pj of projects) {
        const rel = pj._rel || pj.name;
        const dir = rel.slice(0, rel.lastIndexOf('/'));
        const siblings = files.filter((file) => (file._rel || '').startsWith(`${dir}/`));
        const video = siblings.find((file) => /\.(mp4|webm)$/i.test(file.name) && !VARIANT_NAME_RE.test(file.name));
        let meta = {};
        try { meta = JSON.parse(await pj.text()); } catch { meta = {}; }
        const baseTitle = String(meta.title || dir.split('/').pop() || handle.name).slice(0, 110);
        const tags = [...new Set((meta.tags ?? []).map((tag) => WE_TAG_MAP[tag]).filter(Boolean))];

        if (video) {
          // 同目录里预置的 1080p 变体（prepare-upload 的产物）一起带上，服务端会先体检再入库
          const variant = siblings.find((file) => VARIANT_NAME_RE.test(file.name)
            && variantBase(file.name) === variantBase(video.name));
          entries.push({
            title: baseTitle, file: video, kind: 'dynamic', tags, variants: variant ? [variant] : [],
          });
        } else {
          // 场景包（.pkg）没有可用的原图，preview 只是缩略图，不能当作品。
          // 两条出路：录屏转 mp4 再扫；或 `tools/pack-we-project.mjs` 打包成 zip，
          // 用「批量导入本地文件」上传（那条路接受 .zip，服务端按 bundle 豁免宽高）。
          entries.push({
            title: baseTitle,
            file: null,
            kind: 'static',
            tags,
            skipReason: '场景包只有低清预览：需录屏转 mp4，或用 pack-we-project 打包成 zip 后「批量导入本地文件」',
          });
        }
      }
      return entries;
    }

    // 普通目录：`xxx.1080p.mp4` 不单独成条目，它属于 `xxx.mp4`（变体配对）
    const variants = files.filter((file) => VARIANT_NAME_RE.test(file.name));
    for (const file of files) {
      if (VARIANT_NAME_RE.test(file.name)) continue;
      if (!/\.(mp4|webm|png|jpe?g|webp|avif|gif)$/i.test(file.name)) continue;
      const variant = variants.find((candidate) => variantBase(candidate.name) === variantBase(file.name));
      entries.push({
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 110),
        file,
        kind: /\.(mp4|webm)$/i.test(file.name) ? 'dynamic' : 'static',
        tags: [],
        variants: variant ? [variant] : [],
      });
    }
    return entries;
  }

  /**
   * 扫描所有已挂目录，把库里没有的**走批量入库接口**存成草稿。
   *
   * 每条都经过服务端 ingestAsset()：合规体检（4K@60 / HEVC / 非 faststart 该拒就拒）、
   * sha256、HEAD 回读、缩略图、1080p 变体、必填字段门。失败的条目**不会留在库里**，
   * 全部进导入报告。
   */
  async function scanImportDirs({ silent = true } = {}) {
    if (!state.importDirs.length) return 0;
    const categoryId = (state.categories[0] && state.categories[0].id) || null;
    if (!categoryId) {
      if (!silent) toast('还没有分类，先去「分类」里建一个再扫描', 'error', 6000);
      return 0;
    }

    const known = new Set(state.wallpapers.items.map((item) => item.title));
    const queue = [];
    const skipped = [];

    for (const dir of state.importDirs) {
      let permission = await dir.handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
      if (permission !== 'granted') {
        if (silent) continue;                       // 自动扫描时不弹授权框
        permission = await dir.handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (permission !== 'granted') continue;
      }

      let entries = [];
      try {
        entries = await scanDirectory(dir.handle);
      } catch (error) {
        console.warn('[auto-import] 扫描失败', dir.name, error.message);
        skipped.push({ title: dir.name, status: 'skipped', reason: `扫描失败：${error.message}` });
        continue;
      }

      for (const entry of entries) {
        if (!entry.file) {
          skipped.push({ title: entry.title, status: 'skipped', reason: entry.skipReason || '没有可用文件' });
          continue;
        }
        if (known.has(entry.title)) continue;
        if (entry.file.size > importCapFor(entry.file)) {
          skipped.push({
            title: entry.title,
            status: 'skipped',
            reason: `${(entry.file.size / 1048576).toFixed(0)}MB 超过单文件上限`,
          });
          continue;
        }

        // 高清闸门：图片宽度不够的不要，宁可空着也不放糊图
        if (entry.kind === 'static') {
          const width = await imageWidth(entry.file);
          if (width > 0 && width < MIN_IMAGE_WIDTH) {
            skipped.push({ title: entry.title, status: 'skipped', reason: `只有 ${width}px 宽（低于 ${MIN_IMAGE_WIDTH}px 高清线）` });
            continue;
          }
        }

        const allowed = (entry.tags || []).filter((tag) => state.tagVocabulary.includes(tag));
        queue.push({ title: entry.title, file: entry.file, kind: entry.kind, tags: allowed, variants: entry.variants || [] });
        known.add(entry.title);
      }
    }

    if (!queue.length && !skipped.length) return 0;

    const report = await runImportQueue(queue, { categoryId, skipped });
    if (report.imported || report.reused || report.failed || skipped.length) {
      const note = `成功 ${report.imported} · 复用 ${report.reused} · 失败 ${report.failed}`
        + `${skipped.length ? ` · 跳过 ${skipped.length}` : ''}`;
      toast(`扫描完成：${note}`, report.failed ? 'error' : 'ok', 9000);
    }
    if (report.imported || report.reused) await loadWallpapers();
    // 自动静默扫描只在有失败时弹报告；手动「立即扫描」总是给报告
    if (!silent || report.failed) showImportReport(report);
    return report.imported;
  }

  async function addImportDir() {
    if (!window.showDirectoryPicker) {
      toast('这个浏览器不支持目录授权，请用 Chrome / Edge', 'error', 6000);
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: 'folia-import', mode: 'read' });
      state.importDirs = [...state.importDirs, { name: handle.name, handle }];
      await saveImportDirs();
      renderImportStrip();
      await scanImportDirs({ silent: false });
    } catch (error) {
      if (error && error.name !== 'AbortError') toast('选择目录失败', 'error');
    }
  }

  function renderImportStrip() {
    const host = $('#import-status');
    if (!host) return;
    host.textContent = state.importDirs.length
      ? `已挂载 ${state.importDirs.map((dir) => dir.name).join('、')} · 打开本页会自动扫描新增作品并存入草稿`
      : '未挂载本机目录 · 点「添加目录」授权一次，之后新作品自动进草稿';
  }

  // ------------------------------------------------------------------ 壁纸
  async function mountWallpapers() {
    $('#view-actions').innerHTML = `
      <button class="btn" type="button" data-action="import-local">批量导入本地文件</button>
      <button class="btn primary" type="button" data-action="new-wallpaper">＋ 新增作品</button>`;
    $('#view').innerHTML = `
      <div class="import-strip">
        <span class="muted small" id="import-status">检查本机目录…</span>
        <span class="spacer"></span>
        <button class="btn small" type="button" data-action="scan-import">立即扫描</button>
        <button class="btn small ghost" type="button" data-action="add-import-dir">添加目录</button>
      </div>
      <div class="toolbar">
        <input type="search" id="wp-q" placeholder="搜索标题…" value="${esc(state.filters.q)}">
        <select id="wp-cat"><option value="">全部分类</option></select>
        <select id="wp-tag"><option value="">全部标签</option></select>
        <select id="wp-subtag-filter"><option value="">子标签</option></select>
        <select id="wp-review-filter">
          <option value="">审核</option>
          <option value="approved">已审核</option>
          <option value="pending">未审核</option>
        </select>
        <select id="wp-status">
          <option value="">全部状态</option>
          <option value="published">已发布</option>
          <option value="draft">草稿</option>
        </select>
        <select id="wp-format-filter">
          <option value="">全部格式</option>
          <option value="video">视频（mp4 / webm）</option>
          <option value="zip">ZIP 包</option>
          <option value="image">图片</option>
        </select>
        <span class="spacer"></span>
        <button class="btn small ghost" type="button" data-action="reset-filters" title="清空搜索和所有筛选">重置</button>
        <button class="btn small" type="button" data-action="approve-all" title="把已发布但未审核的作品全部标记为已审核">全部通过审核</button>
        <button class="btn small${state.filters.needsVariant ? ' primary' : ' ghost'}" type="button" data-action="filter-needs-variant" id="wp-needs-btn" title="只看需要转码的条目（needs_variant=1）">待转码</button>
        <span class="muted small" id="wp-total"></span>
      </div>
      <div class="bulk-bar" id="wp-bulk-bar">
        <span class="muted small" id="wp-bulk-count">未选择</span>
        <select id="wp-bulk-cat" class="small" disabled>
          <option value="">改分类…</option>
          ${state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select>
        <input id="wp-bulk-tags" class="small" type="text" placeholder="标签（逗号分隔，覆盖原标签）" disabled>
        <button class="btn small" type="button" data-action="bulk-tags" id="wp-bulk-tags-btn" disabled>应用标签</button>
        <button class="btn small" type="button" data-action="bulk-publish" id="wp-bulk-pub" disabled>发布</button>
        <button class="btn small" type="button" data-action="bulk-unpublish" id="wp-bulk-unpub" disabled>下线</button>
        <button class="btn small" type="button" data-action="bulk-hide" id="wp-bulk-hide" disabled>软删</button>
        <button class="btn small danger" type="button" data-action="bulk-delete" id="wp-bulk-del" disabled>删除选中</button>
      </div>
      <div id="wp-table" class="drop-target"><p class="muted">加载中…</p></div>
      <p class="hint drop-hint" id="wp-drop-hint">把图片 / 视频 / zip 直接拖到这张表上，就能批量导入（重复文件会自动复用）。</p>
    `;

    $('#wp-cat').innerHTML = categoryOptions(state.filters.categoryId).replace('未分类', '全部分类');
    $('#wp-review-filter').value = state.filters.review;
    $('#wp-format-filter').value = state.filters.format;
    $('#wp-status').value = state.filters.status;

    // 标签归分类：全局标签一直都在，分类专属标签只在选中那个分类时出现
    const renderTagOptions = () => {
      const select = $('#wp-tag');
      if (!select) return;
      const categoryId = state.filters.categoryId;
      const names = state.tags
        .filter((tag) => !tag.categoryId || !categoryId || tag.categoryId === categoryId)
        .map((tag) => tag.name);
      select.innerHTML = '<option value="">全部标签</option>'
        + '<option value="__liked__"' + (state.filters.tag === '__liked__' ? ' selected' : '') + '>喜欢</option>'
        + names.map((tag) => `<option value="${esc(tag)}"${tag === state.filters.tag ? ' selected' : ''}>${esc(tag)}</option>`).join('');
    };
    renderTagOptions();

    // 子标签跟着标签走：不同标签下面各有一套，互不影响
    const renderSubtagOptions = async () => {
      const select = $('#wp-subtag-filter');
      if (!select) return;
      const tag = state.filters.tag && state.filters.tag !== '__liked__' ? state.filters.tag : '';
      let subtags = [];
      try {
        const data = tag
          ? await api('/admin/subtags/used?tag=' + encodeURIComponent(tag))
          : await api('/admin/subtags/used');
        subtags = data.subtags || [];
      } catch {
        subtags = [];
      }
      if (!subtags.includes(state.filters.subtag)) state.filters.subtag = '';
      select.innerHTML = '<option value="">子标签</option>'
        + subtags.map((name) => `<option value="${esc(name)}"${name === state.filters.subtag ? ' selected' : ''}>${esc(name)}</option>`).join('');
    };
    await renderSubtagOptions();

    $('#wp-q').addEventListener('input', debounce((event) => {
      state.filters.q = event.target.value.trim();
      loadWallpapers().catch(reportError);
    }, 250));
    $('#wp-review-filter').addEventListener('change', (event) => {
      state.filters.review = event.target.value;
      loadWallpapers().catch(reportError);
    });
    $('#wp-format-filter').addEventListener('change', (event) => {
      state.filters.format = event.target.value;
      loadWallpapers().catch(reportError);
    });
    $('#wp-status').addEventListener('change', (event) => {
      state.filters.status = event.target.value;
      loadWallpapers().catch(reportError);
    });
    $('#wp-cat').addEventListener('change', (event) => {
      state.filters.categoryId = event.target.value;
      // 换了分类，之前选的标签可能已经不在这个分类下
      state.filters.tag = '';
      state.filters.subtag = '';
      renderTagOptions();
      renderSubtagOptions().catch(() => {});
      loadWallpapers().catch(reportError);
    });
    $('#wp-tag')?.addEventListener('change', (event) => {
      state.filters.tag = event.target.value;
      // 标签换了，子标签列表和已选子标签都要重置
      state.filters.subtag = '';
      renderSubtagOptions().catch(() => {});
      loadWallpapers().catch(reportError);
    });
    $('#wp-subtag-filter').addEventListener('change', (event) => {
      state.filters.subtag = event.target.value;
      loadWallpapers().catch(reportError);
    });

    // 批量改分类：选完直接生效（不需要再点按钮），失败会 toast 原因
    $('#wp-bulk-cat')?.addEventListener('change', (event) => {
      const categoryId = event.target.value;
      if (!categoryId) return;
      bulkPatch({ categoryId }, '批量改分类')
        .catch(reportError)
        .finally(() => { event.target.value = ''; });
    });

    await loadWallpapers();

    // ---- 拖拽导入：把文件直接拖到列表上（阶段五） ----------------------------
    // 用 dragenter/dragleave 计数而不是「在子元素上判断 relatedTarget」：
    // 拖过表格里任意一行都会触发子元素的 dragleave，浅判断会让高亮一闪一闪。
    const dropTarget = $('#wp-table');
    let dragDepth = 0;
    const setDragging = (on) => {
      dropTarget.classList.toggle('dragging', on);
      const hint = $('#wp-drop-hint');
      if (hint) hint.textContent = on ? '松开就开始导入（重复文件会自动复用）' : '把图片 / 视频 / zip 直接拖到这张表上，就能批量导入（重复文件会自动复用）。';
    };
    $('#wp-table').addEventListener('dragover', (event) => {
      if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    });
    $('#wp-table').addEventListener('dragenter', (event) => {
      if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    });
    $('#wp-table').addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) setDragging(false);
    });
    $('#wp-table').addEventListener('drop', (event) => {
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      openLocalImport([...event.dataTransfer.files]);
    });

    // 挂载了本机目录就静默扫一遍：新增的直接进草稿
    await loadImportDirs();
    renderImportStrip();
    if (state.importDirs.length) {
      scanImportDirs({ silent: true }).catch((error) => console.warn('[auto-import]', error.message));
    }
  }

  /** 一键通过审核：公开接口只下发 approved，新上传默认 pending */
  async function approveAll() {
    if (!window.confirm('把所有「已发布但未审核」的作品标记为已审核？')) return;
    const data = await api('/admin/wallpapers/approve-all', { method: 'POST' });
    toast(data.approved ? '已全部通过审核' : '已完成', 'ok');
    await loadWallpapers();
  }

  async function loadWallpapers() {
    const params = new URLSearchParams();
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.review) params.set('review', state.filters.review);
    if (state.filters.status) params.set('status', state.filters.status);
    if (state.filters.categoryId) params.set('categoryId', state.filters.categoryId);
    // 「喜欢」现在挂在标签下拉里，是个哨兵值，转成后端的 liked=1
    if (state.filters.tag === '__liked__') params.set('liked', '1');
    else if (state.filters.tag) params.set('tag', state.filters.tag);
    if (state.filters.subtag) params.set('subtag', state.filters.subtag);
    if (state.filters.format) params.set('format', state.filters.format);
    if (state.filters.needsVariant) params.set('needsVariant', '1');
    params.set('limit', '200');
    const data = await api(`/admin/wallpapers?${params.toString()}`);
    state.wallpapers = data;
    const total = $('#wp-total');
    if (total) total.textContent = `共 ${data.total} 条`;
    renderWallpaperRows();
  }

  /** mime → 一眼能看懂的格式标签（ZIP 包 / MP4 / PNG…） */
  function formatLabel(mime) {
    if (!mime) return '—';
    const map = {
      'video/mp4': 'MP4',
      'video/webm': 'WebM',
      'application/zip': 'ZIP',
      'image/png': 'PNG',
      'image/jpeg': 'JPG',
      'image/webp': 'WebP',
      'image/avif': 'AVIF',
      'image/gif': 'GIF',
    };
    return map[mime] || mime.replace(/^.*\//, '').toUpperCase();
  }

  function wallpaperRowHtml(item) {
    const thumb = thumbHtml(item);
    const canEdit = isAdmin() || item.createdBy === state.user.id;
    const actions = [];
    if (canEdit) {
      actions.push(`<button class="btn small" type="button" data-action="upload-wallpaper" data-id="${esc(item.id)}">${item.hasAsset ? '换文件' : '上传'}</button>`);
      actions.push(`<button class="btn small" type="button" data-action="edit-wallpaper" data-id="${esc(item.id)}">编辑</button>`);
    }
    if (canPublish()) {
      actions.push(item.status === 'published'
        ? `<button class="btn small" type="button" data-action="unpublish" data-id="${esc(item.id)}">下线</button>`
        : `<button class="btn small primary" type="button" data-action="publish" data-id="${esc(item.id)}">发布</button>`);
    }
    if (isAdmin()) {
      actions.push(`<button class="btn small danger" type="button" data-action="delete-wallpaper" data-id="${esc(item.id)}">删除</button>`);
    }
    const catSelect = canEdit
      ? `<select class="small" data-action="select-category" data-id="${esc(item.id)}">${categoryOptions(item.category ? item.category.id : '')}</select>`
      : esc(item.category ? item.category.name : '未分类');
    const tags = item.tags ?? [];
    const chips = [
      ...tags.map((tag) => `<span class="tag-chip">${esc(tag)}</span>`),
      ...(item.subtag ? [`<span class="tag-chip subtag">${esc(item.subtag)}</span>`] : []),
    ];
    const tagChips = chips.length ? chips.join('') : '<span class="muted small">未打标签</span>';
    // 标签 + 子标签直接列在行里；能编辑的人点一下进编辑弹层改
    const tagCell = canEdit
      ? `<button class="tag-cell" type="button" data-action="edit-wallpaper" data-id="${esc(item.id)}" title="点击编辑标签 / 子标签">${tagChips}</button>`
      : `<div class="tag-cell as-text">${tagChips}</div>`;
    const reviewBadge = item.reviewStatus === 'approved'
      ? '<span class="badge approved">已审核</span>'
      : '<span class="badge pending">未审核</span>';
    // 阶段五：待转码徽标 —— 条数必须与 `needs_variant=1` 的行一一对应
    // （`tools/make-variants.mjs --all-draft` 按同一个条件捞活）。
    const variantBadge = item.needsVariant
      ? `<span class="badge warn" title="原片超过可播门槛，等 make-variants 转码后再发布">待转码${item.variantReason ? ` · ${esc(item.variantReason)}` : ''}</span>`
      : '';
    const variantLabels = (item.variants || []).map((variant) => variant.label).filter(Boolean);
    const techLine = [
      item.width ? `${item.width}×${item.height}` : '—',
      item.fps ? `${item.fps}fps` : '',
      item.durationMs ? formatDuration(item.durationMs) : '',
    ].filter(Boolean).join(' · ');
    const variantsLine = variantLabels.length
      ? `<span class="badge">${esc(variantLabels.join(' / '))}</span>`
      : '';
    return `
      <tr${item.needsVariant ? ' class="needs-variant"' : ''}>
        <td class="pick"><input type="checkbox" class="wp-pick" value="${esc(item.id)}" aria-label="选择这件作品"></td>
        <td>${thumb}</td>
        <td>
          <div class="title-cell">
            <strong>${esc(item.title)}</strong>
            ${item.description ? `<span class="title-desc" title="${esc(item.description)}">${esc(item.description)}</span>` : ''}
          </div>
        </td>
        <td class="hide-sm">${catSelect}</td>
        <td class="hide-sm">${tagCell}</td>
        <td><span class="status-badges"><span class="badge ${esc(item.status)}">${esc(STATUS_LABEL[item.status] || item.status)}</span>${reviewBadge}${item.featured ? '<span class="badge">置顶</span>' : ''}${variantBadge}</span></td>
        <td class="hide-sm"><span class="badge fmt">${esc(formatLabel(item.mime))}</span> ${techLine}<br><span class="muted small">${formatBytes(item.bytes)}</span>${variantsLine ? `<br>${variantsLine}` : ''}</td>
        <td class="hide-sm muted small">${esc(item.creatorEmail || '—')}</td>
        <td class="actions">${actions.join('')}</td>
      </tr>`;
  }

  function wallpaperTableHtml(rows) {
    return `<table class="table">
      <thead>
        <tr>
          <th class="pick"><input type="checkbox" id="wp-pick-all" aria-label="全选"></th>
          <th></th><th>标题</th><th class="hide-sm">分类</th><th class="hide-sm">标签 / 子标签</th><th>状态</th>
          <th class="hide-sm">尺寸 / 体积</th><th class="hide-sm">上传者</th><th>操作</th>
        </tr>
      </thead>
      <tbody>${rows.map(wallpaperRowHtml).join('')}</tbody>
    </table>`;
  }

  function renderWallpaperRows() {
    const host = $('#wp-table');
    if (!host) return;
    const items = state.wallpapers.items;
    if (!items.length) {
      host.innerHTML = '<p class="empty">还没有作品。点右上角「新增作品」或「批量导入本地文件」。</p>';
      syncBulkButton();
      return;
    }
    // 状态已经由工具栏的下拉负责筛选，这里只出一张表
    host.innerHTML = wallpaperTableHtml(items);
    const pickAll = $('#wp-pick-all');
    if (pickAll) {
      pickAll.addEventListener('change', () => {
        document.querySelectorAll('.wp-pick').forEach((box) => { box.checked = pickAll.checked; });
        syncBulkButton();
      });
    }
    document.querySelectorAll('.wp-pick').forEach((box) => box.addEventListener('change', syncBulkButton));
    syncBulkButton();
  }

  /** 批量工具条的文案与可用状态跟着勾选数量走。 */
  function syncBulkButton() {
    const count = document.querySelectorAll('.wp-pick:checked').length;
    const button = $('#wp-bulk-del');
    if (button) {
      button.disabled = count === 0;
      button.textContent = count ? `删除选中（${count}）` : '删除选中';
    }
    const counter = $('#wp-bulk-count');
    if (counter) counter.textContent = count ? `已选 ${count} 件` : '未选择';
    for (const id of ['#wp-bulk-cat', '#wp-bulk-tags', '#wp-bulk-tags-btn', '#wp-bulk-pub', '#wp-bulk-unpub', '#wp-bulk-hide']) {
      const node = $(id);
      if (node) node.disabled = count === 0;
    }
  }

  /** 勾选中的 id 列表（批量操作共用）。 */
  function pickedIds() {
    return [...document.querySelectorAll('.wp-pick:checked')].map((box) => box.value);
  }

  /**
   * 批量套同一份 patch（阶段五）。
   *
   * 一次请求打到 `POST /api/admin/wallpapers/batch`：服务端逐条判权限、逐条记账、
   * 整批只写一条审计、只重建一次公开快照。失败条数会带着原因一起回来。
   */
  async function bulkPatch(patch, label) {
    const ids = pickedIds();
    if (!ids.length) return;
    const data = await api('/admin/wallpapers/batch', { method: 'POST', body: { ids, patch } });
    const failed = data.failed || [];
    const detail = failed.length ? `，失败 ${failed.length} 条（${failed[0].reason}）` : '';
    toast(`${label}：成功 ${data.updated} 条${detail}`, failed.length ? 'error' : 'ok', 6000);
    await loadWallpapers();
  }

  /** 批量改标签：输入框里的逗号分隔文本，整体覆盖（不是追加，避免「越改越多」）。 */
  async function bulkSetTags() {
    const input = $('#wp-bulk-tags');
    const tags = String(input ? input.value : '')
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!tags.length) { toast('先在输入框里写标签，逗号分隔', 'info'); return; }
    await bulkPatch({ tags }, `改标签（${tags.join(' / ')}）`);
    if (input) input.value = '';
  }

  /** 批量删除：逐条走已有的 DELETE 接口，失败的单独计数，不中断其余删除。 */
  async function bulkDeleteWallpapers() {
    const ids = [...document.querySelectorAll('.wp-pick:checked')].map((box) => box.value);
    if (!ids.length) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 件作品？文件与记录都会被删除，无法恢复。`)) return;
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await api(`/admin/wallpapers/${encodeURIComponent(id)}`, { method: 'DELETE' });
        done += 1;
      } catch {
        failed += 1;
      }
    }
    toast(failed ? `已删除 ${done} 件，${failed} 件失败` : `已删除 ${done} 件`, failed ? 'error' : 'ok');
    await loadWallpapers();
  }

  function tagPickerHtml(item) {
    const selected = new Set(item && item.tags ? item.tags : []);
    const options = state.tagVocabulary.length ? state.tagVocabulary : [];
    // 词表里没有的标签（老数据、批量导入带的自由标签）也要显示成已勾选，
    // 否则一保存就被当成「取消勾选」冲掉。
    const extras = [...selected].filter((tag) => !options.includes(tag));
    return `<div class="tag-picker" id="wp-tags">
      ${options.map((tag) => `<label class="tag-option">
        <input type="checkbox" value="${esc(tag)}"${selected.has(tag) ? ' checked' : ''}> ${esc(tag)}
      </label>`).join('')}
      ${extras.map((tag) => `<label class="tag-option extra">
        <input type="checkbox" value="${esc(tag)}" checked> ${esc(tag)}
      </label>`).join('')}
    </div>`;
  }

  /**
   * Cloudflare 单次请求上限 100MB，Worker 又要把文件读进内存，55MB 是稳妥的天花板。
   * zip 资源包（助手皮肤 / 开机动画）服务端上限是 64MB（`MAX_BUNDLE_BYTES`），单独一档。
   */
  const MAX_IMPORT_BYTES = 55 * 1024 * 1024;
  const MAX_IMPORT_BUNDLE_BYTES = 64 * 1024 * 1024;
  const importCapFor = (file) => (/\.zip$/i.test(file.name) ? MAX_IMPORT_BUNDLE_BYTES : MAX_IMPORT_BYTES);

  /** 批量导入本地文件：**拖拽或多选**，2 并发，逐条显示状态，失败可单条/全部重试 */
  function openLocalImport(initialFiles = null) {
    openDialog(`
      <form id="loc-form">
        <h3>批量导入本地文件</h3>
        <p class="hint">图片 png/jpg/webp/avif/gif，视频 mp4/webm，单个不超过 55MB。<br>
          标题取文件名（去掉扩展名），标签导入后可以再勾。<br>
          重复文件会先查摘要：已有同一个文件就直接复用，<strong>不会重复占用 R2</strong>。</p>
        <div class="row">
          <label>放到哪个模块
            <select id="loc-module">
              ${state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
            </select>
          </label>
          <label>导入后
            <select id="loc-publish">
              <option value="0" selected>先存草稿</option>
              <option value="1">直接发布</option>
            </select>
          </label>
        </div>
        <div class="dropzone" id="loc-pick">
          <strong>把文件拖到这里，或点击选择（可多选）</strong>
          <span class="small" id="loc-status">还没有选择文件</span>
        </div>
        <div id="loc-list"></div>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="button" class="btn" id="loc-retry" hidden>重试失败项</button>
          <button type="submit" class="btn primary" id="loc-start" disabled>开始导入</button>
        </footer>
      </form>
    `, (dialog) => {
      let entries = [];
      let picked = new Set();
      let running = false;
      $('[data-close]', dialog).addEventListener('click', closeDialog);

      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif,video/mp4,video/webm,application/zip,.zip';
      input.className = 'hidden';
      dialog.appendChild(input);

      const STATE_LABEL = {
        pending: '待导入', hashing: '计算摘要…', uploading: '上传中…',
        done: '成功', reused: '已复用', failed: '失败', skipped: '跳过',
      };

      /** 逐行状态：导入过程中每变一次就重画一次（只重画列表，不重画整个弹窗）。 */
      const renderList = () => {
        const host = $('#loc-list', dialog);
        if (!entries.length) { host.innerHTML = ''; return; }
        const failed = entries.filter((entry) => entry.state === 'failed').length;
        $('#loc-retry', dialog).hidden = running || failed === 0;
        $('#loc-retry', dialog).textContent = `重试失败项（${failed}）`;
        host.innerHTML = `<p class="hint">已选 ${picked.size} / ${entries.length} 个文件${running ? '（导入中，已完成的不再重传）' : ''}</p>
          <ul class="queue-list">${entries.map((entry, index) => {
            const state = entry.state || (entry.skipped ? 'skipped' : 'pending');
            return `<li class="queue-item ${state}">
              ${running || entry.state ? '' : `<input type="checkbox" data-index="${index}" ${picked.has(index) ? 'checked' : ''} ${entry.skipped ? 'disabled' : ''}>`}
              <span class="wep-title">${esc(entry.title)}</span>
              <span class="queue-meta">${esc(STATE_LABEL[state] || state)}${entry.detail ? ` · ${esc(entry.detail)}` : ''}</span>
              <span class="wep-meta">${esc(entry.kindLabel || '')} · ${(entry.file.size / 1048576).toFixed(1)}MB</span>
            </li>`;
          }).join('')}</ul>`;
        const start = $('#loc-start', dialog);
        if (!running) start.disabled = picked.size === 0;
      };

      /** 把一批 File 变成 entries（识别 1080p 变体、超限、低清），然后渲染。 */
      const addFiles = async (files) => {
        if (!files || !files.length) return;
        // 先把 `xxx.1080p.mp4` 挑出来：它不是独立条目，而是 `xxx.mp4` 的变体。
        const variantFiles = files.filter((file) => VARIANT_NAME_RE.test(file.name));
        const fresh = await Promise.all(files
          .filter((file) => !VARIANT_NAME_RE.test(file.name))
          .map(async (file) => {
            const isVideo = /\.(mp4|webm)$/i.test(file.name);
            const isBundle = /\.zip$/i.test(file.name);
            const variant = variantFiles.find((candidate) => variantBase(candidate.name) === variantBase(file.name));
            const entry = {
              file,
              title: file.name.replace(/\.[^.]+$/, '').slice(0, 120),
              kind: isVideo ? 'dynamic' : 'static',
              kindLabel: `${isVideo ? '视频' : isBundle ? '资源包' : '图片'}${variant ? ' +1080p' : ''}`,
              variants: variant ? [variant] : [],
              state: 'pending',
              skipped: false,
              digest: null,
            };
            if (file.size > importCapFor(file)) {
              entry.skipped = true;
              entry.state = 'skipped';
              entry.kindLabel = `${(file.size / 1048576).toFixed(0)}MB 超限`;
              return entry;
            }
            if (!isVideo && !isBundle) {
              const width = await imageWidth(file);
              if (width > 0 && width < MIN_IMAGE_WIDTH) {
                entry.skipped = true;
                entry.state = 'skipped';
                entry.kindLabel = `${width}px 低清`;
              }
            }
            return entry;
          }));
        entries = [...entries, ...fresh];
        picked = new Set(entries.map((_, index) => index).filter((index) => !entries[index].skipped));
        $('#loc-status', dialog).textContent = `共 ${entries.length} 个文件`
          + `${variantFiles.length ? `（配到 ${variantFiles.length} 个 1080p 变体）` : ''}`;
        renderList();
      };

      // ---- 拖拽：dragover 一定要 preventDefault，否则浏览器会直接用文件打开页面 ----
      const zone = $('#loc-pick', dialog);
      let dragDepth = 0;
      zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        zone.classList.add('active');
      });
      zone.addEventListener('dragenter', (event) => {
        event.preventDefault();
        dragDepth += 1;
        zone.classList.add('active');
      });
      zone.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) zone.classList.remove('active');
      });
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        dragDepth = 0;
        zone.classList.remove('active');
        if (running) { toast('正在导入，等这一批结束再拖', 'info'); return; }
        addFiles([...event.dataTransfer.files]).catch(reportError);
      });

      input.addEventListener('change', () => {
        addFiles([...input.files]).catch(reportError);
        input.value = '';
      });
      zone.addEventListener('click', () => { if (!running) input.click(); });

      dialog.addEventListener('change', (event) => {
        const box = event.target.closest('input[data-index]');
        if (!box) return;
        const index = Number(box.dataset.index);
        if (box.checked) picked.add(index); else picked.delete(index);
        const hint = $('#loc-list p.hint', dialog);
        if (hint) hint.textContent = `已选 ${picked.size} / ${entries.length} 个文件`;
        $('#loc-start', dialog).disabled = picked.size === 0;
      });

      /** 跑一批（初次导入与重试共用）。 */
      const runBatch = async (queue, { skipped = [] } = {}) => {
        const start = $('#loc-start', dialog);
        running = true;
        start.disabled = true;
        start.textContent = '导入中…';
        const report = await runImportQueue(queue, {
          categoryId: $('#loc-module', dialog).value,
          publish: $('#loc-publish', dialog).value === '1',
          skipped,
          onProgress: (done, total) => { start.textContent = `导入中 ${done}/${total}`; },
          onEntry: () => renderList(),
        });
        running = false;
        start.textContent = '开始导入';
        start.disabled = picked.size === 0;
        renderList();
        return report;
      };

      $('#loc-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        if (running) return;
        const queue = [...picked].map((index) => entries[index]).filter((entry) => entry.state !== 'done' && entry.state !== 'reused');
        const skipped = entries
          .filter((entry, index) => entry.skipped && !picked.has(index))
          .map((entry) => ({ title: entry.title, status: 'skipped', reason: entry.kindLabel, autoFixes: [] }));
        for (const entry of queue) { entry.state = 'pending'; entry.detail = ''; }
        const report = await runBatch(queue, { skipped });
        toast(
          `成功 ${report.imported} · 复用 ${report.reused} · 失败 ${report.failed}`,
          report.failed ? 'error' : 'ok',
          8000,
        );
        await loadWallpapers();
        // 有失败项就留在弹窗里（可单条/全部重试）；全成功才自动关
        if (!report.failed) { closeDialog(); showImportReport(report); }
      });

      $('#loc-retry', dialog).addEventListener('click', async () => {
        if (running) return;
        const failed = entries.filter((entry) => entry.state === 'failed');
        if (!failed.length) return;
        for (const entry of failed) { entry.state = 'pending'; entry.detail = ''; }
        renderList();
        const report = await runBatch(failed);
        toast(`重试完成：成功 ${report.imported} · 复用 ${report.reused} · 仍失败 ${report.failed}`, report.failed ? 'error' : 'ok', 8000);
        await loadWallpapers();
        if (!report.failed) { closeDialog(); showImportReport(report); }
      });

      if (initialFiles && initialFiles.length) addFiles([...initialFiles]).catch(reportError);
    });
  }

  function wallpaperDialog(item) {
    const editing = Boolean(item);    openDialog(`
      <form id="wallpaper-form">
        <h3>${editing ? '编辑壁纸' : '新增壁纸'}</h3>
        <label>标题<input id="wp-title" required maxlength="120" value="${esc(item ? item.title : '')}" placeholder="例如：夜雨霓虹"></label>
        <label>描述<textarea id="wp-desc" rows="2" maxlength="400" placeholder="一句话说明这张壁纸（可选）">${esc(item ? item.description : '')}</textarea></label>
        ${editing ? `<p class="hint">链接标识（slug）：<code>${esc(item.slug)}</code>　用来拼分享链接，创建后不能改</p>` : ''}
        <div class="row">
          <label>分类<select id="wp-category">${categoryOptions(item && item.category ? item.category.id : '')}</select></label>
          <label>审核
            <select id="wp-review">
              <option value="pending"${item && item.reviewStatus === 'approved' ? '' : ' selected'}>未审核</option>
              <option value="approved"${item && item.reviewStatus === 'approved' ? ' selected' : ''}>已审核</option>
            </select>
          </label>
        </div>
        <label>标签${tagPickerHtml(item)}</label>
        <label>子标签<input id="wp-subtag" maxlength="40" list="wp-subtag-list"
          value="${esc(item ? item.subtag : '')}" placeholder="例如：原神" autocomplete="off">
          <datalist id="wp-subtag-list"></datalist>
        </label>
        ${canPublish() ? `
          <div class="row">
            <label>状态
              <select id="wp-status-input">
                <option value="draft"${item && item.status === 'draft' ? ' selected' : ''}>草稿</option>
                <option value="published"${item && item.status === 'published' ? ' selected' : ''}>已发布</option>
                <option value="hidden"${item && item.status === 'hidden' ? ' selected' : ''}>已隐藏</option>
              </select>
            </label>
            <label>置顶
              <select id="wp-featured">
                <option value="0"${item && item.featured ? '' : ' selected'}>不置顶</option>
                <option value="1"${item && item.featured ? ' selected' : ''}>置顶</option>
              </select>
            </label>
          </div>` : ''}
        ${editing ? '' : `
          <div class="dropzone" id="wp-drop">
            <strong>拖入文件，或点击选择</strong>
            <span class="small">图片 PNG/JPG/WebP/AVIF ≤ 20MB；视频 mp4/webm ≤ 60MB（超过 55MB 自动分片，最大 2GB）；开机动画包 zip ≤ 64MB</span>
            <div class="small" id="wp-file-name" style="margin-top:6px"></div>
          </div>`}
        <p class="hint" id="wp-progress"></p>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">${editing ? '保存' : '创建'}</button>
        </footer>
      </form>
    `, (dialog) => {
      let chosenFile = null;
      $('[data-close]', dialog).addEventListener('click', closeDialog);

      const drop = $('#wp-drop', dialog);
      if (drop) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ACCEPT;
        input.className = 'hidden';
        dialog.appendChild(input);
        const accept = (file) => {
          chosenFile = file;
          const label = $('#wp-file-name', dialog);
          if (!file) { label.textContent = ''; return; }
          label.textContent = `${file.name} · ${formatBytes(file.size)}`;
          // 低清图当场提醒：它会成为 url，铺桌面就是糊的
          if (file.type.startsWith('image/')) {
            imageWidth(file).then((width) => {
              if (width > 0 && width < MIN_IMAGE_WIDTH) {
                label.textContent += ` ⚠ 只有 ${width}px 宽，当壁纸会糊`;
              }
            });
          }
        };
        drop.addEventListener('click', () => input.click());
        input.addEventListener('change', () => accept(input.files[0] || null));
        drop.addEventListener('dragover', (event) => {
          event.preventDefault();
          drop.classList.add('dragover');
        });
        drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
        drop.addEventListener('drop', (event) => {
          event.preventDefault();
          drop.classList.remove('dragover');
          if (event.dataTransfer.files.length) accept(event.dataTransfer.files[0]);
        });
      }

      // 子标签的历史值做输入提示（不联网失败也不影响手填）
      api('/admin/subtags').then((data) => {
        const list = $('#wp-subtag-list', dialog);
        if (list) {
          list.innerHTML = (data.subtags || [])
            .map((entry) => `<option value="${esc(entry.name ?? entry)}"></option>`)
            .join('');
        }
      }).catch(() => {});

      $('#wallpaper-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = event.target.querySelector('button[type="submit"]');
        submit.disabled = true;
        const original = submit.textContent;
        try {
          const body = {
            title: $('#wp-title', dialog).value.trim(),
            description: $('#wp-desc', dialog).value.trim(),
            subtag: $('#wp-subtag', dialog).value.trim(),
            reviewStatus: $('#wp-review', dialog).value,
            categoryId: $('#wp-category', dialog).value || null,
            tags: $$('#wp-tags input:checked', dialog).map((node) => node.value),
          };
          if (canPublish()) {
            body.status = $('#wp-status-input', dialog).value;
            body.featured = $('#wp-featured', dialog).value === '1';
          }

          if (editing) {
            await api(`/admin/wallpapers/${encodeURIComponent(item.id)}`, { method: 'PATCH', body });
            closeDialog();
            toast('已保存', 'ok');
          } else {
            const data = await api('/admin/wallpapers', { method: 'POST', body });
            const id = data.wallpaper.id;
            if (chosenFile) {
              submit.textContent = '上传中…';
              const startedAt = Date.now();
              const totalBytes = chosenFile.size;
              await putAssetWithThumb(id, chosenFile, (ratio) => {
                const done = Math.min(1, ratio) * totalBytes;
                const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const speed = done / elapsed;
                const remain = speed > 0 ? Math.max(0, (totalBytes - done) / speed) : 0;
                $('#wp-progress', dialog).textContent = ratio >= 0.999
                  ? '已完成'
                  : `已上传 ${Math.round(ratio * 100)}%（${(done / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB · 剩余 ${Math.ceil(remain)} 秒）`;
              });
            }
            closeDialog();
            toast(chosenFile ? '壁纸已创建并上传' : '壁纸草稿已创建', 'ok');
          }
          await loadWallpapers();
        } catch (error) {
          submit.disabled = false;
          submit.textContent = original;
          if (error.details && error.details.wallpaperId) {
            toast(`${error.message}（可搜索「${error.details.title}」找到它）`, 'error', 7000);
          } else {
            reportError(error);
          }
        }
      });
    });
  }

  async function uploadForExisting(id) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const toastNode = document.createElement('div');
      toastNode.className = 'toast';
      toastNode.textContent = '上传中 0%';
      $('#toasts').appendChild(toastNode);
      try {
        await putAssetWithThumb(id, file, (ratio) => {
          toastNode.textContent = `上传中 ${Math.round(ratio * 100)}%`;
        });
        toastNode.remove();
        toast('文件已更新', 'ok');
        await loadWallpapers();
      } catch (error) {
        toastNode.remove();
        reportError(error);
      }
    });
    input.click();
  }

  async function patchWallpaper(id, body, successMessage) {
    try {
      await api(`/admin/wallpapers/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      if (successMessage) toast(successMessage, 'ok');
      await loadWallpapers();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  }

  async function deleteWallpaper(id) {
    const target = state.wallpapers.items.find((item) => item.id === id);
    if (!window.confirm(`确定删除「${target ? target.title : id}」？文件也会从存储里删除，无法恢复。`)) return;
    try {
      await api(`/admin/wallpapers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      await loadWallpapers();
    } catch (error) {
      reportError(error);
    }
  }

  // ------------------------------------------------------------------ 分类页
  async function mountCategories() {
    $('#view-actions').innerHTML = `
      <button class="btn" type="button" data-action="new-tag">＋ 新建标签</button>
      <button class="btn primary" type="button" data-action="new-category">＋ 新建分类</button>`;
    $('#view').innerHTML = `
      <div class="category-columns">
        <section class="status-group">
          <h3 class="group-title">前台模块分类<span class="count">${state.categories.length}</span></h3>
          <p class="muted small">前台顶部的模块，顺序即展示顺序。「全部」「喜欢」是前台虚拟状态，不在这里建。</p>
          <div id="cat-table"></div>
        </section>
        <section class="status-group">
          <h3 class="group-title">标签分类<span class="count">${state.tags.length}</span></h3>
          <p class="muted small">前台筛选栏第二行。还被作品用着的标签删不掉，要先把那些作品改掉。</p>
          <div id="tag-table"><p class="muted">加载中…</p></div>
        </section>
      </div>`;
    renderCategoryRows();
    await renderTagRows();
  }

  async function renderTagRows() {
    const host = $('#tag-table');
    if (!host) return;
    try {
      const [tagData, statData, subtagData] = await Promise.all([
        api('/admin/tags'),
        api('/admin/tag-stats'),
        api('/admin/subtags'),
      ]);
      state.tags = tagData.tags;
      state.subtags = subtagData.subtags || [];
      const counts = new Map(statData.tags.map((entry) => [entry.tag, entry.count]));
      const subtagsOf = (tagId) => state.subtags.filter((item) => item.tagId === tagId);
      // 先选前台模块，再看这个模块下的标签（全局标签在各模块里都算）
      const moduleId = state.tagModule || '';
      const visible = state.tags.filter((tag) => !moduleId || !tag.categoryId || tag.categoryId === moduleId);
      const moduleName = moduleId ? state.categories.find((c) => c.id === moduleId)?.name : '';
      const unassigned = state.subtags.filter((item) => !item.tagId);

      const chip = (item) => `<span class="subtag-chip">${esc(item.name)}<button type="button"
        data-action="delete-subtag" data-id="${esc(item.id)}" data-name="${esc(item.name)}" aria-label="删除子标签">×</button></span>`;
      // 未归类的子标签可以点名字挑一个标签挂上去
      const looseChip = (item) => `<span class="subtag-chip loose">
        <button type="button" class="subtag-name" data-action="assign-subtag"
          data-id="${esc(item.id)}" data-name="${esc(item.name)}">${esc(item.name)}</button>
        <button type="button" data-action="delete-subtag" data-id="${esc(item.id)}" data-name="${esc(item.name)}" aria-label="删除子标签">×</button></span>`;

      host.innerHTML = `
        <div class="tag-module-bar">
          <span class="muted small">前台模块</span>
          <select id="tag-module-filter">
            <option value="">全部模块</option>
            ${state.categories.map((category) => `<option value="${esc(category.id)}"${category.id === moduleId ? ' selected' : ''}>${esc(category.name)}</option>`).join('')}
          </select>
          <span class="muted small">${moduleId ? `当前模块：${esc(moduleName)} · 标签 ${visible.length} 个` : `共 ${visible.length} 个标签`}</span>
        </div>
        <table class="table">
          <thead><tr><th>顺序</th><th>名称</th><th>归属</th><th>作品数</th><th>操作</th></tr></thead>
          <tbody>${visible.map((tag, index) => `
            <tr>
              <td>
                <button class="btn small ghost" type="button" data-action="tag-up" data-id="${esc(tag.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn small ghost" type="button" data-action="tag-down" data-id="${esc(tag.id)}" ${index === visible.length - 1 ? 'disabled' : ''}>↓</button>
              </td>
              <td><input data-field="tag-name" data-id="${esc(tag.id)}" value="${esc(tag.name)}" maxlength="24"></td>
              <td><select data-field="tag-category" data-id="${esc(tag.id)}">${tagCategoryOptions(tag.categoryId)}</select></td>
              <td class="muted">${counts.get(tag.name) ?? 0}</td>
              <td class="actions">
                <button class="btn small" type="button" data-action="save-tag" data-id="${esc(tag.id)}">保存</button>
                <button class="btn small danger" type="button" data-action="delete-tag" data-id="${esc(tag.id)}" data-name="${esc(tag.name)}">删除</button>
              </td>
            </tr>
            <tr class="subtag-row">
              <td></td>
              <td colspan="4">
                <div class="subtag-list">
                  <span class="subtag-label">子标签</span>
                  ${subtagsOf(tag.id).map(chip).join('') || '<span class="muted small">还没有</span>'}
                  <input class="subtag-input" data-tag="${esc(tag.id)}" maxlength="40" placeholder="＋ 新子标签，回车添加">
                </div>
              </td>
            </tr>`).join('')}</tbody>
        </table>
        ${unassigned.length ? `
          <div class="subtag-unassigned">
            <span class="subtag-label">未归类</span>
            ${unassigned.map(looseChip).join('')}
            <span class="muted small">（这些是作品里用过、还没挂到具体标签下的子标签，挂靠后可在标签下统一管理）</span>
          </div>` : ''}`;

      const moduleSelect = $('#tag-module-filter');
      if (moduleSelect) {
        moduleSelect.addEventListener('change', (event) => {
          state.tagModule = event.target.value;
          renderTagRows().catch(reportError);
        });
      }
    } catch (error) {
      host.innerHTML = `<p class="empty small">${esc(error.message)}</p>`;
    }
  }

  /** 未归类子标签 → 选一个标签挂上去。 */
  function openSubtagAssign(id, name) {
    openDialog(`
      <form id="subtag-assign">
        <h3>归类子标签</h3>
        <p class="hint">「${esc(name)}」挂到哪个标签下面？挂好后会出现在那个标签的行里。</p>
        <label>标签
          <select id="subtag-assign-tag">
            ${state.tags.map((tag) => `<option value="${esc(tag.id)}">${esc(tag.name)}</option>`).join('')}
          </select>
        </label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">确定</button>
        </footer>
      </form>`, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#subtag-assign', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api(`/admin/subtags/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { tagId: $('#subtag-assign-tag', dialog).value },
          });
          closeDialog();
          await renderTagRows();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  /** 子标签：在输入框回车就新建到对应标签下。 */
  async function addSubtag(input) {
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    try {
      await api('/admin/subtags', { method: 'POST', body: { tagId: input.dataset.tag || null, name } });
      input.value = '';
      await renderTagRows();
    } catch (error) {
      reportError(error);
    }
  }

  async function deleteSubtag(id, name) {
    if (!window.confirm(`删除子标签「${name || id}」？只会从可选列表里移除，已用到它的作品不受影响。`)) return;
    try {
      await api(`/admin/subtags/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await renderTagRows();
    } catch (error) {
      reportError(error);
    }
  }

  /** 标签归属：全局（空）或某个分类。 */
  function tagCategoryOptions(selectedId) {
    const rows = state.categories.map((category) => (
      `<option value="${esc(category.id)}"${category.id === selectedId ? ' selected' : ''}>${esc(category.name)}</option>`
    ));
    return `<option value=""${selectedId ? '' : ' selected'}>全局（所有分类）</option>${rows.join('')}`;
  }

  function openTagDialog() {
    openDialog(`
      <form id="tag-form">
        <h3>新建标签</h3>
        <label>名称<input id="tag-name" required maxlength="24" placeholder="例如：赛博朋克 / 极简壁纸"></label>
        <label>归属<select id="tag-category">${tagCategoryOptions('')}</select></label>
        <p class="hint">「全局」标签在每个分类下都会出现；选了分类，就只在该分类的筛选栏里显示。</p>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">创建</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#tag-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api('/admin/tags', {
            method: 'POST',
            body: {
              name: $('#tag-name', dialog).value.trim(),
              categoryId: $('#tag-category', dialog).value || null,
            },
          });
          closeDialog();
          toast('标签已创建', 'ok');
          await loadTagVocabulary();
          await renderTagRows();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  async function saveTag(id) {
    const input = $(`input[data-field="tag-name"][data-id="${id}"]`);
    const categorySelect = $(`select[data-field="tag-category"][data-id="${id}"]`);
    if (!input) return;
    try {
      await api(`/admin/tags/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: {
          name: input.value.trim(),
          categoryId: categorySelect ? (categorySelect.value || null) : undefined,
        },
      });
      toast('已保存', 'ok');
      await loadTagVocabulary();
      await renderTagRows();
    } catch (error) {
      reportError(error);
    }
  }

  async function deleteTag(id, name) {
    if (!window.confirm(`删除标签「${name}」？`)) return;
    try {
      await api(`/admin/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      await loadTagVocabulary();
      await renderTagRows();
    } catch (error) {
      if (error.status === 409) toast(error.message, 'error', 8000);
      else reportError(error);
    }
  }

  async function moveTag(id, direction) {
    const index = state.tags.findIndex((tag) => tag.id === id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= state.tags.length) return;
    const next = state.tags.slice();
    const [moved] = next.splice(index, 1);
    next.splice(swapWith, 0, moved);
    state.tags = next;
    try {
      await api('/admin/tags/reorder', { method: 'POST', body: { ids: next.map((tag) => tag.id) } });
      await loadTagVocabulary();
      await renderTagRows();
    } catch (error) {
      reportError(error);
      await renderTagRows();
    }
  }

  function renderCategoryRows() {
    const host = $('#cat-table');
    if (!host) return;
    if (!state.categories.length) {
      host.innerHTML = '<p class="empty">还没有分类，先建一个「动态」试试。</p>';
      return;
    }
    const rows = state.categories.map((category, index) => `
      <tr data-cat-row="${esc(category.id)}">
        <td class="order-cell">
          <span class="drag-handle" draggable="true" data-id="${esc(category.id)}"
                title="按住拖动排序" aria-label="拖动排序">⠿</span>
          <button class="btn small ghost" type="button" data-action="category-up" data-id="${esc(category.id)}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small ghost" type="button" data-action="category-down" data-id="${esc(category.id)}" ${index === state.categories.length - 1 ? 'disabled' : ''}>↓</button>
        </td>
        <td>
          <div class="cat-name-cell">
            <input data-field="name" data-id="${esc(category.id)}" value="${esc(category.name)}" maxlength="40" aria-label="分类名">
            <input class="desc-input" data-field="description" data-id="${esc(category.id)}"
                   value="${esc(category.description)}" maxlength="400" placeholder="描述（可留空，展示在前台分类上）" aria-label="分类描述">
          </div>
        </td>
        <td class="hide-sm"><code class="muted small">${esc(category.slug)}</code></td>
        <td class="hide-sm">${category.wallpaperCount} 张 / 已发布 ${category.publishedCount}</td>
        <td><label class="small"><input type="checkbox" data-field="isPublic" data-id="${esc(category.id)}" ${category.isPublic ? 'checked' : ''}> 前台可见</label></td>
        <td class="actions">
          <button class="btn small" type="button" data-action="save-category" data-id="${esc(category.id)}">保存</button>
          <button class="btn small danger" type="button" data-action="delete-category" data-id="${esc(category.id)}">删除</button>
        </td>
      </tr>`).join('');

    host.innerHTML = `
      <table class="table">
        <thead><tr><th>顺序</th><th>名称 / 描述</th><th class="hide-sm">slug</th><th class="hide-sm">壁纸数</th><th>前台</th><th>操作</th></tr></thead>
        <tbody>${rows}
          <tr class="cat-add-row">
            <td class="muted small">＋</td>
            <td><input id="cat-new-name" maxlength="40" placeholder="新分类名称，回车直接创建"></td>
            <td class="hide-sm"></td>
            <td class="hide-sm"></td>
            <td></td>
            <td class="actions"><button class="btn small primary" type="button" data-action="create-category-inline">添加</button></td>
          </tr>
        </tbody>
      </table>`;
  }

  /** 分类页底部那一行的「快捷新建」。 */
  async function createCategoryInline(input) {
    const name = input?.value.trim();
    if (!name) return;
    try {
      await api('/admin/categories', { method: 'POST', body: { name, description: '', isPublic: true } });
      input.value = '';
      await loadCategories();
      renderCategoryRows();
      if (typeof renderTagRows === 'function') await renderTagRows();
      toast(`已新建分类「${name}」`, 'ok');
    } catch (error) {
      reportError(error);
    }
  }

  function openCategoryDialog() {
    openDialog(`
      <form id="category-form">
        <h3>新建分类</h3>
        <label>名称<input id="cat-name" required maxlength="40" placeholder="例如：极简"></label>
        <label>描述（可选）<input id="cat-desc" maxlength="400"></label>
        <label class="small"><input type="checkbox" id="cat-public" checked> 前台可见</label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">创建</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#category-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api('/admin/categories', {
            method: 'POST',
            body: {
              name: $('#cat-name', dialog).value.trim(),
              description: $('#cat-desc', dialog).value.trim(),
              isPublic: $('#cat-public', dialog).checked,
            },
          });
          closeDialog();
          toast('分类已创建', 'ok');
          await loadCategories();
          renderCategoryRows();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  async function saveCategory(id) {
    const nameInput = $(`input[data-field="name"][data-id="${id}"]`);
    const descInput = $(`input[data-field="description"][data-id="${id}"]`);
    const name = nameInput ? nameInput.value.trim() : '';
    const description = descInput ? descInput.value.trim() : '';
    const isPublic = $(`input[data-field="isPublic"][data-id="${id}"]`).checked;
    if (!name) {
      toast('分类名不能为空', 'error');
      if (nameInput) nameInput.focus();
      return;
    }
    try {
      await api(`/admin/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name, description, isPublic } });
      toast('分类已保存', 'ok');
      await loadCategories();
      renderCategoryRows();
    } catch (error) {
      reportError(error);
    }
  }

  async function deleteCategory(id) {
    const target = state.categories.find((category) => category.id === id);
    if (!target) return;

    // 空分类没什么可纠结的，直接删；有壁纸就先问清楚这些壁纸去哪
    if (!target.wallpaperCount) {
      if (!window.confirm(`删除空白分类「${target.name}」？`)) return;
      await finishDeleteCategory(id, '?strategy=detach', `分类「${target.name}」已删除`);
      return;
    }
    openDeleteCategoryDialog(target);
  }

  function openDeleteCategoryDialog(target) {
    const others = state.categories.filter((category) => category.id !== target.id);
    const options = others
      .map((category) => `<option value="${esc(category.id)}">${esc(category.name)}（${category.wallpaperCount} 张）</option>`)
      .join('');
    openDialog(`
      <form id="delete-category-form">
        <h3>删除分类「${esc(target.name)}」</h3>
        <p class="hint">这个分类下还有 ${target.wallpaperCount} 张壁纸（已发布 ${target.publishedCount} 张）。删之前先决定它们去哪。</p>
        <label class="radio-line">
          <input type="radio" name="delete-mode" value="move" ${others.length ? 'checked' : 'disabled'}>
          <span>迁移到其他分类</span>
        </label>
        <select id="delete-category-target" ${others.length ? '' : 'disabled'}>${
          options || '<option value="">没有其他分类可迁移</option>'
        }</select>
        <label class="radio-line">
          <input type="radio" name="delete-mode" value="detach" ${others.length ? '' : 'checked'}>
          <span>改为「未分类」</span>
        </label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn danger">删除分类</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#delete-category-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        const checked = $('input[name="delete-mode"]:checked', dialog);
        const mode = checked ? checked.value : 'detach';
        const to = $('#delete-category-target', dialog).value;
        if (mode === 'move' && !to) {
          toast('请选择要迁移到的分类', 'error');
          return;
        }
        closeDialog();
        const query = mode === 'move'
          ? `?strategy=move&to=${encodeURIComponent(to)}`
          : '?strategy=detach';
        await finishDeleteCategory(target.id, query, `分类「${target.name}」已删除`);
      });
    });
  }

  async function finishDeleteCategory(id, query, message) {
    try {
      const result = await api(`/admin/categories/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
      const moved = result && result.moved ? `，${result.moved} 张壁纸已迁移` : '';
      toast(`${message}${moved}`, 'ok');
      await loadCategories();
      renderCategoryRows();
    } catch (error) {
      reportError(error);
    }
  }

  async function moveCategory(id, direction) {
    const index = state.categories.findIndex((category) => category.id === id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= state.categories.length) return;
    const ids = state.categories.map((category) => category.id);
    ids.splice(swapWith, 0, ids.splice(index, 1)[0]);
    await persistCategoryOrder(ids);
  }

  /** 拖拽与 ↑↓ 共用：先乐观重排，再落库；失败就回读服务端顺序。 */
  async function persistCategoryOrder(ids) {
    const byId = new Map(state.categories.map((category) => [category.id, category]));
    state.categories = ids.map((id) => byId.get(id)).filter(Boolean);
    renderCategoryRows();
    try {
      await api('/admin/categories/reorder', { method: 'POST', body: { ids } });
      await loadCategories();
    } catch (error) {
      reportError(error);
      await loadCategories();
    }
    renderCategoryRows();
  }

  // ---- 拖拽排序：手柄上开始拖，落点按行的上下半决定插到前面还是后面 ----
  let dragCategoryId = null;

  const categoryRows = () => $$('#cat-table tr[data-cat-row]');

  function clearCategoryDropMarks() {
    for (const row of categoryRows()) row.classList.remove('drop-before', 'drop-after', 'dragging');
  }

  document.addEventListener('dragstart', (event) => {
    const handle = event.target.closest && event.target.closest('.drag-handle');
    if (!handle) return;
    dragCategoryId = handle.dataset.id;
    const row = handle.closest('tr');
    if (row) row.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox 不 setData 就不会触发后续的 drop
      event.dataTransfer.setData('text/plain', dragCategoryId);
    }
  });

  document.addEventListener('dragover', (event) => {
    if (!dragCategoryId) return;
    const row = event.target.closest && event.target.closest('#cat-table tr[data-cat-row]');
    if (!row || row.dataset.catRow === dragCategoryId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    for (const other of categoryRows()) {
      if (other === row) continue;
      other.classList.remove('drop-before', 'drop-after');
    }
    row.classList.toggle('drop-after', after);
    row.classList.toggle('drop-before', !after);
  });

  document.addEventListener('drop', (event) => {
    if (!dragCategoryId) return;
    const row = event.target.closest && event.target.closest('#cat-table tr[data-cat-row]');
    if (!row) return;
    event.preventDefault();
    const moving = dragCategoryId;
    const targetId = row.dataset.catRow;
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    dragCategoryId = null;
    clearCategoryDropMarks();
    if (moving === targetId) return;

    const ids = state.categories.map((category) => category.id).filter((id) => id !== moving);
    const anchor = ids.indexOf(targetId);
    if (anchor < 0) return;
    ids.splice(anchor + (after ? 1 : 0), 0, moving);
    persistCategoryOrder(ids).catch(reportError);
  });

  document.addEventListener('dragend', () => {
    dragCategoryId = null;
    clearCategoryDropMarks();
  });

  // ------------------------------------------------------------------ 成员页
  async function mountMembers() {
    $('#view-actions').innerHTML = '<button class="btn primary" type="button" data-action="new-member">＋ 新增成员</button>';
    const data = await api('/admin/members');
    state.members = data.members;
    renderMembers();
  }

  function renderMembers() {
    const rows = state.members.map((member) => {
      const self = member.id === state.user.id;
      return `
        <tr>
          <td><div class="title-cell"><strong>${esc(member.name)}</strong><code>${esc(member.email)}</code></div></td>
          <td>
            <select data-field="role" data-id="${esc(member.id)}" ${self ? 'disabled' : ''}>
              <option value="editor"${member.role === 'editor' ? ' selected' : ''}>编辑</option>
              <option value="admin"${member.role === 'admin' ? ' selected' : ''}>管理员</option>
            </select>
          </td>
          <td>${member.active ? '<span class="badge published">启用</span>' : '<span class="badge off">停用</span>'}</td>
          <td class="hide-sm muted small">${formatTime(member.lastLoginAt)}</td>
          <td class="actions">
            ${self ? '<span class="muted small">当前账号</span>' : `<button class="btn small" type="button" data-action="edit-member" data-id="${esc(member.id)}">编辑</button>`}
            ${self ? '' : `<button class="btn small ghost" type="button" data-action="save-member" data-id="${esc(member.id)}">保存角色</button>`}
            ${self ? '' : `<button class="btn small ghost" type="button" data-action="toggle-member" data-id="${esc(member.id)}" data-active="${member.active ? '1' : '0'}">${member.active ? '停用' : '启用'}</button>`}
            ${self ? '' : `<button class="btn small ghost" type="button" data-action="reset-password" data-id="${esc(member.id)}" data-email="${esc(member.email)}">重置密码</button>`}
            ${self ? '' : `<button class="btn small danger" type="button" data-action="delete-member" data-id="${esc(member.id)}" data-email="${esc(member.email)}">删除</button>`}
          </td>
        </tr>`;
    }).join('');

    $('#view').innerHTML = `
      <p class="muted small" style="margin-top:0">
        编辑可以上传壁纸、维护自己上传的草稿、选择分类；管理员还能发布、删除、管理分类与成员。
      </p>
      <table class="table">
        <thead><tr><th>成员</th><th>角色</th><th>状态</th><th class="hide-sm">最后登录</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">还没有成员</td></tr>'}</tbody>
      </table>`;
  }

  function openMemberDialog() {
    openDialog(`
      <form id="member-form">
        <h3>新增成员</h3>
        <label>账号<input id="member-email" type="text" required placeholder="用户名或邮箱"></label>
        <label>显示名<input id="member-name" required maxlength="60"></label>
        <label>角色
          <select id="member-role">
            <option value="editor">编辑</option>
            <option value="admin">管理员</option>
          </select>
        </label>
        <label>初始密码<input id="member-password" type="password" required minlength="10" autocomplete="new-password"></label>
        <p class="hint">把账号和初始密码告诉对方，登录后请提醒他自行修改密码。</p>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">创建</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#member-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api('/admin/members', {
            method: 'POST',
            body: {
              email: $('#member-email', dialog).value.trim(),
              name: $('#member-name', dialog).value.trim(),
              role: $('#member-role', dialog).value,
              password: $('#member-password', dialog).value,
            },
          });
          closeDialog();
          toast('成员已创建', 'ok');
          await mountMembers();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  async function saveMember(id) {
    const role = $(`select[data-field="role"][data-id="${id}"]`).value;
    try {
      await api(`/admin/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: { role } });
      toast('已保存', 'ok');
      await mountMembers();
    } catch (error) {
      reportError(error);
      await mountMembers();
    }
  }

  async function deleteMember(id, email) {
    const label = email || id;
    openDialog(`
      <form id="delete-member-form">
        <h3>删除成员</h3>
        <p class="hint">即将删除 <strong>${esc(label)}</strong>：账号和登录状态立即失效，他上传的壁纸会保留（作者栏变空）。<br>这一步不可撤销。</p>
        <label>删除口令
          <input id="delete-member-passcode" type="password" required autocomplete="off" placeholder="站点级删除口令（不是你的登录密码）">
        </label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn danger">删除成员</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#delete-member-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api(`/admin/members/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            body: { passcode: $('#delete-member-passcode', dialog).value },
          });
          closeDialog();
          toast('已删除', 'ok');
          await mountMembers();
        } catch (error) {
          reportError(error);
          if (error.status === 403) $('#delete-member-passcode', dialog)?.select();
        }
      });
    });
  }

  /** 改显示名 / 登录邮箱（账号名）。改邮箱等于换登录名，原密码不变。 */
  function openMemberEdit(member) {
    if (!member) return;
    openDialog(`
      <form id="member-edit-form">
        <h3>编辑成员</h3>
        <label>显示名<input id="member-edit-name" value="${esc(member.name)}" required maxlength="60"></label>
        <label>账号<input id="member-edit-email" type="text" value="${esc(member.email)}" required placeholder="用户名或邮箱"></label>
        <p class="hint">改账号后，对方下次要用新账号登录；密码不变。</p>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">保存</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#member-edit-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api(`/admin/members/${encodeURIComponent(member.id)}`, {
            method: 'PATCH',
            body: {
              name: $('#member-edit-name', dialog).value.trim(),
              email: $('#member-edit-email', dialog).value.trim(),
            },
          });
          closeDialog();
          toast('已保存', 'ok');
          await mountMembers();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  async function toggleMember(id, active) {    if (!window.confirm(active ? '停用后该成员立即无法登录，确定？' : '重新启用该成员？')) return;
    try {
      await api(`/admin/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active: !active } });
      toast(active ? '已停用' : '已启用', 'ok');
      await mountMembers();
    } catch (error) {
      reportError(error);
    }
  }

  function openResetPassword(id, email) {
    openDialog(`
      <form id="reset-form">
        <h3>重置密码</h3>
        <p class="hint">为 ${esc(email)} 设置新密码。该成员的所有登录状态会立即失效。</p>
        <label>新密码<input id="reset-password" type="password" required minlength="10" autocomplete="new-password"></label>
        <footer>
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">重置</button>
        </footer>
      </form>
    `, (dialog) => {
      $('[data-close]', dialog).addEventListener('click', closeDialog);
      $('#reset-form', dialog).addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
          await api(`/admin/members/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { password: $('#reset-password', dialog).value },
          });
          closeDialog();
          toast('密码已重置', 'ok');
          await mountMembers();
        } catch (error) {
          reportError(error);
        }
      });
    });
  }

  // ------------------------------------------------------------------ 审计页
  async function mountAudit() {
    const data = await api('/admin/audit?limit=150');
    state.audit = data.items;
    const rows = state.audit.map((entry) => `
      <tr>
        <td class="muted small" style="white-space:nowrap">${formatTime(entry.at)}</td>
        <td><span class="badge">${esc(AUDIT_LABEL[entry.action] || entry.action)}</span></td>
        <td class="hide-sm">${esc(entry.actorEmail || '—')}</td>
        <td class="hide-sm">${esc(entry.targetType)}${entry.targetId ? ` · ${esc(entry.targetId.slice(0, 14))}` : ''}</td>
        <td class="muted small">${esc(entry.detail)}</td>
      </tr>`).join('');
    $('#view').innerHTML = `
      <p class="muted small" style="margin-top:0">最近 150 条写操作记录。谁改了什么，这里都有。</p>
      <table class="table">
        <thead><tr><th>时间</th><th>动作</th><th class="hide-sm">操作人</th><th class="hide-sm">对象</th><th>详情</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">暂无记录</td></tr>'}</tbody>
      </table>`;
  }

  // ------------------------------------------------------------------ 事件
  document.addEventListener('click', (event) => {
    const navButton = event.target.closest('.nav-item');
    if (navButton) {
      switchView(navButton.dataset.view).catch(reportError);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    const item = id ? state.wallpapers.items.find((row) => row.id === id) : null;

    switch (action) {
      case 'new-wallpaper':
        wallpaperDialog(null);
        break;
      case 'import-local':
        openLocalImport();
        break;
      case 'add-import-dir':
        addImportDir();
        break;
      case 'scan-import':
        scanImportDirs({ silent: false })
          .then((count) => { if (!count) toast('没有发现新作品', 'info'); })
          .catch(reportError);
        break;
      case 'edit-wallpaper':
        if (item) wallpaperDialog(item);
        break;
      case 'upload-wallpaper':
        if (id) uploadForExisting(id);
        break;
      case 'publish':
        patchWallpaper(id, { status: 'published' }, '已发布').catch(reportError);
        break;
      case 'unpublish':
        patchWallpaper(id, { status: 'draft' }, '已下线').catch(reportError);
        break;
      case 'delete-wallpaper':
        deleteWallpaper(id);
        break;
      case 'bulk-delete':
        bulkDeleteWallpapers().catch(reportError);
        break;
      case 'bulk-tags':
        bulkSetTags().catch(reportError);
        break;
      case 'bulk-publish':
        bulkPatch({ status: 'published' }, '批量发布').catch(reportError);
        break;
      case 'bulk-unpublish':
        bulkPatch({ status: 'draft' }, '批量下线').catch(reportError);
        break;
      case 'bulk-hide':
        if (window.confirm(`把选中的 ${pickedIds().length} 件设为「已下线」（软删，记录和文件都保留）？`)) {
          bulkPatch({ status: 'hidden' }, '批量软删').catch(reportError);
        }
        break;
      case 'filter-needs-variant':
        state.filters.needsVariant = !state.filters.needsVariant;
        if (button.id === 'wp-needs-btn') {
          button.classList.toggle('primary', state.filters.needsVariant);
          button.classList.toggle('ghost', !state.filters.needsVariant);
        }
        loadWallpapers().catch(reportError);
        break;
      case 'new-category':
        openCategoryDialog();
        break;
      case 'new-tag':
        openTagDialog();
        break;
      case 'save-tag':
        saveTag(id);
        break;
      case 'delete-tag':
        deleteTag(id, button.dataset.name || '');
        break;
      case 'delete-subtag':
        deleteSubtag(id, button.dataset.name || '');
        break;
      case 'approve-all':
        approveAll().catch(reportError);
        break;
      case 'reset-filters':
        state.filters = { q: '', status: '', review: '', categoryId: '', tag: '', subtag: '', format: '' };
        mountWallpapers().catch(reportError);
        break;
      case 'create-category-inline':
        createCategoryInline($('#cat-new-name')).catch(reportError);
        break;
      case 'assign-subtag':
        openSubtagAssign(id, button.dataset.name || '');
        break;
      case 'tag-up':
        moveTag(id, -1);
        break;
      case 'tag-down':
        moveTag(id, 1);
        break;
      case 'save-category':
        saveCategory(id);
        break;
      case 'delete-category':
        deleteCategory(id);
        break;
      case 'category-up':
        moveCategory(id, -1);
        break;
      case 'category-down':
        moveCategory(id, 1);
        break;
      case 'new-member':
        openMemberDialog();
        break;
      case 'save-member':
        saveMember(id);
        break;
      case 'edit-member':
        openMemberEdit(state.members.find((member) => member.id === id));
        break;
      case 'toggle-member':
        toggleMember(id, button.dataset.active === '1');
        break;
      case 'reset-password':
        openResetPassword(id, button.dataset.email || '');
        break;
      case 'delete-member':
        deleteMember(id, button.dataset.email || '');
        break;
      default:
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = event.target.closest ? event.target : null;
    if (!target) return;
    const input = target.closest('.subtag-input');
    if (input && event.key === 'Enter') {
      event.preventDefault();
      addSubtag(input).catch(reportError);
      return;
    }
    const catInput = target.closest('#cat-new-name');
    if (catInput && event.key === 'Enter') {
      event.preventDefault();
      createCategoryInline(catInput).catch(reportError);
    }
  });

  document.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-action="select-category"]');
    if (!select) return;
    const id = select.dataset.id;
    const categoryId = select.value || null;
    patchWallpaper(id, { categoryId }, '分类已更新').catch(reportError);
  });

  document.addEventListener('DOMContentLoaded', () => {
    $('#login-form').addEventListener('submit', doLogin);
    $('#setup-form').addEventListener('submit', doSetup);
    $('#btn-logout').addEventListener('click', doLogout);
    $('#btn-password').addEventListener('click', openPasswordDialog);
    $('#dialog').addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog();
    });
    boot();
  });
})();
