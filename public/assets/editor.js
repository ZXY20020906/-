/**
 * 前台即后台。
 *
 * 站点本来就是「登录才能看」，所以画廊不需要另一个后台页面：有写权限的人在这里
 * 打开编辑模式，卡片上就会长出编辑 / 发布 / 删除，顶栏多出上传与分类管理。
 * 所有写操作都走 /api/admin/*，权限仍然由服务端逐请求判定，这里只决定「显示什么按钮」。
 *
 * 这个模块不 import gallery.js（避免循环），只通过 mountEditor 拿到的 facade
 * 和一个 folia:grid 事件沟通。
 */

const HEADERS = { 'x-folia-client': 'admin' };
const THUMB_WIDTH = 640;

let facade = null;
let bar = null;
let toggleButton = null;

const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));
const toast = (message, kind = 'info') => facade.toast(message, kind);

// ------------------------------------------------------------------ 请求
async function request(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { ...HEADERS }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof File) {
      init.headers['content-type'] = body.type || 'application/octet-stream';
      init.body = body;
    } else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`/api${path}`, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok === false) {
    const error = new Error((payload && payload.error && payload.error.message) || `请求失败（${response.status}）`);
    error.status = response.status;
    error.details = payload && payload.error ? payload.error.details : null;
    throw error;
  }
  return payload.data;
}

// ------------------------------------------------------- 谁是负责人（权限）
const has = (cap) => facade.has(cap);
const canPublish = () => has('wallpaper:publish');
const canDelete = () => has('wallpaper:delete');

function canEditItem(item) {
  if (!item) return false;
  // 第 4 项：前台编辑模式只用于「已上线」的壁纸（草稿/已下线不给编辑入口）
  if (item.status !== 'published') return false;
  if (has('wallpaper:update:any')) return true;
  if (!has('wallpaper:update:own')) return false;
  const user = facade.state.user;
  return Boolean(user && item.createdBy && item.createdBy === user.id);
}

// ------------------------------------------------------------------ 界面骨架
function injectToggle() {
  const actions = $('.head-actions');
  if (!actions) return;
  toggleButton = document.createElement('button');
  toggleButton.type = 'button';
  toggleButton.className = 'ghost edit-toggle';
  toggleButton.textContent = '编辑';
  toggleButton.title = '把画廊切成可编辑状态';
  toggleButton.addEventListener('click', () => toggle(!facade.state.editing));
  actions.insertBefore(toggleButton, actions.firstChild);
}

