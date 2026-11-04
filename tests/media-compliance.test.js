/**
 * 上传播放合规体检（src/server/media-compliance.js + 上传路由的 422 闸门）。
 *
 * 两段：
 *  1) 纯函数用例：规则本身（违规码、宽容差、变体更严的宽度上限）；
 *  2) 路由用例：用**真 SQLite**（node:sqlite）跑全量 schema + 真 `handle()`，
 *     这样才能证明「违规时一个字节都没落盘、D1 一行都没写」——假映射只能证明
 *     「没调用某个查询」，证明不了表里真的没变。
 *
 * 拿不到 node:sqlite（Node < 22.5）时路由用例整组 skip，不拉红基线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPLIANCE_HINT, MEDIA_LIMITS, VIOLATION, WARNING, checkVideoCompliance, complianceMessage,
} from '../src/server/media-compliance.js';
import { readVideoFps, readVideoInfo } from '../src/core/image-meta.js';
import { handle } from '../src/server/app.js';
import { sha256Hex } from '../src/server/util.js';
import { reset } from '../src/server/rate-limit.js';
import { makeMp4, makeWebm } from './mp4-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '..', 'schema');
const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const skip = DatabaseSync ? false : '需要 Node ≥ 22.5 的 node:sqlite';

const codes = (result) => result.violations.map((item) => item.code);
const warnCodes = (result) => result.warnings.map((item) => item.code);

// --------------------------------------------------------------- 纯函数：违规码

test('规格上限：3840×2160 / 30fps / 8,294,400 像素', () => {
  assert.equal(MEDIA_LIMITS.maxWidth, 3840);
  assert.equal(MEDIA_LIMITS.maxHeight, 2160);
  assert.equal(MEDIA_LIMITS.maxPixels, 8_294_400);
  assert.equal(MEDIA_LIMITS.maxPixels, MEDIA_LIMITS.maxWidth * MEDIA_LIMITS.maxHeight);
  assert.equal(MEDIA_LIMITS.maxFps, 30);
  assert.equal(MEDIA_LIMITS.variantMaxWidth, 1920);
  assert.equal(MEDIA_LIMITS.originalMaxBytes, 25 * 1024 * 1024);
  assert.equal(MEDIA_LIMITS.variantMaxBytes, 8 * 1024 * 1024);
});

test('5916×2530 ⇒ too-wide + too-many-pixels（高度也超了，故同时有 too-tall）', () => {
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 5916, height: 2530, fps: 30, codec: 'h264', faststart: true, bytes: 10 * 1024 * 1024,
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes(VIOLATION.TOO_WIDE), '宽 5916 > 3840 必须报 too-wide');
  assert.ok(codes(result).includes(VIOLATION.TOO_MANY_PIXELS), '5916×2530 = 14,967,480 像素必须超限');
  // 2530 > 2160，所以 too-tall 也会命中——这是同一件事的另一面，不是误报
  assert.ok(codes(result).includes(VIOLATION.TOO_TALL));
  assert.deepEqual(codes(result), [VIOLATION.TOO_WIDE, VIOLATION.TOO_TALL, VIOLATION.TOO_MANY_PIXELS]);
  assert.equal(result.warnings.length, 0);
});

test('3840×2160 @30fps H.264 faststart ⇒ ok（上限本身是合规的）', () => {
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 3840, height: 2160, fps: 30, codec: 'avc1', faststart: true, bytes: 24 * 1024 * 1024,
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.ok, true);
});

test('1920×1080 @60fps ⇒ fps-too-high 是**违规**（不是警告）', () => {
  // 取舍说明：60fps 浏览器能播，但它顶穿站点的解码/体积预算（1080p 变体 ≤8MB 基本不可能），
  // 而本地工具一条 `fps=30` 就能修好。硬拒才能保证「先跑工具」是唯一路径。
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 60, codec: 'h264', faststart: true, bytes: 8 * 1024 * 1024,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [VIOLATION.FPS_TOO_HIGH]);
  assert.match(result.violations[0].message, /60fps/);
});

test('帧率容差：29.97 / 30.000 不算超，30.6 才算', () => {
  const base = { mime: 'video/mp4', width: 1920, height: 1080, codec: 'h264', faststart: true };
  assert.equal(checkVideoCompliance({ ...base, fps: 29.97 }).ok, true);
  assert.equal(checkVideoCompliance({ ...base, fps: 30 }).ok, true);
  assert.equal(checkVideoCompliance({ ...base, fps: 30.4 }).ok, true, '实测抖动留 0.5 容差');
  assert.equal(checkVideoCompliance({ ...base, fps: 30.6 }).ok, false);
});

test('HEVC ⇒ codec-unsupported（浏览器多数解不了）', () => {
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'hevc', faststart: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [VIOLATION.CODEC_UNSUPPORTED]);
  assert.match(result.violations[0].message, /H\.264/);
  // hvc1 是 container 里的写法，也得认
  assert.equal(checkVideoCompliance({ mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'hvc1', faststart: true }).ok, false);
});

test('moov 在文件尾部 ⇒ not-faststart（浏览器要下完整个文件才能起播）', () => {
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: false,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), [VIOLATION.NOT_FASTSTART]);
  // 探测不出来也不能当合规：null 同样拒
  assert.deepEqual(
    codes(checkVideoCompliance({ mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: null })),
    [VIOLATION.NOT_FASTSTART],
  );
});

test('宽高探测不出来 ⇒ probe-failed（库里留 null 宽高会让列表/变体全失真）', () => {
  for (const bad of [{ width: null, height: null }, { width: 0, height: 1080 }, { width: 1920 }, {}]) {
    const result = checkVideoCompliance({
      mime: 'video/mp4', fps: 30, codec: 'h264', faststart: true, ...bad,
    });
    assert.ok(codes(result).includes(VIOLATION.PROBE_FAILED), `宽高缺失必须报 probe-failed：${JSON.stringify(bad)}`);
    assert.equal(result.ok, false);
  }
  // moov 都读不到时编码也读不到：同样算探测失败
  const noCodec = checkVideoCompliance({ mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: null, faststart: true });
  assert.ok(codes(noCodec).includes(VIOLATION.PROBE_FAILED));
});

test('体积超限只给 warning，不拒绝入库', () => {
  const original = checkVideoCompliance({
    mime: 'video/mp4', width: 3840, height: 2160, fps: 30, codec: 'h264', faststart: true, bytes: 26 * 1024 * 1024,
  });
  assert.equal(original.ok, true, '26MB 的原画只 warn');
  assert.deepEqual(warnCodes(original), [WARNING.ORIGINAL_TOO_LARGE]);

  const variant = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: true, bytes: 9 * 1024 * 1024,
  }, { role: 'variant' });
  assert.equal(variant.ok, true);
  assert.deepEqual(warnCodes(variant), [WARNING.VARIANT_TOO_LARGE]);
});

test('1080p 变体：宽度上限收到 1920，H.264 + faststart 要求更严', () => {
  const wide = checkVideoCompliance({
    mime: 'video/mp4', width: 2560, height: 1080, fps: 30, codec: 'h264', faststart: true,
  }, { role: 'variant' });
  assert.equal(wide.ok, false);
  assert.deepEqual(codes(wide), [VIOLATION.TOO_WIDE]);
  assert.match(wide.violations[0].message, /变体宽度 2560px 超过上限 1920px/);

  assert.equal(checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: true,
  }, { role: 'variant' }).ok, true);

  // 1922×1080 是 `scale=-2:1080` 处理 2000×1124 源时产出的宽度（线上存量里就有）。
  // 按「变体 ≤1920」这条规格它就是超限的 —— 所以本地工具改用「装进 1920×1080 框」的
  // 缩放（见 tools/prepare-upload.mjs 的 variantScale），不再产出 1922。存量对象不动。
  assert.deepEqual(codes(checkVideoCompliance({
    mime: 'video/mp4', width: 1922, height: 1080, fps: 30, codec: 'h264', faststart: true,
  }, { role: 'variant' })), [VIOLATION.TOO_WIDE]);

  // faststart 未知时，原画与变体都拒（变体要求更严：不接受「无法确认」）
  const unknown = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: null,
  }, { role: 'variant' });
  assert.deepEqual(codes(unknown), [VIOLATION.NOT_FASTSTART]);
});

test('WebM 不套 MP4 规则：VP9 原生可播，只留 container-webm 警告', () => {
  const ok = checkVideoCompliance({
    mime: 'video/webm', width: 1920, height: 1080, fps: 30, codec: 'vp9', faststart: null, bytes: 1024,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(warnCodes(ok), [WARNING.CONTAINER_WEBM]);

  // 但分辨率/帧率的硬约束照样管
  const wide = checkVideoCompliance({
    mime: 'video/webm', width: 5916, height: 2530, fps: 30, codec: 'vp9', faststart: null,
  });
  assert.equal(wide.ok, false);
  assert.ok(codes(wide).includes(VIOLATION.TOO_WIDE));

  // 浏览器不认的编码照样拒
  const bad = checkVideoCompliance({
    mime: 'video/webm', width: 1920, height: 1080, fps: 30, codec: 'hevc', faststart: null,
  });
  assert.deepEqual(codes(bad), [VIOLATION.CODEC_UNSUPPORTED]);
});

test('帧率探测不到 ⇒ fps-unknown 警告（不拒绝，但留痕）', () => {
  const result = checkVideoCompliance({
    mime: 'video/mp4', width: 1920, height: 1080, fps: null, codec: 'h264', faststart: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(warnCodes(result), [WARNING.FPS_UNKNOWN]);
});

test('limits 可覆盖：--max-pixels 调小后 1920×1080 也会超限', () => {
  const base = { mime: 'video/mp4', width: 1920, height: 1080, fps: 30, codec: 'h264', faststart: true };
  assert.equal(checkVideoCompliance(base).ok, true);
  const strict = checkVideoCompliance(base, { limits: { maxPixels: 1920 * 1080 - 1 } });
  assert.deepEqual(codes(strict), [VIOLATION.TOO_MANY_PIXELS]);
});

test('422 的 message：中文明细 + 指向本地工具', () => {
  const result = checkVideoCompliance({ mime: 'video/mp4', width: 5916, height: 2530, fps: 30, codec: 'h264', faststart: true });
  const message = complianceMessage(result);
  assert.match(message, /视频不符合播放规格/);
  assert.match(message, /宽度 5916px 超过上限 3840px/);
  assert.ok(message.includes(COMPLIANCE_HINT));
  assert.match(COMPLIANCE_HINT, /tools\/prepare-upload\.mjs/);
});

// ------------------------------------------------- 探针：真文件结构能读出帧率

test('探针：mp4 的 stts 能算出 30/60fps，moov 在尾部也能读', () => {
  assert.equal(readVideoFps(makeMp4({ fps: 30 }), 'video/mp4'), 30);
  assert.equal(readVideoFps(makeMp4({ fps: 60 }), 'video/mp4'), 60);
  assert.equal(readVideoFps(makeMp4({ fps: 24 }), 'video/mp4'), 24);
  assert.equal(readVideoFps(makeMp4({ fps: 30, faststart: false }), 'video/mp4'), 30, 'moov 在尾部同样能算');
  assert.equal(readVideoFps(makeMp4({ codec: 'hvc1' }), 'video/mp4'), 30, '编码不影响帧率');
  assert.equal(readVideoFps(new Uint8Array(32), 'video/mp4'), null);
  assert.equal(readVideoFps(null, 'video/mp4'), null);
});

test('探针：readVideoInfo 同时给出 codec / faststart / fps', () => {
  const good = readVideoInfo(makeMp4({ codec: 'avc1', fps: 30 }), 'video/mp4');
  assert.deepEqual(good, { codec: 'h264', faststart: true, fps: 30 });

  const tail = readVideoInfo(makeMp4({ codec: 'avc1', faststart: false }), 'video/mp4');
  assert.equal(tail.faststart, false, 'moov 在 mdat 之后必须判 false（旧实现一律 null）');
  assert.equal(tail.codec, 'h264');
  assert.equal(tail.fps, 30);

  const hevc = readVideoInfo(makeMp4({ codec: 'hvc1' }), 'video/mp4');
  assert.equal(hevc.codec, 'hevc');
});

test('探针：WebM 的 DefaultDuration 能算帧率，缺了就返回 null', () => {
  assert.equal(readVideoFps(makeWebm({ fps: 30 }), 'video/webm'), 30);
  assert.equal(readVideoFps(makeWebm({ fps: 60 }), 'video/webm'), 60);
  assert.equal(readVideoFps(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]), 'video/webm'), null);
});

// --------------------------------------------------------- 路由：违规不写库

/** 全量迁移（001–015）建一个内存库：验证性用例跑的是真 schema、真触发器。 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  return db;
}

/** D1 → node:sqlite 最小适配（只实现被测代码用到的 all/first/run/batch）。 */
function makeD1(db) {
  /**
   * D1 会把 boolean 当 0/1 绑进去（上传路由把 detect 到的 faststart 原样传下来），
   * node:sqlite 则会直接拒 string/number/null/TypedArray 之外的值。适配层负责抹平，
   * 否则测试失败的是「D1 与 SQLite 的差异」，不是被测逻辑。
   */
  const bindable = (args) => args.map((value) => {
    if (value === true) return 1;
    if (value === false) return 0;
    if (value === undefined) return null;
    return value;
  });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const state = { args: [] };
      const api = {
        bind(...args) {
          state.args = bindable(args);
          return api;
        },
        async all() {
          return { results: stmt.all(...state.args) };
        },
        async first() {
          return stmt.get(...state.args) ?? null;
        },
        async run() {
          stmt.run(...state.args);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
}

const DEVICE_ID = 'e'.repeat(43);
const TOKEN = 'upload-compliance-token';
const USER = {
  id: 'usr_compliance', email: 'up@folia.test', name: '上传者', role: 'admin',
};

async function routeEnv(wallpapers = []) {
  const db = makeDb();
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'h', 's', 100000, 1, ?, ?)`).run(USER.id, USER.email, USER.name, USER.role, now, now);
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash, device_hash, last_seen_at)
    VALUES (?, ?, ?, ?, '', '', ?, ?)`).run(
    await sha256Hex(TOKEN), USER.id, now, now + 60_000, await sha256Hex(DEVICE_ID), now,
  );
  for (const row of wallpapers) {
    db.prepare(`INSERT INTO wallpapers
      (id, slug, title, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
       tags, featured, sort_order, created_by, created_at, updated_at, published_at)
      VALUES (?, ?, ?, NULL, ?, 'draft', NULL, NULL, 0, NULL, NULL, NULL, '[]', 0, 0, ?, ?, ?, NULL)`).run(
      row.id, row.slug, row.title, row.kind, USER.id, now, now,
    );
  }

  const puts = [];
  const env = {
    DB: makeD1(db),
    BUCKET: {
      async put(key, bytes, options) {
        puts.push({ key, bytes, options });
      },
      async get() {
        return null;
      },
      async delete() {},
    },
    PUBLIC_ORIGIN: 'https://example.test',
  };
  return { db, env, puts };
}

