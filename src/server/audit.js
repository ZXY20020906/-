/**
 * 审计日志：每次写操作都留痕（谁、什么时候、对什么、改了什么）。
 * 写日志失败绝不能影响主流程，所以这里吞掉异常但打 error 日志。
 */
import { Q } from './queries.js';
import { run } from './db.js';
import { nowMs } from './db.js';

export const AUDIT_ACTION = Object.freeze({
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password_changed',
  SETUP: 'auth.setup',
  WALLPAPER_CREATE: 'wallpaper.create',
  WALLPAPER_UPDATE: 'wallpaper.update',
  WALLPAPER_ASSET: 'wallpaper.asset_upload',
  /**
   * 上传出现「播放合规警告」（体积超限 / WebM 容器 / 帧率探测不到）时单独记一条。
   * 这类文件照常入库，只是想查「哪些条目不在目标规格里」时能直接按 action 过滤，
   * 不用去 detail 里猜。规则见 src/server/media-compliance.js。
   */
  WALLPAPER_COMPLIANCE_WARN: 'wallpaper.asset_compliance_warn',
  WALLPAPER_DELETE: 'wallpaper.delete',
  WALLPAPER_REORDER: 'wallpaper.reorder',
  CATEGORY_CREATE: 'category.create',
  CATEGORY_UPDATE: 'category.update',
  CATEGORY_DELETE: 'category.delete',
  CATEGORY_REORDER: 'category.reorder',
  TAG_CREATE: 'tag.create',
  TAG_UPDATE: 'tag.update',
  TAG_DELETE: 'tag.delete',
  TAG_REORDER: 'tag.reorder',
  MEMBER_CREATE: 'member.create',
  MEMBER_UPDATE: 'member.update',
  MEMBER_DELETE: 'member.delete',
});

export async function writeAudit(env, { actor, action, targetType, targetId = '', detail = '' }) {
  try {
    await run(
      env,
      Q.insertAudit,
      nowMs(),
      actor?.id ?? '',
      actor?.email ?? '',
      actor?.role ?? '',
      action,
      targetType,
      String(targetId ?? ''),
      String(detail ?? '').slice(0, 500),
    );
  } catch (error) {
    console.error('[audit] write failed', action, error?.message ?? error);
  }
}
