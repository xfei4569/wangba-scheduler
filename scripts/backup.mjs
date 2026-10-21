#!/usr/bin/env node
/**
 * 手动/启动时备份 SQLite 到 backup/（不依赖 TypeScript，可直接用 node 运行）
 * 用法：node scripts/backup.mjs        （npm run backup 亦可）
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = process.cwd();
const dataDir = process.env.SCHEDULER_DATA_DIR ? path.resolve(process.env.SCHEDULER_DATA_DIR) : path.join(root, 'data');
const dbPath = process.env.SCHEDULER_DB ? path.resolve(process.env.SCHEDULER_DB) : path.join(dataDir, 'scheduler.db');
const backupDir = process.env.SCHEDULER_BACKUP_DIR
  ? path.resolve(process.env.SCHEDULER_BACKUP_DIR)
  : process.env.SCHEDULER_DB || process.env.SCHEDULER_DATA_DIR
    ? path.join(path.dirname(dbPath), 'backup')
    : path.join(root, 'backup');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());

if (!fs.existsSync(dbPath)) {
  console.log('[备份] 数据库还不存在，跳过：' + dbPath);
  process.exit(0);
}

let keep = Number(process.env.BACKUP_KEEP || 0);
if (!keep) {
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'backup_keep'").get();
    db.close();
    keep = Number(row?.value || 30) || 30;
  } catch {
    keep = 30;
  }
}

fs.mkdirSync(backupDir, { recursive: true });
const target = path.join(backupDir, 'scheduler-' + today + '.db');

if (fs.existsSync(target)) {
  console.log('[备份] 今天已经备份过：' + path.basename(target));
} else {
  try {
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    console.warn('[备份] WAL 检查点失败（不影响复制）：' + err.message);
  }
  fs.copyFileSync(dbPath, target);
  console.log('[备份] 已生成：' + target + '（' + (fs.statSync(target).size / 1024).toFixed(1) + ' KB）');
}

// 只保留最近 keep 份
const files = fs
  .readdirSync(backupDir)
  .filter((f) => f.startsWith('scheduler-') && f.endsWith('.db'))
  .sort()
  .reverse();
for (const f of files.slice(Math.max(keep, 1))) {
  fs.unlinkSync(path.join(backupDir, f));
  console.log('[备份] 已清理旧备份：' + f);
}
console.log('[备份] 完成，当前保留 ' + Math.min(files.length, Math.max(keep, 1)) + ' 份（上限 ' + keep + '）');
