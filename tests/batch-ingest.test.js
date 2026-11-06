/**
 * 批量入口（A=「立即扫描 / 添加目录」，B=「批量导入本地文件」）的入库管线测试。
 *
 * 为什么用**真 SQLite**（node:sqlite）跑一遍 schema/001–015：
 *   这里要证明的是「批量入口产出的 D1 行**字段齐全**、能被插件消费」——
 *   width/height/sha256/thumb_key/variants 这些列是不是真的写进去了、失败条目是不是
 *   真的没有留在库里。假映射只会把 SQL 再抄一遍，证明不了这件事。
 *
 * 报告与运行时：
 *   · 请求走**真的** `POST /api/admin/wallpapers/import`（真 multipart、真权限、真限流），
 *     与后台两个入口点的是同一个处理函数；
 *   · R2 用内存假桶（带 head()，因此 HEAD 回读校验真的会跑）；
 *   · 视频转码/抽帧用确定性替身（`env.MEDIA_TOOLS`）——测试里没有 ffmpeg，
 *     生产环境由浏览器 canvas（缩略图）与本地 ffmpeg（变体）提供，见 docs/UPLOAD-SOP.md。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importAsset } from '../src/server/routes/wallpapers.js';
import { AUTO_FIX, IMPORT_WARNING, ingestAsset } from '../src/server/ingest.js';
import { wallpaperDto } from '../src/server/dto.js';
import { readMediaMeta } from '../src/core/image-meta.js';
import { assetKey } from '../src/server/storage.js';
import { sha256Bytes } from '../src/server/util.js';
import { reset } from '../src/server/rate-limit.js';
import { makeMp4 } from './mp4-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, '..', 'schema');
const SCHEMA_FILES = readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.sql')).sort();
const PNG = new Uint8Array(readFileSync(resolve(here, 'fixtures', 'sample.png')));

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync ? false : '需要 Node ≥ 22.5 的 node:sqlite';

// ---------------------------------------------------------------- 测试环境
/** 全量迁移建一个内存库（001–015），再按需造会话/用户不需要——这里直接调 handler+actor。 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of SCHEMA_FILES) db.exec(readFileSync(resolve(SCHEMA_DIR, name), 'utf8'));
  const now = Date.now();
  db.prepare(`INSERT INTO users (id, email, name, role, password_hash, password_salt, iterations, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'h', 's', 100000, 1, ?, ?)`)
    .run('usr_batch', 'batch@folia.test', '批量', 'admin', now, now);
  return db;
}

/** D1 → node:sqlite 最小适配（undefined→NULL、boolean→0/1：node:sqlite 比 D1 严）。 */
function makeD1(db) {
  const bind = (args) => args.map((value) => {
    if (value === undefined) return null;
    if (value === true) return 1;
    if (value === false) return 0;
    return value;
  });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const state = { args: [] };
      const api = {
        bind(...args) {
          state.args = bind(args);
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

/** 内存 R2：**带 head()**，所以 ingestAsset 的 HEAD 回读校验真的会执行。 */
function makeBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, options) {
      objects.set(key, { bytes: new Uint8Array(bytes), options });
    },
    async get(key) {
      const hit = objects.get(key);
      return hit ? { body: hit.bytes } : null;
    },
    async head(key) {
      const hit = objects.get(key);
      return hit ? { size: hit.bytes.byteLength, httpEtag: `"${key}"` } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function makeEnv() {
  const db = makeDb();
  const bucket = makeBucket();
  return {
    db,
    bucket,
    env: { DB: makeD1(db), BUCKET: bucket, PUBLIC_ORIGIN: 'https://example.test' },
  };
}

const ACTOR = { id: 'usr_batch', email: 'batch@folia.test', name: '批量', role: 'admin', active: 1 };

/** 一个最小但合法的 WebP（VP8X 头 + 1280×720），只够 readMediaMeta 读出宽高。 */
function makeWebp({ width = 1280, height = 720 } = {}) {
  const out = new Uint8Array(30);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  new DataView(out.buffer).setUint32(4, 22, true);
  ascii(8, 'WEBP');
  ascii(12, 'VP8X');
  new DataView(out.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  out[24] = w & 0xff; out[25] = (w >> 8) & 0xff; out[26] = (w >> 16) & 0xff;
  out[27] = h & 0xff; out[28] = (h >> 8) & 0xff; out[29] = (h >> 16) & 0xff;
  return out;
}

/**
 * 确定性「转码器 / 抽帧器」替身：测试机没有 ffmpeg，但管线要证明的是
 * 「该生成的东西生成了、该校验的校验了、该写的写了」——所以产物用同规格的合法文件顶替。
 */
const MEDIA_TOOLS = {
  transcodeOriginal: async () => makeMp4({ width: 3840, height: 2160, fps: 30, faststart: true }),
  transcodeVariant: async () => makeMp4({ width: 1920, height: 1080, fps: 30, faststart: true }),
  extractThumb: async () => makeWebp({ width: 1280, height: 720 }),
};

/** 构造真实的 multipart 请求（与后台两个入口发的形状一致）。 */
function importRequest(payload, { ip = '203.0.113.90' } = {}) {
  const form = new FormData();
  const name = payload.fileName ?? 'untitled.bin';
  form.append('file', new Blob([payload.file], { type: payload.type ?? 'application/octet-stream' }), name);
  form.append('title', payload.title ?? name.replace(/\.[^.]+$/, ''));
  form.append('kind', payload.kind ?? 'static');
  form.append('categoryId', payload.categoryId ?? 'cat_wallpaper');
  form.append('tags', JSON.stringify(payload.tags ?? []));
  form.append('publish', payload.publish ? '1' : '0');
  form.append('reportId', payload.reportId ?? 'report_test_1');
  if (payload.thumb) form.append('thumb', new Blob([payload.thumb], { type: 'image/webp' }), 'thumb.webp');
  for (const variant of payload.variants ?? []) {
    form.append('variant', new Blob([variant.bytes], { type: 'video/mp4' }), variant.name ?? 'v.1080p.mp4');
  }
  return new Request('https://example.test/api/admin/wallpapers/import', {
    method: 'POST',
    headers: { 'x-folia-client': 'admin', 'cf-connecting-ip': ip },
    body: form,
  });
}

/** 走真实路由处理函数，返回 `{ item, report }`。 */
async function runImport(env, payload) {
  const response = await importAsset({ env, actor: ACTOR, request: importRequest(payload) });
  const body = await response.json();
  assert.equal(response.status, 200, `批量入口应返回 200 + 报告（实际 ${response.status}）`);
  assert.equal(body.ok, true);
  return body.data;
}

const rowOf = (db, id) => db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id);
const countWallpapers = (db) => db.prepare('SELECT COUNT(*) AS n FROM wallpapers').get().n;

// ---------------------------------------------------------------- A 路径
test('A 路径：4K@60 ⇒ 自动降帧到 4K@30 + 生成 1080p 变体，记录字段齐全', { skip }, async () => {
  const { db, env, bucket } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);

  const data = await runImport(env, {
    fileName: '原神 绫华 4K60.mp4',
    file: makeMp4({ width: 3840, height: 2160, fps: 60 }),
    kind: 'dynamic',
  });
  const item = data.item;

  assert.equal(item.status, 'imported', item.reason ?? '应当入库');
  assert.deepEqual(
    [...item.autoFixes].sort(),
    [AUTO_FIX.FPS_DECIMATE, AUTO_FIX.THUMB, AUTO_FIX.VARIANT_1080].sort(),
    '自动修正项要写清楚：降帧 / 缩略图 / 1080p 变体',
  );

  const row = rowOf(db, item.wallpaperId);
  assert.equal(row.width, 3840, '宽高必须写进库（插件靠它预判解码上限）');
  assert.equal(row.height, 2160);
  assert.equal(row.kind, 'dynamic');
  assert.ok(row.duration_ms > 0, '视频要有时长');
  assert.match(row.sha256, /^[0-9a-f]{64}$/, '≤40MB 必须算完整 sha256');
  assert.ok(row.thumb_key, '缩略图 key 必须落库（插件卡片要用）');
  assert.ok(bucket.objects.has(row.storage_key), 'storage_key 对应的对象必须在桶里');
  assert.ok(bucket.objects.has(row.thumb_key), '缩略图对象必须在桶里');

  const variants = JSON.parse(row.variants);
  assert.equal(variants.length, 1, '超 1080p 必须有一档 1080p 变体');
  assert.equal(variants[0].height, 1080);
  assert.ok(variants[0].bytes > 0);
  assert.match(variants[0].sha256, /^[0-9a-f]{64}$/, '变体要有自己的 sha256（插件按它校验）');
  assert.match(variants[0].key, /\.1080p\.mp4$/);
  assert.ok(bucket.objects.has(variants[0].key), '变体对象必须在桶里');

  // 落盘的**不是**那个 60fps 原文件：自动修正必须真的换了字节
  const originalSha = await sha256Bytes(makeMp4({ width: 3840, height: 2160, fps: 60 }));
  assert.notEqual(row.sha256, originalSha, '4K@60 原文件不许原样入库');

  db.close();
});

test('A 路径：4K@60 入库为待转码草稿（软违规，不再拒绝）', { skip }, async () => {
  const { db, env } = makeEnv(); // 不注入 MEDIA_TOOLS：等价于线上 Worker（没有 ffmpeg）
  reset(`import:${ACTOR.id}`);
  const data = await runImport(env, {
    fileName: '4k60-无转码器.mp4',
    file: makeMp4({ width: 3840, height: 2160, fps: 60 }),
    kind: 'dynamic',
  });

  assert.equal(data.item.status, 'imported', data.item.reason ?? '');
  const row = rowOf(db, data.item.wallpaperId);
  assert.equal(row.status, 'draft');
  assert.equal(Number(row.needs_variant), 1);
  assert.equal(row.variant_reason, 'fps-60');
  db.close();
});

// ---------------------------------------------------------------- B 路径
test('B 路径：png 一条 ⇒ 字段齐全、thumbUrl 非空、sha256 非空', { skip }, async () => {
  const { db, env } = makeEnv();
  reset(`import:${ACTOR.id}`);
  const data = await runImport(env, { fileName: '星空.png', file: PNG, kind: 'static' });
  const item = data.item;

  assert.equal(item.status, 'imported', item.reason ?? '');
  const row = rowOf(db, item.wallpaperId);
  assert.equal(row.mime, 'image/png');
  assert.equal(row.width, 4);
  assert.equal(row.height, 3);
  assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.ok(row.storage_key);
  assert.ok(row.thumb_key, '图片没有独立缩略图时用原图当缩略图，不能留空');
  assert.equal(row.thumb_key, row.storage_key);
  assert.ok(item.autoFixes.includes(AUTO_FIX.THUMB_FROM_ORIGINAL));
  assert.equal(row.variants, null, '图片不生成变体');
  db.close();
});

test('B 路径：1080p mp4 一条 ⇒ 字段齐全、sha256 非空、规格内不生成变体', { skip }, async () => {
  const { db, env } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);
  const data = await runImport(env, {
    fileName: '1080p-30.mp4',
    file: makeMp4({ width: 1920, height: 1080, fps: 30 }),
    kind: 'dynamic',
  });
  const item = data.item;

  assert.equal(item.status, 'imported', item.reason ?? '');
  const row = rowOf(db, item.wallpaperId);
  assert.equal(row.width, 1920);
  assert.equal(row.height, 1080);
  assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.ok(row.thumb_key, '视频缩略图由抽帧器/浏览器 canvas 提供');
  assert.equal(row.variants, null, '1080p@30 本来就在规格内，不该生成变体');
  assert.ok(!item.autoFixes.includes(AUTO_FIX.VARIANT_1080));
  db.close();
});

// ---------------------------------------------------------------- 失败 / 幂等
test('探测失败（图片读不出宽高）⇒ 进失败报告，不入库', { skip }, async () => {
  const { db, env } = makeEnv();
  reset(`import:${ACTOR.id}`);
  // JPEG 的 SOI 之后没有 SOF：mime 认得出是 image/jpeg，但宽高探测不到
  const broken = new Uint8Array(64);
  broken.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const data = await runImport(env, { fileName: '坏图.jpg', file: broken, kind: 'static' });

  assert.equal(data.item.status, 'failed');
  assert.equal(data.item.code, 'import_incomplete');
  assert.ok(data.report.failed === 1 && data.report.imported === 0);
  assert.deepEqual(data.item.details.missing.sort(), ['height', 'width']);
  assert.equal(countWallpapers(db), 0, '缺宽高的条目不许静默入库');
  db.close();
});

test('HEVC 入库为待转码草稿，reason=codec（编码软违规）', { skip }, async () => {
  const { db, env } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);
  const data = await runImport(env, {
    fileName: 'hevc.mp4',
    file: makeMp4({ width: 1920, height: 1080, fps: 30, codec: 'hvc1' }),
    kind: 'dynamic',
  });

  assert.equal(data.item.status, 'imported', data.item.reason ?? '');
  const row = rowOf(db, data.item.wallpaperId);
  assert.equal(row.status, 'draft');
  assert.equal(Number(row.needs_variant), 1);
  assert.equal(row.variant_reason, 'codec');
  db.close();
});

