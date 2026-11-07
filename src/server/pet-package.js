/**
 * 桌宠包（pet package）识别与校验 —— **站点侧唯一实现**。
 *
 * 契约来源：插件仓库 `docs/PET-CHAT-PLAN.md` §1.1 / `docs/PET-CHAT-EXEC.md` 任务 B。
 *
 * 包结构（zip）：
 *   pet.json                  必须有，且按下面的规则合法
 *   <sprite2d.spritesheetPath> 必须有，且是图片
 *   previews/（至少 1 张 gif/webp/png/jpg）→ 列表封面
 *
 * pet.json 必须满足：
 *   petManifestVersion === 2
 *   renderer === 'sprite2d'
 *   sprite2d.spritesheetPath 存在且指向包内的一张图
 *   sprite2d.frames 是非空数组（长度 = 行数）
 *   sprite2d.tracks 至少含 idle
 *
 * 设计约束（照工单）：
 *   · **不改数据库结构**：识别出来的元数据要塞回现有 JSON 列（调用方负责）；
 *   · 校验失败要能说清原因（422 的 message 就是这里返回的 reason）；
 *   · 没有 pet.json 的 zip **不算错**：它是普通资源包，走原来的 zip 通道。
 */
import { readMediaMeta } from '../core/image-meta.js';

/** 桌宠包的 mime（与普通 zip 资源包相同，靠包内 pet.json 区分）。 */
export const PET_MIME = 'application/zip';

/** pet.json 里允许的图片后缀（雪碧图 / 预览图都用同一套）。 */
export const PET_IMAGE_EXTS = Object.freeze(['png', 'webp', 'gif', 'jpg', 'jpeg', 'avif']);

/** 预览图所在目录。 */
export const PET_PREVIEW_DIR = 'previews/';

// ------------------------------------------------------------------ zip 解析

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

/**
 * 读 zip 的中央目录。**只读目录、不解压**——桌宠包 2MB 上下，
 * 但没必要把雪碧图整张解出来（只校验它在不在、是不是图片）。
 *
 * @param {Uint8Array} bytes
 * @returns {{name: string, method: number, compressedSize: number, size: number, dataStart: number}[]}
 */
