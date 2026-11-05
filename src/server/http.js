/** HTTP 层：统一 JSON 形状、安全头、CSRF 防护、请求体大小限制。 */
import { HttpError, badRequest, forbidden, payloadTooLarge } from '../core/errors.js';
import { hintForCode, statusForCode } from '../core/error-codes.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

export function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...BASE_HEADERS, ...JSON_HEADERS, ...headers },
  });
}

export function created(data, headers = {}) {
  return json(data, { status: 201, headers });
}

/**
 * 统一错误体：`{ ok:false, error:{ code, message, hint?, details? } }`。
 *
 * `hint` 的来源优先级：`details.hint`（业务自己知道得更具体，比如 422 体检）
 * → 错误码表的默认提示（`core/error-codes.js`）。两处都没有就不出现这个字段。
 * `details` 保持原样不动：老客户端读 `details.field` / `details.violations` 的地方一个都不受影响。
 */
export function failure(error) {
  const status = error instanceof HttpError ? error.status : statusForCode('internal_error');
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message = error instanceof HttpError ? error.message : '服务器内部错误';
  const details = error instanceof HttpError ? error.details : null;
  const hint = (details && typeof details === 'object' ? details.hint : null) ?? hintForCode(code);
  const body = {
    ok: false,
    error: {
      code,
      message,
      ...(hint ? { hint } : {}),
      ...(details ? { details } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...JSON_HEADERS },
  });
}

/** 读 JSON 请求体，带类型与体积校验。 */
export async function readJson(request, { maxBytes = 512 * 1024 } = {}) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest('Content-Type 必须是 application/json');
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length && length > maxBytes) throw payloadTooLarge(`请求体不能超过 ${Math.round(maxBytes / 1024)} KB`);
  const text = await request.text();
  if (text.length > maxBytes) throw payloadTooLarge(`请求体不能超过 ${Math.round(maxBytes / 1024)} KB`);
  if (!text.trim()) throw badRequest('请求体不能为空');
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF：管理接口要求自定义头 X-Folia-Client: admin（跨站表单无法携带），
 * 同时若请求带 Origin，则必须与站点同源。
 */
export function assertSafeRequest(request, env) {
  if (!MUTATING.has(request.method)) return;
  if (request.headers.get('x-folia-client') !== 'admin') {
    throw forbidden('缺少 X-Folia-Client 请求头');
  }
  const origin = request.headers.get('origin');
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  const allowed = new Set([requestOrigin]);
  if (env?.PUBLIC_ORIGIN) allowed.add(env.PUBLIC_ORIGIN.replace(/\/$/, ''));
  if (!allowed.has(origin)) throw forbidden('请求来源不被允许');
}

/**
 * 公开只读接口的 CORS：一律 `*`。
 * 这些路由只吐「已发布」数据、不接受 Cookie 身份，所以任意源的插件 / 扩展都能直接 fetch。
 * 需要凭据的 /api/admin/* 不走这里，因此不存在把会话暴露给别的源的问题。
 */
export function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'content-type, range, authorization',
    // 客户端要能读到限流/缓存相关的头（含 429 的 Retry-After）
    'access-control-expose-headers': 'etag, content-length, content-range, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-window',
    'access-control-max-age': '86400',
  };
}

export function preflight(env) {
  return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...corsHeaders(env) } });
}

export function methodNotAllowed(allowed) {
  // 与 failure() 同一形状：错误码表里的 hint 也要出现，否则 405 是唯一没有提示的错。
  const base = failure(new HttpError(405, 'method_not_allowed', `只支持 ${allowed.join(', ')}`));
  const headers = new Headers(base.headers);
  headers.set('allow', allowed.join(', '));
  return new Response(base.body, { status: 405, headers });
}
