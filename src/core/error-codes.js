/**
 * 错误码表 —— **唯一来源**。
 *
 * 为什么单独抽出来：`docs/api.md` / `docs/API-V1.md` / `docs/openapi.yaml` 都要列错误码，
 * 而 `http.js` 只负责把 `HttpError` 转成 JSON。三处各写一份清单，改一处忘两处，
 * 就会出现「文档说 400、线上其实 422」这种没法排查的事。
 *
 * 约定：
 *   - `code` 是机读的稳定标识（下划线风格，历史遗留的 `storage-verify-failed` 保留连字符）；
 *   - `status` 是默认 HTTP 状态码；
 *   - `message` 是默认中文提示（路由可以覆盖成更具体的文案）；
 *   - `hint` 是「用户下一步该做什么」，v1 错误体统一输出到 `error.hint`。
 *
 * 向后兼容：老路径的错误体仍然是 `{ ok:false, error:{ code, message, details? } }`，
 * 只是**多了一个可选 `hint`**；老客户端忽略即可。
 */
export const ERROR_CODES = Object.freeze([
  {
    code: 'bad_request',
    status: 400,
    message: '请求参数不合法',
    hint: '检查查询参数或请求体字段名/类型；details.field 会指出具体字段。',
  },
  {
    code: 'unauthorized',
    status: 401,
    message: '请先登录',
    hint: '管理接口需要 folia_session Cookie；公开接口不需要登录。',
  },
  {
    code: 'site_locked',
    status: 401,
    message: '站点未开放',
    hint: '该路径不在匿名只读白名单内，请用 /api/v1/public/* 或先登录管理后台。',
  },
  {
    code: 'api_key_invalid',
    status: 401,
    message: 'API key 无效或已停用',
    hint: '检查 Authorization: Bearer <key> 或 ?key= 的拼写；没有 key 可以不带，按 IP 限流。',
  },
  {
    code: 'forbidden',
    status: 403,
    message: '没有权限执行此操作',
    hint: '当前账号角色不含该动作；details.required 是缺少的权限名。',
  },
  {
    code: 'not_found',
    status: 404,
    message: '资源不存在',
    hint: '检查 id/slug 是否正确；公开接口只返回「已发布 + 已审核 + 有文件」的条目。',
  },
  {
    code: 'method_not_allowed',
    status: 405,
    message: '请求方法不被允许',
    hint: '公开接口只读，只接受 GET / HEAD / OPTIONS。',
  },
  {
    code: 'conflict',
    status: 409,
    message: '资源冲突',
    hint: '常见于 slug 重名或文件已存在；details 里会带已有条目的 id。',
  },
  {
    code: 'payload_too_large',
    status: 413,
    message: '文件或请求体过大',
    hint: '图片 ≤20MB、视频 ≤60MB、资源包 ≤64MB；请求体 JSON ≤512KB。',
  },
  {
    code: 'unsupported_media_type',
    status: 415,
    message: '不支持的文件类型',
    hint: '只收 png/jpeg/webp/avif/gif、mp4/webm 与 zip 资源包。',
  },
  {
    code: 'media_non_compliant',
    status: 422,
    message: '视频不符合播放规格',
    hint: '先用 tools/prepare-upload.mjs 转码（≤3840×2160、≤30fps、H.264、faststart）再上传。',
  },
  {
    code: 'import_incomplete',
    status: 422,
    message: '导入失败：缺少必填字段',
    hint: 'details.missing 列出缺的字段名；宽高探测不出来时先用本地工具确认文件头。',
  },
  {
    code: 'pet_package_invalid',
    status: 422,
    message: '桌宠包不合法',
    hint: 'message 里是具体原因：petManifestVersion 必须为 2、renderer 必须为 sprite2d、'
      + 'sprite2d.spritesheetPath 要指向包内图片、frames 非空、tracks 至少含 idle、previews/ 至少一张图。',
  },
  {
    code: 'too_many_requests',
    status: 429,
    message: '尝试过于频繁，请稍后再试',
    hint: '按响应头 Retry-After（秒）等待；带 API key 的配额更高，见 docs/API-V1.md。',
  },
  {
    code: 'storage-verify-failed',
    status: 500,
    message: 'R2 写入校验失败（对象缺失或大小不符），请重试',
    hint: '对象没有真正落盘时整条上传会回滚，重试一次；连续失败查看 R2 绑定。',
  },
  {
    code: 'internal_error',
    status: 500,
    message: '服务器内部错误',
    hint: '打开 DEBUG_API=1 可把真实异常带进响应；查 D1/R2 绑定与最近部署日志。',
  },
]);

/** code → 错误码定义（含默认 status/message/hint）。 */
export const ERROR_BY_CODE = Object.freeze(
  Object.fromEntries(ERROR_CODES.map((item) => [item.code, Object.freeze({ ...item })])),
);

export function statusForCode(code) {
  return ERROR_BY_CODE[code]?.status ?? 500;
}

/** 错误码对应的「下一步怎么做」；未知码返回 undefined（不硬编一句空话）。 */
export function hintForCode(code) {
  return ERROR_BY_CODE[code]?.hint;
}
