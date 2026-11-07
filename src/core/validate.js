/**
 * 入参校验与归一化。所有写接口都先过这里，路由层拿到的都是干净数据。
 * 校验失败抛 400，details.field 指明是哪个字段，前端可以直接高亮。
 */
import { badRequest } from './errors.js';
import { TAGS } from './tags.js';
import { normalizeTag } from './tag-vocabulary.js';

export const LIMITS = Object.freeze({
  title: 120,
  description: 400,
  categoryName: 40,
  memberName: 60,
  email: 190,
  passwordMin: 10,
  passwordMax: 200,
  tagCount: 8,
  tagLength: 24,
  slug: 120,
  id: 64,
});

export const STATUSES = Object.freeze(['draft', 'published', 'hidden']);
export const REVIEW_STATUSES = Object.freeze(['pending', 'approved']);
// 'pet' 是桌宠包（zip 内含 pet.json）的对外取值；库里仍存 kind='static'，
// 由 DTO 派生（见 src/server/dto.js 的 petDto），所以放开白名单不影响任何已有数据。
export const KINDS = Object.freeze(['static', 'dynamic', 'pet']);
export const SORTS = Object.freeze(['recent', 'oldest', 'name', 'size', 'resolution']);

export const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function fail(field, message) {
  throw badRequest(message, { field });
}

function asObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

export function cleanText(value, field, { min = 0, max = 200, collapse = false } = {}) {
  if (typeof value !== 'string') fail(field, `${field} 必须是字符串`);
  let out = value.trim();
  if (collapse) out = out.replace(/\s+/g, ' ');
  if (out.length < min) fail(field, `${field} 至少 ${min} 个字符`);
  if (out.length > max) fail(field, `${field} 最多 ${max} 个字符`);
  return out;
}

export function cleanEnum(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(field, `${field} 只能是 ${allowed.join(' / ')}`);
  }
  return value;
}

export function cleanBool(value, field) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === 'true' || value === 'false') return value === 'true';
  return fail(field, `${field} 必须是布尔值`);
}

export function cleanInt(value, field, { min = -1e9, max = 1e9 } = {}) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) fail(field, `${field} 必须是数字`);
  const i = Math.trunc(n);
  if (i < min || i > max) fail(field, `${field} 超出范围 ${min}~${max}`);
  return i;
}

export function cleanEmail(value) {
  if (typeof value !== 'string') fail('email', 'email 必须是字符串');
  const out = value.trim().toLowerCase();
  if (out.length < 5 || out.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) {
    fail('email', '邮箱格式不正确');
  }
  return out;
}

/** 账号允许用户名或邮箱：带 @ 的按邮箱校验，不带的按用户名规则（3–64 位）。 */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function cleanAccount(value) {
  if (typeof value !== 'string') fail('email', '账号必须是字符串');
  const out = value.trim().toLowerCase();
  if (!out) fail('email', '请输入账号');
  if (out.includes('@')) return cleanEmail(out);
  if (!USERNAME_RE.test(out)) {
    fail('email', '账号只能用 3–64 位字母、数字、点、下划线或短横线（也可以直接填邮箱）');
  }
  return out;
}

const WEAK_PASSWORDS = new Set([
  '1234567890', 'password123', 'qwertyuiop', 'administrator', 'wallpaper1',
]);

export function cleanPassword(value, field = 'password') {
  if (typeof value !== 'string') fail(field, '密码必须是字符串');
  if (value.length < LIMITS.passwordMin) fail(field, `密码至少 ${LIMITS.passwordMin} 位`);
  if (value.length > LIMITS.passwordMax) fail(field, `密码最多 ${LIMITS.passwordMax} 位`);
  if (WEAK_PASSWORDS.has(value.toLowerCase())) fail(field, '这个密码太常见了，换一个');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 2) fail(field, '密码需同时包含字母与数字/符号中的至少两类');
  return value;
}

/**
 * 标签只接受库里已存在的词。allowed 由调用方从 DB 取（以前是代码里的常量）。
 * 自由输入会让「动漫 / 动画 / anime」三种写法并存，筛选栏就废了。
 *
 * 第二期起先做 alias 归一（`anime` → `动漫`）再查词表：同一个概念只落一种写法。
 */
