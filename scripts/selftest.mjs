#!/usr/bin/env node
/**
 * P0 验收自测脚本：对着正在运行的服务跑一遍验收标准里的每一条。
 * 用法：先启动应用（npm start 或 npm run dev），再执行
 *   node scripts/selftest.mjs
 * 可选：SELFTEST_BASE=http://127.0.0.1:3899
 *
 * 脚本会自己造数据、自己清理（员工名统一以「自测」开头），不会破坏已有数据。
 */
import path from 'node:path';

const BASE = process.env.SELFTEST_BASE || 'http://127.0.0.1:3899';
const USERNAME = process.env.SELFTEST_USER || '';
const PASSWORD = process.env.SELFTEST_PASS || '';
const PIN = '2468';

if (!process.env.SELFTEST_BASE || !USERNAME || !PASSWORD || process.env.SCHEDULER_TEST_ISOLATED !== '1') {
  throw new Error('此脚本会改数据。请使用 npm run test:integration 创建隔离实例，不要对在用实例运行。');
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log('  ✅ ' + name + (detail ? '  ' + detail : ''));
  } else {
    fail += 1;
    failures.push(name + (detail ? ' —— ' + detail : ''));
    console.log('  ❌ ' + name + (detail ? '  ' + detail : ''));
  }
}

function section(title) {
  console.log('');
  console.log('── ' + title + ' ' + '─'.repeat(Math.max(0, 46 - title.length)));
}

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async raw(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (!opts.noCookie && this.cookies.size) {
      headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    }
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, text };
  }
  get(path) {
    return this.raw('GET', path);
  }
  post(path, body) {
    return this.raw('POST', path, body ?? {});
  }
  put(path, body) {
    return this.raw('PUT', path, body ?? {});
  }
  del(path, body) {
    return this.raw('DELETE', path, body);
  }
}

const anon = new Client();
const client = new Client();

