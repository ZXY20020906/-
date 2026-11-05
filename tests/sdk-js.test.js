/**
 * SDK（JS，ESM）验收：用真实路由 + 内存 R2 当后端，验证 list/get/manifest/download 四条路径。
 *
 * 为什么值得测：SDK 是「素材网客户端」的第一层，方法名/返回形状/校验语义都是对外契约。
 * 这里用一个 fetch 桥把 SDK 的请求导回 `handle()`，所以走的是真路由、真 DTO、真 SQL。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handle } from '../src/server/app.js';
import { FoliaClient, FoliaError } from '../sdk/js/folia-client.mjs';
import { openSite, sqliteSkip, NOW } from './sqlite-site.js';

const BODY = new TextEncoder().encode('hello folia sdk');
const SHA = createHash('sha256').update(BODY).digest('hex');
const STORAGE_KEY = 'wallpapers/wp_sdk/abcdef0123456789.mp4';

function makeBridge(site) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.startsWith('/media/')) {
      const key = parsed.pathname.replace(/^\/media\//, '');
      const bytes = site.bucket.objects.get(key);
      if (!bytes) return new Response('{"ok":false}', { status: 404 });
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.byteLength) },
      });
    }
    // 摘掉 media-range.test.js 装的全局假 caches：否则第二次 manifest 请求会命中缓存，
    // 拿不到我们想验证的 304（与 tests/sqlite-site.js 的 call() 同一个处理）。
    const saved = globalThis.caches;
    delete globalThis.caches;
    try {
      return await handle(new Request(parsed.toString(), init), site.env);
    } finally {
      if (saved !== undefined) globalThis.caches = saved;
    }
  };
}

test('SDK JS：list / get / manifest（ETag 304）/ download（sha256 校验）', { skip: sqliteSkip }, async () => {
  const site = openSite([{
    id: 'wp_sdk', slug: 'sdk-item', width: 1920, height: 1080, fps: 30,
    bytes: BODY.byteLength, sha256: SHA, storage_key: STORAGE_KEY,
    poster_key: 'posters/wp_sdk/1111111111111111.webp',
    license: 'cc0', tags: ['动漫'], updated_at: NOW,
  }]);
  site.bucket.objects.set(STORAGE_KEY, BODY);
  const dest = join(tmpdir(), `folia-sdk-${process.pid}.mp4`);
  rmSync(dest, { force: true });

  try {
    const client = new FoliaClient({ baseUrl: 'https://example.test', fetch: makeBridge(site) });

    const page = await client.list({ limit: 1 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].id, 'wp_sdk');
    assert.equal(page.items[0].posterUrl, 'https://example.test/media/posters/wp_sdk/1111111111111111.webp');
    assert.deepEqual(page.items[0].tags, ['动漫']);

    const detail = await client.get('sdk-item');
    assert.equal(detail.slug, 'sdk-item');
    assert.equal(detail.fps, 30);
    assert.equal(detail.license, 'cc0');

    const manifest = await client.manifest();
    assert.equal(manifest.apiVersion, 'v1');
    assert.equal(manifest.total, 1);
    assert.equal(manifest.generatedAt, NOW);
    const unchanged = await client.manifest({ etag: `"${manifest.etag}"` });
    assert.equal(unchanged, null, 'ETag 命中应返回 null（304）');

    const saved = await client.download(detail.url, dest, { verifySha: detail.sha256 });
    assert.equal(saved.bytes, BODY.byteLength);
    assert.equal(saved.sha256, SHA);
    assert.ok(existsSync(dest));
    assert.equal(readFileSync(dest).toString('utf8'), 'hello folia sdk');

    // 错误的 sha256 ⇒ 抛 FoliaError（code = sha256_mismatch），但文件已落盘（SDK 只做校验）
    await assert.rejects(
      client.download(detail.url, dest, { verifySha: 'f'.repeat(64) }),
      (error) => error instanceof FoliaError && error.code === 'sha256_mismatch',
    );

    // 不存在的 slug ⇒ not_found（带 hint）
    await assert.rejects(
      client.get('nope'),
      (error) => error instanceof FoliaError && error.status === 404 && error.code === 'not_found' && Boolean(error.hint),
    );
  } finally {
    rmSync(dest, { force: true });
    site.close();
  }
});

test('SDK JS：带 apiKey 时走 Authorization，不被当成匿名', { skip: sqliteSkip }, async () => {
  const site = openSite([{ id: 'wp_sdk2', slug: 'sdk-2' }]);
  try {
    let seen = '';
    const bridge = async (url, init = {}) => {
      const headers = new Headers(init.headers ?? {});
      seen = headers.get('authorization') ?? '';
      return handle(new Request(String(url), init), site.env);
    };
    // 未注册 api_keys 行 → 401 api_key_invalid（证明 key 真的被发送并校验了）
    const client = new FoliaClient({ baseUrl: 'https://example.test', apiKey: 'flk_test_key_1234567890', fetch: bridge });
    await assert.rejects(
      client.list(),
      (error) => error instanceof FoliaError && error.status === 401 && error.code === 'api_key_invalid',
    );
    assert.equal(seen, 'Bearer flk_test_key_1234567890');
  } finally {
    site.close();
  }
});
