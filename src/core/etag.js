/**
 * ETag 归一化与比较 —— **唯一实现**。
 *
 * 为什么单独抽出来：Cloudflare 的边缘缓存/压缩会在 ETag 前加 `W/`，有时还会重排引号；
 * 站点侧原来在 `routes/public-v1.js`、`routes/public.js` 各写了一份「去 W/、去引号」，
 * 边缘缓存层（`app.js`）又要用同一条规则判断 304。三处各抄一份就会出现
 * 「handler 认为是 304、缓存层认为是 200」这种最难查的分叉。
 *
 * 只做 RFC 9110 的 weak comparison：比较时忽略 `W/` 前缀与首尾引号。
 * 生成 ETag 时仍然用强 ETag（`"<hex>"`），弱前缀只可能来自传输层。
 */

/** 去掉弱校验前缀 `W/` 与首尾引号，返回可直接比较的裸值。 */
export function normalizeEtag(value) {
  return String(value ?? '').replace(/^W\//, '').replace(/^"|"$/g, '').trim();
}

/**
 * 请求的 `If-None-Match` 是否命中给定 ETag。
 * 支持逗号分隔的多个候选值（RFC 允许），逐项做 weak comparison。
 */
export function etagMatches(ifNoneMatch, etag) {
  const target = normalizeEtag(etag);
  if (!target) return false;
  const raw = String(ifNoneMatch ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  return raw.split(',').some((part) => normalizeEtag(part) === target);
}
