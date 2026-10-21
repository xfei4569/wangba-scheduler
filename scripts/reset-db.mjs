#!/usr/bin/env node
/**
 * 清空数据库（危险操作，用于把演示数据抹掉、回到「空库 + 预置班次/节假日」状态）
 * 用法：node scripts/reset-db.mjs --yes
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataDir = process.env.SCHEDULER_DATA_DIR ? path.resolve(process.env.SCHEDULER_DATA_DIR) : path.join(root, 'data');
const dbPath = process.env.SCHEDULER_DB ? path.resolve(process.env.SCHEDULER_DB) : path.join(dataDir, 'scheduler.db');

if (!process.argv.includes('--yes')) {
  console.log('这会删除数据库文件：' + dbPath);
  console.log('确认请加参数：node scripts/reset-db.mjs --yes');
  process.exit(0);
}

const targets = [dbPath, dbPath + '-wal', dbPath + '-shm'];
let removed = 0;
for (const f of targets) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    removed += 1;
    console.log('已删除：' + f);
  }
}
console.log(removed === 0 ? '没有需要删除的文件。' : '完成。下次启动应用会自动重建空库并写入预置班次与节假日。');