test('幂等：同一个文件导入两次 ⇒ 第二次复用已有记录，不产生重复条目', { skip }, async () => {
  const { db, env } = makeEnv();
  reset(`import:${ACTOR.id}`);
  const first = await runImport(env, { fileName: '同一张.png', file: PNG, kind: 'static' });
  const second = await runImport(env, { fileName: '同一张.png', file: PNG, kind: 'static' });

  assert.equal(first.item.status, 'imported');
  assert.equal(second.item.status, 'reused');
  assert.equal(second.item.wallpaperId, first.item.wallpaperId);
  assert.equal(countWallpapers(db), 1);
  db.close();
});

test('>40MB 分支：不算完整 sha256，改记采样指纹并在报告里标出来', { skip }, async () => {
  const { db, env } = makeEnv();
  env.UPLOAD_HASH_LIMIT = '16'; // PNG 76 字节 > 16 ⇒ 走大文件分支（等价于 >40MB）
  reset(`import:${ACTOR.id}`);
  const first = await runImport(env, { fileName: '大文件.png', file: PNG, kind: 'static' });

  assert.equal(first.item.status, 'imported', first.item.reason ?? '');
  const row = rowOf(db, first.item.wallpaperId);
  assert.equal(row.sha256, null, '大文件不许伪造 sha256');
  assert.match(row.content_fingerprint, /^[0-9a-f]{64}$/, '采样指纹要落在 content_fingerprint');
  assert.equal(first.item.fields.sha256, null);
  assert.ok(first.item.warnings.some((item) => item.code === IMPORT_WARNING.SHA_SAMPLED));

  // 同一个「>40MB」文件再来一次：靠同名 + 同大小复用（没有 sha256 可查）
  const second = await runImport(env, { fileName: '大文件.png', file: PNG, kind: 'static' });
  assert.equal(second.item.status, 'reused');
  assert.equal(countWallpapers(db), 1);
  db.close();
});

