#!/usr/bin/env node
/**
 * backfill-metadata.mjs — 存量素材的元数据 / 首帧海报回填（schema/016）。
 *
 * 做四件事，全部可重复执行：
 *   ① 视频：ffprobe **只读文件头**（HTTP Range + `-read_intervals "%+#1"`，不整档下载）
 *      补 `fps / codec / pix_fmt / has_audio`；顺手补空的宽高/时长。
 *   ② 图片：只取文件头（Range 128KB）用仓库里的 `readMediaMeta()` 补宽高。
 *   ③ 首帧海报：ffmpeg 抽第 1 帧 → 1280 宽 WebP → 内容哈希 key → R2 → D1 `poster_key`。
 *   ④ 变体：对 `variants[]` 里的每个对象再探一次，补 `width / height / fps`。
 *
 * 为什么只读文件头：4K 素材动辄几十 MB，整档下载既慢又费 R2 出网流量。
 * ffprobe 对 HTTP 源会按需 Range 拉 moov 与首包；`-read_intervals "%+#1"` 读完第一帧就停。
 *
 * 不打印 token。token 从 `--token-file`（默认 D:\folia-recover\cf-token.txt）或
 * 环境变量 `CF_API_TOKEN` 读取；只用于 Authorization 头。
 *
 * 用法：
 *   node tools/backfill-metadata.mjs --dry-run              # 只看要改什么
 *   node tools/backfill-metadata.mjs                        # 真写（补空缺 + 覆盖技术字段）
 *   node tools/backfill-metadata.mjs --posters=all          # 连已有 poster_key 也重新生成
 *   node tools/backfill-metadata.mjs --only=some-slug --limit=1
 *
 * 退出码：0 全部成功（允许个别失败，见报告）；1 有致命错误（配置/鉴权失败）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMediaMeta } from '../src/core/image-meta.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: 0,
    only: '',
    posters: 'missing', // missing | all | skip
    concurrency: 1,
    base: process.env.MEDIA_ORIGIN || 'https://folia-5ve.pages.dev',
    tokenFile: process.env.CF_TOKEN_FILE || 'D:\\folia-recover\\cf-token.txt',
    account: process.env.CF_ACCOUNT_ID || '2f31addd6894dbafbcfb220c6809fee3',
    database: process.env.D1_DATABASE_ID || '64761fc2-cd88-46f4-b08f-c2b08d5b667f',
    bucket: process.env.R2_BUCKET || 'folia-wallpapers',
    ffmpegBin: process.env.FFMPEG_BIN || 'D:\\folia-recover\\tools\\ffmpeg-master-latest-win64-gpl-shared\\bin',
    posterWidth: 1280,
  };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8)) || 0;
    else if (raw.startsWith('--only=')) args.only = raw.slice(7);
    else if (raw.startsWith('--posters=')) args.posters = raw.slice(10);
    else if (raw.startsWith('--base=')) args.base = raw.slice(7);
    else if (raw.startsWith('--token-file=')) args.tokenFile = raw.slice(13);
    else if (raw.startsWith('--ffmpeg-bin=')) args.ffmpegBin = raw.slice(13);
    else if (raw.startsWith('--poster-width=')) args.posterWidth = Number(raw.slice(15)) || 1280;
    else if (raw.startsWith('--concurrency=')) args.concurrency = Math.max(1, Number(raw.slice(14)) || 1);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!['missing', 'all', 'skip'].includes(args.posters)) {
  console.error('--posters 只能是 missing / all / skip');
  process.exit(1);
}

// ---------------------------------------------------------------- 鉴权（绝不打印 token）
function readToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN.trim();
  if (existsSync(args.tokenFile)) return readFileSync(args.tokenFile, 'utf8').trim();
  console.error(`找不到 token：既没有 CF_API_TOKEN，也没有 ${args.tokenFile}`);
  process.exit(1);
}
const TOKEN = readToken();
if (!TOKEN) {
  console.error('token 是空的');
  process.exit(1);
}

const FFMPEG = resolve(args.ffmpegBin, 'ffmpeg.exe');
const FFPROBE = resolve(args.ffprobeBin ?? args.ffmpegBin, 'ffprobe.exe');
if (!existsSync(FFMPEG) || !existsSync(FFPROBE)) {
  console.error(`找不到 ffmpeg/ffprobe：${FFMPEG} / ${FFPROBE}`);
  process.exit(1);
}

const CF_API = 'https://api.cloudflare.com/client/v4';
const D1_ENDPOINT = `${CF_API}/accounts/${args.account}/d1/database/${args.database}/query`;

// ---------------------------------------------------------------- 小工具
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function runProcess(command, argv, { timeoutMs = 240_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`超时（${timeoutMs}ms）：${command.split(/[\\/]/).pop()}`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command.split(/[\\/]/).pop()} 退出码 ${code}：${stderr.trim().slice(0, 300)}`));
    });
  });
}

async function d1(sql, params = []) {
  const payload = params.length ? { sql, params } : { sql };
  const response = await fetch(D1_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!body.success) {
    const message = (body.errors ?? []).map((item) => item.message).join('; ') || `HTTP ${response.status}`;
    throw new Error(`D1 失败：${message}`);
  }
  return body.result?.[0]?.results ?? [];
}

async function d1Update(sql, params) {
  if (args.dryRun) return { dryRun: true };
  return d1(sql, params);
}

async function r2Put(key, bytes, contentType) {
  if (args.dryRun) return { dryRun: true, key };
  const response = await fetch(
    `${CF_API}/accounts/${args.account}/r2/buckets/${args.bucket}/objects/${key}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType },
      body: bytes,
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(`R2 写入失败 ${response.status}：${JSON.stringify(body.errors ?? body).slice(0, 200)}`);
  }
  return body;
}

/** 媒体直链（与站点 /media/<key> 同一套）。 */
function mediaUrl(key) {
  return `${args.base.replace(/\/+$/, '')}/media/${key}`;
}

