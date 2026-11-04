/**
 * 诊断：用仓库里的 readMediaMeta / readDurationMs 直接喂真实线上文件的前 2MB，
 * 验证「写库时元数据为空」到底是解析器读不出来，还是那批行根本没走上传接口。
 *
 *   node diag-media-meta.mjs <本地文件> [...]
 */
import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { readMediaMeta, readDurationMs, readVideoInfo } from '../src/core/image-meta.js';

const SCAN = 2 * 1024 * 1024;

function head2mb(path) {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(SCAN);
  const n = readSync(fd, buf, 0, SCAN, 0);
  closeSync(fd);
  return new Uint8Array(buf.subarray(0, n));
}

for (const path of process.argv.slice(2)) {
  const full = new Uint8Array(readFileSync(path));
  const head = head2mb(path);
  const mHead = readMediaMeta(head);
  const mFull = readMediaMeta(full);
  const idx = full.length >= 4 ? full.slice(0, 64).toString('latin1') : '';
  console.log(JSON.stringify({
    file: path.split(/[\\/]/).pop(),
    totalBytes: full.length,
    headBytes: head.length,
    前2MB: { mime: mHead.mime, width: mHead.width, height: mHead.height },
    全文件: { mime: mFull.mime, width: mFull.width, height: mFull.height },
    durationMs: readDurationMs(full, mFull.mime),
    video: readVideoInfo(full, mFull.mime),
    moovInHead2mb: Buffer.from(head).includes(Buffer.from('moov')),
    tkhdInHead2mb: Buffer.from(head).includes(Buffer.from('tkhd')),
    head64: idx.replace(/[^\x20-\x7e]/g, '.'),
  }, null, 1));
}
