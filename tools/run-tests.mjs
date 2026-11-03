/**
 * 同进程测试入口。
 * 直接 `node --test tests/` 也可以，但它会为每个文件 spawn 子进程；
 * 在禁用了管道 stdio 的沙箱里会失败（spawn EPERM），所以这里改成逐个 import。
 * 用法：node tools/run-tests.mjs
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = resolve(here, '..', 'tests');
const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.js')).sort();

if (!files.length) {
  console.error('没有找到测试文件');
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(join(testsDir, file)).href);
}