/** ffprobe 只读文件头：probesize 限制 + 读完第一帧就停。 */
async function probe(url) {
  const { stdout } = await runProcess(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-probesize', '2000000',
    '-analyzeduration', '2000000',
    '-read_intervals', '%+#1',
    '-show_streams',
    '-show_format',
    '-i', url,
  ], { timeoutMs: 120_000 });
  const doc = JSON.parse(stdout);
  const video = (doc.streams ?? []).find((stream) => stream.codec_type === 'video') ?? null;
  const hasAudio = (doc.streams ?? []).some((stream) => stream.codec_type === 'audio') ? 1 : 0;
  const fps = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate);
  const durationMs = Number.isFinite(Number(doc.format?.duration))
    ? Math.round(Number(doc.format.duration) * 1000)
    : null;
  return {
    fps: fps ?? null,
    codec: video?.codec_name ?? null,
    pixFmt: video?.pix_fmt ?? null,
    hasAudio,
    width: video?.width ?? null,
    height: video?.height ?? null,
    durationMs: durationMs && durationMs > 0 ? durationMs : null,
  };
}

function parseRate(text) {
  if (!text || typeof text !== 'string') return null;
  const [num, den] = text.split('/').map(Number);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (den === undefined || den === 0) return null;
  const value = num / den;
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  return Math.round(value * 100) / 100;
}