test('B 路径：助手皮肤 zip ⇒ 宽高豁免、sha256 非空、报告标出「没有缩略图」', { skip }, async () => {
  const { db, env } = makeEnv();
  reset(`import:${ACTOR.id}`);
  const zip = new Uint8Array(64);
  zip.set([0x50, 0x4b, 0x03, 0x04], 0); // PK\3\4
  const data = await runImport(env, {
    fileName: '皮肤包.zip', file: zip, kind: 'static', categoryId: 'cat_assistant_skin',
  });
  const item = data.item;

  assert.equal(item.status, 'imported', item.reason ?? 'zip 资源包不该被宽高门拦住');
  const row = rowOf(db, item.wallpaperId);
  assert.equal(row.mime, 'application/zip');
  assert.equal(row.width, null, 'zip 没有宽高，按 bundle 豁免');
  assert.equal(row.height, null);
  assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.equal(row.category_id, 'cat_assistant_skin', '皮肤包要能归到助手皮肤模块');
  assert.ok(item.warnings.some((warn) => warn.code === IMPORT_WARNING.THUMB_MISSING));
  db.close();
});

test('B 路径：勾「直接发布」⇒ 入库后置为 published（审核仍是 pending，走 approve-all）', { skip }, async () => {
  const { db, env } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);
  const data = await runImport(env, {
    fileName: '直接发布.mp4',
    file: makeMp4({ width: 1920, height: 1080, fps: 30 }),
    kind: 'dynamic',
    publish: true,
  });
  const item = data.item;
  assert.equal(item.status, 'imported', item.reason ?? '');
  const row = rowOf(db, item.wallpaperId);
  assert.equal(row.status, 'published');
  assert.ok(row.published_at > 0);
  assert.equal(row.review_status, 'pending', '发布 ≠ 审核，公开接口还要 approved');
  db.close();
});

