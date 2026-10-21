#!/usr/bin/env node
/**
 * P2 验收自测：月度汇总 / Excel 导出数据 / 月休可配置 / 工作台改人数 / 诊断联动 / 备份提醒。
 * 用法：先启动一个应用实例（建议用独立数据库与端口，例如
 *   SCHEDULER_DB=/tmp/wb-p2/scheduler.db SCHEDULER_BACKUP_DIR=/tmp/wb-p2/backup \
 *   node node_modules/next/dist/bin/next start -p 3902
 * ），再执行：
 *   SELFTEST_BASE=http://127.0.0.1:3902 node scripts/p2-selftest.mjs
 *
 * 本脚本只走 HTTP 接口，不直接读写数据库；会自己造员工与排班数据。
 * 例外：第 16 节（B7）为了构造「锁定 + 0 人」的历史脏数据，会用 better-sqlite3 直连自测实例的
 * 临时库写几条记录（只写 SCHEDULER_DB 指向的临时库，写法与用户现网的历史态一致），
 * 之后的自愈与显示仍全部通过 HTTP 验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const BASE = process.env.SELFTEST_BASE || 'http://127.0.0.1:3902';
const USERNAME = process.env.SELFTEST_USER || '';
const PASSWORD = process.env.SELFTEST_PASS || '';
const MONTH = process.env.P2_MONTH || '2026-11';

/** 自测实例的数据库文件（第 0 节校验过它不是正式库） */
let DB_FILE = '';

if (!process.env.SELFTEST_BASE || !USERNAME || !PASSWORD || process.env.SCHEDULER_TEST_ISOLATED !== '1') {
  throw new Error('此脚本会改数据。请使用 npm run test:integration 创建隔离实例，不要对在用实例运行。');
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fail += 1; failures.push(name + (detail ? ' —— ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}
function section(title) { console.log(''); console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 46 - title.length))); }

class Client {
  constructor() { this.cookies = new Map(); }
  async raw(method, path, body) {
    const headers = {};
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (this.cookies.size) headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const res = await fetch(BASE + path, { method, headers, body: body === undefined || body === null ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age=0/i.test(c)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, json, text };
  }
  get(p) { return this.raw('GET', p); }
  post(p, b) { return this.raw('POST', p, b ?? {}); }
  put(p, b) { return this.raw('PUT', p, b ?? {}); }
  del(p, b) { return this.raw('DELETE', p, b); }
  patch(p, b) { return this.raw('PATCH', p, b ?? {}); }
}

const client = new Client();
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };
const mondayOf = (s) => { const [y, m, d] = s.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDays(s, -((w + 6) % 7)); };

/** 从月视图网格重新算一遍每人统计，用来核对统计列 */
function statsFromGrid(month) {
  const map = new Map();
  for (const day of month.days.filter((d) => d.scheduled)) {
    const seen = new Set();
    for (const cell of day.shifts) {
      for (const p of cell.people) {
        const row = map.get(p.name) || { name: p.name, workDays: 0, early: 0, middle: 0, night: 0 };
        if (!seen.has(p.name)) { row.workDays += 1; seen.add(p.name); }
        row[cell.code] += 1;
        map.set(p.name, row);
      }
    }
  }
  return map;
}

const REST = 6;
const EMPLOYEES = ['P2甲', 'P2乙', 'P2丙', 'P2丁', 'P2戊', 'P2己', 'P2庚', 'P2辛'];