/** 图片只取头部字节（Range），不整档下载。 */
async function fetchHead(url, bytes = 256 * 1024) {
  const response = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}` } });
  if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  return buffer.subarray(0, bytes);
}

async function makePoster(url, outPath) {
  await runProcess(FFMPEG, [
    '-hide_banner', '-v', 'error',
    '-i', url,
    '-frames:v', '1',
    '-vf', `scale=${args.posterWidth}:-2`,
    '-c:v', 'libwebp',
    '-quality', '80',
    '-f', 'webp',
    '-y', outPath,
  ], { timeoutMs: 180_000 });
  return new Uint8Array(readFileSync(outPath));
}

function posterKeyFor(id, hash) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
  return `posters/${safe}/${hash.slice(0, 16)}.webp`;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 主流程
const report = {
  startedAt: new Date().toISOString(),
  dryRun: args.dryRun,
  base: args.base,
  totals: { rows: 0, videos: 0, images: 0, bundles: 0 },
  probed: { videos: 0, failed: 0 },
  filled: { fps: 0, codec: 0, pixFmt: 0, hasAudio: 0, width: 0, height: 0, durationMs: 0 },
  posters: { generated: 0, skipped: 0, failed: 0 },
  variants: { rows: 0, objects: 0, updated: 0, failed: 0 },
  errors: [],
};

function bump(field, before, after) {
  if (before === null || before === undefined || before === '' || Number.isNaN(before)) {
    if (after !== null && after !== undefined) report.filled[field] += 1;
  }
}

const tmpDir = resolve(ROOT, 'build', 'backfill-tmp');
if (!args.dryRun) mkdirSync(tmpDir, { recursive: true });

const rows = await d1(
  `SELECT id, slug, mime, storage_key, width, height, duration_ms, fps, codec, pix_fmt,
          has_audio, poster_key, variants
     FROM wallpapers
     WHERE storage_key IS NOT NULL
     ORDER BY CASE WHEN mime LIKE 'video/%' THEN 0 WHEN mime LIKE 'image/%' THEN 1 ELSE 2 END, id`,
);
const picked = (args.only ? rows.filter((row) => row.slug === args.only) : rows)
  .slice(0, args.limit > 0 ? args.limit : rows.length);

console.log(`[backfill] 共 ${rows.length} 条有文件，本次处理 ${picked.length} 条${args.dryRun ? '（dry-run）' : ''}`);

for (const [index, row] of picked.entries()) {
  report.totals.rows += 1;
  const isVideo = String(row.mime ?? '').startsWith('video/');
  const isImage = String(row.mime ?? '').startsWith('image/');
  if (isVideo) report.totals.videos += 1;
  else if (isImage) report.totals.images += 1;
  else report.totals.bundles += 1;

  const url = mediaUrl(row.storage_key);
  const tag = `[${index + 1}/${picked.length}] ${row.slug}`;

  if (isVideo) {
    try {
      const info = await probe(url);
      report.probed.videos += 1;
      bump('fps', row.fps, info.fps);
      bump('codec', row.codec, info.codec);
      bump('pixFmt', row.pix_fmt, info.pixFmt);
      bump('hasAudio', row.has_audio, info.hasAudio);
      bump('width', row.width, info.width);
      bump('height', row.height, info.height);
      bump('durationMs', row.duration_ms, info.durationMs);
      await d1Update(
        `UPDATE wallpapers SET fps = ?, codec = ?, pix_fmt = ?, has_audio = ?,
           width = COALESCE(width, ?), height = COALESCE(height, ?),
           duration_ms = COALESCE(duration_ms, ?)
         WHERE id = ?`,
        [info.fps, info.codec, info.pixFmt, info.hasAudio, info.width, info.height, info.durationMs, row.id],
      );
      console.log(`${tag} video fps=${info.fps} codec=${info.codec} pix=${info.pixFmt} audio=${info.hasAudio}`);
    } catch (error) {
      report.probed.failed += 1;
      report.errors.push({ id: row.id, slug: row.slug, stage: 'probe', message: String(error.message).slice(0, 200) });
      console.warn(`${tag} ffprobe 失败：${String(error.message).slice(0, 160)}`);
    }

    // 首帧海报
    const wantPoster = args.posters === 'all' || (args.posters === 'missing' && !row.poster_key);
    if (wantPoster) {
      const tmp = resolve(tmpDir, `${row.id}.webp`);
      try {
        const bytes = await makePoster(url, tmp);
        const hash = sha256Hex(bytes);
        const key = posterKeyFor(row.id, hash);
        await r2Put(key, bytes, 'image/webp');
        await d1Update('UPDATE wallpapers SET poster_key = ? WHERE id = ?', [key, row.id]);
        report.posters.generated += 1;
        console.log(`${tag} poster ${key} (${Math.round(bytes.byteLength / 1024)}KB)`);
      } catch (error) {
        report.posters.failed += 1;
        report.errors.push({ id: row.id, slug: row.slug, stage: 'poster', message: String(error.message).slice(0, 200) });
        console.warn(`${tag} 海报失败：${String(error.message).slice(0, 160)}`);
      } finally {
        try { unlinkSync(tmp); } catch { /* 临时文件可能没生成 */ }
      }
    } else if (row.poster_key) {
      report.posters.skipped += 1;
    }
  } else if (isImage) {
    if (row.width && row.height) continue;
    try {
      const head = await fetchHead(url);
      const meta = readMediaMeta(head);
      if (meta.width && meta.height) {
        bump('width', row.width, meta.width);
        bump('height', row.height, meta.height);
        await d1Update(
          'UPDATE wallpapers SET width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?',
          [meta.width, meta.height, row.id],
        );
        console.log(`${tag} image ${meta.width}x${meta.height}`);
      } else {
        throw new Error('文件头里读不出宽高');
      }
    } catch (error) {
      report.errors.push({ id: row.id, slug: row.slug, stage: 'image-meta', message: String(error.message).slice(0, 200) });
      console.warn(`${tag} 图片宽高失败：${String(error.message).slice(0, 160)}`);
    }
  }

  // 变体：补 width/height/fps（同一份 JSON 只写一次）
  const variants = safeJson(row.variants, []);
  if (Array.isArray(variants) && variants.length) {
    let changed = false;
    for (const variant of variants) {
      if (!variant || !variant.key) continue;
      report.variants.objects += 1;
      if (variant.width && variant.height && variant.fps) continue;
      try {
        const info = await probe(mediaUrl(variant.key));
        if (!variant.width && info.width) { variant.width = info.width; changed = true; }
        if (!variant.height && info.height) { variant.height = info.height; changed = true; }
        if (!variant.fps && info.fps) { variant.fps = info.fps; changed = true; }
      } catch (error) {
        report.variants.failed += 1;
        report.errors.push({ id: row.id, slug: row.slug, stage: 'variant', key: variant.key, message: String(error.message).slice(0, 160) });
      }
    }
    if (changed) {
      report.variants.rows += 1;
      report.variants.updated += 1;
      await d1Update('UPDATE wallpapers SET variants = ? WHERE id = ?', [JSON.stringify(variants), row.id]);
      console.log(`${tag} variants updated (${variants.length})`);
    }
  }
}

report.finishedAt = new Date().toISOString();
mkdirSync(resolve(ROOT, 'build'), { recursive: true });
writeFileSync(resolve(ROOT, 'build', 'backfill-report.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('\n[backfill] 完成');
console.log(`  行数：${report.totals.rows}（视频 ${report.totals.videos} / 图片 ${report.totals.images} / 资源包 ${report.totals.bundles}）`);
console.log(`  探测：成功 ${report.probed.videos}，失败 ${report.probed.failed}`);
console.log(`  补字段：fps ${report.filled.fps}，codec ${report.filled.codec}，pix_fmt ${report.filled.pixFmt}，has_audio ${report.filled.hasAudio}，width ${report.filled.width}，height ${report.filled.height}`);
console.log(`  海报：生成 ${report.posters.generated}，跳过 ${report.posters.skipped}，失败 ${report.posters.failed}`);
console.log(`  变体：更新 ${report.variants.rows} 行 / ${report.variants.objects} 个对象（失败 ${report.variants.failed}）`);
console.log(`  报告：build/backfill-report.json${args.dryRun ? '（dry-run，未写库/未上传）' : ''}`);
