/**
 * 媒体元数据（storage_key / bytes / sha256）变更审计的应用层补写。
 *
 * schema/015 的触发器负责落事实：谁在什么时候改了哪几列、旧值、新值。
 * 但 SQLite 触发器拿不到调用方，changed_by 只能是 NULL。所以所有改这三列的
 * Web 写路径都必须走 setMediaIdentity()：
 *   1) UPDATE wallpapers（触发 AFTER UPDATE 审计）；
 *   2) 把最近一条未标注的审计行补上 actor。
 *
 * 已知边界：这是「更新后补标注」而不是同一事务，极端并发下（同一 wallpaper
 * 在同一秒被两个请求改身份）可能把 actor 标到另一条审计行；changed_at / 旧值
 * / 新值仍由触发器保证准确。要彻底消除只能让调用方在 UPDATE 里显式写审计行。
 *
 * 审计表不存在时（老库未执行 schema/015）只 warn 一次，绝不能反过来把上传卡死。
 */
import { Q } from './queries.js';
import { run } from './db.js';

/** changed_by 允许的写入方标识；新增取值请同步 docs/MEDIA-AUDIT.md。 */
export const MEDIA_ACTOR = Object.freeze({
  UPLOAD: 'admin-upload',
  REPLACE: 'admin-replace',
  SHA_RESYNC: 'tool:sha-resync',
  INTEGRITY: 'cron:integrity',
});

/** 时钟容差：D1 的 strftime('now') 与 Worker 的 Date.now() 都走 NTP，留 2 分钟足够。 */
const ANNOTATE_WINDOW_MS = 120_000;

let warnedMissingAudit = false;

/**
 * 写媒体身份 + 补审计 actor。这是更新这三列的唯一入口。
 *
 * @param {object} env Cloudflare env（需要 DB）
 * @param {string} id wallpaper id
 * @param {object} identity
 * @param {string|null} identity.storageKey
 * @param {number} identity.bytes
 * @param {string|null} identity.sha256
 * @param {string} identity.actor MEDIA_ACTOR 之一
 * @param {string|null} [identity.mime]
 * @param {number|null} [identity.width]
 * @param {number|null} [identity.height]
 * @param {number|null} [identity.durationMs]
 * @param {string} [identity.kind] 传了 mime/width/height/durationMs 时必须一起给
 * @param {number} [identity.updatedAt]
 */
export async function setMediaIdentity(env, id, identity) {
  const {
    storageKey = null,
    bytes = 0,
    sha256 = null,
    actor,
    mime = null,
    width = null,
    height = null,
    durationMs = null,
    kind,
    updatedAt = Date.now(),
  } = identity ?? {};

  if (!actor) throw new Error('setMediaIdentity 需要 actor（见 MEDIA_ACTOR）');

  // 两种调用形态：
  //   1) 上传/替换：带 mime/width/height/durationMs/kind，一条 UPDATE 写全；
  //   2) 工具重算 sha256/bytes：只给三列 + actor，不能把已有 mime/kind 清空。
  const hasAssetMeta = kind !== undefined
    || mime !== null || width !== null || height !== null || durationMs !== null;

  if (hasAssetMeta) {
    if (kind === undefined) {
      throw new Error('setMediaIdentity 带 mime/width/height/durationMs 时必须同时给 kind');
    }
    await run(
      env,
      Q.updateWallpaperAsset,
      storageKey, mime, bytes, width, height, durationMs, sha256, kind, updatedAt, id,
    );
  } else {
    await run(env, Q.updateMediaIdentity, storageKey, bytes, sha256, updatedAt, id);
  }

  await annotateMediaAudit(env, id, actor, updatedAt - ANNOTATE_WINDOW_MS);
}

/**
 * 把某条壁纸最近一条未标注的审计行补上 actor。
 * 供 setMediaIdentity() 内部调用，也供工具/人工在直接跑 SQL 后补标注。
 * 失败只 warn，不影响主流程（审计是旁路，不是写入前置条件）。
 */
export async function annotateMediaAudit(env, id, actor, since = Date.now() - ANNOTATE_WINDOW_MS) {
  try {
    await run(env, Q.mediaAuditAnnotate, actor, id, since);
  } catch (error) {
    if (!warnedMissingAudit) {
      warnedMissingAudit = true;
      console.warn(
        '[media-audit] 补写 changed_by 失败（schema/015 未执行？），审计行保持 NULL',
        error?.message ?? error,
      );
    }
  }
}