export function cleanTags(value, allowed = TAGS) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const unknown = [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') fail('tags', '标签必须是字符串');
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (!allowed.includes(tag)) {
      unknown.push(tag);
      continue;
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (unknown.length) {
    throw badRequest(`不认识的标签：${unknown.join('、')}`, { field: 'tags', allowed: [...allowed] });
  }
  return out;
}

/**
 * 兼容老数据的标签清洗：库里已经有「皮肤 / black / gold」这类不在词表里的标签
 * （批量导入、早期数据），严格按词表校验会让它们一保存就被拒。
 * 这里只做格式约束，词表退化成输入建议。
 *
 * 仍然做 alias 归一：写入侧不归一会让 facets 的 canonical 聚合永远等不到干净数据。
 */
export function cleanFreeTags(value, field = 'tags') {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') fail(field, '标签必须是字符串');
    const tag = normalizeTag(item);
    if (!tag) continue;
    if (tag.length > LIMITS.tagLength) fail(field, `单个标签最多 ${LIMITS.tagLength} 个字`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > LIMITS.tagCount) fail(field, `最多 ${LIMITS.tagCount} 个标签`);
  return out;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 授权信息长度上限（schema/016 的 license/source/author）。 */
export const LICENSE_MAX = 40;
export const SOURCE_MAX = 200;
export const AUTHOR_MAX = 120;

/**
 * 许可证标识：null/空串 = 未声明；否则统一小写、只允许 `[a-z0-9._-]`。
 *
 * 为什么收敛成小写：筛选参数 `license=` 也是小写，两处大小写不一致会让
 * 「填了 CC0、筛 cc0 却查不到」。想展示成 `CC0` 是前端的事，库里只有一种写法。
 */
export function cleanLicense(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('license', 'license 必须是字符串');
  const out = value.trim().toLowerCase();
  if (!out) return null;
  if (out.length > LICENSE_MAX) fail('license', `license 最多 ${LICENSE_MAX} 个字符`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(out)) {
    fail('license', 'license 只能包含小写字母、数字、点、下划线、短横线');
  }
  return out;
}

/** 来源 / 作者：可空文本；空串统一存 null（DTO 输出 null 而不是 ""）。 */
export function cleanNullableText(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(field, `${field} 必须是字符串`);
  const out = value.trim().replace(/\s+/g, ' ');
  if (!out) return null;
  if (out.length > max) fail(field, `${field} 最多 ${max} 个字符`);
  return out;
}

export function cleanId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(field, `${field} 格式不合法`);
  return value;
}

/** 分类引用：null 表示「未分类」，字符串表示分类 id。 */
export function cleanCategoryRef(value, field = 'categoryId') {
  if (value === null || value === '') return null;
  return cleanId(value, field);
}

export function cleanSlugInput(value, field = 'slug') {
  const out = cleanText(value, field, { min: 1, max: LIMITS.slug });
  if (!/^[\p{L}\p{N}-]+$/u.test(out)) fail(field, 'slug 只能包含字母、数字与连字符');
  return out;
}

export function parseWallpaperCreate(body, { allowedTags = TAGS } = {}) {
  const b = asObject(body);
  return {
    title: cleanText(b.title, 'title', { min: 1, max: LIMITS.title, collapse: true }),
    description: b.description === undefined ? '' : cleanText(b.description, 'description', { min: 0, max: LIMITS.description }),
    subtag: b.subtag === undefined ? '' : cleanText(b.subtag, 'subtag', { min: 0, max: 40, collapse: true }),
    reviewStatus: b.reviewStatus === undefined ? 'pending' : cleanEnum(b.reviewStatus, 'reviewStatus', REVIEW_STATUSES),
    kind: b.kind === undefined ? 'static' : cleanEnum(b.kind, 'kind', KINDS),
    categoryId: b.categoryId === undefined ? null : cleanCategoryRef(b.categoryId),
    tags: cleanFreeTags(b.tags),
    slug: b.slug ? cleanSlugInput(b.slug) : '',
    featured: b.featured === undefined ? false : cleanBool(b.featured, 'featured'),
    // 授权信息（schema/016）：新建时就可以带上，列表/详情/筛选都能用
    license: cleanLicense(b.license),
    source: cleanNullableText(b.source, 'source', SOURCE_MAX),
    author: cleanNullableText(b.author, 'author', AUTHOR_MAX),
  };
}

export function parseWallpaperPatch(body, { allowedTags = TAGS } = {}) {
  const b = asObject(body);
  const patch = {};
  if (has(b, 'title')) patch.title = cleanText(b.title, 'title', { min: 1, max: LIMITS.title, collapse: true });
  if (has(b, 'description')) patch.description = cleanText(b.description, 'description', { min: 0, max: LIMITS.description });
  if (has(b, 'subtag')) patch.subtag = cleanText(b.subtag, 'subtag', { min: 0, max: 40, collapse: true });
  if (has(b, 'reviewStatus')) patch.reviewStatus = cleanEnum(b.reviewStatus, 'reviewStatus', REVIEW_STATUSES);
  if (has(b, 'kind')) patch.kind = cleanEnum(b.kind, 'kind', KINDS);
  if (has(b, 'categoryId')) patch.categoryId = cleanCategoryRef(b.categoryId);
  if (has(b, 'tags')) patch.tags = cleanFreeTags(b.tags);
  if (has(b, 'featured')) patch.featured = cleanBool(b.featured, 'featured');
  if (has(b, 'status')) patch.status = cleanEnum(b.status, 'status', STATUSES);
  if (has(b, 'sortOrder')) patch.sortOrder = cleanInt(b.sortOrder, 'sortOrder', { min: 0, max: 1e6 });
  if (has(b, 'license')) patch.license = cleanLicense(b.license);
  if (has(b, 'source')) patch.source = cleanNullableText(b.source, 'source', SOURCE_MAX);
  if (has(b, 'author')) patch.author = cleanNullableText(b.author, 'author', AUTHOR_MAX);
  if (Object.keys(patch).length === 0) fail('body', '没有可更新的字段');
  return patch;
}

export function parseCategoryCreate(body) {
  const b = asObject(body);
  return {
    name: cleanText(b.name, 'name', { min: 1, max: LIMITS.categoryName, collapse: true }),
    description: b.description === undefined ? '' : cleanText(b.description, 'description', { min: 0, max: LIMITS.description }),
    isPublic: b.isPublic === undefined ? true : cleanBool(b.isPublic, 'isPublic'),
    slug: b.slug ? cleanSlugInput(b.slug) : '',
  };
}

export function parseCategoryPatch(body) {
  const b = asObject(body);
  const patch = {};
  if (has(b, 'name')) patch.name = cleanText(b.name, 'name', { min: 1, max: LIMITS.categoryName, collapse: true });
  if (has(b, 'description')) patch.description = cleanText(b.description, 'description', { min: 0, max: LIMITS.description });
  if (has(b, 'isPublic')) patch.isPublic = cleanBool(b.isPublic, 'isPublic');
  if (has(b, 'sortOrder')) patch.sortOrder = cleanInt(b.sortOrder, 'sortOrder', { min: 0, max: 1e6 });
  if (Object.keys(patch).length === 0) fail('body', '没有可更新的字段');
  return patch;
}

export function parseMemberCreate(body) {
  const b = asObject(body);
  return {
    email: cleanAccount(b.email),
    name: cleanText(b.name, 'name', { min: 1, max: LIMITS.memberName, collapse: true }),
    role: cleanEnum(b.role, 'role', ['admin', 'editor']),
    password: cleanPassword(b.password),
  };
}

export function parseMemberPatch(body) {
  const b = asObject(body);
  const patch = {};
  if (has(b, 'email')) patch.email = cleanAccount(b.email);
  if (has(b, 'name')) patch.name = cleanText(b.name, 'name', { min: 1, max: LIMITS.memberName, collapse: true });
  if (has(b, 'role')) patch.role = cleanEnum(b.role, 'role', ['admin', 'editor']);
  if (has(b, 'active')) patch.active = cleanBool(b.active, 'active');
  if (has(b, 'password')) patch.password = cleanPassword(b.password);
  if (Object.keys(patch).length === 0) fail('body', '没有可更新的字段');
  return patch;
}

export function parseLogin(body) {
  const b = asObject(body);
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!email || !password) fail('email', '请输入账号和密码');
  if (email.length > LIMITS.email || password.length > LIMITS.passwordMax) fail('email', '账号或密码过长');
  return { email, password };
}

