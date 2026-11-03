/**
 * 全站安全响应头。
 *
 * 放在最外层中间件执行，所有分支（登录页 / 页面 / API / 媒体）都会带上，
 * 不需要每个路由自己记得加。
 *
 * 几个取舍：
 * - CSP 允许 `style-src 'unsafe-inline'`：页面用了内联 <style> 和 `style="--ar:…"` 属性；
 *   脚本只允许同源（`script-src 'self'`），没有 inline script。
 * - `/media/*` 的 CORP 必须是 cross-origin：插件要跨源取封面和皮肤包；
 *   其它路径收紧成 same-origin。
 * - `referrer-policy` 默认 no-referrer，只有登录页（/__gate）放宽到 same-origin：
 *   登录 POST 的来源校验用同源 Referer 兜底，no-referrer 会把它掐掉。
 */
import { isGatePath } from './gate.js';

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function withSecurityHeaders(response, request) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  // 插件要跨源用的东西：媒体文件 + 公开只读接口（后者已经带 CORS 头）
  const crossOrigin = url.pathname.startsWith('/media/') || url.pathname.startsWith('/api/public/');

  headers.set('content-security-policy', CSP);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  // 登录页例外：登录 POST 的来源校验有一条「同源 Referer」兜底（gate-middleware.js 的 checkSource），
  // 而 no-referrer 会让浏览器连同源 Referer 都不发，那条兜底就永远失效。这里只放开到 same-origin。
  headers.set('referrer-policy', isGatePath(url.pathname) ? 'same-origin' : 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('cross-origin-opener-policy', 'same-origin');
  // 媒体 / 公开接口要能被插件跨源使用，其它资源只允许同源
  headers.set('cross-origin-resource-policy', crossOrigin ? 'cross-origin' : 'same-origin');
  headers.set('x-permitted-cross-domain-policies', 'none');

  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