function injectBar() {
  bar = document.createElement('div');
  bar.className = 'edit-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <span class="edit-bar-label">编辑模式</span>
    <!-- 第 3 项：前台编辑模式只做「预览 / 改名 / 改分类 / 删除」，上传与分类管理收归后台 -->
    <a class="edit-bar-btn" href="/admin/" title="成员、审计日志、批量导入">高级</a>
    <button type="button" class="edit-bar-btn ghost" data-admin="exit">退出编辑</button>`;
  document.body.appendChild(bar);

  bar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-admin]');
    if (!button) return;
    const action = button.dataset.admin;
    if (action === 'exit') toggle(false);
    if (action === 'upload') openUploadDialog().catch(report);
    if (action === 'categories') openCategoryManager().catch(report);
  });
}

async function toggle(on) {
  if (on === facade.state.editing) return;
  await facade.setEditing(on);
  const editing = facade.state.editing;
  bar.hidden = !editing;
  if (toggleButton) {
    toggleButton.textContent = editing ? '退出编辑' : '编辑';
    toggleButton.classList.toggle('active', editing);
  }
  if (editing) decorateGrid();
  syncUrl(editing);
}

function syncUrl(editing) {
  const params = new URLSearchParams(location.search);
  if (editing) params.set('edit', '1');
  else params.delete('edit');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function report(error) {
  if (!error) return;
  toast(error.message || '操作失败', 'error');
}

// ------------------------------------------------------------------ 卡片装饰
function itemOf(slug) {
  return facade.state.items.find((item) => item.slug === slug) || null;
}

function decorateGrid() {
  if (!facade.state.editing) return;
  for (const card of $$('#grid .card')) {
    const slug = card.dataset.slug;
    const item = itemOf(slug);
    if (!item) continue;

    let host = $('.card-admin', card);
    if (!host) {
      host = document.createElement('span');
      host.className = 'card-admin';
      card.appendChild(host);
    }

    const tools = [];
    if (canEditItem(item)) tools.push('<span class="admin-tool" role="button" tabindex="0" data-edit="edit" title="编辑标题、分类、标签">✎</span>');
    host.innerHTML = tools.join('');

    let status = $('.admin-status', card);
    if (!status) {
      status = document.createElement('span');
      status.className = 'admin-status';
      card.appendChild(status);
    }
    // 编辑模式下在卡片下方列出标签：一眼能认出要编辑的是哪张
    let tagsEl = $(".card-tags", card);
    if (!tagsEl) {
      tagsEl = document.createElement("span");
      tagsEl.className = "card-tags";
      card.appendChild(tagsEl);
    }
    const tagText = Array.isArray(item.tags) && item.tags.length ? item.tags.join(" · ") : "";
    tagsEl.textContent = tagText;
    tagsEl.hidden = !tagText;
    const label = item.status === 'published' ? '' : item.status === 'hidden' ? '已下线' : '草稿';
    status.textContent = label;
    status.hidden = !label;
    status.dataset.state = item.status || 'draft';
  }
}

function onCaptureClick(event) {
  const tool = event.target.closest && event.target.closest('[data-edit]');
  if (!tool) return;
  event.preventDefault();
  event.stopPropagation();
  const card = tool.closest('.card');
  const item = card ? itemOf(card.dataset.slug) : null;
  if (!item) return;
  const action = tool.dataset.edit;
  if (action === 'edit') openWallpaperDialog(item).catch(report);
  else if (action === 'delete') removeWallpaper(item).catch(report);
  else togglePublish(item).catch(report);
}

function onCaptureKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const tool = event.target.closest && event.target.closest('[data-edit]');
  if (!tool) return;
  event.preventDefault();
  tool.click ? tool.click() : onCaptureClick(event);
}

// ------------------------------------------------------------------ 作品操作
async function togglePublish(item) {
  const next = item.status === 'published' ? 'draft' : 'published';
  await request(`/admin/wallpapers/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { status: next } });
  toast(next === 'published' ? `「${item.title}」已发布` : `「${item.title}」已下线`, 'ok');
  await facade.refresh();
}

