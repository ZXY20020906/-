/**
 * 把源码同步进 deploy/（Pages 的部署根目录）。
 * deploy/ 不进 git，是构建产物；部署前跑这个再 wrangler pages deploy。
 *
 *   node tools/sync-deploy.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'deploy');
mkdirSync(OUT, { recursive: true });

for (const dir of ['src', 'public', 'functions', 'schema']) {
  const from = join(ROOT, dir);
  if (!existsSync(from)) continue;
  cpSync(from, join(OUT, dir), { recursive: true });
  console.log('同步', dir, '→ deploy/' + dir);
}

// deploy 的 wrangler.toml 必须指向线上项目；没有就从根配置复制
const rootToml = join(ROOT, 'wrangler.toml');
const deployToml = join(OUT, 'wrangler.toml');
if (!existsSync(deployToml) && existsSync(rootToml)) {
  writeFileSync(deployToml, readFileSync(rootToml, 'utf8'));
  console.log('生成 deploy/wrangler.toml');
}

console.log('完成。部署：wrangler pages deploy ./deploy --project-name=folia --branch=main --commit-dirty=true');
