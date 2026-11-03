/**
 * slug 生成：中文标题也要能拿到稳定、可放进 URL 的标识。
 * 策略：NFKC 归一化 → 小写 → 保留各语言字母/数字/连字符 → 其余折叠成 '-'。
 * 纯标题（如「夏日」）会得到 '夏日'，URL 里会被转义，但稳定且可读；
 * 若想要纯 ASCII，传入 { ascii: true } 会退化为短哈希。
 */
const MAX_SLUG = 60;

function base16(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slugify(input, { ascii = false, max = MAX_SLUG } = {}) {
  const raw = String(input ?? '').normalize('NFKC').trim().toLowerCase();
  if (!raw) return '';

  let out = raw
    .replace(/[\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (ascii || !out) {
    // 非 ASCII 后缀用内容哈希，保证同一标题多次生成结果稳定
    const codePoints = [...raw].reduce((acc, ch) => (acc * 31 + ch.codePointAt(0)) >>> 0, 7);
    const suffix = codePoints.toString(16).padStart(8, '0').slice(0, 8);
    const asciiBase = raw
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
    out = asciiBase ? `${asciiBase}-${suffix}` : suffix;
  }

  if (out.length > max) out = out.slice(0, max).replace(/-+$/, '');
  return out;
}

/**
 * 在重名时追加 -2、-3…，isTaken 可以是同步或异步函数。
 * @param {string} base
 * @param {(candidate:string)=>boolean|Promise<boolean>} isTaken
 */
export async function uniqueSlug(base, isTaken, { fallback = 'wallpaper', max = MAX_SLUG } = {}) {
  const root = slugify(base) || fallback;
  let candidate = root;
  let n = 1;
  // 上限保护：避免异常情况下死循环
  while (n < 500 && (await isTaken(candidate))) {
    n += 1;
    const suffix = `-${n}`;
    candidate = `${root.slice(0, max - suffix.length)}${suffix}`;
  }
  return candidate;
}

export function shortHash(input) {
  const s = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { base16 };
