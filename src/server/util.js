/** id / token / 编码等零碎工具，Workers 与 Node 都可用（Web Crypto + TextEncoder）。 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += HEX[(b >> 4) & 0xf] + HEX[b & 0xf];
  return out;
}

export function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(input) {
  const norm = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

export function randomBytes(length) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomToken(length = 32) {
  return toBase64Url(randomBytes(length));
}

/** 形如 wp_9f3c… 的主键，可读且不易碰撞。 */
export function newId(prefix) {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** 定长比较，避免密码/令牌校验泄漏时间信息。 */
export function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function bytesToMb(bytes) {
  return Math.round((Number(bytes || 0) / (1024 * 1024)) * 10) / 10;
}

export function safeJsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 大文件（>40MB）算不了完整 sha256：Worker 128MB 内存会炸。
 * 取「首 1MB + 尾 1MB」做采样哈希当 key 种子——
 * 内容变了 key 基本一定变（缓存不会脏），同一文件重复上传 key 也稳定（能识别重复）。
 */
export async function sampleFingerprint(bytes) {
  const CHUNK = 1024 * 1024;
  const head = bytes.subarray(0, Math.min(CHUNK, bytes.length));
  const tail = bytes.subarray(Math.max(0, bytes.length - CHUNK));
  const merged = new Uint8Array(head.length + tail.length);
  merged.set(head, 0);
  merged.set(tail, head.length);
  return sha256Bytes(merged);
}
