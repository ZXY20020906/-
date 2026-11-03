/**
 * 语法 + 模块解析检查。
 *
 * 不用 `node --check` 起子进程（受限环境里管道 stdio 会被拒），
 * 改成直接 import —— 比单纯语法检查更强：连 import 路径写错也会暴露。
 * public/admin/app.js 是经典脚本（一加载就会碰 document），用 vm 只编译不执行。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'build') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const esmFiles = [
  ...walk(resolve(root, 'src')),
  ...walk(resolve(root, 'functions')),
  ...walk(resolve(root, 'public/assets')),
];
const scriptFiles = [resolve(root, 'public/admin/app.js')];

let failed = 0;
for (const file of esmFiles) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    failed += 1;
    console.error(`模块加载失败：${file}`);
    console.error(`  ${error.message}`);
  }
}

for (const file of scriptFiles) {
  try {
    new vm.Script(readFileSync(file, 'utf8'), { filename: file });
  } catch (error) {
    failed += 1;
    console.error(`语法错误：${file}`);
    console.error(`  ${error.message}`);
  }
}

if (failed) process.exit(1);
console.log(`检查通过：${esmFiles.length} 个模块 + ${scriptFiles.length} 个脚本`);
