import { getDb } from './db';
import { runDailyBackupIfNeeded } from './backup';
import { todayStr } from './date';
import { healEmptyLocks } from './scheduler/heal';

let bootstrapped = false;
/** 上次做「每日备份检查」的日期：本进程可能连续运行很多天，必须跨天重查 */
let backupCheckedOn = '';

/**
 * 进程内只跑一次的启动初始化：
 * 1) 建库 / 建表 / 写预置数据
 * 2) 每天第一次运行自动备份数据库到 backup/
 *
 * 说明：没有用 Next.js 的 instrumentation 钩子，因为它在 Edge 运行时也会被打包，
 * 会把 better-sqlite3 / node:fs 这些 Node 专有依赖带进 Edge 构建而报错。
 * 改为在第一个 API 请求到达时初始化（Windows 启动脚本里还会额外跑一次 scripts/backup.mjs）。
 */
export function bootstrap(): void {
  try {
    if (!bootstrapped) {
      bootstrapped = true;
      getDb();
      // B7 存量自愈：「锁定但 0 人」的周 / 天没有任何要保护的安排，启动时先清掉，
      // 否则用户在旧数据上点「一键排整月」会被整周跳过、周排班页也改不了。
      const healed = healEmptyLocks();
      if (healed.removedWeeks || healed.removedEntries || healed.unlockedWeeks) {
        console.log('[排班台] 数据自愈：清理空周记录 ' + healed.removedWeeks + ' 条、无人员锁定条目 '
          + healed.removedEntries + ' 条，解锁空周 ' + healed.unlockedWeeks + ' 条');
      }
    }
    // 备份检查必须跨天重做：排班台在前台电脑上常年不重启，
    // 原来只在整个进程的第一次请求时查一次，服务连续开着就再也不备份了。
    const today = todayStr();
    if (backupCheckedOn === today) return;
    backupCheckedOn = today;
    const result = runDailyBackupIfNeeded();
    if (result.created) {
      console.log('[排班台] 已自动备份今日数据库：backup/' + result.name);
    } else {
      console.log('[排班台] 数据库就绪，今日备份检查：' + (result.reason || '已存在'));
    }
  } catch (err) {
    console.error('[排班台] 启动初始化失败：', err);
  }
}
