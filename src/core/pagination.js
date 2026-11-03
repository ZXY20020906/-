/**
 * 游标分页 + 排序。壁纸库会越滚越大，offset 分页在「新增后翻页错位」上很难受，
 * 这里统一用 (排序键, id) 复合游标。
 */
import { badRequest } from './errors.js';
import { cleanId, cleanInt } from './validate.js';

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input) {
  const norm = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(payload) {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 512) throw badRequest('cursor 不合法');
  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(raw));
  } catch {
    throw badRequest('cursor 不合法');
  }
  if (!parsed || typeof parsed !== 'object') throw badRequest('cursor 不合法');
  return parsed;
}

/**
 * 每种排序对应一个「游标键」。
 * recent/oldest 用毫秒时间戳，name 用标题，size 用字节数，resolution 用像素总数。
 */
export function cursorForSort(sort, row) {
  switch (sort) {
    case 'name':
      return encodeCursor({ t: row.title, i: row.id });
    case 'size':
      return encodeCursor({ t: row.bytes, i: row.id });
    case 'resolution':
      return encodeCursor({ t: (row.width ?? 0) * (row.height ?? 0), i: row.id });
    case 'oldest':
    case 'recent':
    default:
      return encodeCursor({ t: row.published_at ?? row.created_at, i: row.id });
  }
}

/** 校验解码后的游标是否与当前排序匹配，防止跨排序串用导致空页。 */
export function normalizeCursor(decoded, sort) {
  if (!decoded) return null;
  if (decoded.i === undefined) throw badRequest('cursor 缺少 id');
  const id = cleanId(decoded.i, 'cursor.id');
  if (sort === 'name') {
    if (typeof decoded.t !== 'string') throw badRequest('cursor 与排序方式不匹配');
    return { key: decoded.t, id };
  }
  const key = cleanInt(decoded.t, 'cursor.key', { min: 0, max: 1e15 });
  return { key, id };
}
