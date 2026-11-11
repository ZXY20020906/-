/**
 * 把源码同步进 deploy/（Pages 的部署根目录）。
 * deploy/ 不进 git，是构建产物；部署前跑这个再 wrangler pages deploy。
 *
 *   node tools/sync-deploy.mjs
 *
 * 目录约定（与 functions 里的相对 import 对齐）：
 *   deploy/index.html          ← public/* 平铺到根（不是 deploy/public/）
 *   deploy/assets/ …
 *   deploy/functions/…         ← import '../../src/…'
 *   deploy/src/…
 *   deploy/schema/…            ← 迁移脚本，部署包里留一份便于排查
 *
 * 为什么必须平铺 + 不写 pages_build_output_dir：
 *   wrangler pages deploy ./deploy 会把 **参数目录本身** 当静态根；
 *   若这里再放一层 public/，根目录就没有 index.html ⇒ 登录后访问 / 得到 404。
 *   （2026-11-11 线上 404 事故就是这一层造成的。）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'deploy');

// 从零重建：避免上一轮的 .wrangler / 旧 sql / 旧工具脚本残留进部署包
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1) 静态资源：public/* 平铺到 deploy 根
const publicDir = join(ROOT, 'public');
if (existsSync(publicDir)) {
  for (const name of readdirSync(publicDir)) {
    cpSync(join(publicDir, name), join(OUT, name), { recursive: true });
  }
  console.log('同步 public/* → deploy/（平铺）');
}

// 2) functions / src / schema 保持子目录（functions 里按 ../../src 引用）
for (const dir of ['functions', 'src', 'schema']) {
  const from = join(ROOT, dir);
  if (!existsSync(from)) continue;
  cpSync(from, join(OUT, dir), { recursive: true });
  console.log('同步', dir, '→ deploy/' + dir);
}

// 3) deploy/wrangler.toml：复制根配置，但**去掉 pages_build_output_dir**
//    （否则 wrangler 会去找 deploy/public，而不是 deploy 根）
const rootToml = join(ROOT, 'wrangler.toml');
if (existsSync(rootToml)) {
  const toml = readFileSync(rootToml, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*pages_build_output_dir\s*=/.test(line))
    .join('\n');
  writeFileSync(join(OUT, 'wrangler.toml'), toml);
  console.log('生成 deploy/wrangler.toml（已移除 pages_build_output_dir）');
}

// 4) 自检：缺这四个就算失败，别把 404 发上线
const required = ['index.html', 'admin/index.html', 'assets/gallery.js', 'functions/_middleware.js', 'src/server/app.js'];
const missing = required.filter((rel) => !existsSync(join(OUT, rel)));
if (missing.length) {
  console.error('✗ deploy 目录缺少：', missing.join(', '));
  process.exit(1);
}
console.log('自检通过：', required.join(' / '));
console.log('完成。部署：wrangler pages deploy ./deploy --project-name=folia --branch=main --commit-dirty=true');
