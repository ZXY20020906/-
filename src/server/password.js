/**
 * 口令哈希：PBKDF2-HMAC-SHA256，纯 Web Crypto，Workers 与 Node 通用。
 * 迭代次数随记录一起存库，以后调高也能继续验证老密码。
 *
 * 注意：Cloudflare Workers 的 WebCrypto 对 PBKDF2 迭代次数有硬上限——
 * 超过 100000 会直接抛 NotSupportedError（"iteration counts above 100000 are not supported"）。
 * 所以 100000 就是这里的可取值上限，不是随手写的默认值。
 */
import { constantTimeEqual, fromBase64Url, randomBytes, toBase64Url } from './util.js';

export const MAX_SUPPORTED_ITERATIONS = 100000;
export const DEFAULT_ITERATIONS = MAX_SUPPORTED_ITERATIONS;
const KEY_BITS = 256;

function clampIterations(value) {
  const requested = Math.trunc(Number(value) || DEFAULT_ITERATIONS);
  // 合法区间实际上只有一个点：schema CHECK 要求 >= 100000，
  // Workers WebCrypto 要求 <= 100000。两边一夹，只能是 100000。
  if (requested < 100000) return 100000;
  return Math.min(MAX_SUPPORTED_ITERATIONS, requested);
}

/**
 * @param {string} password
 * @param {{iterations?: number, salt?: Uint8Array}} [options]
 * @returns {Promise<{hash: string, salt: string, iterations: number}>}
 */
export async function hashPassword(password, options = {}) {
  const iterations = clampIterations(options.iterations);
  const salt = options.salt ?? randomBytes(16);
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    KEY_BITS,
  );
  return {
    hash: toBase64Url(new Uint8Array(bits)),
    salt: toBase64Url(salt),
    iterations,
  };
}

/**
 * @param {string} password
 * @param {{password_hash?:string, password_salt?:string, iterations?:number}} row
 */
export async function verifyPassword(password, row) {
  if (!row?.password_hash || !row?.password_salt) return false;
  try {
    const derived = await hashPassword(password, {
      iterations: Number(row.iterations) || DEFAULT_ITERATIONS,
      salt: fromBase64Url(row.password_salt),
    });
    return constantTimeEqual(derived.hash, row.password_hash);
  } catch {
    return false;
  }
}

/** 旧记录迭代次数偏低时，登录成功后顺手升级。 */
export function needsRehash(row) {
  return (Number(row?.iterations) || 0) < DEFAULT_ITERATIONS;
}
