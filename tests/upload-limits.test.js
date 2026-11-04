/**
 * TODO-05：上传限流 / 每日配额。
 * TODO-06：>40MB 文件的内容指纹（不再用 Date.now() 当 key）。
 *
 * 两个都是「降级可用」设计：schema/013 的表/列不存在时只跳过，
 * 绝不能让上传 500（和 codec/faststart 的探测一个模式）。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from '../src/server/app.js';
import { HASH_LIMIT, UPLOAD_ACTOR_MAX } from '../src/server/routes/wallpapers.js';
import { sampleFingerprint } from '../src/server/util.js';
import { Q } from '../src/server/queries.js';
import {
  createEnv, sessionCookie, sessionDeviceFields, wallpaperRow,
} from './harness.js';
import { reset } from '../src/server/rate-limit.js';

const here = dirname(fileURLToPath(import.meta.url));
const PNG = new Uint8Array(readFileSync(resolve(here, 'fixtures', 'sample.png')));

const UPLOAD_ACTOR = { id: 'usr_uploader', email: 'up@folia.test', name: '上传者', role: 'editor', active: 1 };

const sessionOf = (user) => () => [{
  token_hash: 'hashed',
  expires_at: Date.now() + 60_000,
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  active: user.active,
  ...sessionDeviceFields(),
}];

function uploadEnv(extra = {}, { actor = UPLOAD_ACTOR } = {}) {
  return createEnv({
    [Q.sessionByToken]: sessionOf(actor),
    [Q.wallpaperById]: () => [wallpaperRow({ id: 'wp_1', created_by: actor.id, kind: 'static' })],
    [Q.wallpaperShaTaken]: () => [],
    [Q.updateWallpaperAsset]: () => [],
    [Q.insertAudit]: () => [],
    ...extra,
  });
}

function putAsset(env, { path = '/api/admin/wallpapers/wp_1/asset', bytes = PNG, ip = '203.0.113.60', type = 'image/png' } = {}) {
  return call(env, new Request(`https://example.test${path}`, {
    method: 'PUT',
    headers: {
      cookie: sessionCookie(),
      'x-folia-client': 'admin',
      'content-type': type,
      'cf-connecting-ip': ip,
    },
    body: bytes,
  }));
}

async function call(env, request) {
  const response = await handle(request, env);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

beforeEach(() => {
  reset(`upload:${UPLOAD_ACTOR.id}`);
  reset(`upload-ip:203.0.113.60`);
  reset(`upload:usr_other`);
});

test('限流：同一账号连续 30 次成功，第 31 次 429 too_many_requests', async () => {
  const { env } = uploadEnv();
  assert.equal(UPLOAD_ACTOR_MAX, 30);
  for (let i = 0; i < 30; i += 1) {
    const res = await putAsset(env);
    assert.equal(res.status, 200, `第 ${i + 1} 次上传应当成功`);
  }
  const blocked = await putAsset(env);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_requests');
});

test('限流按账号隔离：另一个账号不受影响', async () => {
  const { env } = uploadEnv();
  for (let i = 0; i < 30; i += 1) await putAsset(env);
  assert.equal((await putAsset(env)).status, 429);

  const other = { ...UPLOAD_ACTOR, id: 'usr_other' };
  const otherEnv = uploadEnv({}, { actor: other });
  const res = await putAsset(otherEnv.env, { ip: '203.0.113.61' });
  assert.equal(res.status, 200);
  reset(`upload-ip:203.0.113.61`);
});

test('缩略图上传同样计入限流', async () => {
  const { env } = uploadEnv();
  for (let i = 0; i < 30; i += 1) await putAsset(env);
  const thumb = await putAsset(env, { path: '/api/admin/wallpapers/wp_1/thumb' });
  assert.equal(thumb.status, 429);
  assert.equal(thumb.body.error.code, 'too_many_requests');
});

test('每日配额：没有 upload_usage 表时降级，上传仍然成功', async () => {
  // 不注册 tableExists → 探测抛错 → 降级（这一条必须排在注册了 tableExists 的用例之前：
  // 探测结果「有表」会被模块级缓存，之后再测降级就不真实了）
  const { env } = uploadEnv();
  const res = await putAsset(env);
  assert.equal(res.status, 200);
});

test('每日配额：超过 UPLOAD_DAILY_BYTES 后 429，且只记账成功的那次', async () => {
  const usage = { bytes: 0 };
  const { env, calls, find } = uploadEnv({
    [Q.tableExists]: ([name]) => (name === 'upload_usage' ? [{ name: 'upload_usage' }] : []),
    [Q.uploadUsageGet]: () => [{ bytes: usage.bytes }],
    [Q.uploadUsageAdd]: ([day, actorId, bytes]) => {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(actorId, UPLOAD_ACTOR.id);
      usage.bytes += bytes;
      return [];
    },
  });
  env.UPLOAD_DAILY_BYTES = String(PNG.byteLength + 10);

  const first = await putAsset(env);
  assert.equal(first.status, 200);
  assert.equal(usage.bytes, PNG.byteLength, '落盘成功后要记一次账');

  const second = await putAsset(env);
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'too_many_requests');
  assert.equal(find(Q.uploadUsageAdd).length, 1, '被拒的上传不应记账');
  void calls;
});

test('大文件指纹：key 用内容指纹而不是 13 位时间戳，且只写一次 R2', async () => {
  const { env, puts, calls } = uploadEnv();
  env.UPLOAD_HASH_LIMIT = '16'; // PNG 76 字节 > 16 → 走大文件分支
  const res = await putAsset(env);

  assert.equal(res.status, 200);
  assert.equal(puts.length, 1, 'putAsset 只调用一次');
  const [, keyPart] = /^wallpapers\/wp_1\/([^.]*)\.png$/.exec(puts[0].key) ?? [];
  assert.ok(keyPart, `key 形状不对：${puts[0].key}`);
  assert.match(keyPart, /^[0-9a-f]{16}$/, 'key 第二段应当是十六进制指纹，不是时间戳');
  assert.doesNotMatch(keyPart, /^\d{13}$/, '不能再是 Date.now()');

  // 大文件不写 sha256（那一列是对外输出的真 sha256），但回读校验仍然执行
  const update = calls.find((c) => c.sql === Q.updateWallpaperAsset);
  assert.ok(update, 'updateWallpaperAsset 必须执行（含 head 校验后的 size）');
  assert.equal(update.args[6], null, '大文件不伪造 sha256');
  assert.equal(update.args[2], PNG.byteLength, '落盘字节数来自 R2 head()');
});

test('大文件指纹：content_fingerprint 列存在时写入同一枚指纹', async () => {
  const fingerprint = await sampleFingerprint(PNG);
  const { env, calls } = uploadEnv({
    [Q.wallpaperColumnExists]: ([name]) => (name === 'content_fingerprint' ? [{ name }] : []),
    [Q.wallpaperFingerprintTaken]: () => [],
    [Q.updateWallpaperFingerprint]: () => [],
  });
  env.UPLOAD_HASH_LIMIT = '16';
  const res = await putAsset(env);
  assert.equal(res.status, 200);

  const written = calls.find((c) => c.sql === Q.updateWallpaperFingerprint);
  assert.ok(written, '列存在时必须写 content_fingerprint');
  assert.equal(written.args[0], fingerprint);
  assert.match(written.args[0], /^[0-9a-f]{64}$/);
});

test('大文件指纹：同一文件重复上传 → 409 conflict', async () => {
  const { env } = uploadEnv({
    [Q.wallpaperColumnExists]: () => [{ name: 'content_fingerprint' }],
    [Q.wallpaperFingerprintTaken]: () => [{ id: 'wp_other', title: '别处已上传' }],
  });
  env.UPLOAD_HASH_LIMIT = '16';
  const res = await putAsset(env);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'conflict');
});

test('小文件分支不回归：仍然算 sha256 并做 sha 去重', async () => {
  const { env, calls, puts } = uploadEnv();
  const res = await putAsset(env);
  assert.equal(res.status, 200);
  assert.match(puts[0].key, /^wallpapers\/wp_1\/[0-9a-f]{16}\.png$/);
  const update = calls.find((c) => c.sql === Q.updateWallpaperAsset);
  assert.match(update.args[6], /^[0-9a-f]{64}$/, '小文件必须写真 sha256');
  assert.equal(calls.some((c) => c.sql === Q.updateWallpaperFingerprint), false);
});

test('采样指纹：同内容同指纹、不同内容不同指纹、定长 64 hex', async () => {
  const a = await sampleFingerprint(PNG);
  const b = await sampleFingerprint(new Uint8Array(PNG));
  const c = await sampleFingerprint(new Uint8Array([...PNG, 0]));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(HASH_LIMIT, 40 * 1024 * 1024);
});