function uploadRequest(bytes, { type = 'video/mp4', path = '/api/admin/wallpapers/wp_c1/asset' } = {}) {
  return new Request(`https://example.test${path}`, {
    method: 'PUT',
    headers: {
      cookie: `folia_session=${TOKEN}; folia_device=${DEVICE_ID}`,
      'x-folia-client': 'admin',
      'content-type': type,
      'cf-connecting-ip': '203.0.113.70',
    },
    body: bytes,
  });
}

async function call(env, request) {
  const response = await handle(request, env);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WP_ROW = { id: 'wp_c1', slug: 'compliance-1', title: '合规用例', kind: 'dynamic' };

test('路由：5916×2530 的视频 422，且 R2 / D1 一个字节都没写', { skip }, async () => {
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const video = makeMp4({ width: 5916, height: 2530, fps: 30 });

  const res = await call(env, uploadRequest(video));

  assert.equal(res.status, 422, '违规必须 422（不是 400/415）');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'media_non_compliant');
  const details = res.body.error.details;
  const got = details.violations.map((item) => item.code);
  assert.ok(got.includes(VIOLATION.TOO_WIDE));
  assert.ok(got.includes(VIOLATION.TOO_MANY_PIXELS));
  assert.equal(details.width, 5916);
  assert.ok(details.hint.includes('tools/prepare-upload.mjs'), 'details.hint 要指向本地工具');
  assert.ok(res.body.error.message.includes('tools/prepare-upload.mjs'), 'message 里也要有处理建议');

  // —— 不写库 / 不落盘 ——
  assert.equal(puts.length, 0, '违规时不允许写 R2');
  const row = db.prepare('SELECT storage_key, mime, bytes, verified_at, sha256 FROM wallpapers WHERE id = ?').get(WP_ROW.id);
  assert.equal(row.storage_key, null);
  assert.equal(row.mime, null);
  assert.equal(Number(row.bytes), 0);
  assert.equal(row.verified_at, null);
  assert.equal(row.sha256, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_audit WHERE wallpaper_id = ?').get(WP_ROW.id).n, 0, '媒体审计不应有行');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ?').get(WP_ROW.id).n, 0, '审计日志不应有行');
  db.close();
});

