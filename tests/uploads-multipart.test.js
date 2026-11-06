/**
 * 阶段一：分片上传（R2 multipart）。
 * 只测「协议与边界」：参数校验、长度校验、清理、abort。
 * 真正的入库链路由 upload-limits / batch-ingest 那两组覆盖（complete 内复用 ingestAsset）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { handle } from '../src/server/app.js';
import { Q } from '../src/server/queries.js';
import { createEnv, jsonRequest, sessionCookie, sessionDeviceFields, wallpaperRow, USERS } from './harness.js';
import { reset } from '../src/server/rate-limit.js';
import { MAX_MULTIPART_BYTES } from '../src/server/routes/uploads.js';

const ACTOR = { ...USERS.editor, id: 'usr_up', email: 'up@folia.test', name: '上传者' };

function sessionOf(user) {
  return () => [{
    token_hash: 'hashed',
    expires_at: Date.now() + 60_000,
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.active,
    ...sessionDeviceFields(),
  }];
}

/** 假 R2：实现 multipart 需要的 4 个方法 */
function multipartBucket(state = {}) {
  const store = new Map();
  const deleted = [];
  const bucket = {
    deleted,
    async createMultipartUpload(key) {
      store.set(key, { parts: new Map() });
      return { key, uploadId: 'up_test' };
    },
    resumeMultipartUpload(key, uploadId) {
      const entry = store.get(key) || { parts: new Map() };
      store.set(key, entry);
      return {
        uploadPart(partNumber, body) {
          entry.parts.set(partNumber, body);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        complete(parts) {
          entry.parts = new Map(parts.map((p) => [p.partNumber, p.etag]));
          return { key, size: state.completeSize ?? 1234 };
        },
        abort() {
          deleted.push(`abort:${key}`);
        },
      };
    },
    async get(key) {
      if (!store.has(key)) return null;
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        body: null,
      };
    },
    async put() { /* noop */ },
    async head(key) {
      if (!store.has(key)) return null;
      return { size: state.completeSize ?? 1234, httpEtag: '"e"' };
    },
    async delete(key) { deleted.push(key); },
  };
  return bucket;
}

function envWith(extra = {}, bucketState = {}) {
  const bucket = multipartBucket(bucketState);
  const { env } = createEnv({
    [Q.sessionByToken]: sessionOf(ACTOR),
    [Q.wallpaperById]: () => [wallpaperRow({ id: 'wp_1', created_by: ACTOR.id })],
    ...extra,
  }, { bucket });
  return { env, bucket };
}

async function call(env, request) {
  const response = await handle(request, env);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

const initReq = (env, body) => call(env, jsonRequest('/api/admin/uploads/init', {
  method: 'POST', cookie: sessionCookie(), body, headers: { 'x-folia-client': 'admin' },
}));

test('init：超过 2GB 直接 413', async () => {
  const { env } = envWith();
  const res = await initReq(env, { fileName: 'big.mp4', size: MAX_MULTIPART_BYTES + 1, contentType: 'video/mp4' });
  assert.equal(res.status, 413);
  assert.match(res.body.error.message, /2GB|最大/);
});

test('init：20MB 文件按 8MB 切片，返回 key 与 maxParts', async () => {
  const { env } = envWith();
  const res = await initReq(env, { fileName: 'a b.mp4', size: 20 * 1024 * 1024, contentType: 'video/mp4' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.partSize, 8 * 1024 * 1024);
  assert.equal(res.body.data.maxParts, 3);
  assert.match(res.body.data.key, /^_tmp\/uploads\/up_[A-Za-z0-9]+\/a_b\.mp4$/);
  assert.equal(res.body.data.uploadId, 'up_test');
});

test('part：非法 key / 非法片号一律 400', async () => {
  const { env } = envWith();
  const badKey = await call(env, new Request('https://example.test/api/admin/uploads/part?uploadId=u&part=1&key=wallpapers/x.mp4', {
    method: 'PUT', headers: { cookie: sessionCookie(), 'x-folia-client': 'admin' }, body: 'x',
  }));
  assert.equal(badKey.status, 400);

  const badPart = await call(env, new Request('https://example.test/api/admin/uploads/part?uploadId=u&part=0&key=_tmp/uploads/up_1/a.mp4', {
    method: 'PUT', headers: { cookie: sessionCookie(), 'x-folia-client': 'admin' }, body: 'x',
  }));
  assert.equal(badPart.status, 400);
});

test('part：正常分片返回 etag', async () => {
  const { env } = envWith();
  const res = await call(env, new Request('https://example.test/api/admin/uploads/part?uploadId=up_test&part=2&key=_tmp/uploads/up_1/a.mp4', {
    method: 'PUT', headers: { cookie: sessionCookie(), 'x-folia-client': 'admin' }, body: 'chunk',
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { partNumber: 2, etag: 'etag-2' });
});

test('complete：总长度不符 ⇒ 400 且删除临时对象', async () => {
  const { env, bucket } = envWith({}, { completeSize: 999 });
  const res = await call(env, jsonRequest('/api/admin/uploads/complete', {
    method: 'POST',
    cookie: sessionCookie(),
    headers: { 'x-folia-client': 'admin' },
    body: {
      uploadId: 'up_test',
      key: '_tmp/uploads/up_1/a.mp4',
      parts: [{ partNumber: 1, etag: 'etag-1' }],
      meta: { wallpaperId: 'wp_1', size: 10 },
    },
  }));
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /总长度不符/);
  assert.ok(bucket.deleted.includes('_tmp/uploads/up_1/a.mp4'), '临时对象应被删除');
});

test('abort：调用 abort 并删除临时对象', async () => {
  const { env, bucket } = envWith();
  const res = await call(env, jsonRequest('/api/admin/uploads/abort', {
    method: 'POST',
    cookie: sessionCookie(),
    headers: { 'x-folia-client': 'admin' },
    body: { uploadId: 'up_test', key: '_tmp/uploads/up_1/a.mp4' },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.data.aborted, true);
  assert.ok(bucket.deleted.some((entry) => entry.startsWith('abort:_tmp/uploads/up_1/a.mp4')));
});

test('下载队列限流不影响分片接口（同账号 20 次 init 不被 429）', async () => {
  reset(`upload:${ACTOR.id}`);
  const { env } = envWith();
  for (let i = 0; i < 20; i += 1) {
    const res = await initReq(env, { fileName: 'x.mp4', size: 1024, contentType: 'video/mp4' });
    assert.equal(res.status, 201);
  }
});
