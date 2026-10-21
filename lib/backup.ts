import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, PROJECT_ROOT, getDb, resetDb } from './db';
import { getSettingNumber } from './settings';
import { SK } from './settings-defaults';
import { todayStr } from './date';

export const BACKUP_DIR = process.env.SCHEDULER_BACKUP_DIR
  ? path.resolve(process.env.SCHEDULER_BACKUP_DIR)
  : process.env.SCHEDULER_DB || process.env.SCHEDULER_DATA_DIR
    ? path.join(path.dirname(DB_PATH), 'backup')
    : path.join(PROJECT_ROOT, 'backup');

export type BackupKind = 'daily' | 'manual' | 'before-update';

export interface BackupItem {
  name: string;
  path: string;
  size: number;
  mtime: string;
  kind: BackupKind;
}

export function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export function backupKeepCount(): number {
  const n = getSettingNumber(SK.backupKeep, 30);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 365) : 30;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/** 复制一份数据库到 backup/，返回备份信息 */
export function createBackup(kind: 'daily' | 'manual' = 'manual'): BackupItem {
  ensureBackupDir();
  const name = kind === 'daily'
    ? 'scheduler-' + todayStr() + '.db'
    : 'scheduler-' + todayStr() + '-' + stamp() + '-manual.db';
  let dest = path.join(BACKUP_DIR, name);
  if (kind === 'manual' && fs.existsSync(dest)) {
    const dot = dest.lastIndexOf('.');
    let n = 2;
    while (fs.existsSync(dest.slice(0, dot) + '-' + n + dest.slice(dot))) n += 1;
    dest = dest.slice(0, dot) + '-' + n + dest.slice(dot);
  }

  if (kind === 'daily' && fs.existsSync(dest)) {
    return statItem(dest, kind);
  }

  if (!fs.existsSync(DB_PATH)) {
    throw new Error('数据库文件还不存在，暂时无法备份：' + DB_PATH);
  }

  // 先做一次 WAL 检查点，保证主库文件内容完整
  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* 忽略：只是让备份更干净，失败也能复制 */
  }
  fs.copyFileSync(DB_PATH, dest);
  return statItem(dest, kind);
}

function statItem(file: string, kind: BackupKind): BackupItem {
  const st = fs.statSync(file);
  return {
    name: path.basename(file),
    path: file,
    size: st.size,
    mtime: st.mtime.toISOString(),
    kind,
  };
}

/** 更新前备份（update.ps1 生成：scheduler-日期-时间-before-update.db） */
export function kindOfBackupName(name: string): BackupKind {
  if (name.includes('-before-update')) return 'before-update';
  return name.includes('-manual') ? 'manual' : 'daily';
}

export function listBackups(): BackupItem[] {
  ensureBackupDir();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('scheduler-') && f.endsWith('.db'))
    .map((f) => statItem(path.join(BACKUP_DIR, f), kindOfBackupName(f)))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/**
 * 只保留最近 keep 份，返回被删除的文件名。
 * 「更新前备份」不参与轮换：它是更新失败后唯一的回退点，份数本来就少，绝不能被自动清理掉。
 */
export function pruneBackups(keep: number): string[] {
  const all = listBackups();
  const removed: string[] = [];
  for (const item of all.filter((row) => row.kind !== 'before-update').slice(Math.max(keep, 1))) {
    try {
      fs.unlinkSync(item.path);
      removed.push(item.name);
    } catch {
      /* 忽略单个删除失败 */
    }
  }
  return removed;
}

/** 每日首次启动自动备份；返回本次是否真的产生了备份 */
export function runDailyBackupIfNeeded(): { created: boolean; name?: string; reason?: string } {
  try {
    const enabled = getSettingNumber(SK.dailyBackup, 1) === 1;
    if (!enabled) return { created: false, reason: '每日自动备份已在设置中关闭' };
    const name = 'scheduler-' + todayStr() + '.db';
    const dest = path.join(BACKUP_DIR, name);
    if (fs.existsSync(dest)) return { created: false, reason: '今日备份已存在：' + name };
    const item = createBackup('daily');
    pruneBackups(backupKeepCount());
    return { created: true, name: item.name };
  } catch (err) {
    return { created: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// 每日 / 手动 / 更新前（update.ps1 生成的 before-update）三种命名都要能还原，
// 否则更新出问题时唯一的回退点在界面上点不动。
// 注意 update.ps1 用的是 yyyyMMdd-HHmmss（没有短横线），和手动备份的 YYYY-MM-DD 不一样。
const BACKUP_NAME = /^scheduler-(?:\d{4}-\d{2}-\d{2}|\d{8})(-\d{6}-(?:manual|before-update)(-\d+)?)?\.db$/;

/** 用一份已有备份换掉当前库。先自动再存一份「还原前」，换失败就改回去。 */
export function restoreBackup(name: string): { restored: string; safety: string } {
  if (!BACKUP_NAME.test(name)) throw new Error('备份文件名不正确');
  const source = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(source)) throw new Error('找不到这份备份');
  const check = new Database(source, { readonly: true, fileMustExist: true });
  const integrity = String(check.pragma('integrity_check', { simple: true }));
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'employees'").get();
  check.close();
  if (integrity !== 'ok' || !tables) throw new Error('这份备份不完整，没有还原');

  const safety = createBackup('manual');
  resetDb();
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const extra = DB_PATH + suffix;
      if (suffix && fs.existsSync(extra)) fs.unlinkSync(extra);
    }
    fs.copyFileSync(source, DB_PATH);
    getDb().prepare('SELECT COUNT(*) AS c FROM employees').get();
  } catch (err) {
    resetDb();
    fs.copyFileSync(safety.path, DB_PATH);
    getDb();
    throw err;
  }
  return { restored: name, safety: safety.name };
}
