#!/usr/bin/env node
/**
 * 上传前的本地准备工具：把源视频转成「站点能直接播」的规格，并顺手产出 1080p 变体与封面。
 *
 *   node tools/prepare-upload.mjs <输入文件或目录> --out <输出目录> [--fps 30] [--max-pixels 8294400]
 *
 * 为什么要有它：Cloudflare Workers / Pages Functions 里**没有 ffmpeg**，服务端只能拒绝
 * 不合规的视频（见 src/server/media-compliance.js 与 422 响应），转码必须在本机做。
 *
 * 行为：
 *   1. ffprobe（没有就用 `ffmpeg -i` 的 stderr）探测：宽高 / 帧率 / 编码 / 时长；
 *      faststart 由本工具按 box 头判断（ffprobe 不报这个）。
 *   2. 超规格 ⇒ 转码：装进 3840×2160 框内等比缩放、fps=30、libx264 -crf 20 -preset veryfast、
 *      yuv420p、`-movflags +faststart`、`-an`；
 *      合规（只需要修 faststart）⇒ `-c copy -movflags +faststart` 无损重封装。
 *   3. 生成 1080p 变体（装进 1920×1080 框、fps=30、-crf 23）。
 *      注意不是 `scale=-2:1080`：那个写法对 2000×1124 这类源会产出 1922 宽，
 *      违反「变体 ≤1920 宽」的规格（存量里已有这种对象，不回头改）。
 *   4. 生成 1280 宽 webp 封面（优先取第 1 秒，片子太短就退回首帧）。
 *   5. 写 `prepare-upload.manifest.json`：原始规格、处理后规格、产物的 sha256 与 bytes。
 *
 * 判合规用的是**和站点同一个函数**（src/server/media-compliance.js 的 checkVideoCompliance），
 * 所以本地说合规 = 服务端一定收，不会出现「工具放行、上传 422」。
 *
 * 产物 key 规则（见 docs/UPLOAD-SOP.md）：
 *   wallpapers/<wp_id>/<sha256 前 16 位>.mp4
 *   wallpapers/<wp_id>/<sha256 前 16 位>.1080p.mp4
 * 清单里每项都带 sha256，前 16 位就是 key 里那一段。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import {
  MEDIA_LIMITS, VIOLATION, VIOLATION_LABEL, checkVideoCompliance,
} from '../src/server/media-compliance.js';

const execFileP = promisify(execFile);

/** 允许当输入的容器：真要转码的都行，这里只挡明显不是视频的文件（比如图片/zip）。 */
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.mpg', '.mpeg', '.3gp']);

/** 需要重新编码才能修的违规码；只差 faststart 的走无损重封装。 */
const REENCODE_CODES = new Set([
  VIOLATION.TOO_WIDE,
  VIOLATION.TOO_TALL,
  VIOLATION.TOO_MANY_PIXELS,
  VIOLATION.FPS_TOO_HIGH,
  VIOLATION.CODEC_UNSUPPORTED,
  VIOLATION.PROBE_FAILED,
]);

const USAGE = `用法：
  node tools/prepare-upload.mjs <输入文件或目录> --out <输出目录> [选项]

选项：
  --out <dir>         输出目录（必填，不存在会自动创建）
  --fps <n>           目标帧率，默认 30
  --max-pixels <n>    像素总量上限，默认 ${MEDIA_LIMITS.maxPixels}（=3840×2160）
  --ffmpeg <path>     指定 ffmpeg（也可用环境变量 FFMPEG_PATH）
  --ffprobe <path>    指定 ffprobe（缺省时退回解析 \`ffmpeg -i\` 的 stderr）
  --dry-run           只探测 + 打印体检结论，不转码、不写产物
  --help              打印这段说明

例：
  node tools/prepare-upload.mjs D:\\壁纸源\\demo.mov --out .\\prepared
  node tools/prepare-upload.mjs D:\\壁纸源 --out .\\prepared --fps 30
`;

function die(message) {
  console.error(message);
  process.exit(2);
}

