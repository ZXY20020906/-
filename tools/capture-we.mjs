/**
 * 把 Wallpaper Engine 的 scene 作品渲染成「4K 静帧 + 短视频」，然后上传。
 *
 *   node tools/capture-we.mjs --ids 2814641807,2821781071 --stills --videos
 *
 * 原理：WE 有命令行控制接口，能让它播放指定 project.json；
 * 再用 ffmpeg 抓桌面。**抓的是整块屏幕，所以录制期间不要开别的窗口。**
 *
 * 已知限制（写死在脚本里，不藏着）：
 * - 分辨率上限 = 屏幕分辨率，本机是 2048×1152，出不了真 4K；
 * - 播放会临时替换当前桌面壁纸；
 * - 必须有可交互的桌面会话（锁屏不行）。
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WE_EXE = 'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';
const FFMPEG = resolve('..', '.tools', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe');
const WE_ROOT = 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const OUT = resolve('.cache', 'captures');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ids = String(option('ids', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wantStills = args.includes('--stills');
const wantVideos = args.includes('--videos');
const videoSeconds = Number(option('seconds', '15'));

if (!ids.length) {
  console.error('用法：node tools/capture-we.mjs --ids 2814641807,... [--stills] [--videos] [--seconds 15]');
  process.exit(2);
}
if (!existsSync(WE_EXE)) {
  console.error(`找不到 Wallpaper Engine：${WE_EXE}`);
  process.exit(2);
}

await mkdir(OUT, { recursive: true });

const run = (cmd, argv) => new Promise((res, rej) => {
  execFile(cmd, argv, { windowsHide: true }, (err) => (err ? rej(err) : res()));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const id of ids) {
  const dir = join(WE_ROOT, id);
  const projectJson = join(dir, 'project.json');
  if (!existsSync(projectJson)) {
    console.log(`跳过 ${id}：没有 project.json`);
    continue;
  }

  let title = id;
  try { title = JSON.parse(await readFile(projectJson, 'utf8')).title || id; } catch { /* 忽略 */ }

  console.log(`\n▶ ${id}  ${title.slice(0, 40)}`);

  // 1) 让 WE 播放这件作品
  await run(WE_EXE, ['-control', 'openWallpaper', '-file', projectJson]);
  await wait(6000);   // 等场景加载完成

  // 2) 静帧：单帧抓取
  if (wantStills) {
    const stillPath = join(OUT, `${id}.png`);
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-i', 'desktop',
      '-frames:v', '1', stillPath]);
    const info = await stat(stillPath);
    console.log(`  静帧 ${(info.size / 1024).toFixed(0)}KB → ${stillPath}`);
  }

  // 3) 视频：录一段（scene 是循环动画，15 秒够看）
  if (wantVideos) {
    const videoPath = join(OUT, `${id}.mp4`);
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'gdigrab', '-framerate', '60',
      '-i', 'desktop', '-t', String(videoSeconds),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', videoPath]);
    const info = await stat(videoPath);
    console.log(`  视频 ${(info.size / 1048576).toFixed(1)}MB → ${videoPath}`);
  }

  // 4) 关掉，避免下一件叠加
  await run(WE_EXE, ['-control', 'closeWallpaper']);
  await wait(1500);
}

console.log(`\n产物在 ${OUT}。下一步：用 tools/upload-captures.mjs 上传。`);
