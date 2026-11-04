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

/**
 * 422：请求本身没问题，但内容不符合播放规格（分辨率/帧率/编码/faststart）。
 * 和 415 的区别：415 是「这种类型我不要」，422 是「类型对，但这个文件播不了」。
 * details 里带 violations（机读码 + 中文说明），见 src/server/media-compliance.js。
 */
export const mediaNonCompliant = (message = '视频不符合播放规格', details = null) =>
  new HttpError(422, 'media_non_compliant', message, details);

export const storageVerifyFailed = (message = 'R2 写入校验失败（对象缺失或大小不符），请重试') =>
  new HttpError(500, 'storage-verify-failed', message);

/**
 * 422：文件能识别，但缺了插件消费的必填字段（宽高探测失败是最常见的一种）。
 * 与 media_non_compliant 的区别：那条是「视频播不了」，这条是「记录不完整」。
 * `details.missing` 是缺的字段名数组，批量入口据此写导入报告。
 */
export const importIncomplete = (message = '导入失败：缺少必填字段', details = null) =>
  new HttpError(422, 'import_incomplete', message, details);

export const internal = (message = '服务器内部错误') =>
  new HttpError(500, 'internal_error', message);