async function main() {
  console.log('网吧排班台 · P2 验收自测');
  console.log('目标地址：' + BASE + '　测试月份：' + MONTH);

  section('0. 登录与数据准备');
  {
    const login = await client.post('/api/auth/login', { username: USERNAME, password: PASSWORD });
    check('登录成功', login.status === 200, 'HTTP ' + login.status);

    const target = await client.get('/api/settings');
    const meta = target.json?.data?.meta;
    if (target.status !== 200 || !meta ||
      path.resolve(meta.dbPath) === path.resolve(import.meta.dirname, '../data/scheduler.db') ||
      path.resolve(meta.backupDir) === path.resolve(import.meta.dirname, '../backup')) {
      throw new Error('自测必须使用独立数据库和备份目录；请检查实例的 SCHEDULER_DB / SCHEDULER_BACKUP_DIR');
    }
    DB_FILE = path.resolve(meta.dbPath);

    const list = await client.get('/api/employees');
    const existing = list.json.data.items.map((e) => e.name);
    let created = 0;
    for (const name of EMPLOYEES) {
      if (existing.includes(name)) continue;
      const r = await client.post('/api/employees', { name, tags: ['内场'], status: 'active', hire_date: '2026-01-01' });
      if (r.status === 200) created += 1;
    }
    const after = await client.get('/api/employees');
    const active = after.json.data.items.filter((e) => e.status === 'active');
    check('测试员工就绪（8 人）', active.length >= EMPLOYEES.length, '新增 ' + created + ' 人，当前在职 ' + active.length + ' 人');

    const s = await client.get('/api/shifts');
    const shifts = s.json.data.items;
    check('班次模板为默认 2-1-2', ['early', 'middle', 'night'].every((c) => {
      const row = shifts.find((x) => x.code === c);
      return row.weekday_count === 2 || row.weekday_count === 1;
    }), shifts.map((x) => x.name + ':' + x.weekday_count + '/' + x.weekend_count + '/' + x.holiday_count).join(' '));

    const settings = await client.get('/api/settings');
    check('读取设置成功', settings.status === 200);
  }

  section('1. 月休天数可配置（设置 6 天 → 生成整月 → 每人月休 ≥ 6）');
  {
    const bad = await client.put('/api/settings', { scheduler_min_rest_days: 99 });
    check('月休超出 2-10 被拒绝', bad.status === 400, bad.json?.error || '');
    const saved = await client.put('/api/settings', { scheduler_min_rest_days: REST });
    check('设置月休 = ' + REST + ' 天', saved.status === 200, JSON.stringify(saved.json?.data?.saved));
    const s = await client.get('/api/settings');
    check('设置已落库', Number(s.json.data.settings.scheduler_min_rest_days) === REST);

    const gen = await client.post('/api/month/generate', { month: MONTH, lock: false });
    check('一键排整月成功', gen.status === 200 && gen.json.data.ok === true, '处理 ' + gen.json?.data?.results?.length + ' 周');
    if (gen.json?.data?.ok === false) {
      check('诊断已返回', Array.isArray(gen.json.data.diagnosis?.suggestions), (gen.json.data.diagnosis?.suggestions || []).slice(0, 2).join('；'));
    }

    // 逐周锁定，再核对月休
    const weeks = [];
    for (let cur = mondayOf(MONTH + '-01'); cur <= MONTH + '-30'; cur = addDays(cur, 7)) weeks.push(cur);
    for (const week of weeks) await client.post('/api/schedule/lock', { week_start: week, locked: true });

    const month = (await client.get('/api/month?month=' + MONTH)).json.data;
    check('整月全部锁定', month.scheduled_days === month.total_days, month.scheduled_days + '/' + month.total_days + ' 天');
    check('月休要求已回显', month.rest_requirement === REST, 'rest_requirement=' + month.rest_requirement);
    const working = month.people.filter((p) => p.workDays > 0);
    const minRest = Math.min(...working.map((p) => p.restDays));
    check('每人月休 ≥ ' + REST + ' 天', minRest >= REST, '月休：' + working.map((p) => p.name + '=' + p.restDays).join(' '));

    const scheduledEmployee = (await client.get('/api/employees')).json.data.items.find((e) => e.name === EMPLOYEES[0]);
    const deniedDelete = await client.del('/api/employees/' + scheduledEmployee.id);
    check('已有班次的员工不能删除', deniedDelete.status === 409 && deniedDelete.json?.error?.includes('离职'));
  }

  section('2. 工作台快捷改人数（周三晚班 2→3）');
  {
    const wednesday = addDays(mondayOf(MONTH + '-02'), 2); // 当月第一个周三
    const week = mondayOf(wednesday);
    await client.post('/api/schedule/lock', { week_start: week, locked: false });

    const before = (await client.get('/api/schedule/generate?week_start=' + week)).json.data;
    const cell0 = before.demand.find((d) => d.date === wednesday && d.code === 'night');
    check('改动前需求为模板人数 2', cell0.demand === 2 && cell0.override === false, '需求 ' + cell0.demand + ' 人');

    const change = await client.post('/api/schedule/staffing', { date: wednesday, shift_code: 'night', count: 3, scope: 'day' });
    check('改人数接口成功', change.status === 200 && change.json.data.count === 3, '影响 ' + change.json?.data?.changed + ' 天，需要重排=' + change.json?.data?.need_regenerate);

    const after = (await client.get('/api/schedule/generate?week_start=' + week)).json.data;
    const cell1 = after.demand.find((d) => d.date === wednesday && d.code === 'night');
    check('需求已变为 3 人且标记为临时', cell1.demand === 3 && cell1.override === true, '需求 ' + cell1.demand + '（模板 ' + cell1.base + '）');

    const regen = await client.post('/api/schedule/regenerate', { week_start: week });
    check('重排本周剩余成功', regen.status === 200 && regen.json.data.ok === true);
    const week2 = (await client.get('/api/schedule/generate?week_start=' + week)).json.data;
    const night = week2.entries.filter((e) => e.work_date === wednesday && e.shift_code === 'night');
    check('生成后该班就是 3 人', night.length === 3, '实际 ' + night.length + ' 人：' + night.map((e) => e.employee_name).join('、'));

    // 应用到本月所有同类日
    const same = await client.post('/api/schedule/staffing', { date: wednesday, shift_code: 'night', count: 3, scope: 'same-kind' });
    check('「应用到本月所有同类日」成功', same.status === 200 && same.json.data.changed > 1, '影响 ' + same.json?.data?.changed + ' 天（同日类型：' + same.json?.data?.day_type + '）');
    check('返回需要重排的周', same.json?.data?.stale_weeks?.includes(week) && same.json?.data?.affected_weeks?.includes(week));
    const grid = (await client.get('/api/month?month=' + MONTH)).json.data;
    const weekdayNight = grid.days.filter((d) => d.day_type === 'weekday').map((d) => d.shifts.find((s) => s.code === 'night'));
    const unlockedWeekdayNight = grid.days.filter((d) => d.day_type === 'weekday' && d.week_status !== 'locked').map((d) => d.shifts.find((s) => s.code === 'night'));
    const weekendNight = grid.days.filter((d) => d.day_type === 'weekend').map((d) => d.shifts.find((s) => s.code === 'night'));
    check('未锁定周的平日·晚班变成 3 人', unlockedWeekdayNight.every((c) => c.demand === 3), unlockedWeekdayNight.length + ' 个平日；已锁定周保持不变');
    check('周末·晚班保持模板 2 人', weekendNight.every((c) => c.demand === 2), weekendNight.length + ' 个周末日');
    check('月视图格子标出人数变化（override）', grid.days.some((d) => d.shifts.some((s) => s.override)));

    // 还原模板人数（填回默认值应该删掉临时记录）
    const reset = await client.post('/api/schedule/staffing', { date: wednesday, shift_code: 'night', count: 2, scope: 'same-kind' });
    check('填回模板人数即恢复默认', reset.status === 200, '处理 ' + reset.json?.data?.changed + ' 天');
    const grid2 = (await client.get('/api/month?month=' + MONTH)).json.data;
    check('恢复后不再有临时人数', grid2.days.every((d) => d.shifts.every((s) => !s.override)));
  }

  section('3. 诊断联动（人数调大 + 当天无人可出勤）');
  {
    const wednesday = addDays(mondayOf(MONTH + '-02'), 2);
    const week = mondayOf(wednesday);
    await client.post('/api/schedule/lock', { week_start: week, locked: false });
    await client.post('/api/schedule/staffing', { date: wednesday, shift_code: 'night', count: 4, scope: 'day' });

    const emps = (await client.get('/api/employees')).json.data.items.filter((e) => e.status === 'active' && e.name.startsWith('P2'));
    const leaveIds = [];
    for (const e of emps) {
      const r = await client.post('/api/requirements', { type: 'leave', employee_id: e.id, leave_type: '事假', date_start: wednesday, date_end: wednesday, note: 'P2自测' });
      if (r.status === 200) leaveIds.push(r.json.data.item.id);
    }
    check('已登记全员请假（' + leaveIds.length + ' 条）', leaveIds.length === emps.length);

    const regen = await client.post('/api/schedule/regenerate', { week_start: week });
    const ok = regen.json?.data?.ok;
    check('排不下并返回诊断', ok === false, ok === false ? '诊断为结构化数据' : '竟然排下了');
    const suggestions = regen.json?.data?.diagnosis?.suggestions || [];
    const tip = suggestions.find((s) => s.includes('降回'));
    check('诊断建议包含人数松绑建议', Boolean(tip), tip || suggestions.slice(0, 2).join('；'));

    for (const id of leaveIds) await client.del('/api/requirements/' + id);
    await client.post('/api/schedule/staffing', { date: wednesday, shift_code: 'night', count: 2, scope: 'day' });
    check('清理测试用请假与临时人数', true);
  }

  section('4. 月视图：30 天 × 3 班 + 统计列核对 + 待排占位');
  {
    // 前面的改人数测试解锁过其中一周，这里先恢复「整月锁定」再核对
    for (let cur = mondayOf(MONTH + '-01'); cur <= MONTH + '-30'; cur = addDays(cur, 7)) {
      // 改回模板人数后先重算草稿，锁定接口会拒绝人数与班表不一致的周。
      await client.post('/api/schedule/regenerate', { week_start: cur });
      await client.post('/api/schedule/lock', { week_start: cur, locked: true });
    }
    const month = (await client.get('/api/month?month=' + MONTH)).json.data;
    check('整月恢复锁定', month.scheduled_days === month.total_days, month.scheduled_days + '/' + month.total_days);
    check('整月天数正确', month.days.length === 30, month.days.length + ' 天');
    check('每天都是 3 个班次列', month.days.every((d) => d.shifts.length === 3));
    check('月休要求显示在顶部数据里', month.rest_requirement === REST);

    const mine = statsFromGrid(month);
    const mismatches = [];
    for (const p of month.people) {
      const g = mine.get(p.name);
      if (!g) continue;
      if (g.workDays !== p.workDays || g.early !== p.early || g.middle !== p.middle || g.night !== p.night) {
        mismatches.push(p.name + '：统计 出勤' + p.workDays + '/早' + p.early + '/中' + p.middle + '/晚' + p.night + ' ≠ 网格 ' + g.workDays + '/' + g.early + '/' + g.middle + '/' + g.night);
      }
      if (p.workDays + p.restDays !== month.scheduled_days) mismatches.push(p.name + '：出勤+月休 ≠ 已排天数');
    }
    check('每人统计列与网格逐格重算一致', mismatches.length === 0, mismatches.slice(0, 3).join('；') || (month.people.length + ' 人全部一致'));
    const sample = month.people.slice(0, 2).map((p) => p.name + '：出勤' + p.workDays + ' 月休' + p.restDays + ' 早' + p.early + ' 中' + p.middle + ' 晚' + p.night);
    console.log('     抽查 ' + sample.join(' ｜ '));

    // 未锁定（草稿）周照常算已排并展示人：草稿=还能改，锁定=定稿
    const week = mondayOf(MONTH + '-16');
    await client.post('/api/schedule/lock', { week_start: week, locked: false });
    const pending = (await client.get('/api/month?month=' + MONTH)).json.data;
    const weekDays = pending.days.filter((d) => d.week_start === week);
    check('草稿周照常展示人名并算已排', weekDays.every((d) => d.scheduled === true && d.shifts.some((s) => s.people.length > 0)), weekDays.length + ' 天');
    check('待排只算未生成的天', pending.pending_days === 0, '待排 ' + pending.pending_days + ' 天');
    check('草稿周计入已排天数', pending.scheduled_days === 30, '已排 ' + pending.scheduled_days + ' 天');
    const afterUnlock = statsFromGrid(pending);
    const p0 = pending.people[0];
    check('解锁不改变统计（草稿仍计入）', (afterUnlock.get(p0.name)?.workDays ?? -1) === p0.workDays, p0.name + ' 出勤 ' + p0.workDays + ' 天');
    await client.post('/api/schedule/lock', { week_start: week, locked: true });
  }

  section('5. 隐私红线（不搭班不得出现在排班/汇总）');
  {
    const month = (await client.get('/api/month?month=' + MONTH)).json.data;
    const raw = JSON.stringify(month);
    const hasPair = /pairing|不搭班|组合避让/.test(raw);
    check('月视图不含不搭班字段', !hasPair);
    const week = (await client.get('/api/schedule/generate?week_start=' + mondayOf(MONTH + '-02'))).json.data;
    check('周工作台不含不搭班字段', !/pairing|不搭班/.test(JSON.stringify(week)));
  }

  section('6. 整月失败回滚');
  {
    const targetDate = '2027-02-10';
    const active = (await client.get('/api/employees')).json.data.items.filter((e) => e.status === 'active');
    const leaveIds = [];
    try {
      for (const employee of active) {
        const leave = await client.post('/api/requirements', { type: 'leave', employee_id: employee.id,
          leave_type: '事假', date_start: targetDate, date_end: targetDate, note: '整月回滚自测' });
        if (leave.status === 200) leaveIds.push(leave.json.data.item.id);
      }
      const result = await client.post('/api/month/generate', { month: '2027-02', lock: true });
      check('后续周排不下时整月生成失败', result.status === 200 && result.json?.data?.ok === false);
      const earlier = (await client.get('/api/schedule/generate?week_start=2027-02-01')).json.data;
      check('失败前已生成的周已回滚', earlier.schedule === null);
    } finally {
      for (const id of leaveIds) await client.del('/api/requirements/' + id);
    }
    const currentMonday = mondayOf(new Date().toISOString().slice(0, 10));
    const generated = await client.post('/api/schedule/generate', { week_start: currentMonday });
    const current = (await client.get('/api/schedule/generate?week_start=' + currentMonday)).json.data;
    const startedEntry = (current.entries || []).find((row) => (current.frozenSlots || []).includes(row.work_date + '|' + row.shift_code) && row.employee_id);
    // 换人对象必须不在这个班里（同班已有的人会被「不能重复」挡住，测不到「已开始」这条）
    const startedSlot = startedEntry ? startedEntry.work_date + '|' + startedEntry.shift_code : '';
    const sameSlot = new Set((current.entries || [])
      .filter((row) => row.work_date + '|' + row.shift_code === startedSlot)
      .map((row) => row.employee_id));
    const otherPerson = (current.entries || []).find((row) => startedEntry && row.employee_id
      && !sameSlot.has(row.employee_id) && row.employee_id !== startedEntry.employee_id);
    if (generated.json?.data?.ok && startedEntry && otherPerson) {
      // 问题①：已开始的班放开手动换人 —— 试查只提示不拒绝，改了立即生效并留痕 source='manual'
      const dry = await client.patch('/api/schedule/entries/' + startedEntry.id, { employee_id: otherPerson.employee_id, dryRun: true });
      check('已开始的班试查仍提示「已开始」', dry.status === 200 && (dry.json?.data?.notices || []).some((n) => n.includes('已经开始')),
        JSON.stringify(dry.json?.data?.notices || dry.json?.error || ''));
      const swap = await client.patch('/api/schedule/entries/' + startedEntry.id, { employee_id: otherPerson.employee_id, force: true });
      check('已经开始的班可以手动换人（不再 409）', swap.status === 200, swap.json?.error || ('HTTP ' + swap.status));
      const after = (await client.get('/api/schedule/generate?week_start=' + currentMonday)).json.data;
      const changed = (after.entries || []).find((row) => row.id === startedEntry.id);
      check('换人生效并留痕 source=manual',
        changed?.employee_id === otherPerson.employee_id && changed?.source === 'manual',
        JSON.stringify(changed && { employee_id: changed.employee_id, source: changed.source }));
      const back = await client.patch('/api/schedule/entries/' + startedEntry.id, { employee_id: startedEntry.employee_id, force: true });
      check('已开始的班能改回原人（排错了能改回来）', back.status === 200, back.json?.error || ('HTTP ' + back.status));
    } else {
      check('当前周生成后应有已经开始的班', false, 'frozen ' + (current.frozenSlots || []).length);
    }
    const notice = await client.post('/api/requirements', { type: 'leave', employee_id: active[0].id,
      leave_type: '事假', date_start: MONTH + '-03', date_end: MONTH + '-03', note: '重算提示自测' });
    check('请假后告诉店长哪些草稿周要重算', Array.isArray(notice.json?.data?.stale_weeks), '受影响周 ' + (notice.json?.data?.stale_weeks || []).join(','));
    if (notice.json?.data?.item?.id) await client.del('/api/requirements/' + notice.json.data.item.id);
  }

  section('7. 备份提醒（清空备份 → 接口为空 → 立即备份 → 有文件）');
  {
    const before = await client.get('/api/backup');
    check('备份接口可读', before.status === 200, '当前 ' + before.json.data.items.length + ' 份，目录 ' + before.json.data.dir);
    const created = await client.post('/api/backup');
    check('「立即备份」成功', created.status === 200 && created.json.data.items.length >= 1, created.json?.data?.item?.name || '');
    const marker = await client.post('/api/employees', { name: '还原标记', status: 'active', tags: [] });
    check('还原前写入标记员工', marker.status === 200);
    const restored = await client.put('/api/backup', { name: created.json.data.item.name });
    const after = await client.get('/api/employees?q=' + encodeURIComponent('还原标记'));
    check('用备份还原后标记员工消失', restored.status === 200 && after.json.data.items.length === 0, restored.json?.error || '');
    const bad = await client.put('/api/backup', { name: '../data/scheduler.db' });
    check('非法备份名被拒绝', bad.status >= 400);
  }

  section('8. 换人报错实时化 + 半满槽位补人 + 新员工入列');
  {
    const WEEK = '2027-01-04';
    const gen = await client.post('/api/schedule/generate', { week_start: WEEK });
    check('生成 2027-01-04 周', gen.status === 200 && gen.json?.data?.ok === true, JSON.stringify(gen.json?.data?.diagnosis?.conflicts || []));
    let week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const early = week.entries.find((e) => e.work_date === WEEK && e.shift_code === 'early');
    const middle = week.entries.find((e) => e.work_date === WEEK && e.shift_code === 'middle');
    const dup = await client.patch('/api/schedule/entries/' + middle.id, { employee_id: early.employee_id, force: true });
    check('强制换人制造同日两班', dup.status === 200, dup.json?.error || '');
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const flaggedNew = week.issues?.[middle.id] || [];
    const flaggedOld = week.issues?.[early.id] || [];
    check('同日冲突实时标红（两个班都标）',
      flaggedNew.some((r) => r.includes('同日已有班次')) && flaggedOld.some((r) => r.includes('同日已有班次')),
      JSON.stringify(week.issues || {}));
    const fix = await client.patch('/api/schedule/entries/' + middle.id, { employee_id: middle.employee_id, force: true });
    check('修正同日冲突', fix.status === 200, fix.json?.error || '');
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('改完报错立即消失', !(week.issues?.[middle.id] || []).length && !(week.issues?.[early.id] || []).length, JSON.stringify(week.issues || {}));

    // 半满槽位：晚班钉 1 个手工条目后把人数改成 3，重排应把剩下的座补齐
    const day2 = addDays(WEEK, 1);
    const night = week.entries.find((e) => e.work_date === day2 && e.shift_code === 'night');
    await client.patch('/api/schedule/entries/' + night.id, { employee_id: night.employee_id, force: true });
    const staff = await client.post('/api/schedule/staffing', { date: day2, shift_code: 'night', count: 3, scope: 'day' });
    check('晚班人数改为 3', staff.status === 200, staff.json?.error || '');
    const regen = await client.post('/api/schedule/regenerate', { week_start: WEEK });
    check('钉住手工后仍能重排成功', regen.json?.data?.ok === true, JSON.stringify(regen.json?.data?.diagnosis?.conflicts || []));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const nightCount = week.entries.filter((e) => e.work_date === day2 && e.shift_code === 'night').length;
    check('手工钉住的晚班补齐到 3 人', nightCount === 3, '实际 ' + nightCount + ' 人');

    // 新员工入列：加人后重排，新员工应能排到班
    const newbie = await client.post('/api/employees', { name: 'P2新员工', tags: ['内场'], status: 'active', hire_date: '2026-01-01' });
    const newbieId = newbie.json?.data?.item?.id ?? newbie.json?.data?.id;
    check('新增员工成功', newbie.status === 200 && Number.isInteger(newbieId), JSON.stringify(newbie.json?.data || newbie.json?.error || {}));
    const regen2 = await client.post('/api/schedule/regenerate', { week_start: WEEK });
    check('加人后重排成功', regen2.json?.data?.ok === true, JSON.stringify(regen2.json?.data?.diagnosis?.conflicts || []));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const newbieShifts = week.entries.filter((e) => e.employee_id === newbieId).length;
    check('新员工被排到班', newbieShifts > 0, '排到 ' + newbieShifts + ' 个班');
  }

  section('9. 草稿周月视图可见 + 一周起始日可改');
  {
    const month1 = (await client.get('/api/month?month=2027-01')).json.data;
    const jan4 = (month1.days || []).find((d) => d.date === '2027-01-04');
    check('草稿周的天算「已排」', Boolean(jan4?.scheduled), JSON.stringify(jan4 && { scheduled: jan4.scheduled, status: jan4.week_status }));
    check('草稿周的天显示人', Boolean(jan4?.shifts?.some((s) => s.people.length > 0)));

    const save = await client.put('/api/settings', { scheduler_week_start_weekday: 2 });
    check('保存一周起始日=周二', save.status === 200, save.json?.error || '');
    const snapped = (await client.get('/api/schedule/generate?week_start=2027-01-04')).json.data.weekStart;
    check('周排班起始日按你选的那天，不再被设置改掉', snapped === '2027-01-04', '实际 ' + snapped);
    const m = (await client.get('/api/month?month=2027-01')).json.data;
    check('月视图周边界按周二', m.days[0].week_start === '2026-12-29', m.days[0].week_start);
    const regrouped = (await client.get('/api/schedule/generate?week_start=2026-12-29')).json.data.entries.length;
    check('改周期后班表归组不丢条目', regrouped > 0, '新周 ' + regrouped + ' 条');

    const back = await client.put('/api/settings', { scheduler_week_start_weekday: 1 });
    check('还原为周一起始', back.status === 200, back.json?.error || '');
    const restored = (await client.get('/api/schedule/generate?week_start=2027-01-04')).json.data.weekStart;
    check('还原后你选的起始日仍原样保留', restored === '2027-01-04', restored);
  }

  section('10. 临时加派可点名 + 周月联动');
  {
    const WEEK = '2027-03-01';
    const day = '2027-03-03';
    const gen = await client.post('/api/schedule/generate', { week_start: WEEK });
    check('生成 2027-03-01 周', gen.json?.data?.ok === true, JSON.stringify(gen.json?.data?.diagnosis?.conflicts || []));
    const emps = (await client.get('/api/employees')).json.data.items.filter((e) => e.status === 'active');

    const week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const early = week.entries.find((e) => e.work_date === day && e.shift_code === 'early');

    // 找一个当天没班、次日也没早/中班的人（避开同日冲突与休息红线）
    const busyNextMorning = new Set(week.entries.filter((e) => e.work_date === addDays(day, 1) && (e.shift_code === 'early' || e.shift_code === 'middle')).map((e) => e.employee_id));
    const free = emps.find((e) => !week.entries.some((x) => x.work_date === day && x.employee_id === e.id) && !busyNextMorning.has(e.id));
    check('存在可点名的空闲员工', Boolean(free), emps.length + ' 名在职');
    const pickId = free.id;

    // 试查：点名当天已有班的人 → 查出同日冲突
    const dry = await client.post('/api/schedule/staffing', { date: day, shift_code: 'night', count: 3, scope: 'day', employee_ids: [early.employee_id], dry_run: true });
    check('试查能查出同日冲突', (dry.json?.data?.conflicts || []).some((c) => c.reasons.some((r) => r.includes('同日'))), JSON.stringify(dry.json?.data?.conflicts || []));

    // 点名加派：把 pickId 钉进晚班（他当天没班 → 无冲突）
    const pin = await client.post('/api/schedule/staffing', { date: day, shift_code: 'night', count: 3, scope: 'day', employee_ids: [pickId] });
    check('点名加派成功', pin.status === 200 && (pin.json?.data?.pinned || []).some((p) => p.employee_id === pickId), JSON.stringify(pin.json?.data?.pinned || pin.json?.error || {}));
    let after = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('点名的人立刻在班里（不用重算）', after.entries.some((e) => e.work_date === day && e.shift_code === 'night' && e.employee_id === pickId));
    check('人数按需写成 3', (after.demand || []).find((d) => d.date === day && d.code === 'night')?.demand === 3, '');

    // 重算后点名的人保留（manual 不动）
    await client.post('/api/schedule/regenerate', { week_start: WEEK });
    after = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('重算后点名的人保留', after.entries.some((e) => e.work_date === day && e.shift_code === 'night' && e.employee_id === pickId));

    // 月表联动：该天晚班格能看到人，且带「临时人数」标记
    const m = (await client.get('/api/month?month=2027-03')).json.data;
    const cell = (m.days || []).find((x) => x.date === day)?.shifts?.find((c) => c.code === 'night');
    check('月表格子里看到点名的人', Boolean(cell?.people.some((p) => p.id === pickId)), JSON.stringify(cell?.people || []));
    check('月表带「临时人数」标记', Boolean(cell?.override));

    // 恢复默认人数（3 → 模板 2）：临时记录删掉，点名的人仍在
    const reset = await client.post('/api/schedule/staffing', { date: day, shift_code: 'night', count: 2, scope: 'day' });
    check('恢复默认人数成功', reset.status === 200, JSON.stringify(reset.json?.data?.targets || reset.json?.error || {}));
    const m2 = (await client.get('/api/month?month=2027-03')).json.data;
    const cell2 = (m2.days || []).find((x) => x.date === day)?.shifts?.find((c) => c.code === 'night');
    check('恢复默认后点名的人仍在班里', Boolean(cell2?.people.some((p) => p.id === pickId)), JSON.stringify(cell2?.people || []));
  }

  section('11. 撤下 / 挪班 / 互换（拖拽换班背后的三种动作）');
  {
    const WEEK = '2027-04-05';
    const CODES = ['early', 'middle', 'night'];
    const gen11 = await client.post('/api/schedule/generate', { week_start: WEEK });
    check('生成 2027-04-05 周', gen11.json?.data?.ok === true, JSON.stringify(gen11.json?.data?.diagnosis?.conflicts || []));
    let week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const getEntry = (id) => week.entries.find((e) => e.id === id);

    // ① 撤下：把人移出班次，班里立刻没有他
    const victim = week.entries.find((e) => e.shift_code === 'early') || week.entries[0];
    const del = await client.del('/api/schedule/entries/' + victim.id);
    check('撤下成功', del.status === 200 && del.json?.data?.removed === true, JSON.stringify(del.json?.error || {}));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('撤下后班里没有这个人', !week.entries.some((e) => e.id === victim.id));
    const again = await client.del('/api/schedule/entries/' + victim.id);
    check('再撤同一条返回 404', again.status === 404);

    // ② 挪班：同一天换个班次（原班留空）
    const mover = week.entries.find((e) => week.entries.filter((x) => x.employee_id === e.employee_id).length >= 2) || week.entries[0];
    const otherCode = CODES.find((c) => c !== mover.shift_code);
    const mDry = await client.patch('/api/schedule/entries/' + mover.id, { work_date: mover.work_date, shift_code: otherCode, dryRun: true });
    check('挪班试查返回体检结果', typeof mDry.json?.data?.valid === 'boolean', JSON.stringify(mDry.json?.data || mDry.json?.error || {}));
    const mv = await client.patch('/api/schedule/entries/' + mover.id, { work_date: mover.work_date, shift_code: otherCode, ...(mDry.json?.data?.valid ? {} : { force: true }) });
    check('挪班成功（同日换个班）', mv.status === 200 && mv.json?.data?.moved === true, JSON.stringify(mv.json?.error || {}));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('挪班后班次更新、原格留空', getEntry(mover.id)?.shift_code === otherCode
      && !week.entries.some((e) => e.employee_id === mover.employee_id && e.work_date === mover.work_date && e.shift_code === mover.shift_code), JSON.stringify(getEntry(mover.id)));

    // ③ 冲突拦截：挪到本人已占的班（重复）、挪到已有班的日子（同日）、跨周挪动
    let e1 = null; let e2 = null;
    for (const e of week.entries) {
      const other = week.entries.find((x) => x.employee_id === e.employee_id && x.work_date !== e.work_date);
      if (other) { e1 = e; e2 = other; break; }
    }
    const dupMove = await client.patch('/api/schedule/entries/' + e1.id, { work_date: e2.work_date, shift_code: e2.shift_code });
    check('挪到本人已占的班被拒绝', dupMove.status === 409, JSON.stringify(dupMove.json || {}));
    const otherCode2 = CODES.find((c) => c !== e2.shift_code);
    const cfl = await client.patch('/api/schedule/entries/' + e1.id, { work_date: e2.work_date, shift_code: otherCode2 });
    check('挪到已有班的日子报同日冲突', cfl.status === 409 && JSON.stringify(cfl.json || {}).includes('同日'), JSON.stringify(cfl.json || {}));
    const crossWeek = await client.patch('/api/schedule/entries/' + e1.id, { work_date: '2026-01-01', shift_code: 'early' });
    check('跨周挪动被拒绝', crossWeek.status === 400, JSON.stringify(crossWeek.json || {}));

    // ④ 互换：两人对调班次（拖到人身上走这条）
    const a = e1;
    const b = week.entries.find((x) => x.employee_id !== a.employee_id && x.work_date !== a.work_date);
    const sDry = await client.patch('/api/schedule/entries/' + a.id, { swap_with: b.id, dryRun: true });
    check('互换试查返回体检结果', typeof sDry.json?.data?.valid === 'boolean', JSON.stringify(sDry.json?.data || sDry.json?.error || {}));
    const sw = await client.patch('/api/schedule/entries/' + a.id, { swap_with: b.id, ...(sDry.json?.data?.valid ? {} : { force: true }) });
    check('互换成功', sw.status === 200, JSON.stringify(sw.json?.error || {}));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('互换后两人对调班次', getEntry(a.id)?.employee_id === b.employee_id && getEntry(b.id)?.employee_id === a.employee_id,
      JSON.stringify([getEntry(a.id), getEntry(b.id)]));
    const selfSwap = await client.patch('/api/schedule/entries/' + a.id, { swap_with: a.id });
    check('和自己互换被拒绝', selfSwap.status === 400);
    const ghost = await client.patch('/api/schedule/entries/999999', { swap_with: b.id });
    check('不存在的班次返回 404', ghost.status === 404);
  }

  section('12. 同班互换不再 500 + 滚动窗口不覆盖已排的天');
  {
    const A = '2027-05-03';
    const B = addDays(A, 3);
    const genA = await client.post('/api/schedule/generate', { week_start: A });
    check('任意起始日（非周一）能生成', genA.json?.data?.ok === true, JSON.stringify(genA.json?.error || {}));
    let week = (await client.get('/api/schedule/generate?week_start=' + A)).json.data;
    check('窗口起点就是你选的那天', week.weekStart === A, week.weekStart);
    check('窗口正好 7 天', week.weekEnd === addDays(A, 6), week.weekStart + ' ~ ' + week.weekEnd);

    const pair = week.entries.filter((e) => e.work_date === A && e.shift_code === 'early');
    check('同一格至少两个人', pair.length >= 2, String(pair.length));
    const same = await client.patch('/api/schedule/entries/' + pair[0].id, { swap_with: pair[1].id });
    check('同格互换返回 400 而不是 500', same.status === 400 && JSON.stringify(same.json || {}).includes('同一个班'), JSON.stringify(same.json || {}));

    const mate = week.entries.find((e) => e.work_date === A && e.shift_code === 'early' && e.employee_id !== pair[1].employee_id);
    const otherDay = week.entries.find((e) => e.work_date !== A && e.employee_id === mate.employee_id);
    const dup = await client.patch('/api/schedule/entries/' + pair[1].id, { swap_with: otherDay.id, force: true });
    const dupMsg = JSON.stringify(dup.json || {});
    check('换到对方已有班次被拦住', dup.status === 409 && (dupMsg.includes('已在') || dupMsg.includes('同日')), dupMsg);
    week = (await client.get('/api/schedule/generate?week_start=' + A)).json.data;
    const snap = week.entries.filter((e) => e.work_date < B).map((e) => e.id + ':' + e.employee_id).sort().join(',');

    const genB = await client.post('/api/schedule/generate', { week_start: B });
    check('重叠窗口能生成', genB.json?.data?.ok === true, JSON.stringify(genB.json?.error || genB.json?.data?.diagnosis?.suggestions || {}));
    const again = (await client.get('/api/schedule/generate?week_start=' + A)).json.data;
    const snap2 = again.entries.filter((e) => e.work_date < B).map((e) => e.id + ':' + e.employee_id).sort().join(',');
    check('后排的窗口没有改掉先排的人', snap === snap2);
    const bWeek = (await client.get('/api/schedule/generate?week_start=' + B)).json.data;
    const overlap = addDays(A, 4);
    const fromA = again.entries.filter((e) => e.work_date === overlap).map((e) => e.id).sort().join(',');
    const fromB = bWeek.entries.filter((e) => e.work_date === overlap).map((e) => e.id).sort().join(',');
    check('重叠的那天两边看到的是同一批人', fromA === fromB && fromA.length > 0, fromA + ' vs ' + fromB);
  }

  section('13. 单日锁定：锁 → 各操作 409 → 重排跳过 → 解锁恢复（问题③）');
  {
    const WEEK = '2027-06-07';
    const DAY = '2027-06-09';
    const gen = await client.post('/api/schedule/generate', { week_start: WEEK });
    check('生成 2027-06-07 周', gen.json?.data?.ok === true, JSON.stringify(gen.json?.data?.diagnosis?.suggestions || {}));
    let week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const dayEntries = (week.entries || []).filter((e) => e.work_date === DAY);
    check('锁定日已有条目', dayEntries.length > 0, dayEntries.length + ' 条');
    const lockedEntry = dayEntries[0];
    const other = (week.entries || []).find((e) => e.work_date !== DAY && e.employee_id !== lockedEntry.employee_id);
    const src = (week.entries || []).find((e) => e.work_date !== DAY && e.shift_code !== lockedEntry.shift_code);

    const lock = await client.post('/api/schedule/day-lock', { date: DAY, locked: true });
    check('锁定这一天', lock.status === 200 && lock.json?.data?.locked === true, lock.json?.error || '');
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('周视图回传锁定日', (week.lockedDays || []).includes(DAY), JSON.stringify(week.lockedDays || []));
    const afterLock = (week.entries || []).find((e) => e.work_date === DAY);
    check('该日条目状态为 locked', afterLock?.status === 'locked', afterLock?.status || '');
    const lockedSnapshot = (week.entries || []).filter((e) => e.work_date === DAY).map((e) => e.id + ':' + e.employee_id).sort().join(',');

    const change = await client.patch('/api/schedule/entries/' + lockedEntry.id, { employee_id: other.employee_id, force: true });
    check('锁定日换人 409', change.status === 409 && String(change.json?.error || '').includes('该日已锁定'), change.json?.error || ('HTTP ' + change.status));
    const moveIn = await client.patch('/api/schedule/entries/' + src.id, { work_date: DAY, shift_code: lockedEntry.shift_code, force: true });
    check('挪进锁定日 409', moveIn.status === 409 && String(moveIn.json?.error || '').includes('该日已锁定'), moveIn.json?.error || ('HTTP ' + moveIn.status));
    const remove = await client.del('/api/schedule/entries/' + lockedEntry.id);
    check('删除锁定日条目 409', remove.status === 409 && String(remove.json?.error || '').includes('该日已锁定'), remove.json?.error || ('HTTP ' + remove.status));
    const demand = (week.demand || []).find((d) => d.date === DAY && d.code === lockedEntry.shift_code)?.demand || 2;
    const count = await client.post('/api/schedule/staffing', { date: DAY, shift_code: lockedEntry.shift_code, count: demand + 1, scope: 'day' });
    check('锁定日改人数 409', count.status === 409 && String(count.json?.error || '').includes('该日已锁定'), count.json?.error || ('HTTP ' + count.status));
    const pin = await client.post('/api/schedule/staffing', { date: DAY, shift_code: lockedEntry.shift_code, count: demand, scope: 'day', employee_ids: [other.employee_id] });
    check('锁定日点名加派 409', pin.status === 409 && String(pin.json?.error || '').includes('该日已锁定'), pin.json?.error || ('HTTP ' + pin.status));
    const clearDay = await client.post('/api/schedule/clear', { scope: 'day', from: DAY });
    check('删除锁定日 409', clearDay.status === 409, clearDay.json?.error || ('HTTP ' + clearDay.status));

    const regen = await client.post('/api/schedule/regenerate', { week_start: WEEK });
    check('锁定后仍可重排（跳过锁定日）', regen.json?.data?.ok === true, JSON.stringify(regen.json?.data?.diagnosis?.suggestions || {}));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    const lockedSnapshot2 = (week.entries || []).filter((e) => e.work_date === DAY).map((e) => e.id + ':' + e.employee_id).sort().join(',');
    check('重排后锁定日原样保留', lockedSnapshot === lockedSnapshot2 && lockedSnapshot.length > 0, lockedSnapshot + ' vs ' + lockedSnapshot2);
    check('别的天照常重排', (week.entries || []).some((e) => e.work_date !== DAY), '');

    const month = (await client.get('/api/month?month=2027-06')).json.data;
    const cell = (month.days || []).find((d) => d.date === DAY);
    check('月表同步显示单日锁定', cell?.day_locked === true, JSON.stringify(cell && { day_locked: cell.day_locked, week_status: cell.week_status }));

    const wholeMonth = await client.post('/api/schedule/clear', { scope: 'month', from: DAY });
    check('「删除这个月」保留锁定日（kept_locked）', wholeMonth.status === 200 && (wholeMonth.json?.data?.kept_locked || []).includes(DAY),
      JSON.stringify(wholeMonth.json?.data || wholeMonth.json?.error || {}));
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('锁定日的条目在删月后仍在', (week.entries || []).filter((e) => e.work_date === DAY).length > 0, '');

    const unlock = await client.post('/api/schedule/day-lock', { date: DAY, locked: false });
    check('解锁这一天', unlock.status === 200 && unlock.json?.data?.locked === false, unlock.json?.error || '');
    week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('解锁后该日恢复 draft', (week.entries || []).filter((e) => e.work_date === DAY).every((e) => e.status === 'draft'), '');
    const edit = await client.patch('/api/schedule/entries/' + lockedEntry.id, { employee_id: lockedEntry.employee_id, force: true });
    check('解锁后换人恢复 200', edit.status === 200, edit.json?.error || ('HTTP ' + edit.status));
  }

  section('14. 店长月休设 0 = 不设下限、零报错、零提醒（问题②）');
  {
    const boss = await client.post('/api/employees', { name: 'P2店长', tags: ['内场'], status: 'active', hire_date: '2026-01-01', position: '店长' });
    check('新增店长员工', boss.status === 200, JSON.stringify(boss.json?.data || boss.json?.error || {}));
    const save0 = await client.put('/api/settings', { scheduler_manager_rest_days: 0 });
    check('店长月休可设为 0', save0.status === 200, save0.json?.error || '');
    const s0 = (await client.get('/api/settings')).json.data.settings;
    check('设置已落库为 0', Number(s0.scheduler_manager_rest_days) === 0, '读到 ' + s0.scheduler_manager_rest_days);

    const WEEK = '2027-07-05';
    const gen = await client.post('/api/schedule/generate', { week_start: WEEK });
    check('店长月休 0 时照常生成', gen.json?.data?.ok === true, JSON.stringify(gen.json?.data?.diagnosis?.suggestions || {}));
    const week = (await client.get('/api/schedule/generate?week_start=' + WEEK)).json.data;
    check('周视图回传店长月休下限 0', week.managerRestRequirement === 0, '读到 ' + week.managerRestRequirement);
    check('店长月休 0 时零提醒（managerRestNotice 为空）', !week.report?.managerRestNotice, JSON.stringify(week.report?.managerRestNotice || null));
    check('店长月休 0 时体检不报店长月休不足',
      !(week.report?.warnings || []).some((w) => w.includes('P2店长')),
      JSON.stringify(week.report?.warnings || []));
    const bossRow = (week.report?.week || []).find((p) => p.name === 'P2店长');
    check('店长的「距月休目标」为 0（不设下限）', (bossRow?.monthlyRestGap ?? -1) === 0, JSON.stringify(bossRow || null));

    const month = (await client.get('/api/month?month=2027-07')).json.data;
    check('月表回传店长月休下限 0', month.manager_rest_requirement === 0, '读到 ' + month.manager_rest_requirement);
    const bossMonth = (month.people || []).find((p) => p.name === 'P2店长');
    check('月表不给店长标「月休偏低」', !(bossMonth && bossMonth.workDays > 0 && bossMonth.restDays < bossMonth.restTarget),
      JSON.stringify(bossMonth && { workDays: bossMonth.workDays, restDays: bossMonth.restDays, restTarget: bossMonth.restTarget }));

    const back = await client.put('/api/settings', { scheduler_manager_rest_days: 2 });
    check('店长月休还原为 2', back.status === 200, back.json?.error || '');
  }

  section('15. B6 删除排班后的显示口径：0 人 = 待排（不再报「缺 N 人」）');
  {
    const M8 = '2027-08';
    const WEEK8 = '2027-08-02';
    const DAY_ALL = '2027-08-04';   // 一整天全删光（用户场景：这一天不想排了）
    const DAY_SHIFT = '2027-08-05'; // 只删一个班次（同一天别的班照常）
    const gen = await client.post('/api/schedule/generate', { week_start: WEEK8 });
    check('生成 2027-08-02 周', gen.json?.data?.ok === true, JSON.stringify(gen.json?.data?.diagnosis?.suggestions || gen.json?.error || {}));

    const before = (await client.get('/api/month?month=' + M8)).json.data;
    const beforeDay = before.days.find((d) => d.date === DAY_ALL);
    check('前置：这一天原本有人（月表算已排）', beforeDay?.scheduled === true && beforeDay.shifts.some((s) => s.people.length > 0),
      JSON.stringify(beforeDay && { scheduled: beforeDay.scheduled, people: beforeDay.shifts.map((s) => s.people.length) }));
    // 找一个这一天没班的人：删空后这天整体退出统计（休息 −1、出勤不变），不再被算成「休」
    const off = before.people.find((p) => beforeDay.shifts.every((s) => !s.people.some((q) => q.id === p.employeeId)));
    check('前置：存在当天没班的人', Boolean(off), off ? off.name + '（休息 ' + off.restDays + ' 天）' : '无');

    // ① 删掉某天全部条目：排班窗口记录还在（同周别的天还有人），这一天 0 人 → 待排
    const removedAll = await client.post('/api/schedule/clear', { scope: 'day', from: DAY_ALL });
    check('删掉这一天全部条目', removedAll.status === 200 && removedAll.json?.data?.removed > 0,
      JSON.stringify(removedAll.json?.data || removedAll.json?.error || {}));
    const weekAfter = (await client.get('/api/schedule/generate?week_start=' + WEEK8)).json.data;
    check('排班窗口记录还在（同周别的天仍有人）', Boolean(weekAfter.schedule) && weekAfter.entries.some((e) => e.work_date !== DAY_ALL),
      JSON.stringify(weekAfter.schedule || null));
    check('①周视图：删空的那天 0 条 → 三个班次格都是 0 人（显示「待排」，不再渲染红色缺员空位）',
      weekAfter.entries.filter((e) => e.work_date === DAY_ALL).length === 0,
      '该天条目 ' + weekAfter.entries.filter((e) => e.work_date === DAY_ALL).length + ' 条，本周共 ' + weekAfter.entries.length + ' 条');

    const after = (await client.get('/api/month?month=' + M8)).json.data;
    const dayAfter = after.days.find((d) => d.date === DAY_ALL);
    check('①月视图：删空的一天 scheduled=false（走「待排」分支，不渲染「缺 N 人」，垃圾桶也不显示）',
      dayAfter?.scheduled === false, JSON.stringify({ scheduled: dayAfter?.scheduled, week_status: dayAfter?.week_status }));
    check('①月视图：该天三个班次格 0 人、需求 > 0（口径 = 待排，不是缺员）',
      dayAfter.shifts.every((s) => s.people.length === 0) && dayAfter.shifts.some((s) => s.demand > 0),
      dayAfter.shifts.map((s) => s.code + ' 0/' + s.demand).join('　'));
    check('③删空的天计入「待排 N 天」、不计入「已排 N 天」',
      after.pending_days === before.pending_days + 1 && after.scheduled_days === before.scheduled_days - 1,
      '已排 ' + before.scheduled_days + '→' + after.scheduled_days + ' 天，待排 ' + before.pending_days + '→' + after.pending_days + ' 天');
    const offAfter = after.people.find((p) => p.employeeId === off.employeeId);
    check('③删空的天不再给没班的人算「休」（该天整体退出出勤/休息统计：休息 −1、出勤不变）',
      offAfter.restDays === off.restDays - 1 && offAfter.workDays === off.workDays,
      off.name + '：出勤 ' + off.workDays + '→' + offAfter.workDays + ' 天，休息 ' + off.restDays + '→' + offAfter.restDays + ' 天');
    const statMismatch = after.people.filter((p) => p.workDays + p.restDays !== after.scheduled_days)
      .map((p) => p.name + '：' + p.workDays + '+' + p.restDays + '≠' + after.scheduled_days);
    check('③每人「出勤 + 休息 = 已排天数」在删空后仍成立（该天两边都不计）',
      statMismatch.length === 0, statMismatch.slice(0, 3).join('；') || after.people.length + ' 人一致');
    check('④Excel 口径数据源一致：月表 scheduled=false → 「按员工」表写「待排」；本周该天 0 条 → 周导出同样写「待排」',
      dayAfter.scheduled === false && weekAfter.entries.filter((e) => e.work_date === DAY_ALL).length === 0,
      '（格子文案本身由 engine-test 的 shiftCellText 断言：0 人 = 「待排（需 N）」，不再写「缺 N 人」）');

    // ② 只删一个班次：这个班次 0 人 → 待排；同一天其余班次照常；0<N<需求 的格子仍报「缺 N 人」
    const earlyRows = weekAfter.entries.filter((e) => e.work_date === DAY_SHIFT && e.shift_code === 'early');
    check('前置：要删空的班次原本有人', earlyRows.length > 0, earlyRows.length + ' 人');
    for (const row of earlyRows) await client.del('/api/schedule/entries/' + row.id);
    const week2 = (await client.get('/api/schedule/generate?week_start=' + WEEK8)).json.data;
    check('②这个班次删空（周视图该格显示「待排」，灰色补人入口保留，可继续点开选人）',
      week2.entries.filter((e) => e.work_date === DAY_SHIFT && e.shift_code === 'early').length === 0);
    check('②同一天其余班次照常有人', week2.entries.some((e) => e.work_date === DAY_SHIFT && e.shift_code !== 'early'),
      '其余 ' + week2.entries.filter((e) => e.work_date === DAY_SHIFT && e.shift_code !== 'early').length + ' 条');
    const month2 = (await client.get('/api/month?month=' + M8)).json.data;
    const day2 = month2.days.find((d) => d.date === DAY_SHIFT);
    const cell2 = day2.shifts.find((s) => s.code === 'early');
    check('②月表：这一天仍算已排（混合日），被删空的班次 0 人 → 「待排」',
      day2.scheduled === true && cell2.people.length === 0 && cell2.demand > 0,
      JSON.stringify({ scheduled: day2.scheduled, early: cell2.people.length + '/' + cell2.demand }));

    // 部分缺员：再从某格撤下 1 人（原本 ≥2 人）→ 0 < 人数 < 需求 → 仍报「缺 N 人」
    let part = null;
    for (const date of [...new Set(week2.entries.map((e) => e.work_date))]) {
      for (const code of ['early', 'middle', 'night']) {
        const list = week2.entries.filter((e) => e.work_date === date && e.shift_code === code);
        const demand = month2.days.find((d) => d.date === date)?.shifts.find((s) => s.code === code)?.demand ?? 0;
        if (list.length >= 2 && demand >= list.length) { part = { date, code, entry: list[0], count: list.length, demand }; break; }
      }
      if (part) break;
    }
    check('前置：找到可制造「部分缺员」的班次', Boolean(part),
      part ? part.date + ' ' + part.code + '（' + part.count + '/' + part.demand + '）' : '无');
    await client.del('/api/schedule/entries/' + part.entry.id);
    const month3 = (await client.get('/api/month?month=' + M8)).json.data;
    const cell3 = month3.days.find((d) => d.date === part.date).shifts.find((s) => s.code === part.code);
    check('②部分缺员（0 < 人数 < 需求）仍按红色「缺 N 人」口径显示（保留现状）',
      cell3.people.length > 0 && cell3.people.length < cell3.demand,
      part.date + ' ' + part.code + '：' + cell3.people.length + '/' + cell3.demand + ' → 缺 ' + (cell3.demand - cell3.people.length) + ' 人');

    // ⑤ 显示口径不影响生成/重排：下次排班照常把 0 人的日子排上人
    const regen = await client.post('/api/schedule/regenerate', { week_start: WEEK8 });
    check('⑤重排照常工作（不因「待排」而拒绝）', regen.status === 200, JSON.stringify(regen.json?.error || {}));
    const week3 = (await client.get('/api/schedule/generate?week_start=' + WEEK8)).json.data;
    check('⑤重排后删空的那天重新有人', week3.entries.some((e) => e.work_date === DAY_ALL),
      '该天 ' + week3.entries.filter((e) => e.work_date === DAY_ALL).length + ' 条');
    const month4 = (await client.get('/api/month?month=' + M8)).json.data;
    check('⑤重排后月表该天回到「已排」', month4.days.find((d) => d.date === DAY_ALL)?.scheduled === true);
  }

  section('16. B7 锁定卡死修复：锁只保护「有人」的安排（存量自愈 / 拒绝空锁 / 跳过收紧 / 反馈细分）');
  {
    // 历史态形状照抄用户现网：锁定周里全是 employee_id 为空的空槽条目（真实库里 210 条这种记录）。
    const Database = require('better-sqlite3');
    const raw = new Database(DB_FILE);
    const all = (q, ...args) => raw.prepare(q).all(...args);
    const one = (q, ...args) => raw.prepare(q).get(...args);
    const run = (q, ...args) => raw.prepare(q).run(...args);
    const M10 = '2027-10';
    const weeks10 = [];
    for (let cur = mondayOf(M10 + '-01'); cur <= M10 + '-31'; cur = addDays(cur, 7)) weeks10.push(cur);
    const A = '2027-10-18';  // 构造成「锁定 + 0 人」的周
    const B = '2027-10-04';  // 锁定且有人：保护语义不得回退
    const D = '2027-10-06';  // 锁定周里被删空的一天（B6 口径：显示待排）
    const daysOf = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const lockedNoPeople = () => one("SELECT COUNT(*) c FROM schedule_entries WHERE status='locked' AND (employee_id IS NULL OR is_rest = 1)").c;
    const emptyLockedWeeks = () => one(`SELECT COUNT(*) c FROM schedules s WHERE s.status='locked'
      AND NOT EXISTS (SELECT 1 FROM schedule_entries se WHERE se.schedule_id = s.id AND se.employee_id IS NOT NULL AND se.is_rest = 0)`).c;
    const snapshot = (scheduleId) => all('SELECT id, employee_id, status FROM schedule_entries WHERE schedule_id = ? ORDER BY id', scheduleId)
      .map((row) => row.id + ':' + row.employee_id + ':' + row.status).join(',');

    try {
      // 前置清理：本节可重复运行 —— M10 的周先解锁 + 清空，回到「一周都没排」再开始
      for (const week of weeks10) {
        await client.post('/api/schedule/lock', { week_start: week, locked: false });
        await client.post('/api/schedule/clear', { scope: 'week', from: week });
      }
      // ① 前置：按用户操作排满整月并逐周锁定（模拟「先排好、再逐周上锁」）
      const gen1 = await client.post('/api/month/generate', { month: M10, lock: false });
      check('①前置：一键排整月把 ' + M10 + ' 排满（' + weeks10.length + ' 周全部新排）',
        gen1.json?.data?.ok === true && (gen1.json?.data?.generated_weeks || []).length === weeks10.length,
        '新排 ' + (gen1.json?.data?.generated_weeks || []).length + ' 周，跳过 ' + (gen1.json?.data?.skipped_weeks || []).length + ' 周');
      for (const week of weeks10) {
        const lock = await client.post('/api/schedule/lock', { week_start: week, locked: true });
        if (lock.status !== 200) check('①前置：锁定 ' + week, false, lock.json?.error || ('HTTP ' + lock.status));
      }
      const lockedWeeks = all("SELECT week_start FROM schedules WHERE status = 'locked'").map((r) => r.week_start);
      check('①前置：' + weeks10.length + ' 周全部锁定', weeks10.every((w) => lockedWeeks.includes(w)), lockedWeeks.join('、'));

      // 构造历史态：A 周清空成 0 人 + 写满「锁定空槽」；B 周的 D 日同样清空成 0 人
      const shifts = all('SELECT id, code FROM shift_templates ORDER BY id');
      const emptySlots = (weekStart, days) => {
        const id = one('SELECT id FROM schedules WHERE week_start = ?', weekStart).id;
        for (const day of days) for (const st of shifts) {
          run(`INSERT INTO schedule_entries (schedule_id, work_date, shift_id, shift_code, employee_id, status, source, is_rest, note)
               VALUES (?, ?, ?, ?, NULL, 'locked', 'auto', 0, NULL)`, id, day, st.id, st.code);
        }
      };
      const weekIdA = one('SELECT id FROM schedules WHERE week_start = ?', A).id;
      const weekIdB = one('SELECT id FROM schedules WHERE week_start = ?', B).id;
      run('DELETE FROM schedule_entries WHERE schedule_id = ?', weekIdA);
      emptySlots(A, daysOf(A));
      run('DELETE FROM schedule_entries WHERE schedule_id = ? AND work_date = ?', weekIdB, D);
      emptySlots(B, [D]);

      check('①构造历史态：出现 1 个「锁定 + 0 人」的周（旧代码看到 locked 就整周跳过，用户改不了也补不上）',
        emptyLockedWeeks() === 1 && one('SELECT status FROM schedules WHERE week_start = ?', A).status === 'locked'
        && lockedNoPeople() > 0,
        A + ' = locked 且 0 人；全局无人员锁定条目 ' + lockedNoPeople() + ' 条');

      // ② 自愈：读一次月表（数据加载）即可恢复
      const healed = (await client.get('/api/month?month=' + M10)).json?.data || {};
      check('①自愈：0 人的锁定周记录被清掉', one('SELECT COUNT(*) c FROM schedules WHERE week_start = ?', A).c === 0,
        'schedules 里已无 ' + A);
      check('①自愈：无人员的锁定条目清零（空槽不再冒充「锁定日」）', lockedNoPeople() === 0);
      const weekADays = (healed.days || []).filter((d) => daysOf(A).includes(d.date));
      check('①自愈后月表：' + A + ' 那一周 7 天全部「待排」且不再是锁定周',
        weekADays.length === 7 && weekADays.every((d) => d.scheduled === false) && weekADays.every((d) => d.week_status !== 'locked'),
        weekADays.map((d) => d.date.slice(5) + ':' + (d.scheduled ? '已排' : '待排') + '/' + d.week_status).join(' '));
      const weekPageA = (await client.get('/api/schedule/generate?week_start=' + A)).json?.data || {};
      check('①自愈后周表可改：该周回到「还没排班」（schedule=null，编辑按钮不再被锁死）', weekPageA.schedule === null,
        JSON.stringify(weekPageA.schedule || null));
      const dayD = (healed.days || []).find((d) => d.date === D);
      check('①锁定周里被删空的一天仍显示「待排」（B6 口径不回退，周本身仍是 locked 保护其余 6 天）',
        dayD?.scheduled === false && dayD?.week_status === 'locked',
        JSON.stringify({ date: D, scheduled: dayD?.scheduled, week_status: dayD?.week_status }));

      // ① 一键排整月把空周补上；④ 锁定且有人的周继续被跳过、条目一条不动
      const snapB = snapshot(weekIdB);
      const gen2 = await client.post('/api/month/generate', { month: M10, lock: false });
      const gd = gen2.json?.data || {};
      check('①一键排整月能补上空周：只新排 ' + A + ' 一周', gd.ok === true && JSON.stringify(gd.generated_weeks) === JSON.stringify([A]),
        JSON.stringify(gd.generated_weeks));
      check('④跳过判定收紧：锁定且有人 的 4 周仍被跳过（保护语义不回退）',
        (gd.skipped_weeks || []).length === 4 && gd.skipped_weeks.includes(B) && !gd.skipped_weeks.includes(A),
        JSON.stringify(gd.skipped_weeks));
      check('④锁定且有人 的周条目一条没动（前后快照一致）', snapshot(weekIdB) === snapB && snapB.length > 0,
        snapB.split(',').length + ' 条');
      const monthAfter = (await client.get('/api/month?month=' + M10)).json?.data || {};
      check('①补排后月表该周恢复「已排」',
        daysOf(A).every((d) => (monthAfter.days || []).find((x) => x.date === d)?.scheduled === true));
      const skippedSorted = [...(gd.skipped_weeks || [])].sort();
      check('③反馈明细带起止区间（页面按同一份数据出「新排 X 周 / 跳过 Y 周（起止）」）',
        gd.generated_weeks.join() === A && skippedSorted[0] === '2027-09-27'
        && addDays(skippedSorted[skippedSorted.length - 1], 6) === '2027-10-31',
        '新排 ' + gd.generated_weeks.join('、') + '；跳过 ' + gd.skipped_weeks.join('、'));

      // ② 0 人的周 / 天不允许锁定
      const noteWeek = '2027-11-01';
      const flag = await client.post('/api/schedule/manager', { week_start: noteWeek, no_rest: true });
      const noteWeekData = (await client.get('/api/schedule/generate?week_start=' + noteWeek)).json?.data || {};
      check('②前置：只开了「店长本周不休息」的 0 人周记录（自愈不吞窗口设置）',
        flag.status === 200 && noteWeekData.schedule !== null && noteWeekData.managerNoRest === true && noteWeekData.entries.length === 0,
        JSON.stringify({ schedule: noteWeekData.schedule, managerNoRest: noteWeekData.managerNoRest, entries: noteWeekData.entries.length }));
      const lockEmptyWeek = await client.post('/api/schedule/lock', { week_start: noteWeek, locked: true });
      check('②0 人的周拒绝锁定（复用「还没有排班，先排班再锁定」文案）',
        lockEmptyWeek.status >= 400 && String(lockEmptyWeek.json?.error || '').includes('还没有排班，先排班再锁定'),
        'HTTP ' + lockEmptyWeek.status + ' ' + (lockEmptyWeek.json?.error || ''));
      check('②拒绝锁定后该周仍是草稿、店长开关保留',
        one('SELECT status FROM schedules WHERE week_start = ?', noteWeek)?.status === 'draft'
        && (await client.get('/api/schedule/generate?week_start=' + noteWeek)).json?.data?.managerNoRest === true);

      const W11 = '2027-11-08';
      const gen11 = await client.post('/api/schedule/generate', { week_start: W11 });
      check('②前置：生成 ' + W11 + ' 周', gen11.json?.data?.ok === true,
        JSON.stringify(gen11.json?.data?.diagnosis?.suggestions || gen11.json?.error || {}));
      const D2 = '2027-11-10';
      const D3 = '2027-11-11';
      const clearD2 = await client.post('/api/schedule/clear', { scope: 'day', from: D2 });
      const lockEmptyDay = await client.post('/api/schedule/day-lock', { date: D2, locked: true });
      check('②整天 0 人（条目被删空）拒绝单日锁定',
        lockEmptyDay.status >= 400 && String(lockEmptyDay.json?.error || '').includes('还没有排班，先排班再锁定'),
        'HTTP ' + lockEmptyDay.status + ' ' + (lockEmptyDay.json?.error || '') + '（删掉 ' + clearD2.json?.data?.removed + ' 条）');
      const weekId11 = one('SELECT id FROM schedules WHERE week_start = ?', W11).id;
      const shiftEarly = one("SELECT id FROM shift_templates WHERE code = 'early'").id;
      // D3：先把这一天的人删空，再留一条空槽（历史态：有记录但 0 人）
      const clearD3 = await client.post('/api/schedule/clear', { scope: 'day', from: D3 });
      run(`INSERT INTO schedule_entries (schedule_id, work_date, shift_id, shift_code, employee_id, status, source, is_rest, note)
           VALUES (?, ?, ?, 'early', NULL, 'draft', 'auto', 0, NULL)`, weekId11, D3, shiftEarly);
      const lockNoPeopleDay = await client.post('/api/schedule/day-lock', { date: D3, locked: true });
      check('②只剩空槽（有记录但 0 人）同样拒绝单日锁定',
        lockNoPeopleDay.status >= 400 && String(lockNoPeopleDay.json?.error || '').includes('还没有排班，先排班再锁定'),
        'HTTP ' + lockNoPeopleDay.status + ' ' + (lockNoPeopleDay.json?.error || '') + '（删掉 ' + clearD3.json?.data?.removed + ' 条）');
      run('DELETE FROM schedule_entries WHERE schedule_id = ? AND work_date = ? AND employee_id IS NULL', weekId11, D3);

      // ⑤ 一键排整月默认不勾选自动锁定（静态断言：默认值就在页面源码里；注释先去掉再扫文案）
      const monthSrc = fs.readFileSync(path.join(import.meta.dirname, '../app/(main)/month/page.tsx'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      check('⑤一键排整月默认不勾选「自动锁定」', /const \[autoLock, setAutoLock\] = useState\(false\)/.test(monthSrc));
      check('⑤文案改为「排完后自动锁定（锁了要改需先解锁）」，去掉过时的推荐理由',
        monthSrc.includes('排完后自动锁定（锁了要改需先解锁）') && !monthSrc.includes('推荐：月度汇总只展示已锁定的周'));
      check('③页面不再出现「共处理 N 周」，反馈走 monthGenerateFeedback（新排/跳过明细 + 起止 + 解锁提示）',
        monthSrc.includes('monthGenerateFeedback(') && !monthSrc.includes('共处理')
        && monthSrc.includes('generated_weeks') && monthSrc.includes('skipped_weeks'));
    } finally {
      raw.close();
    }
  }

  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  P2 自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('  失败明细：'); failures.forEach((f) => console.log('   · ' + f)); }
  console.log('════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('自测脚本异常：', err); process.exit(2); });