// ---------------------------------------------------------------- 负对照
test('负对照：绕过 ingestAsset 直接写库的旧实现会把 4K@60 收进库（钉住「不能回退」）', { skip }, async () => {
  /**
   * 这段是 4.23.17 之前批量入口的形态：**建草稿 → putAsset → 直接 UPDATE 媒体列**。
   * 没有体检、没有变体、没有必填门。它写出来的那条记录正是线上「无法解码」的来源。
   * 留着它是为了证明：如果有人把批量入口改回这种写法，上面 A 路径那条测试立刻会红。
   */
  const legacyBypass = async ({ db, env, bucket }, bytes, title) => {
    const id = 'wp_legacy_1';
    const now = Date.now();
    db.prepare(`INSERT INTO wallpapers
      (id, slug, title, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
       tags, featured, sort_order, created_by, created_at, updated_at, published_at)
      VALUES (?, ?, ?, 'cat_wallpaper', 'dynamic', 'draft', NULL, NULL, 0, NULL, NULL, NULL, '[]', 0, 0, 'usr_batch', ?, ?, NULL)`)
      .run(id, 'legacy-1', title, now, now);
    const meta = readMediaMeta(bytes);
    const sha = await sha256Bytes(bytes);
    const key = assetKey(id, sha, meta.mime);
    await bucket.put(key, bytes, {});
    db.prepare('UPDATE wallpapers SET storage_key = ?, mime = ?, bytes = ?, width = ?, height = ?, sha256 = ? WHERE id = ?')
      .run(key, meta.mime, bytes.byteLength, meta.width, meta.height, sha, id);
    return rowOf(db, id);
  };

  const fourK60 = makeMp4({ width: 3840, height: 2160, fps: 60 });
  const legacyEnv = makeEnv();
  const legacyRow = await legacyBypass(legacyEnv, fourK60, '旧实现留下的 4K@60');
  assert.equal(legacyRow.width, 3840, '旧实现连线都不看，4K@60 原样进库');
  assert.equal(legacyRow.variants, null, '旧实现没有变体');
  assert.equal(legacyRow.thumb_key, null, '旧实现没有缩略图');

  // 生产管线对同一个文件：有转码器 ⇒ 换成合规字节；没有 ⇒ 直接拒绝。两条都不允许原样进库。
  reset(`import:${ACTOR.id}`);
  const fixedEnv = makeEnv();
  fixedEnv.env.MEDIA_TOOLS = MEDIA_TOOLS;
  const fixed = await runImport(fixedEnv.env, {
    fileName: '旧实现的同一个文件.mp4', file: fourK60, kind: 'dynamic',
  });
  assert.equal(fixed.item.status, 'imported');
  const fixedRow = rowOf(fixedEnv.db, fixed.item.wallpaperId);
  assert.notEqual(fixedRow.sha256, legacyRow.sha256, '入库字节必须是修正后的，不是原文件');
  assert.ok(JSON.parse(fixedRow.variants).length === 1);
  fixedEnv.db.close();
  legacyEnv.db.close();
});

