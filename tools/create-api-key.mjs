#!/usr/bin/env node
/**
 * create-api-key.mjs — 创建一把公开 API key（第三期）。
 *
 * 生成规则：`flk_` + 32 字节随机数的 base64url（共 47 字符）；**明文只在创建时打印一次**，
 * 库里只存 `sha256(key)`（schema/018 的 `api_keys.key_hash`）。
 *
 * 用法：
 *   node tools/create-api-key.mjs --label="素材网 SDK" --rpm=600
 *   node tools/create-api-key.mjs --label="内测" --rpm=1200
 *   node tools/create-api-key.mjs --label="本地测试" --dry-run   # 只生成，不写库
 *
 * 安全：token 只从 `--token-file` / `CF_API_TOKEN` 读取，绝不打印；
 * key 明文只输出到 stdout 一次，别把它粘进聊天/日志。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = {
  label: '',
  rpm: 600,
  dryRun: false,
  out: '',
  tokenFile: process.env.CF_TOKEN_FILE || 'D:\\folia-recover\\cf-token.txt',
  account: process.env.CF_ACCOUNT_ID || '2f31addd6894dbafbcfb220c6809fee3',
  database: process.env.D1_DATABASE_ID || '64761fc2-cd88-46f4-b08f-c2b08d5b667f',
};
for (const raw of process.argv.slice(2)) {
  if (raw === '--dry-run') args.dryRun = true;
  else if (raw.startsWith('--label=')) args.label = raw.slice(8);
  else if (raw.startsWith('--rpm=')) args.rpm = Number(raw.slice(6)) || 600;
  else if (raw.startsWith('--out=')) args.out = raw.slice(6);
  else if (raw.startsWith('--token-file=')) args.tokenFile = raw.slice(13);
}

function readToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN.trim();
  if (existsSync(args.tokenFile)) return readFileSync(args.tokenFile, 'utf8').trim();
  console.error('找不到 token（CF_API_TOKEN 或 --token-file）');
  process.exit(1);
}
const TOKEN = readToken();

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const key = `flk_${base64url(randomBytes(32))}`;
const id = `key_${randomBytes(9).toString('hex')}`;
const keyHash = createHash('sha256').update(key).digest('hex');
const now = Date.now();

async function insert() {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${args.account}/d1/database/${args.database}/query`;
  const sql = `INSERT INTO api_keys (id, key_hash, label, rpm, active, created_at, last_used_at)
               VALUES (?, ?, ?, ?, 1, ?, NULL)`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params: [id, keyHash, args.label || '未命名', Number(args.rpm) || 600, now] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.success) {
    console.error('写库失败：', (body.errors ?? []).map((item) => item.message).join('; '));
    process.exit(1);
  }
}

if (args.dryRun) {
  console.log('[dry-run] 未写库。生成的 key（只显示一次）：');
} else {
  await insert();
  console.log('已创建 API key（只显示一次，请立刻保存）：');
}
if (args.out) {
  // 写文件时不在 stdout 打印明文（适合脚本/CI；文件权限自己收紧）
  writeFileSync(args.out, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`  key   = 已写入 ${args.out}（未打印）`);
} else {
  console.log(`  key   = ${key}`);
}
console.log(`  id    = ${id}`);
console.log(`  label = ${args.label || '未命名'}`);
console.log(`  rpm   = ${args.rpm}`);
console.log(`  hash  = ${keyHash}`);
if (!args.dryRun) {
  console.log('\n用法：Authorization: Bearer <key> 或 ?key=<key>（仅 /api/v1/public/*）');
}
