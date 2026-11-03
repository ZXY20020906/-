/**
 * Cloudflare Pages 根中间件：所有请求（页面 / api / media）都会先过这里。
 * 逻辑在 src/server/gate-middleware.js，这个文件只做接线 —— 外加统一的安全响应头。
 */
import { gateMiddleware } from '../src/server/gate-middleware.js';
import { withSecurityHeaders } from '../src/server/security.js';

export async function onRequest(context) {
  const response = await gateMiddleware(context);
  return withSecurityHeaders(response, context.request);
}