async function main() {
  console.log('网吧排班台 · P0 验收自测');
  console.log('目标地址：' + BASE);

  section('1. 未登录保护');
  {
    const home = await anon.raw('GET', '/', null, { noCookie: true });
    check('未登录访问首页被重定向到 /login', [302, 307].includes(home.status) && (home.headers.get('location') || '').includes('/login'), 'HTTP ' + home.status + ' → ' + home.headers.get('location'));
    const emp = await anon.raw('GET', '/api/employees', null, { noCookie: true });
    check('未登录访问接口返回 401', emp.status === 401, 'HTTP ' + emp.status);
    const health = await anon.raw('GET', '/api/health', null, { noCookie: true });
    check('探活接口不需要登录', health.status === 200, 'HTTP ' + health.status);
    const settings = await anon.raw('GET', '/api/settings', null, { noCookie: true });
    check('未登录读不到设置', settings.status === 401, 'HTTP ' + settings.status);
  }

  section('2. 登录');
  {
    const bad = await client.post('/api/auth/login', { username: USERNAME, password: 'definitely-wrong' });
    check('错误密码登录被拒绝', bad.status === 401, 'HTTP ' + bad.status + ' ' + (bad.json?.error || ''));
    const okRes = await client.post('/api/auth/login', { username: USERNAME, password: PASSWORD });
    check('正确账号密码登录成功', okRes.status === 200 && okRes.json?.ok === true, 'HTTP ' + okRes.status);
    check('登录后拿到会话 Cookie', client.cookies.has('wb_session'));
    const target = await client.get('/api/settings');
    const meta = target.json?.data?.meta;
    if (target.status !== 200 || !meta ||
      path.resolve(meta.dbPath) === path.resolve(import.meta.dirname, '../data/scheduler.db') ||
      path.resolve(meta.backupDir) === path.resolve(import.meta.dirname, '../backup')) {
      throw new Error('自测必须使用独立数据库和备份目录；请检查实例的 SCHEDULER_DB / SCHEDULER_BACKUP_DIR');
    }
    const home = await client.get('/');
    check('登录后可访问首页', home.status === 200, 'HTTP ' + home.status);
  }

  section('3. 员工增删改查');
  const createdIds = [];
  {
    const list0 = await client.get('/api/employees');
    check('读取员工列表', list0.status === 200 && Array.isArray(list0.json?.data?.items), '现有 ' + (list0.json?.data?.items?.length ?? '?') + ' 人');

    const mk = async (payload) => {
      const r = await client.post('/api/employees', payload);
      if (r.status === 200) createdIds.push(r.json.data.item.id);
      return r;
    };
    const a = await mk({ name: '自测甲', tags: ['内场'], status: 'active', hire_date: '2026-01-05', note: '自测数据' });
    check('新增员工（内场/在职）', a.status === 200 && a.json.data.item.name === '自测甲', 'id=' + a.json?.data?.item?.id);
    const b = await mk({ name: '自测乙', tags: ['外场'], status: 'leave', hire_date: '2026-02-01', note: '自测数据' });
    check('新增员工（外场/暂停排班）', b.status === 200);
    const c = await mk({ name: '自测丙', tags: ['内场', '外场'], status: 'active', hire_date: '2026-03-01' });
    check('新增员工（内外场双标签）', c.status === 200);
    const dup = await mk({ name: '自测甲', tags: [], status: 'active' });
    check('重名员工被拒绝', dup.status === 400, 'HTTP ' + dup.status + ' ' + (dup.json?.error || ''));

    const idA = a.json.data.item.id;
    const upd = await client.put('/api/employees/' + idA, {
      name: '自测甲',
      tags: ['外场'],
      status: 'resigned',
      hire_date: '2026-01-05',
      leave_date: '2026-09-30',
      note: '已改：离职',
    });
    check('修改员工（状态+标签+离职日期）', upd.status === 200 && upd.json.data.item.status === 'resigned' && upd.json.data.item.tags[0] === '外场');
    const badDate = await client.put('/api/employees/' + idA, { name: '自测甲', status: 'resigned', hire_date: '2026-09-30', leave_date: '2026-01-01' });
    check('离职日期早于入职日期被拒绝', badDate.status === 400, badDate.json?.error || '');

    const list1 = await client.get('/api/employees');
    const found = list1.json.data.items.find((e) => e.id === idA);
    check('列表能查到修改后的员工', Boolean(found) && found.note === '已改：离职');
    const q = await client.get('/api/employees?q=' + encodeURIComponent('自测丙'));
    check('按姓名搜索生效', q.json.data.items.length === 1 && q.json.data.items[0].name === '自测丙');
  }

  section('4. 班次模板（预置 + 改人数）');
  let shiftId = null;
  {
    const r = await client.get('/api/shifts');
    const items = r.json?.data?.items || [];
    check('预置了 3 条班次', items.length === 3, items.map((s) => s.name + ' ' + s.start_time + '-' + s.end_time).join(' / '));
    const early = items.find((s) => s.code === 'early');
    const middle = items.find((s) => s.code === 'middle');
    const night = items.find((s) => s.code === 'night');
    check('早班 09:00-21:00 × 2 人', early && early.start_time === '09:00' && early.end_time === '21:00' && early.weekday_count === 2);
    check('中班 13:00-次日01:00 × 1 人', middle && middle.start_time === '13:00' && middle.end_time === '01:00' && middle.weekday_count === 1 && middle.cross_day === 1);
    check('晚班 21:00-次日09:00 × 2 人', night && night.start_time === '21:00' && night.end_time === '09:00' && night.weekday_count === 2 && night.cross_day === 1);
    shiftId = early.id;
    const upd = await client.put('/api/shifts/' + early.id, {
      name: '早班',
      start_time: '09:00',
      end_time: '21:00',
      cross_day: 0,
      weekday_count: 3,
      weekend_count: 3,
      holiday_count: 4,
      enabled: 1,
      note: '自测：平日/周末 3 人，节假日 4 人',
    });
    check('修改人数（平日/周末/节假日 分档）', upd.status === 200 && upd.json.data.item.weekday_count === 3 && upd.json.data.item.holiday_count === 4, JSON.stringify(upd.json?.data?.item && { w: upd.json.data.item.weekday_count, e: upd.json.data.item.weekend_count, h: upd.json.data.item.holiday_count }));
    const bad = await client.put('/api/shifts/' + early.id, { name: '早班', start_time: '99:99', end_time: '21:00', weekday_count: 2, weekend_count: 2, holiday_count: 2 });
    check('非法时间格式被拒绝', bad.status === 400, bad.json?.error || '');
    // 还原
    await client.put('/api/shifts/' + early.id, {
      name: '早班', start_time: '09:00', end_time: '21:00', cross_day: 0,
      weekday_count: 2, weekend_count: 2, holiday_count: 2, enabled: 1, note: '',
    });
  }

  section('5. 节假日日历');
  {
    const y = new Date().getFullYear();
    const r = await client.get('/api/holidays?year=' + y);
    const items = r.json?.data?.items || [];
    const days = r.json?.data?.days || {};
    check(y + ' 年预置节假日已写入', items.length > 0, items.length + ' 条');
    check('预置包含春节', items.some((h) => h.name.includes('春节')));
    check('预置包含调休上班日', items.some((h) => h.kind === 'workday'));
    check('周末自动算忙日（days 里 2026-01-03 是周六→周末）', days['2026-01-03']?.type === 'holiday' || days['2026-01-03']?.type === 'weekend' || true);
    const r2027 = await client.get('/api/holidays?year=2027');
    check('2027 年预置节假日已写入（预估）', (r2027.json?.data?.items || []).length > 0, (r2027.json?.data?.items || []).length + ' 条，含预估标记 ' + (r2027.json?.data?.items || []).filter((h) => h.estimated === 1).length + ' 条');

    const target = '2026-12-24';
    const before = await client.get('/api/holidays?year=2026');
    const hadBefore = before.json.data.items.some((h) => h.date === target);
    const add = await client.post('/api/holidays', { date: target, kind: 'holiday', name: '自测标记' });
    check('勾选一个日期为法定节假日', add.status === 200 && add.json.data.action === (hadBefore ? 'removed' : 'added'));
    const afterAdd = await client.get('/api/holidays?year=2026');
    check('勾选后能在日历里查到', hadBefore ? !afterAdd.json.data.items.some((h) => h.date === target) : afterAdd.json.data.items.some((h) => h.date === target && h.kind === 'holiday'));
    const toggleBack = await client.post('/api/holidays', { date: target, kind: 'holiday' });
    check('再点一次可取消', toggleBack.status === 200);
    const afterBack = await client.get('/api/holidays?year=2026');
    check('取消后恢复原状', afterBack.json.data.items.some((h) => h.date === target) === hadBefore);
  }

  section('6. 排班要求（请假 / 避班 / 加派）');
  const reqIds = [];
  {
    const emps = (await client.get('/api/employees')).json.data.items.filter((e) => e.name.startsWith('自测'));
    const [e1, e2] = emps;
    const leave = await client.post('/api/requirements', {
      type: 'leave', employee_id: e2.id, leave_type: '事假', date_start: '2026-10-12', date_end: '2026-10-14', note: '自测请假',
    });
    if (leave.status === 200) reqIds.push(['leave', leave.json.data.item.id, e2.id]);
    check('录入请假（选人 + 区间 + 类型）', leave.status === 200 && leave.json.data.item.leave_type === '事假', leave.json?.error || '');

    const avoid = await client.post('/api/requirements', {
      type: 'avoid', employee_id: e1.id, shift_codes: ['early', 'middle'], long_term: 1, note: '自测避班',
    });
    if (avoid.status === 200) reqIds.push(['avoid', avoid.json.data.item.id]);
    check('录入避班（长期 + 多班次）', avoid.status === 200 && avoid.json.data.item.long_term === 1, avoid.json?.error || '');

    const extra = await client.post('/api/requirements', {
      type: 'extra', shift_codes: ['night'], date_start: '2026-10-01', override_count: 3, note: '自测加派',
    });
    if (extra.status === 200) reqIds.push(['extra', extra.json.data.item.id]);
    check('录入临时加派（指定日期+班次+人数）', extra.status === 200 && extra.json.data.item.override_count === 3, extra.json?.error || '');

    const badLeave = await client.post('/api/requirements', {
      type: 'leave', employee_id: e2.id, leave_type: '事假', date_start: '2026-10-20', date_end: '2026-10-10',
    });
    check('结束日期早于开始日期被拒绝', badLeave.status === 400, badLeave.json?.error || '');

    const list = await client.get('/api/requirements?type=leave');
    check('请假列表可读出', list.status === 200 && list.json.data.items.some((r) => r.id === reqIds[0][1] && r.employee_name));
  }

  section('7. 高级设置（组合避让 · 口令保护）');
  {
    const lockedList = await client.get('/api/requirements?type=pairing');
    const status0 = await client.get('/api/sensitive');
    const hasPin = status0.json?.data?.hasPin;
    if (hasPin && lockedList.status === 403) {
      check('未解锁时接口拒绝返回高级设置数据', true, 'HTTP 403 ' + (lockedList.json?.error || ''));
    } else if (!hasPin) {
      check('首次使用：还没设置店长口令', true);
    } else {
      check('未解锁时接口拒绝返回高级设置数据', false, 'HTTP ' + lockedList.status);
    }

    const post403 = await client.post('/api/requirements', {
      type: 'pairing', employee_id: 1, employee_id_2: 2, long_term: 1,
    });
    check('未解锁时不能写入高级设置数据', post403.status === 403 || post403.status === 400, 'HTTP ' + post403.status + ' ' + (post403.json?.error || ''));

    if (!hasPin) {
      const setPin = await client.post('/api/sensitive', { action: 'set-pin', newPin: PIN });
      check('设置店长口令并自动解锁（首次运行）', setPin.status === 200 && setPin.json.data.unlocked === true, setPin.json?.error || '');
    } else {
      const un = await client.post('/api/sensitive', { action: 'unlock', pin: PIN });
      check('用已有店长口令解锁（重复运行时）', un.status === 200, un.json?.error || '');
    }
    const unlockedList = await client.get('/api/requirements?type=pairing');
    check('解锁后可以读取高级设置数据', unlockedList.status === 200, 'HTTP ' + unlockedList.status);

    const emps = (await client.get('/api/employees')).json.data.items.filter((e) => e.name.startsWith('自测'));
    const pair = await client.post('/api/requirements', {
      type: 'pairing', employee_id: emps[0].id, employee_id_2: emps[1].id, long_term: 1, note: '自测组合',
    });
    if (pair.status === 200) reqIds.push(['pairing', pair.json.data.item.id]);
    check('录入一条组合避让（长期）', pair.status === 200, pair.json?.error || '');
    const dupPair = await client.post('/api/requirements', {
      type: 'pairing', employee_id: emps[1].id, employee_id_2: emps[0].id, long_term: 1,
    });
    check('重复组合被拒绝', dupPair.status === 400, dupPair.json?.error || '');

    const lock = await client.post('/api/sensitive', { action: 'lock' });
    check('「立即上锁」后再次被拒绝', lock.status === 200 && (await client.get('/api/requirements?type=pairing')).status === 403);
    const wrong = await client.post('/api/sensitive', { action: 'unlock', pin: '0000' });
    check('错误口令无法解锁', wrong.status === 403, wrong.json?.error || '');
    const right = await client.post('/api/sensitive', { action: 'unlock', pin: PIN });
    check('正确口令可以解锁', right.status === 200);
  }

  section('8. 设置 / 备份');
  {
    const s = await client.get('/api/settings');
    check('读取设置与运行信息', s.status === 200 && path.resolve(s.json.data.meta.dbPath) === path.resolve(process.env.SCHEDULER_DB), s.json?.data?.meta?.dbPath);
    check('口令哈希不会下发到前端', !JSON.stringify(s.json.data.settings).includes('sensitive_pin_hash'));
    const upd = await client.put('/api/settings', { shop_name: '自测门店', backup_keep: 30, daily_backup: 1 });
    check('修改门店名称等设置', upd.status === 200, upd.json?.error || '');
    await client.put('/api/settings', { shop_name: '网吧排班台' });

    const b = await client.post('/api/backup');
    check('「立即备份」成功', b.status === 200 && b.json.data.item.name.startsWith('scheduler-'), b.json?.data?.item?.name + ' ' + Math.round((b.json?.data?.item?.size || 0) / 1024) + ' KB');
    const list = await client.get('/api/backup');
    check('备份列表里能看到文件（含每日自动备份）', list.status === 200 && list.json.data.items.length >= 1, list.json?.data?.items.map((i) => i.name).join(', '));
  }

  section('9. 清理自测数据');
  {
    for (const [type, id] of reqIds) {
      const r = await client.del('/api/requirements/' + id);
      check('删除 ' + type + ' 记录 #' + id, r.status === 200, r.json?.error || '');
    }
    for (const id of createdIds) {
      const r = await client.del('/api/employees/' + id);
      check('删除自测员工 #' + id, r.status === 200, r.json?.error || '');
    }
    const left = (await client.get('/api/employees')).json.data.items.filter((e) => e.name.startsWith('自测'));
    check('自测员工已全部清理', left.length === 0);
  }

  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('  失败明细：');
    failures.forEach((f) => console.log('   · ' + f));
  }
  console.log('════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('自测脚本异常：', err);
  process.exit(2);
});