test('路由：60fps 1080p 视频 422（帧率超限）', { skip }, async () => {
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const res = await call(env, uploadRequest(makeMp4({ width: 1920, height: 1080, fps: 60 })));

  assert.equal(res.status, 422);
  assert.deepEqual(res.body.error.details.violations.map((item) => item.code), [VIOLATION.FPS_TOO_HIGH]);
  assert.equal(puts.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
  db.close();
});

test('路由：moov 在尾部的 mp4 自动转封装后入库（不再要求用户跑工具）', { skip }, async () => {
  // 4.23.18 起：`not-faststart` 是唯一**不需要解码器**就能修的违规，
  // 服务端用 src/server/mp4-remux.js 把 moov 前置（只改字节顺序，不重编码）。
  // 所以这条不再是 422 —— 422 留给「必须真转码」的违规（分辨率/编码）。
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const res = await call(env, uploadRequest(makeMp4({ width: 1920, height: 1080, faststart: false })));

  assert.equal(res.status, 200, '能自动修的不该再丢给用户');
  assert.equal(puts.length, 1);
  // 落盘的那份必须是 moov 前置的（ftyp → moov → mdat），不是原始字节
  const stored = puts[0].bytes;
  const topLevel = [];
  for (let at = 0; at + 8 <= stored.length;) {
    const size = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(at);
    topLevel.push(String.fromCharCode(stored[at + 4], stored[at + 5], stored[at + 6], stored[at + 7]));
    if (!(size >= 8)) break;
    at += size;
  }
  assert.deepEqual(topLevel.slice(0, 3), ['ftyp', 'moov', 'mdat'], 'moov 必须被挪到 mdat 前面');

  const row = db.prepare('SELECT faststart, verified_at, width, height FROM wallpapers WHERE id = ?').get(WP_ROW.id);
  assert.equal(Number(row.faststart), 1, '转封装后 faststart 必须为 1');
  assert.equal(row.width, 1920);
  assert.equal(row.height, 1080);
  assert.ok(row.verified_at > 0);
  assert.deepEqual(res.body.data.ingest.autoFixes, ['faststart']);
  db.close();
});

test('路由：真的修不了的视频仍然 422 且不落盘（负对照）', { skip }, async () => {
  // ftyp + mdat、没有 moov：能认出是 video/mp4，但宽高/编码都探测不到 ⇒ probe-failed。
  // 这种「文件本身不完整」的修不了，转封装也救不了 ⇒ 必须继续 422。
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const fake = new Uint8Array(64);
  const view = new DataView(fake.buffer);
  view.setUint32(0, 24); // ftyp box
  fake.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  fake.set([0x6d, 0x70, 0x34, 0x32], 8); // brand 'mp42'
  view.setUint32(24, 40); // mdat box
  fake.set([0x6d, 0x64, 0x61, 0x74], 28); // 'mdat'
  const res = await call(env, uploadRequest(fake));

  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.violations.some((item) => item.code === VIOLATION.PROBE_FAILED));
  assert.equal(puts.length, 0);
  db.close();
});