async function removeWallpaper(item) {
  if (!window.confirm(`删除「${item.title}」？原文件也会一起删掉，不能撤销。`)) return false;
  await request(`/admin/wallpapers/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  toast('已删除', 'ok');
  await facade.refresh();
  return true;
}

// ------------------------------------------------------------------ 弹层
function openSheet(html, { onSubmit } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML = html;
  document.body.appendChild(dialog);
  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
    if (event.target.closest && event.target.closest('[data-close]')) close();
  });
  const form = $('form', dialog);
  if (form && onSubmit) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onSubmit(dialog, close);
    });
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  return dialog;
}

function categoryOptions(selectedId) {
  const rows = facade.state.categories.map((category) => (
    `<option value="${esc(category.id)}"${category.id === selectedId ? ' selected' : ''}>${esc(category.name)}</option>`
  ));
  rows.unshift(`<option value=""${selectedId ? '' : ' selected'}>未分类</option>`);
  return rows.join('');
}

// ------------------------------------------------------------------ 编辑作品
/** 标签选择项：字典在后端维护（/admin/subtags），这里只读；没有就明确显示"无标签"。 */
async function subtagFieldHtml(item) {
  const current = String(item.subtag || '');
  try {
    const data = await request('/admin/subtags');
    const rows = Array.isArray(data && data.subtags) ? data.subtags : [];
    if (!rows.length) return { html: '<p class="sheet-hint">标签：无标签（在后台「分类」里创建）</p>', editable: false };
    const options = rows.map((row) => (
      `<option value="${esc(row.name)}"${row.name === current ? ' selected' : ''}>${esc(row.name)}${row.tagName ? `（${esc(row.tagName)}）` : ''}</option>`
    )).join('');
    return {
      html: `<label class="field-row">标签
        <select name="subtag"><option value=""${current ? '' : ' selected'}>（无标签）</option>${options}</select>
      </label>`,
      editable: true,
    };
  } catch {
    // 没权限/网络失败都不能把弹层卡住：按"没有标签"处理，原来的值保持不变
    return { html: '<p class="sheet-hint">标签：无标签（读取失败，稍后重试）</p>', editable: false };
  }
}

async function openWallpaperDialog(item) {
  const subtagField = await subtagFieldHtml(item);
  const dialog = openSheet(`
    <form>
      <h3>编辑「${esc(item.title)}」</h3>
      <label class="field-row">标题
        <input name="title" value="${esc(item.title)}" maxlength="120" required>
      </label>
      <label class="field-row">分类
        <select name="categoryId">${categoryOptions(item.category ? item.category.id : '')}</select>
      </label>
      ${subtagField.html}
      <p class="sheet-hint">已有标签：${(item.tags || []).length ? esc((item.tags || []).join(' · ')) : '（无）'} · 编辑模式下不可改</p>
      <p class="sheet-hint">文件：${esc(item.mime || '未上传')} · ${esc(facade.formatBytes(item.bytes))}${
        item.width && item.height ? ` · ${item.width}×${item.height}` : ''
      }</p>
      <footer>
        <button type="button" class="btn danger" data-remove>删除</button>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">保存</button>
      </footer>
    </form>`, {
    onSubmit: async (scope, close) => {
      const form = $('form', scope);
      const body = {
        title: $('input[name="title"]', form).value.trim(),
        categoryId: $('select[name="categoryId"]', form).value || null,
      };
      // 只有真的给了下拉框才提交标签；没有字典时不动原值
      if (subtagField.editable) {
        const select = $('select[name="subtag"]', form);
        body.subtag = select ? select.value : '';
      }
      try {
        const updated = await request(`/admin/wallpapers/${encodeURIComponent(item.id)}`, { method: 'PATCH', body });
        close();
        toast('已保存', 'ok');
        // 第 4 项：原地更新卡片文案（不改顺序），只有拿不到返回值时才退回整表刷新
        const patch = updated && (updated.wallpaper || updated);
        if (patch && typeof patch === 'object' && typeof patch.title === 'string') {
          item.title = patch.title;
          if (patch.category) item.category = patch.category;
          const card = `#grid .card[data-slug="${item.slug}"]`;
          const node = document.querySelector(card);
          if (node) {
            const titleNode = node.querySelector('.card-title, h2, h3');
            if (titleNode) titleNode.textContent = item.title;
            const catNode = node.querySelector('.card-cat');
            if (catNode && item.category) catNode.textContent = item.category.name;
          }
        } else {
          await facade.refresh();
        }
      } catch (error) {
        report(error);
      }
    },
  });

  $('[data-remove]', dialog).addEventListener('click', async () => {
    if (!window.confirm(`删除「${item.title}」？原文件也会一起删掉，不能撤销。`)) return;
    try {
      await request(`/admin/wallpapers/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      if (dialog.open) dialog.close();
      await facade.refresh();
    } catch (error) {
      report(error);
    }
  });

}

async function replaceAsset(wallpaperId, file) {
  await request(`/admin/wallpapers/${encodeURIComponent(wallpaperId)}/asset`, { method: 'PUT', body: file });
  const thumb = await makeThumbnail(file);
  if (thumb) {
    await request(`/admin/wallpapers/${encodeURIComponent(wallpaperId)}/thumb`, { method: 'PUT', body: thumb })
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ 上传
function guessKind(file) {
  if (file.type && file.type.startsWith('video/')) return 'dynamic';
  if (/\.zip$/i.test(file.name)) return 'dynamic';
  return 'static';
}

function baseTitle(name) {
  return String(name || '未命名').replace(/\.[^.]+$/, '').slice(0, 120) || '未命名';
}

async function openUploadDialog() {
  const current = facade.currentCategory();
  const dialog = openSheet(`
    <form>
      <h3>上传作品</h3>
      <label class="drop-file">
        <input type="file" name="files" accept="image/*,video/*,.zip" multiple required>
        <span>选择文件，或把文件拖到这里</span>
      </label>
      <label class="field-row">分类
        <select name="categoryId">${categoryOptions(current ? current.id : '')}</select>
      </label>
      ${canPublish() ? '<label class="check-row"><input type="checkbox" name="publish" checked> 上传后直接发布</label>' : ''}
      <p class="sheet-hint">图片和视频会自动生成封面；zip 资源包按「动态」存。发布前请确认能正常预览。</p>
      <ul class="upload-list" hidden></ul>
      <footer>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn primary">开始上传</button>
      </footer>
    </form>`, {
    onSubmit: async (scope, close) => {
      const form = $('form', scope);
      const files = Array.from($('input[name="files"]', form).files || []);
      if (!files.length) return toast('先选文件', 'error');
      const categoryId = $('select[name="categoryId"]', form).value || null;
      const publish = canPublish() && $('input[name="publish"]', form).checked;
      const list = $('.upload-list', form);
      list.hidden = false;
      list.innerHTML = '';
      const button = $('button[type="submit"]', form);
      button.disabled = true;

      let done = 0;
      for (const file of files) {
        const row = document.createElement('li');
        row.textContent = `${file.name} · 上传中…`;
        list.appendChild(row);
        try {
          await uploadOne(file, categoryId, publish, (stage) => {
            row.textContent = `${file.name} · ${stage}`;
          });
          row.textContent = `${file.name} · 完成`;
          row.classList.add('ok');
          done += 1;
        } catch (error) {
          row.textContent = `${file.name} · ${error.message}`;
          row.classList.add('bad');
        }
      }
      button.disabled = false;
      if (done) {
        toast(`上传完成 ${done} 个`, 'ok');
        await facade.refresh();
        close();
      }
    },
  });
}

async function uploadOne(file, categoryId, publish, onStage) {
  const kind = guessKind(file);
  const created = await request('/admin/wallpapers', {
    method: 'POST',
    body: { title: baseTitle(file.name), kind, categoryId, tags: [] },
  });
  const id = created.wallpaper.id;

  try {
    onStage('上传文件');
    await request(`/admin/wallpapers/${encodeURIComponent(id)}/asset`, { method: 'PUT', body: file });

    onStage('生成封面');
    const thumb = await makeThumbnail(file);
    if (thumb) {
      await request(`/admin/wallpapers/${encodeURIComponent(id)}/thumb`, { method: 'PUT', body: thumb }).catch(() => {});
    }

    if (publish) {
      onStage('发布');
      await request(`/admin/wallpapers/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'published' } });
    }
  } catch (error) {
    // 传一半失败就别留一条空壳草稿在库里
    await request(`/admin/wallpapers/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
  return id;
}

// ------------------------------------------------------------------ 分类管理
async function openCategoryManager() {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet sheet-wide';
  dialog.innerHTML = `
    <div class="cat-manage">
      <header>
        <h3>分类</h3>
        <button type="button" class="btn small ghost" data-close>关闭</button>
      </header>
      <p class="sheet-hint">顺序就是前台 tab 的顺序；「前台可见」关掉后这个分类和里面的作品都不出现在画廊。</p>
      <div class="cat-manage-list">加载中…</div>
      <form class="cat-create">
        <input name="name" placeholder="新分类名称" maxlength="40" required>
        <button type="submit" class="btn small primary">新建</button>
      </form>
    </div>`;
  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || (event.target.closest && event.target.closest('[data-close]'))) {
      if (dialog.open) dialog.close();
      else dialog.remove();
    }
  });

  const list = $('.cat-manage-list', dialog);

  const render = async () => {
    let categories = [];
    try {
      const data = await request('/admin/categories');
      categories = data.categories || [];
    } catch (error) {
      list.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
      return;
    }
    list.innerHTML = categories.map((category, index) => `
      <div class="cat-row" data-id="${esc(category.id)}" data-count="${Number(category.wallpaperCount) || 0}">
        <span class="cat-order">
          <button type="button" class="icon-btn" data-cat="up"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="icon-btn" data-cat="down"${index === categories.length - 1 ? ' disabled' : ''}>↓</button>
        </span>
        <div class="cat-main">
          <input class="cat-name" value="${esc(category.name)}" maxlength="40" aria-label="分类名">
          <span class="cat-meta">${category.wallpaperCount} 张 / 已发布 ${category.publishedCount}</span>
        </div>
        <label class="cat-public"><input type="checkbox"${category.isPublic ? ' checked' : ''}> 可见</label>
        <button type="button" class="icon-btn danger" data-cat="delete" title="删除分类">✕</button>
      </div>`).join('') || '<p class="empty">还没有分类</p>';

    list.dataset.order = JSON.stringify(categories.map((category) => category.id));
  };

  const reorder = async (ids) => {
    try {
      await request('/admin/categories/reorder', { method: 'POST', body: { ids } });
      await facade.refreshCategories();
      await facade.refresh();
    } catch (error) {
      report(error);
    }
    await render();
  };

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-cat]');
    if (!button) return;
    const row = button.closest('.cat-row');
    const id = row.dataset.id;
    const ids = JSON.parse(list.dataset.order || '[]');
    const index = ids.indexOf(id);
    const action = button.dataset.cat;

    if (action === 'up' || action === 'down') {
      const swap = index + (action === 'up' ? -1 : 1);
      if (swap < 0 || swap >= ids.length) return;
      ids.splice(swap, 0, ids.splice(index, 1)[0]);
      await reorder(ids);
      return;
    }
    if (action === 'delete') {
      await deleteCategory(row, render);
    }
  });

  list.addEventListener('change', async (event) => {
    const row = event.target.closest('.cat-row');
    if (!row) return;
    const id = row.dataset.id;
    const name = $('.cat-name', row).value.trim();
    const isPublic = $('input[type="checkbox"]', row).checked;
    if (!name) {
      toast('分类名不能为空', 'error');
      return;
    }
    try {
      await request(`/admin/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name, isPublic } });
      toast('已保存', 'ok');
      await facade.refreshCategories();
      await facade.refresh();
      await render();
    } catch (error) {
      report(error);
    }
  });

  $('.cat-create', dialog).addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = $('input[name="name"]', form);
    const name = input.value.trim();
    if (!name) return;
    try {
      await request('/admin/categories', { method: 'POST', body: { name } });
      input.value = '';
      toast('分类已创建', 'ok');
      await facade.refreshCategories();
      await render();
    } catch (error) {
      report(error);
    }
  });

  await render();
}

