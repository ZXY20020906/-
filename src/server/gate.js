/**
 * 站点门的小工具：路径常量与「登录后跳回哪里」的白名单。
 * 门本身在 gate-middleware.js；它判断的是管理员会话，不再是共享口令。
 */
export const GATE_PATH = '/__gate';

export function isGatePath(pathname) {
  return pathname === GATE_PATH || pathname === `${GATE_PATH}/`;
}

/**
 * 只接受站内绝对路径，挡住 //evil.com、/\evil.com、javascript: 这类开放重定向。
 */
export function safeNext(raw, fallback = '/') {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  if (!value || value.length > 400) return fallback;
  if (value[0] !== '/') return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  return value;
}
