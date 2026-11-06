import { createEnv, wallpaperRow, USERS } from './tests/harness.js';
import { Q } from './src/server/queries.js';
import { ingestVariantAsset } from './src/server/ingest.js';
import { makeMp4 } from './tests/mp4-fixture.js';

const actor = { ...USERS.admin, id: 'usr_admin' };
const row = wallpaperRow({ id: 'wp_v1', kind: 'dynamic', fps: 60, width: 3840, height: 2160, codec: 'h264', variants: null });

const stored = new Map();
const bucket = {
  async put(key, bytes) { stored.set(key, bytes); },
  async head(key) { const bytes = stored.get(key); return bytes ? { size: bytes.byteLength, httpEtag: '"x"' } : null; },
  async delete(key) { stored.delete(key); },
  async get() { return null; },
};

const { env } = createEnv({
  [Q.updateWallpaperVariants]: () => [],
  [Q.insertAudit]: () => [],
}, { bucket });

try {
  const out = await ingestVariantAsset(env, actor, row, { bytes: makeMp4({ width: 1920, height: 1080, fps: 30 }), label: '1080p', fps: 30 });
  console.log('OK', out.key, JSON.stringify(out.variants));
} catch (error) {
  console.log('FAILED:', error.name, error.code, error.message);
  console.log(error.stack?.split('\n').slice(0, 5).join('\n'));
}