/**
 * 删分类：空分类直接删；还有作品时必须先决定这些作品去哪（迁移 / 转未分类）。
 * 和高级后台的规则一致，只是这里收在一个小弹层里。
 */
async function deleteCategory(row, after) {
  const id = row.dataset.id;
  const name = $('.cat-name', row).value.trim();
  const used = Number(row.dataset.count || 0);

  if (!used) {
    if (!window.confirm(`删除空白分类「${name}」？`)) return;
    try {
      await request(`/admin/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('分类已删除', 'ok');
    } catch (error) {
      return report(error);
    }
    await facade.refreshCategories();
    await after();
    return;
  }

  const data = await request('/admin/categories');
  const others = (data.categories || []).filter((category) => category.id !== id);
  const options = others.map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('');
  const dialog = openSheet(`
    <form>
      <h3>删除分类「${esc(name)}」</h3>
      <p class="sheet-hint">这个分类下还有 ${used} 张作品。删之前先决定它们去哪。</p>
      <label class="field-row">去处
        <select name="to">
          <option value="">改为未分类</option>
          ${options}
        </select>
      </label>
      <footer>
        <button type="button" class="btn ghost" data-close>取消</button>
        <button type="submit" class="btn danger">删除分类</button>
      </footer>
    </form>`, {
    onSubmit: async (scope, close) => {
      const to = $('select[name="to"]', scope).value;
      const query = to
        ? `?strategy=move&to=${encodeURIComponent(to)}`
        : '?strategy=detach';
      try {
        await request(`/admin/categories/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
        close();
        toast('分类已删除', 'ok');
        await facade.refreshCategories();
        await after();
      } catch (error) {
        report(error);
      }
    },
  });
  return dialog;
}