test('路由：合规视频 200，入库并写 verified_at/codec/faststart', { skip }, async () => {
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const res = await call(env, uploadRequest(makeMp4({ width: 1920, height: 1080, fps: 30 })));

  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^wallpapers\/wp_c1\/[0-9a-f]{16}\.mp4$/);

  const row = db.prepare('SELECT storage_key, mime, width, height, bytes, verified_at, codec, faststart, kind FROM wallpapers WHERE id = ?').get(WP_ROW.id);
  assert.ok(row.storage_key, 'storage_key 必须写进去');
  assert.equal(row.mime, 'video/mp4');
  assert.equal(row.width, 1920);
  assert.equal(row.height, 1080);
  assert.equal(row.codec, 'h264');
  assert.equal(Number(row.faststart), 1);
  assert.equal(row.kind, 'dynamic', '视频自动归到动态');
  assert.ok(row.verified_at > 0);

  const actions = db.prepare('SELECT action FROM audit_log WHERE target_id = ? ORDER BY id').all(WP_ROW.id).map((r) => r.action);
  assert.deepEqual(actions, ['wallpaper.asset_upload'], '没有警告时不应多出合规警告行');
  assert.equal(res.body.data.compliance.warnings.length, 0);
  db.close();
});

test('路由：只有 warning（WebM 容器）时照常入库，并记录到 audit_log', { skip }, async () => {
  reset(`upload:${USER.id}`);
  const { db, env, puts } = await routeEnv([WP_ROW]);
  const res = await call(env, uploadRequest(makeWebm({ width: 1280, height: 720, fps: 30 }), { type: 'video/webm' }));

  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.deepEqual(res.body.data.compliance.warnings.map((item) => item.code), [WARNING.CONTAINER_WEBM]);

  const rows = db.prepare('SELECT action, detail FROM audit_log WHERE target_id = ? ORDER BY id').all(WP_ROW.id);
  const warnRow = rows.find((r) => r.action === 'wallpaper.asset_compliance_warn');
  assert.ok(warnRow, 'warning 必须留一条审计（action = wallpaper.asset_compliance_warn）');
  assert.match(warnRow.detail, /container-webm/);
  assert.equal(res.status, 200);
  db.close();
});

test('路由：图片/zip 完全不受体检影响', { skip }, async () => {
  reset(`upload:${USER.id}`);
  const png = new Uint8Array(readFileSync(resolve(here, 'fixtures', 'sample.png')));
  const { db, env, puts } = await routeEnv([{ ...WP_ROW, kind: 'static' }]);

  const res = await call(env, uploadRequest(png, { type: 'image/png' }));
  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.equal(res.body.data.compliance, undefined, '图片响应里不该有 compliance 字段');
  assert.match(puts[0].key, /\.png$/);
  db.close();
});