export function listZipEntries(bytes) {
  if (!bytes || bytes.byteLength < 22) throw new Error('不是合法的 zip（文件太短）');
  // EOCD 在文件尾部，注释最长 65535，所以最多往回找 22 + 65535
  let eocd = -1;
  const min = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= min; i -= 1) {
    if (u32(bytes, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 zip（找不到目录结尾）');

  const count = u16(bytes, eocd + 10);
  let cursor = u32(bytes, eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== CEN_SIG) throw new Error('zip 目录结构损坏');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const size = u32(bytes, cursor + 24);
    const nameLen = u16(bytes, cursor + 28);
    const extraLen = u16(bytes, cursor + 30);
    const commentLen = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const rawName = new TextDecoder('utf-8').decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    // zip 规范里分隔符是 `\` 的历史实现也要按 `/` 认（工单特意提了这条）
    const name = rawName.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!name.endsWith('/')) {
      if (u32(bytes, localOffset) !== LOC_SIG) throw new Error(`zip 条目损坏：${name}`);
      const locNameLen = u16(bytes, localOffset + 26);
      const locExtraLen = u16(bytes, localOffset + 28);
      entries.push({
        name,
        method,
        compressedSize,
        size,
        dataStart: localOffset + 30 + locNameLen + locExtraLen,
      });
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解开单个条目（store / deflate 两种，够桌宠包用）。 */
export async function readZipEntry(bytes, entry) {
  const raw = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`不支持的 zip 压缩方式（method=${entry.method}）`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ------------------------------------------------------------------ 校验

const extOf = (name) => String(name).split('.').pop()?.toLowerCase() ?? '';
const isImageName = (name) => PET_IMAGE_EXTS.includes(extOf(name));

/** 统一的失败返回：`reason` 会原样进 422 的 message。 */
function invalid(reason, details = null) {
  return { isPet: true, ok: false, reason, details };
}

/**
 * 识别并校验一个 zip。
 *
 * 返回值三种：
 *   `{ isPet: false }`                      —— 包内没有 pet.json，普通资源包
 *   `{ isPet: true, ok: false, reason }`    —— 是桌宠包但不合法（调用方转 422）
 *   `{ isPet: true, ok: true, pet, preview }` —— 合法，`preview` 是解出来的封面图
 *
 * @param {Uint8Array} bytes zip 全文
 */
export async function parsePetPackage(bytes) {
  let entries;
  try {
    entries = listZipEntries(bytes);
  } catch (error) {
    // 连结构都读不出来：交给原来的 zip 通道（它不是桌宠包，也不是我们要报的错误）
    return { isPet: false, zipError: error?.message ?? String(error) };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = entries.find((entry) => entry.name.toLowerCase() === 'pet.json');
  if (!manifestEntry) return { isPet: false };

  let manifest;
  try {
    const text = new TextDecoder('utf-8').decode(await readZipEntry(bytes, manifestEntry));
    manifest = JSON.parse(text);
  } catch (error) {
    return invalid(`pet.json 不是合法 JSON：${error?.message ?? error}`);
  }
  if (!manifest || typeof manifest !== 'object') return invalid('pet.json 必须是一个 JSON 对象');

  if (Number(manifest.petManifestVersion) !== 2) {
    return invalid(`petManifestVersion 必须为 2（当前 ${JSON.stringify(manifest.petManifestVersion)}）`);
  }
  if (manifest.renderer !== 'sprite2d') {
    return invalid(`renderer 必须为 sprite2d（当前 ${JSON.stringify(manifest.renderer)}）`);
  }

  const sprite = manifest.sprite2d;
  if (!sprite || typeof sprite !== 'object') return invalid('缺少 sprite2d 配置');

  const sheetPath = typeof sprite.spritesheetPath === 'string' ? sprite.spritesheetPath.replace(/\\/g, '/').replace(/^\.\//, '') : '';
  if (!sheetPath) return invalid('sprite2d.spritesheetPath 缺失');
  if (!isImageName(sheetPath)) return invalid(`spritesheetPath 必须是图片（${PET_IMAGE_EXTS.join('/')}）：${sheetPath}`);
  const sheetEntry = byName.get(sheetPath);
  if (!sheetEntry) return invalid(`包内找不到雪碧图：${sheetPath}`);

  const frames = sprite.frames;
  if (!Array.isArray(frames) || frames.length === 0) return invalid('sprite2d.frames 必须是非空数组');

  const tracks = sprite.tracks;
  const trackNames = tracks && typeof tracks === 'object' ? Object.keys(tracks) : [];
  if (!trackNames.includes('idle')) {
    return invalid(`sprite2d.tracks 至少要有 idle（当前 ${trackNames.length ? trackNames.join('/') : '空'}）`);
  }

  const previewEntries = entries.filter((entry) => entry.name.startsWith(PET_PREVIEW_DIR) && isImageName(entry.name));
  if (!previewEntries.length) {
    return invalid('previews/ 里至少要有 1 张图片（gif/webp/png）');
  }
  // 封面取文件名排序第一张（稳定，不依赖 zip 内的物理顺序）
  previewEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const previewEntry = previewEntries[0];
  const previewBytes = await readZipEntry(bytes, previewEntry);
  const meta = readMediaMeta(previewBytes);
  if (!meta?.mime || !meta.mime.startsWith('image/')) {
    return invalid(`previews/ 里的封面不是可识别的图片：${previewEntry.name}`);
  }

  const columns = Number(sprite.columns);
  return {
    isPet: true,
    ok: true,
    pet: {
      id: String(manifest.id ?? '').trim() || null,
      displayName: String(manifest.displayName ?? '').trim() || null,
      frames: frames.map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      columns: Number.isFinite(columns) && columns > 0 ? columns : 8,
      tracks: trackNames,
      spritesheetPath: sheetPath,
    },
    preview: { name: previewEntry.name, mime: meta.mime, width: meta.width ?? null, height: meta.height ?? null, bytes: previewBytes },
    previewCount: previewEntries.length,
  };
}

/**
 * 把识别结果压成「存进现有 JSON 列」的形状（db 里放 `variants` 列，见 ingest.js）。
 *
 * 为什么不放 `description`/`source`：那些是给人看的文本，塞 JSON 会被前台直接渲染出来；
 * `variants` 本来就是「这条素材的附属描述」的 JSON 数组，DTO 只挑 `key+bytes` 的变体项，
 * 我们这个标记天然被忽略，所以**公开的 variants 字段一个字节都不会变**。
 */
export const PET_MARKER = 'pet';

export function petMarker(pet, previewKey) {
  return {
    kind: PET_MARKER,
    pet: {
      id: pet.id,
      displayName: pet.displayName,
      frames: pet.frames,
      columns: pet.columns,
      tracks: pet.tracks,
      spritesheetPath: pet.spritesheetPath,
      previewKey: previewKey ?? null,
    },
  };
}

/** 从一条 `variants` 列的原始值里取出桌宠标记（没有就返回 null）。 */
export function petFromVariants(raw, parseJson) {
  const list = Array.isArray(raw) ? raw : (parseJson ? parseJson(raw, []) : []);
  if (!Array.isArray(list)) return null;
  const marker = list.find((item) => item && item.kind === PET_MARKER && item.pet);
  return marker ? marker.pet : null;
}
