#!/usr/bin/env node
/**
 * 演示数据：写入 7 名虚构员工（仅在员工表为空时执行）
 * 用途：验收 / 截图 / 试用。真实使用时请直接在「员工管理」页面录入。
 * 用法：node scripts/demo-seed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const root = process.env.SCHEDULER_ROOT ? path.resolve(process.env.SCHEDULER_ROOT) : process.cwd();
const dataDir = process.env.SCHEDULER_DATA_DIR ? path.resolve(process.env.SCHEDULER_DATA_DIR) : path.join(root, 'data');
const dbPath = process.env.SCHEDULER_DB ? path.resolve(process.env.SCHEDULER_DB) : path.join(dataDir, 'scheduler.db');

if (!fs.existsSync(dbPath)) {
  console.error('[演示数据] 找不到数据库：' + dbPath + '，请先启动一次应用。');
  process.exit(1);
}

const PEOPLE = Array.from({ length: 7 }, (_, i) => ({
  name: '示例员工 ' + String.fromCharCode(65 + i),
  tags: [i % 2 ? '外场' : '内场'],
  note: '虚构演示人员，不对应真实员工',
  gender: i % 2 ? '男' : '女',
}));

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
const count = db.prepare('SELECT COUNT(*) AS c FROM employees').get().c;
if (count > 0) {
  console.log('[演示数据] 员工表已有 ' + count + ' 条记录，跳过（避免污染真实数据）');
  db.close();
  process.exit(0);
}

const today = new Date();
const hire = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-01';
const stmt = db.prepare(
  'INSERT INTO employees (name, tags, status, hire_date, note, sort_order, gender) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const tx = db.transaction(() => {
  PEOPLE.forEach((p, i) => stmt.run(p.name, JSON.stringify(p.tags), 'active', hire, p.note || null, i + 1, p.gender));
});
tx();
db.close();
console.log('[演示数据] 已写入 ' + PEOPLE.length + ' 名示例员工');