test('源码守卫：路由层不许再出现「直接写 R2 / 直接写媒体列」', { skip }, () => {
  const source = readFileSync(resolve(here, '..', 'src', 'server', 'routes', 'wallpapers.js'), 'utf8');
  assert.match(source, /from '\.\.\/ingest\.js'/);
  assert.match(source, /ingestAsset\(env, actor, row/);
  assert.doesNotMatch(source, /setMediaIdentity\(/);
  assert.doesNotMatch(source, /\bputAsset\(\s*env/);
});

// ---------------------------------------------------------------- 直接调管线的自检
test('ingestAsset 本身：缺 category 时批量入口报 missing-field（单条上传不强求分类）', { skip }, async () => {
  const { db, env } = makeEnv();
  const now = Date.now();
  db.prepare(`INSERT INTO wallpapers
    (id, slug, title, category_id, kind, status, storage_key, mime, bytes, width, height, sha256,
     tags, featured, sort_order, created_by, created_at, updated_at, published_at)
    VALUES ('wp_nocat', 'no-cat', '未分类草稿', NULL, 'static', 'draft', NULL, NULL, 0, NULL, NULL, NULL, '[]', 0, 0, 'usr_batch', ?, ?, NULL)`)
    .run(now, now);
  const row = rowOf(db, 'wp_nocat');

  await assert.rejects(
    () => ingestAsset(env, ACTOR, row, { bytes: PNG }, { requireCategory: true }),
    (error) => error.code === 'import_incomplete'
      && error.details.missing.includes('category'),
  );
  // 单条上传（requireCategory 默认 false）照样能传，但宽高/字节/url 仍然要过门
  const ok = await ingestAsset(env, ACTOR, row, { bytes: PNG });
  assert.equal(ok.mime, 'image/png');
  assert.equal(ok.width, 4);
  db.close();
});

// ------------------------------------------------------ 变体 label（R4 口径统一）
test('R4 入库：2:1 源（3840×1920）+ 1920×960 变体 ⇒ label 是 1080p，key 后缀仍是 .1080p', { skip }, async () => {
  // 这条就是线上那个 bug 的形状：4320×2160 的源装进 1920 框只剩 1920×960，
  // 老实现按高度拼 label 就写成了 960p。文件名甚至不写 `.1080p.`（走尺寸推断）。
  const { db, env, bucket } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);

  // 合规的 2:1 原画（宽顶满 3840、高 1920 ≤ 2160）
  const fourK2by1 = makeMp4({ width: 3840, height: 1920, fps: 30, faststart: true });
  const data = await runImport(env, {
    fileName: '超宽原画.mp4',
    file: fourK2by1,
    kind: 'dynamic',
    variants: [{ bytes: makeMp4({ width: 1920, height: 960, fps: 30, faststart: true }), name: 'v.mp4' }],
  });

  assert.equal(data.item.status, 'imported', data.item.reason ?? '应当入库');
  const row = rowOf(db, data.item.wallpaperId);
  const variants = JSON.parse(row.variants);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].height, 960);
  assert.equal(variants[0].label, '1080p', '1920×960 是 1080p 档，不是 960p 档');
  assert.match(variants[0].key, /\.1080p\.mp4$/);
  assert.ok(bucket.objects.has(variants[0].key));

  // 公开 DTO 拿到的 label 与库里一致（同一个函数，不可能再各说一套）
  assert.equal(wallpaperDto(row).variants[0].label, variants[0].label);
  db.close();
});