// ------------------------------------------------------------------ 封面生成
function drawThumb(source, maxWidth = THUMB_WIDTH) {
  const width = source.videoWidth || source.width;
  const height = source.videoHeight || source.height;
  if (!width || !height) return Promise.resolve(null);
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/webp', 0.82));
}

function videoFrame(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  return new Promise((resolve) => {
    video.onloadeddata = async () => {
      await new Promise((done) => {
        video.onseeked = done;
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
        setTimeout(done, 2500);
      });
      const blob = await drawThumb(video);
      URL.revokeObjectURL(url);
      resolve(blob);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    setTimeout(() => resolve(null), 8000);
  });
}

async function makeThumbnail(file) {
  if (!file) return null;
  if (file.type.startsWith('video/')) return videoFrame(file);
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const blob = await drawThumb(bitmap);
    if (bitmap.close) bitmap.close();
    return blob;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 预览里的编辑/删除
/**
 * 预览弹层底部的「编辑」「删除」：编辑模式下才可见（由 gallery 控制显隐）。
 * 用事件委托挂一次，避免每次打开预览都重新绑定、也避免按钮还没渲染时抓不到。
 */
function onViewerAction(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const editButton = target.closest('#viewer-edit');
  const deleteButton = target.closest('#viewer-delete');
  if (!editButton && !deleteButton) return;
  event.preventDefault();
  event.stopPropagation();

  const list = facade.state.viewerList || [];
  const item = list[facade.state.viewerIndex];
  if (!item) return;

  if (editButton) {
    openWallpaperDialog(item).catch(report);
    return;
  }
  removeWallpaper(item).then((removed) => {
    // 只有真的删掉了才关预览；点"取消"不该把预览也关掉
    if (!removed) return;
    const viewer = document.querySelector('#viewer');
    if (viewer && viewer.open) viewer.close();
  }).catch(report);
}

// ------------------------------------------------------------------ 挂载
export function mountEditor(f) {
  facade = f;
  if (!facade.canManage()) return;

  injectToggle();
  injectBar();

  document.addEventListener('folia:grid', () => decorateGrid());
  document.addEventListener('click', onCaptureClick, true);
  document.addEventListener('keydown', onCaptureKeydown, true);
  document.addEventListener('click', onViewerAction, true);

  // ?edit=1 深链：等第一屏列表渲染完再切，避免和首屏的公开列表请求打架
  if (new URLSearchParams(location.search).get('edit') === '1') {
    const once = () => {
      document.removeEventListener('folia:grid', once);
      toggle(true).catch(report);
    };
    document.addEventListener('folia:grid', once);
  }

  window.foliaEditor = { toggle, openUploadDialog, openCategoryManager };
}
