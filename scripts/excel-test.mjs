#!/usr/bin/env node
/**
 * Excel 导出自检：生成一张小样表，读回来核对两张 sheet 的排版与文案：
 *   「按员工」：一人一行、列是日期（周五 09-29 表头）、格子写 白班/中班/夜班/休/请假/待排、颜色按人；
 *   「按班次」：一天一行、格子里是名单（N 人）/ 缺 N 人 / 多 N 人 / 待排（B6：0 人 = 待排）。
 * 用法：node scripts/excel-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
// 临时目录放在项目内，转译出来的 require('xlsx-js-style') 才能按 node_modules 解析
const temp = fs.mkdtempSync(path.join(root, '.excel-test-'));
const require = createRequire(import.meta.url);
for (const file of ['lib/date.ts', 'lib/excel.ts']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dest = path.join(temp, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, output);
}

try {
  const { exportPeopleMatrixExcel } = require(path.join(temp, 'lib/excel.js'));
  const out = path.join(temp, '样表.xlsx');
  await exportPeopleMatrixExcel({
    title: '排班表 样例',
    dates: ['2026-09-29', '2026-09-30', '2026-10-01'],
    people: [
      { name: '甲（店长）', cells: ['白班', '休', '请假'] },
      { name: '乙（新人）', cells: ['中班', '夜班', '待排'] },
    ],
    // 「按班次」sheet：09-30 是「排过后又删空」的一天（B6：三个格子都 0 人）
    shiftHeaders: ['早班 09:00', '中班 13:00', '晚班 21:00'],
    shiftCells: [
      [{ people: ['甲'], demand: 1 }, { people: ['乙'], demand: 1 }, { people: ['甲', '乙'], demand: 3 }],
      [{ people: [], demand: 2 }, { people: [], demand: 1 }, { people: [], demand: 2 }],
      [{ people: ['甲', '乙'], demand: 1 }, { people: [], demand: 0 }, { people: ['乙'], demand: 1 }],
    ],
    note: '注：测试样表。',
    fileName: out,
  });
  assert(fs.existsSync(out), '导出文件应已生成');

  const XLSX = require('xlsx-js-style');
  const wb = XLSX.readFile(out, { cellStyles: true });
  const ws = wb.Sheets['按员工'];
  assert(ws, '应有「按员工」工作表');
  const v = (r, c) => (ws[XLSX.utils.encode_cell({ r, c })] || {}).v;

  // 表头：员工 | 周二 09-29 | 星期三 09-30 | 周四 10-01 | 出勤 休息 晚班 请假
  assert.equal(v(1, 0), '员工');
  assert.equal(v(1, 1), '周二 09-29');
  assert.equal(v(1, 3), '周四 10-01');
  assert.equal(v(1, 4), '出勤');

  // 一人一行，格子文案就是截图那五种
  assert.equal(v(2, 0), '甲（店长）');
  assert.equal(v(2, 1), '白班');
  assert.equal(v(2, 2), '休');
  assert.equal(v(2, 3), '请假');
  assert.equal(v(3, 0), '乙（新人）');
  assert.equal(v(3, 1), '中班');
  assert.equal(v(3, 2), '夜班');
  assert.equal(v(3, 3), '待排');

  // 小计列：由格子现算
  assert.deepEqual([v(2, 4), v(2, 5), v(2, 6), v(2, 7)], [1, 1, 0, 1], '甲的出勤/休息/晚班/请假');
  assert.deepEqual([v(3, 4), v(3, 5), v(3, 6), v(3, 7)], [2, 0, 1, 0], '乙的出勤/休息/晚班/请假');

  // 颜色按人：同一个人的行用同一个底色，两个人的颜色不同
  // （读回来的 RGB 已不带 FF 透明度前缀）
  const fillOf = (sheet, r, c) => {
    const s = (sheet[XLSX.utils.encode_cell({ r, c })] || {}).s;
    return s && s.fgColor ? String(s.fgColor.rgb) : null;
  };
  const a = fillOf(ws, 2, 1);
  const b = fillOf(ws, 3, 1);
  assert.equal(a, 'BDD7EE', '第一人的格子应为色板第 1 色');
  assert.equal(fillOf(ws, 2, 3), a, '同一个人三天格子同色');
  assert.equal(b, 'C6E0B4', '第二人的格子应为色板第 2 色');
  assert.equal(fillOf(ws, 3, 3), 'FFF2CC', '空缺（待排）格应为醒目黄色');

  /* ---------------- B6 回归④：「按班次」格子同样口径 ---------------- */
  const s1 = wb.Sheets['按班次'];
  assert(s1, '应有「按班次」工作表');
  const w = (r, c) => (s1[XLSX.utils.encode_cell({ r, c })] || {}).v;
  assert.deepEqual([w(3, 0), w(3, 1), w(3, 2), w(3, 3), w(3, 4), w(3, 5)],
    ['日期', '星期', '早班 09:00', '中班 13:00', '晚班 21:00', '本日需求人次'], '按班次表头');
  // 09-29：正常 / 部分缺员（0<N<需求，保留「缺 N 人」）
  assert.deepEqual([w(4, 0), w(4, 1), w(4, 2), w(4, 3), w(4, 4), w(4, 5)],
    ['9月29日', '周二', '甲（1 人）', '乙（1 人）', '甲、乙 （缺 1 人／需 3）', 5], '部分缺员仍是「缺 N 人」');
  // 09-30：整天删空 → 全部写「待排」，不得再出现「缺 N 人」
  const deletedDay = [w(5, 2), w(5, 3), w(5, 4)];
  assert.deepEqual(deletedDay, ['待排（需 2）', '待排（需 1）', '待排（需 2）'], '删空的一天应写「待排（需 N）」');
  assert(!deletedDay.join('').includes('缺'), '删空的一天不得出现「缺 N 人」：' + deletedDay.join(' '));
  // 10-01：超额仍是「多 N 人」；0 人且不需要人写「—」
  assert.equal(w(6, 2), '甲、乙（多 1 人／需 1）');
  assert.equal(w(6, 3), '—');
  assert.equal(w(6, 4), '乙（1 人）');

  console.log('Excel 导出自检：按员工（表头/五种格子/按人着色）+ 按班次（B6：0 人 = 待排，部分缺员 = 缺 N 人）全部符合 ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
