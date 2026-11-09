/**
 * routes/admin-status.js — 管理端只读状态（目前只有"公开快照最近一次重建"）。
 *
 * 为什么需要它：`rebuildSnapshotQuietly` 失败不抛（上传不能因为快照挂了而失败），
 * 于是"数据已发布、前台永远旧"可以静默存在。这里把最近一次重建的
 * 时间/结果/原因/版本/条数暴露出来，运维不用翻日志就能判断。
 */
import { json } from '../http.js';
import { lastSnapshotRebuild, readCurrent } from '../snapshot.js';

/** GET /api/admin/snapshot-status */
export async function snapshotStatus({ env }) {
  const current = await readCurrent(env).catch(() => null);
  // 注意：`json()` 自己会包成 `{ok:true,data}`，这里不要再套一层 data
  return json({
    lastRebuild: lastSnapshotRebuild(),
    current: current
      ? { version: current.version || '', generatedAt: Number(current.generatedAt) || 0 }
      : null,
    auto: env.SNAPSHOT_AUTO !== '0',
  });
}