/** 极简参数解析：只认 --key value 与 --flag，位置参数按顺序收集。 */
function parseArgs(argv) {
  const options = {
    input: null, out: null, fps: 30, maxPixels: MEDIA_LIMITS.maxPixels,
    ffmpeg: null, ffprobe: null, dryRun: false, help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--out' || arg === '--fps' || arg === '--max-pixels' || arg === '--ffmpeg' || arg === '--ffprobe') {
      const value = argv[i + 1];
      if (value === undefined) die(`参数 ${arg} 缺少取值\n\n${USAGE}`);
      i += 1;
      if (arg === '--out') options.out = value;
      else if (arg === '--fps') options.fps = Number(value);
      else if (arg === '--max-pixels') options.maxPixels = Number(value);
      else if (arg === '--ffmpeg') options.ffmpeg = value;
      else options.ffprobe = value;
    } else if (arg.startsWith('--')) {
      die(`不认识的参数 ${arg}\n\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) die(`只接受一个输入路径，收到 ${positional.length} 个\n\n${USAGE}`);
  [options.input] = positional;
  return options;
}

/** 找可执行文件：显式参数 → 环境变量 → PATH。找不到就抛，带上怎么装/怎么指定。 */
async function resolveTool(name, explicit) {
  const candidates = [explicit, process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'], name].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await execFileP(candidate, ['-version'], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      return candidate;
    } catch {
      // 换下一个候选
    }
  }
  if (name === 'ffprobe') return null; // ffprobe 可选：没有就走 ffmpeg -i 的 stderr
  throw new Error(
    `找不到 ffmpeg。请先安装并加进 PATH，或用 --ffmpeg <path> / 环境变量 FFMPEG_PATH 指定。`,
  );
}

/** sha256 + 字节数：流式读，几百 MB 的壁纸也不会把内存吃穿。 */
async function fileFingerprint(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  const info = await stat(path);
  return { sha256: hash.digest('hex'), bytes: info.size };
}

/**
 * faststart 判断：moov 是否在 mdat 之前。
 * 只看文件头 4MB —— `+faststart` 的产物 moov 一定在开头；先遇到 mdat 就说明没前置。
 */
async function readFaststart(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const window = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, 0);
    let offset = 0;
    for (let guard = 0; guard < 64 && offset + 8 <= buffer.length; guard += 1) {
      const size32 = buffer.readUInt32BE(offset);
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      let boxSize = size32;
      let header = 8;
      if (size32 === 1) {
        if (offset + 16 > buffer.length) return null;
        boxSize = Number(buffer.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size32 === 0) {
        boxSize = size - offset;
      }
      if (!Number.isFinite(boxSize) || boxSize < header) return null;
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      offset += boxSize;
      if (offset >= size) break;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** "30000/1001" → 29.97；"30" → 30。解析不出来返回 null。 */
function parseRate(text) {
  if (!text || typeof text !== 'string') return null;
  const [num, den] = text.split('/');
  const a = Number(num);
  const b = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0 || a <= 0) return null;
  const fps = a / b;
  return Number.isFinite(fps) && fps > 0 && fps <= 1000 ? Math.round(fps * 100) / 100 : null;
}

/** ffprobe 的 JSON 输出（首选：字段稳定）。 */
async function probeWithFfprobe(ffprobe, file) {
  const { stdout } = await execFileP(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
  );
  const data = JSON.parse(stdout);
  const stream = (data.streams ?? []).find((item) => item.codec_type === 'video');
  if (!stream) return { width: null, height: null, fps: null, codec: null, durationMs: null };
  const durationSec = Number(data.format?.duration ?? stream.duration ?? 0);
  return {
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
    fps: parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate),
    codec: stream.codec_name ?? null,
    durationMs: Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
  };
}

/**
 * 没有 ffprobe 时的退路：`ffmpeg -i <file>` 不带输出文件必然以 1 退出，
 * 把流信息全打在 stderr 上 —— 和 ffprobe 的信息量差不多，只是要自己抠。
 * 真实格式：
 *   Duration: 00:00:20.00, start: 0.000000, bitrate: 20310 kb/s
 *   Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 2000x1124 [SAR 1:1 DAR 16:9], 30 fps, ...
 */
async function probeWithFfmpeg(ffmpeg, file) {
  let stderr = '';
  try {
    const result = await execFileP(ffmpeg, ['-hide_banner', '-i', file], {
      maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
    });
    stderr = result.stderr ?? '';
  } catch (error) {
    stderr = String(error?.stderr ?? '');
  }
  const text = stderr;
  const videoLine = text.split(/\r?\n/).find((line) => line.includes('Stream #') && line.includes('Video:')) ?? '';
  const codec = /Video:\s*([A-Za-z0-9_]+)/.exec(videoLine)?.[1] ?? null;
  let width = null;
  let height = null;
  for (const match of videoLine.matchAll(/(\d{2,5})x(\d{2,5})/g)) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w >= 16 && h >= 16 && w <= 100_000 && h <= 100_000) {
      width = w;
      height = h;
      break;
    }
  }
  const fps = parseRate(/([\d.]+)\s*fps/.exec(videoLine)?.[1]);
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const durationMs = duration
    ? Math.round(((Number(duration[1]) * 3600) + (Number(duration[2]) * 60) + Number(duration[3])) * 1000)
    : null;
  return { width, height, fps, codec, durationMs };
}

/** 探测 + faststart（两条来源合并成一份「事实」）。 */
async function probe(ffmpeg, ffprobe, file) {
  const base = ffprobe
    ? await probeWithFfprobe(ffprobe, file).catch(() => probeWithFfmpeg(ffmpeg, file))
    : await probeWithFfmpeg(ffmpeg, file);
  const faststart = await readFaststart(file);
  return { ...base, faststart };
}

/** 把 3840×2160 这个「框」按 --max-pixels 缩小（最多缩到整数像素）。 */
function boxFor(limits, { maxWidth, maxHeight }) {
  const factor = limits.maxPixels >= maxWidth * maxHeight
    ? 1
    : Math.sqrt(limits.maxPixels / (maxWidth * maxHeight));
  const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(maxWidth * factor), height: even(maxHeight * factor) };
}

/**
 * 算目标宽高：装进框内、保持比例、只缩不放、宽高取偶。
 *
 * 为什么自己在 JS 里算，而不是交给 `scale=...:force_original_aspect_ratio=decrease`：
 * 那个选项为了保住 DAR 会去改 SAR（实测 5916×2530 缩放后 SAR 变成 2726:2723），
 * 播放器再按非方像素铺开就会出现细缝/拉伸。自己算完直接 `scale=W:H,setsar=1`，
 * 像素永远是方的，产物尺寸也完全可预期（清单里写什么就是什么）。
 */
function targetSize(srcWidth, srcHeight, box) {
  const width = Number(srcWidth);
  const height = Number(srcHeight);
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(box.width / width, box.height / height, 1);
  const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(Math.round(width * scale)), height: even(Math.round(height * scale)) };
}

/** 缩放 + 定帧率的滤镜链。尺寸算不出来（探测失败）时退回表达式写法，尽力而为。 */
function fitFilter(size, box, fps) {
  if (!size) {
    return [
      `scale=w='min(${box.width},iw)':h='min(${box.height},ih)':force_original_aspect_ratio=decrease`,
      'setsar=1',
      `fps=${fps}`,
    ].join(',');
  }
  return `scale=${size.width}:${size.height},setsar=1,fps=${fps}`;
}

async function runFfmpeg(ffmpeg, args) {
  try {
    await execFileP(ffmpeg, args, { maxBuffer: 32 * 1024 * 1024, timeout: 1000 * 60 * 60 });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().split(/\r?\n/).slice(-4).join(' | ');
    throw new Error(`ffmpeg 失败：${detail}`);
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function describe(probeInfo) {
  const dims = probeInfo.width && probeInfo.height ? `${probeInfo.width}×${probeInfo.height}` : '宽高未知';
  const fps = probeInfo.fps ? `${probeInfo.fps}fps` : '帧率未知';
  const codec = probeInfo.codec ?? '编码未知';
  const faststart = probeInfo.faststart === true ? 'faststart' : probeInfo.faststart === false ? '非 faststart' : 'faststart 未知';
  return `${dims} ${fps} ${codec} ${faststart}`;
}

/** 递归收集输入里的视频文件（目录形态才递归）。 */
async function collectInputs(input) {
  const info = await stat(input);
  if (info.isFile()) return [resolve(input)];
  const out = [];
  const skipped = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (VIDEO_EXTS.has(extname(entry.name).toLowerCase())) out.push(resolve(full));
      else skipped.push(full);
    }
  }
  await walk(resolve(input));
  out.sort();
  return { files: out, skipped };
}

/** 处理单个文件。返回清单条目；失败直接抛，由上层记 FAIL。 */
async function prepareOne(file, options, tools) {
  const limits = { ...MEDIA_LIMITS, maxPixels: options.maxPixels };
  const stem = basename(file, extname(file));

  const sourceProbe = await probe(tools.ffmpeg, tools.ffprobe, file);
  const sourceFingerprint = await fileFingerprint(file);
  const source = {
    file: basename(file), path: file,
    bytes: sourceFingerprint.bytes, sha256: sourceFingerprint.sha256,
    container: extname(file).toLowerCase().replace('.', '') || 'unknown',
    ...sourceProbe,
  };

  const verdict = checkVideoCompliance({
    mime: 'video/mp4', // 统一按目标封装判：源文件是 mkv/mov 也得满足 MP4 的规矩
    width: sourceProbe.width,
    height: sourceProbe.height,
    fps: sourceProbe.fps,
    codec: sourceProbe.codec,
    faststart: sourceProbe.faststart,
    bytes: sourceProbe.bytes,
  }, { limits });

  const needsReencode = verdict.violations.some((item) => REENCODE_CODES.has(item.code));
  const action = needsReencode ? 'transcode' : 'remux';

  const outDir = resolve(options.out);
  const originalPath = join(outDir, `${stem}.mp4`);
  const variantPath = join(outDir, `${stem}.1080p.mp4`);
  const thumbPath = join(outDir, `${stem}.thumb.webp`);

  const entry = {
    source,
    action,
    violations: verdict.violations,
    warnings: verdict.warnings,
    output: null,
    variant: null,
    thumb: null,
  };

  if (options.dryRun) {
    const planned = targetSize(sourceProbe.width, sourceProbe.height, boxFor(limits, MEDIA_LIMITS));
    entry.plan = {
      original: action === 'transcode'
        ? `转码 → ${planned ? `${planned.width}×${planned.height}` : '装进 3840×2160 框'} @${options.fps}fps`
        : '无损重封装（-c copy -movflags +faststart）',
      variant: sourceProbe.height && sourceProbe.height > 1080 ? '生成 1080p 变体' : '跳过（源不高于 1080p）',
      thumb: '取第 1 秒，缩放 1280 宽',
    };
    return entry;
  }

  await mkdir(outDir, { recursive: true });

  // ---------------------------------------------------------------- 原画
  if (action === 'transcode') {
    const box = boxFor(limits, MEDIA_LIMITS);
    await runFfmpeg(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-vf', fitFilter(targetSize(sourceProbe.width, sourceProbe.height, box), box, options.fps),
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      originalPath,
    ]);
  } else {
    await runFfmpeg(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file,
      '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', '-an',
      originalPath,
    ]);
  }
  entry.output = await describeArtifact(tools, originalPath, 'mp4');

  // 自检：产物必须真的合规，否则宁可报错也不交出一个「工具说 OK、服务端 422」的文件
  const check = checkVideoCompliance({
    mime: 'video/mp4',
    width: entry.output.width,
    height: entry.output.height,
    fps: entry.output.fps,
    codec: entry.output.codec,
    faststart: entry.output.faststart,
    bytes: entry.output.bytes,
  }, { limits });
  if (!check.ok) {
    throw new Error(`产物自检失败：${check.violations.map((item) => `${item.code}(${item.message})`).join('；')}`);
  }
  entry.output.warnings = check.warnings;

  // ---------------------------------------------------------- 1080p 变体
  // 源本来就不高于 1080p 时不做「变体」：等比放大只会更大更糊
  if (entry.output.height > 1080) {
    const variantBox = boxFor(limits, { maxWidth: MEDIA_LIMITS.variantMaxWidth, maxHeight: 1080 });
    await runFfmpeg(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', originalPath,
      '-vf', fitFilter(
        targetSize(entry.output.width, entry.output.height, variantBox),
        variantBox,
        options.fps,
      ),
      '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      variantPath,
    ]);
    entry.variant = await describeArtifact(tools, variantPath, 'mp4');
    const variantCheck = checkVideoCompliance({
      mime: 'video/mp4',
      width: entry.variant.width,
      height: entry.variant.height,
      fps: entry.variant.fps,
      codec: entry.variant.codec,
      faststart: entry.variant.faststart,
      bytes: entry.variant.bytes,
    }, { limits, role: 'variant' });
    if (!variantCheck.ok) {
      throw new Error(`变体自检失败：${variantCheck.violations.map((item) => `${item.code}(${item.message})`).join('；')}`);
    }
    entry.variant.warnings = variantCheck.warnings;
  } else {
    entry.variantSkipped = `源高度 ${entry.output.height}px ≤ 1080，不做等比放大的「变体」`;
  }

  // ---------------------------------------------------------------- 封面
  entry.thumb = await makeThumb(tools, originalPath, thumbPath);

  return entry;
}

/** 产物指纹 + 复核规格（宽高/fps/codec/faststart），清单里记的是复核后的值。 */
async function describeArtifact(tools, path, container) {
  const fingerprint = await fileFingerprint(path);
  const info = await probe(tools.ffmpeg, tools.ffprobe, path);
  return {
    file: basename(path), path, container,
    bytes: fingerprint.bytes, sha256: fingerprint.sha256,
    ...info,
  };
}

/** webp 封面：优先第 1 秒（比首帧有代表性），片子不到 1 秒就退回首帧。 */
async function makeThumb(tools, videoPath, thumbPath) {
  const filter = "scale=w='min(1280,iw)':h=-2";
  const run = (seek) => runFfmpeg(tools.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...(seek ? ['-ss', '1'] : []),
    '-i', videoPath,
    '-frames:v', '1', '-vf', filter,
    '-c:v', 'libwebp', '-quality', '82',
    thumbPath,
  ]);
  // ffmpeg 在「seek 到了片尾、一帧都没解出来」时仍然退出 0，只留下一个 8 字节的空壳，
  // 所以不能只看退出码，必须回看文件大小。
  const usable = async () => {
    try {
      return (await stat(thumbPath)).size > 256;
    } catch {
      return false;
    }
  };
  try {
    await run(true);
  } catch {
    // -ss 1 失败就当片子太短，走首帧
  }
  if (!(await usable())) await run(false);
  if (!(await usable())) throw new Error('封面生成失败：webp 是空的（源视频可能没有可解码的帧）');
  const fingerprint = await fileFingerprint(thumbPath);
  return { file: basename(thumbPath), path: thumbPath, bytes: fingerprint.bytes, sha256: fingerprint.sha256 };
}

// --------------------------------------------------------------------- 主流程

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!options.input) die(`缺少输入路径\n\n${USAGE}`);
if (!options.out) die(`缺少 --out\n\n${USAGE}`);
if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 120) die(`--fps 不合法：${options.fps}`);
if (!Number.isFinite(options.maxPixels) || options.maxPixels < 10000) die(`--max-pixels 不合法：${options.maxPixels}`);

const ffmpeg = await resolveTool('ffmpeg', options.ffmpeg).catch((error) => die(error.message));
const ffprobe = await resolveTool('ffprobe', options.ffprobe);
const tools = { ffmpeg, ffprobe };

if (!ffprobe) {
  console.warn('[提示] 没找到 ffprobe，改用 `ffmpeg -i` 的 stderr 解析（信息一致，精度略低）');
}

const collected = await collectInputs(options.input);
const inputs = Array.isArray(collected) ? collected : collected.files;
const skipped = Array.isArray(collected) ? [] : collected.skipped;

if (!inputs.length) {
  die(`没有可处理的视频文件：${options.input}\n（支持的扩展名：${[...VIDEO_EXTS].join(' ')}）`);
}
if (skipped.length) {
  console.warn(`[跳过] ${skipped.length} 个非视频文件：${skipped.slice(0, 3).map((p) => basename(p)).join(', ')}${skipped.length > 3 ? ' …' : ''}`);
}

console.log(`ffmpeg: ${ffmpeg}`);
console.log(`输入：${resolve(options.input)}（${inputs.length} 个视频）`);
console.log(`输出：${resolve(options.out)}`);
console.log(`目标：≤${MEDIA_LIMITS.maxWidth}×${MEDIA_LIMITS.maxHeight} / ≤${MEDIA_LIMITS.maxPixels} 像素 / ${options.fps}fps / H.264 + faststart${options.dryRun ? '（dry-run，不写产物）' : ''}`);

const entries = [];
const failures = [];

for (const [index, file] of inputs.entries()) {
  console.log(`\n[${index + 1}/${inputs.length}] ${basename(file)}`);
  try {
    const entry = await prepareOne(file, options, tools);
    entries.push(entry);

    console.log(`  源：${describe(entry.source)} ${mb(entry.source.bytes)}`);
    if (entry.violations.length) {
      console.log(`  不合规：${entry.violations.map((item) => `${item.code}(${VIOLATION_LABEL[item.code] ?? item.code})`).join(', ')}`);
    } else {
      console.log('  不合规：无');
    }
    if (entry.warnings.length) {
      console.log(`  警告：${entry.warnings.map((item) => item.code).join(', ')}`);
    }
    if (options.dryRun) {
      console.log(`  计划：${entry.plan.original}；变体：${entry.plan.variant}；封面：${entry.plan.thumb}`);
      continue;
    }
    console.log(`  处理：${entry.action === 'transcode' ? '转码' : '无损重封装'} → ${describe(entry.output)} ${mb(entry.output.bytes)}`);
    if (entry.output.warnings?.length) {
      console.log(`        产物警告：${entry.output.warnings.map((item) => `${item.code}(${item.message})`).join('；')}`);
    }
    if (entry.variant) {
      console.log(`  1080p：${describe(entry.variant)} ${mb(entry.variant.bytes)}  (${entry.variant.file})`);
    } else {
      console.log(`  1080p：跳过（${entry.variantSkipped}）`);
    }
    if (entry.thumb) {
      console.log(`  封面：${entry.thumb.file} ${mb(entry.thumb.bytes)}`);
    }
    console.log(`  key ：wallpapers/<wp_id>/${entry.output.sha256.slice(0, 16)}.mp4`);
  } catch (error) {
    failures.push({ file: basename(file), message: error?.message ?? String(error) });
    console.log(`  FAIL：${error?.message ?? error}`);
  }
}

if (options.dryRun) {
  const fixable = entries.filter((entry) => entry.violations.length).length;
  console.log(`\n体检完成：${entries.length} 个文件，其中 ${fixable} 个需要修；加 --out 去掉 --dry-run 即可产出合规文件`);
  process.exit(failures.length ? 1 : 0);
}

const manifestPath = join(resolve(options.out), 'prepare-upload.manifest.json');
await mkdir(resolve(options.out), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  tool: 'tools/prepare-upload.mjs',
  ffmpeg,
  limits: { ...MEDIA_LIMITS, maxPixels: options.maxPixels, fps: options.fps },
  violations: VIOLATION,
  items: entries,
  failures,
}, null, 2)}\n`, 'utf8');

console.log(`\n清单：${manifestPath}`);
if (failures.length) {
  console.log(`失败 ${failures.length} 个：${failures.map((item) => item.file).join(', ')}`);
}
console.log(`可以直接上传：${entries.length} 个文件；不合规项已修正`);
console.log('提示：落库前按 docs/UPLOAD-SOP.md 算 sha256、走 HEAD 回读校验；换内容一定换新 key。');

process.exit(failures.length ? 1 : 0);