export function parsePasswordChange(body) {
  const b = asObject(body);
  if (typeof b.currentPassword !== 'string' || !b.currentPassword) fail('currentPassword', '请输入当前密码');
  return { currentPassword: b.currentPassword, newPassword: cleanPassword(b.newPassword, 'newPassword') };
}

export function parseSetup(body) {
  const b = asObject(body);
  return {
    token: cleanText(b.token, 'token', { min: 1, max: 200 }),
    email: cleanAccount(b.email),
    name: cleanText(b.name, 'name', { min: 1, max: LIMITS.memberName, collapse: true }),
    password: cleanPassword(b.password),
  };
}

export function parseSort(value) {
  if (value === undefined || value === null || value === '') return 'recent';
  return cleanEnum(String(value), 'sort', SORTS);
}

export function parseLimit(value, { def = 24, max = 100 } = {}) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n)) fail('limit', 'limit 必须是数字');
  const i = Math.trunc(n);
  if (i < 1) fail('limit', 'limit 必须大于 0');
  return Math.min(i, max);
}

/** 页码从 1 开始。页码上限只是防垃圾请求，真实页数由 total 决定。 */
export function parsePage(value, { def = 1, max = 10000 } = {}) {
  if (value === undefined || value === null || value === '') return def;
  return cleanInt(String(value), 'page', { min: 1, max });
}
