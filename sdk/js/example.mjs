/**
 * 最小示例：列出 1080p 可播素材 → 拿详情 → 下原文件（校验 sha256）→ 对比 manifest。
 *
 *   node sdk/js/example.mjs            # 线上站点
 *   FOLIA_BASE=http://127.0.0.1:8788 node sdk/js/example.mjs
 *   FOLIA_KEY=flk_xxx node sdk/js/example.mjs   # 带 key，配额更高
 */
import { FoliaClient } from './folia-client.mjs';
import { mkdir } from 'node:fs/promises';

const client = new FoliaClient({
  baseUrl: process.env.FOLIA_BASE || 'https://folia-5ve.pages.dev',
  apiKey: process.env.FOLIA_KEY || '',
});

const page = await client.list({ category: 'wallpaper', kind: 'dynamic', playable: '1080p30', limit: 3 });
console.log(`列表：total=${page.total}，本页 ${page.items.length} 条`);
for (const item of page.items) {
  console.log(`- ${item.id} ${item.title} ${item.width}x${item.height}@${item.fps ?? '?'}fps ${item.codec ?? ''}`);
}

const first = page.items[0];
if (first) {
  const detail = await client.get(first.slug);
  console.log(`详情：${detail.slug}，variants=${detail.variants.map((v) => v.label).join('/') || '无'}`);

  await mkdir('downloads', { recursive: true });
  const saved = await client.download(detail.url, `downloads/${detail.slug}.mp4`, {
    verifySha: detail.sha256 ?? false,
    onProgress: (received, total) => {
      if (total) process.stdout.write(`\r下载 ${Math.round((received / total) * 100)}%`);
    },
  });
  console.log(`\n下载完成：${saved.bytes} 字节，sha256=${saved.sha256.slice(0, 12)}…`);
}

const manifest = await client.manifest();
console.log(`manifest：apiVersion=${manifest.apiVersion} total=${manifest.total} generatedAt=${manifest.generatedAt}`);

// 第二次带上 etag：没变化时返回 null（304）
const changed = await client.manifest({ etag: `"${manifest.etag}"` });
console.log(changed === null ? 'manifest 未变化（304）' : 'manifest 有更新');
