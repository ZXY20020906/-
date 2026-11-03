/**
 * 统一的 HTTP 错误。路由层只抛这个，由 app 的 catch 统一转成 JSON。
 */
export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = '请求参数不合法', details = null) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = '请先登录') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = '没有权限执行此操作', details = null) =>
  new HttpError(403, 'forbidden', message, details);

export const notFound = (message = '资源不存在') =>
  new HttpError(404, 'not_found', message);

export const conflict = (message = '资源冲突', details = null) =>
  new HttpError(409, 'conflict', message, details);

export const payloadTooLarge = (message = '文件或请求体过大', details = null) =>
  new HttpError(413, 'payload_too_large', message, details);

export const unsupportedMedia = (message = '不支持的文件类型', details = null) =>
  new HttpError(415, 'unsupported_media_type', message, details);

export const tooManyRequests = (message = '尝试过于频繁，请稍后再试') =>
  new HttpError(429, 'too_many_requests', message);

export const storageVerifyFailed = (message = 'R2 写入校验失败（对象缺失或大小不符），请重试') =>
  new HttpError(500, 'storage-verify-failed', message);

export const internal = (message = '服务器内部错误') =>
  new HttpError(500, 'internal_error', message);
