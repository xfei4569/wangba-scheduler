import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema';
import { seedIfEmpty } from './seed';

const globalForDb = globalThis as unknown as { __wangbaDb?: Database.Database };

/** 项目根目录（Windows 便携运行时就是解压目录） */
export const PROJECT_ROOT = process.env.SCHEDULER_ROOT
  ? path.resolve(process.env.SCHEDULER_ROOT)
  : process.cwd();

export const DATA_DIR = process.env.SCHEDULER_DATA_DIR
  ? path.resolve(process.env.SCHEDULER_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');

export const DB_PATH = process.env.SCHEDULER_DB
  ? path.resolve(process.env.SCHEDULER_DB)
  : path.join(DATA_DIR, 'scheduler.db');

/** 全局唯一的数据库连接（dev 热更新时复用，避免句柄泄漏） */
export function getDb(): Database.Database {
  if (globalForDb.__wangbaDb) return globalForDb.__wangbaDb;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  migrate(db);
  seedIfEmpty(db);
  globalForDb.__wangbaDb = db;
  return db;
}

/** 关掉当前连接。还原备份前必须先调用，否则会继续用内存里的旧库。 */
export function resetDb(): void {
  if (globalForDb.__wangbaDb) {
    globalForDb.__wangbaDb.close();
    globalForDb.__wangbaDb = undefined;
  }
}

/**
 * 增量迁移：老库（P0/P1/P2 建的）自动补齐后加的字段。
 * SQLite 的 ALTER TABLE ADD COLUMN 只能加列、不能改约束，因此这里只做「有则跳过」的加列。
 */
function migrate(db: Database.Database): void {
  const columnsOf = (table: string) =>
    new Set((db.prepare('PRAGMA table_info(' + table + ')').all() as { name: string }[]).map((c) => c.name));
  const ensure = (table: string, column: string, ddl: string, existing: Set<string>) => {
    if (!existing.has(column)) {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
      console.log('[排班台] 数据库迁移：' + table + ' 新增字段 ' + column);
    }
  };
  const employees = columnsOf('employees');
  if (employees.size) {
    ensure('employees', 'gender', "gender TEXT NOT NULL DEFAULT ''", employees);
    ensure('employees', 'seniority', "seniority TEXT NOT NULL DEFAULT '老人'", employees);
    ensure('employees', 'can_teach', 'can_teach INTEGER NOT NULL DEFAULT 1', employees);
    ensure('employees', 'position', "position TEXT NOT NULL DEFAULT '员工'", employees);
  }
  // 数据修正：排班窗口恒为 [week_start, week_start+6]。早期版本在「店长本周不休息」先建行时
  // 把 week_end 写成了 week_start，会让月度汇总把整周 6 天当成「待排」、锁定前体检把本周条目当历史。
  const fixed = db.prepare("UPDATE schedules SET week_end = date(week_start, '+6 day') WHERE week_end <> date(week_start, '+6 day')").run();
  if (fixed.changes) console.log('[排班台] 数据修正：修正 ' + fixed.changes + ' 条排班窗口的结束日期');
}

export function dbFileSize(): number {
  try {
    return fs.statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

export function tableCount(table: string): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) AS c FROM ' + table).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