test('R4 入库：4K@60 源 + 同分辨率 3840×2160@30 变体 ⇒ label 是 4K30，key 后缀是 .30fps', { skip }, async () => {
  const { db, env, bucket } = makeEnv();
  env.MEDIA_TOOLS = MEDIA_TOOLS;
  reset(`import:${ACTOR.id}`);

  const data = await runImport(env, {
    fileName: '4K60.mp4',
    file: makeMp4({ width: 3840, height: 2160, fps: 60 }),
    kind: 'dynamic',
    // 同分辨率降帧档：宽 3840 与原画一致 ⇒ 不该被 1080p 的 1920 上限误杀
    variants: [{ bytes: makeMp4({ width: 3840, height: 2160, fps: 30, faststart: true }), name: 'v.30fps.mp4' }],
  });

  assert.equal(data.item.status, 'imported', data.item.reason ?? '应当入库');
  const row = rowOf(db, data.item.wallpaperId);
  const variants = JSON.parse(row.variants);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].height, 2160);
  assert.equal(variants[0].label, '4K30', '同分辨率降帧档不许被说成 2160p');
  assert.equal(variants[0].kind, '30fps');
  assert.match(variants[0].key, /\.30fps\.mp4$/);
  assert.ok(bucket.objects.has(variants[0].key));
  assert.equal(wallpaperDto(row).variants[0].label, '4K30');
  db.close();
});
