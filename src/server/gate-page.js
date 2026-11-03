/**
 * 站点登录页：单文件 HTML（内联样式，零外部资源），
 * 它自己也在门里，所以不需要放行任何静态文件。
 */
import { GATE_PATH } from './gate.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const NO_STORE = {
  'cache-control': 'no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};

export const PAGE_HEADERS = { ...NO_STORE, 'content-security-policy': CSP };

/**
 * @param {{next?: string, error?: string, status?: number, retryAfter?: number, headers?: Record<string,string>}} [options]
 * @returns {Response}
 */
export function loginPage({ next = '/', error = '', status = 401, retryAfter = 0, headers: extra = {} } = {}) {
  const headers = { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra };
  if (status === 429) headers['retry-after'] = String(Math.max(1, Math.ceil(Number(retryAfter) || 60)));
  return new Response(renderLoginPage({ next, error }), { status, headers });
}

export function renderLoginPage({ next = '/', error = '' } = {}) {
  const errorBlock = error ? `<p class="err" role="alert">${esc(error)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0a0a0c">
<title>欢迎回家 · Folia</title>
<style>
  :root {
    --bg: #0a0a0c; --card: #16161c; --line: #24242c;
    --text: #ececf1; --muted: #8b8b99; --accent: #7c6cff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; place-items: center; padding: 24px;
    background: var(--bg); color: var(--text); overflow: hidden;
    font: 15px/1.6 "Inter", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  }
  body::before, body::after {
    content: ""; position: fixed; width: 62vmax; height: 62vmax; border-radius: 50%;
    filter: blur(90px); pointer-events: none; z-index: 0;
  }
  body::before { background: #7c6cff; opacity: .20; top: -28vmax; left: -14vmax; }
  body::after { background: #f0a07c; opacity: .10; bottom: -32vmax; right: -18vmax; }
  .card {
    position: relative; z-index: 1; width: 100%; max-width: 396px;
    padding: 34px 30px 24px; border: 1px solid var(--line); border-radius: 18px;
    background:
      linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012)),
      var(--card);
    box-shadow: 0 40px 90px -40px rgba(0,0,0,.95), 0 0 0 1px rgba(255,255,255,.02) inset;
  }
  .mark {
    width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(135deg, #7c6cff, #4f46e5);
    box-shadow: 0 12px 30px -12px rgba(124,108,255,.9);
  }
  .brandline { margin: 18px 0 2px; color: var(--muted); font-size: 12.5px; letter-spacing: .14em; }
  h1 { margin: 0 0 6px; font-size: 25px; font-weight: 600; letter-spacing: .02em; }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
  label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 12px; letter-spacing: .06em; }
  input {
    width: 100%; padding: 12px 14px; font: inherit; color: var(--text);
    background: #0e0e13; border: 1px solid var(--line); border-radius: 11px;
    outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,108,255,.18); }
  .field { margin-bottom: 14px; }
  button {
    width: 100%; margin-top: 6px; padding: 13px 16px; font: inherit; font-weight: 600;
    color: #fff; border: 0; border-radius: 11px; cursor: pointer;
    background: linear-gradient(135deg, #7c6cff, #5b4bff);
    transition: transform .12s ease, filter .12s ease;
  }
  button:hover { filter: brightness(1.08); }
  button:active { transform: translateY(1px); }
  .err {
    margin: 14px 0 0; padding: 10px 12px; font-size: 13px; color: #fecaca;
    background: rgba(248,113,113,.10); border: 1px solid rgba(248,113,113,.30);
    border-radius: 9px;
  }
  .foot { margin: 20px 0 0; text-align: center; color: #55555f; font-size: 12px; }
  .foot a { color: #8b8b99; text-decoration: none; }
  .foot a:hover { color: var(--text); }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff"
           stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 11.5 12 5l8 6.5"></path>
        <path d="M6 10.5V19h12v-8.5"></path>
        <path d="M10 19v-4.5h4V19"></path>
      </svg>
    </div>
    <p class="brandline">FOLIA · 私人壁纸库</p>
    <h1>欢迎回家</h1>
    <p class="sub">用管理员账号登录，继续浏览你的壁纸。</p>
    <form method="post" action="${GATE_PATH}" autocomplete="on">
      <div class="field">
        <label for="email">账号</label>
        <input id="email" name="email" type="text" required autofocus
               autocomplete="username" placeholder="用户名或邮箱" spellcheck="false">
      </div>
      <div class="field">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" required
               autocomplete="current-password" placeholder="••••••••">
      </div>
      <input type="hidden" name="next" value="${esc(next)}">
      <button type="submit">进入</button>
    </form>
    ${errorBlock}
    <p class="foot">只有站点账号能进入 · <a href="${GATE_PATH}?logout=1">退出登录</a></p>
  </main>
</body>
</html>`;
}

/** 接口被拦时返回的 JSON（前端拿到 401 + code 就知道是站点锁，而不是会话过期）。 */
export function lockedJson(message = '这个站点只对已登录的管理员开放') {
  return new Response(JSON.stringify({ ok: false, error: { code: 'site_locked', message } }), {
    status: 401,
    headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 媒体文件被拦：不返回 HTML，省得 <video> 把页面当视频解析。 */
export function lockedMedia() {
  return new Response('请先登录', {
    status: 403,
    headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' },
  });
}
