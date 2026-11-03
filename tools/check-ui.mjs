/**
 * 前端一致性检查（不需要浏览器）：前台壁纸库 + 后台管理两个页面各查一遍。
 *   1. JS 里用到的 #id 选择器必须存在，HTML 里的 id 也必须被用到；
 *   2. data-action 的值必须都有处理器，反之亦然；
 *   3. JS 调用的 /api 路径必须都在路由表里注册过。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFINITIONS } from '../src/server/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const PAGES = [
  {
    label: '前台壁纸库',
    html: resolve(root, 'public/index.html'),
    js: resolve(root, 'public/assets/gallery.js'),
    // 前台用 if (name === 'x') 分派
    handlerPatterns: [/name === '([a-z-]+)'/g],
    extraApiCalls: [],
  },
  {
    label: '后台管理',
    html: resolve(root, 'public/admin/index.html'),
    js: resolve(root, 'public/admin/app.js'),
    // 后台用 switch 的 case，下拉框在 change 里单独处理
    handlerPatterns: [/case '([a-z-]+)':/g, /select\[data-action="([a-z-]+)"\]/g],
    extraApiCalls: ['/api/admin/wallpapers/${id}/asset'],
  },
];

const routePatterns = DEFINITIONS.map((def) => def.path.split('/').filter(Boolean));

function normalize(path) {
  return path
    .split('?')[0]
    .replace(/\$\{[^}]+\}/g, ':p')
    .split('/')
    .filter(Boolean);
}

function matches(segments, pattern) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((expected, index) => (expected.startsWith(':')
    ? segments[index].length > 0
    : expected === segments[index]));
}

let failures = 0;
const summary = [];

for (const page of PAGES) {
  const html = readFileSync(page.html, 'utf8');
  const js = readFileSync(page.js, 'utf8');
  const problems = [];

  // ---- 1. id ----
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const knownIds = new Set([...htmlIds, ...jsIds]);
  const usedIds = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));

  for (const id of usedIds) {
    if (!knownIds.has(id)) problems.push(`选择器 #${id} 在页面里不存在`);
  }
  for (const id of htmlIds) {
    if (!usedIds.has(id)) problems.push(`HTML 里的 #${id} 没有任何 JS 使用（可能写错了）`);
  }

  // ---- 2. data-action ----
  const markupActions = new Set([
    ...[...html.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]),
  ]);
  const handled = new Set();
  for (const pattern of page.handlerPatterns) {
    for (const match of js.matchAll(pattern)) handled.add(match[1]);
  }

  for (const action of markupActions) {
    if (!handled.has(action)) problems.push(`data-action="${action}" 没有任何处理器`);
  }
  for (const action of handled) {
    if (!markupActions.has(action)) problems.push(`处理器 '${action}' 没有任何地方触发`);
  }

  // ---- 3. API ----
  const apiCalls = new Set();
  for (const match of js.matchAll(/\bapi\((['`])([^'`]*)\1/g)) {
    const literal = match[2];
    if (literal.includes('${path}')) continue; // api() 自身
    apiCalls.add(`/api${literal}`);
  }
  for (const extra of page.extraApiCalls) apiCalls.add(extra);

  for (const call of apiCalls) {
    const segments = normalize(call);
    if (!routePatterns.some((pattern) => matches(segments, pattern))) {
      problems.push(`调用了未注册的接口：${call}`);
    }
  }

  if (problems.length) {
    failures += 1;
    console.error(`\n[${page.label}] 检查失败：`);
    for (const problem of problems) console.error(`  - ${problem}`);
  } else {
    summary.push(`${page.label}：${usedIds.size} 个 id / ${markupActions.size} 个动作 / ${apiCalls.size} 个接口`);
  }
}

if (failures) process.exit(1);
console.log(`检查通过：${summary.join('；')}`);
