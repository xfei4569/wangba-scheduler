import { addDays, daysInMonth, eachDate, isWeekend } from '../date';
import { weekStartDate } from './week';
import { getDb } from '../db';
import { listEmployees, listShifts, mapRequirement } from '../repo';
import { getSettingNumber } from '../settings';
import { SK } from '../settings-defaults';
import { baseDemandFor, demandFor, REST_RELIEF_CAP, type EngineInput } from './engine';
import { healEmptyLocks } from './heal';
import { isManager, type Employee, type Requirement } from '../types';

/**
 * 月度汇总（P2）
 * - 只统计「已锁定的周」；草稿周与未排周在视图里显示为「待排」，且不计入统计
 * - 隐私红线：本模块只读 schedule_entries 与 leave 类要求，绝不读取 pairing（不搭班）
 */

export type DayType = 'weekday' | 'weekend' | 'holiday';
export type WeekStatus = 'locked' | 'draft' | 'none';

export interface SlotDemand {
  date: string;
  code: string;
  name: string;
  start_time: string;
  demand: number;
  base: number;
  override: boolean;
}

export interface EngineContext {
  shifts: ReturnType<typeof listShifts>;
  requirements: Requirement[];
  holidays: Record<string, 'holiday' | 'workday'>;
  holidayNames: Record<string, string>;
}

export function engineContext(): EngineContext {
  const db = getDb();
  const shifts = listShifts(true);
  const requirements = (db.prepare('SELECT * FROM requirements WHERE active = 1 ORDER BY id').all() as Record<string, unknown>[])
    .map(mapRequirement) as Requirement[];
  const rows = db.prepare('SELECT date, kind, name FROM holidays').all() as { date: string; kind: 'holiday' | 'workday'; name: string }[];
  const holidays: Record<string, 'holiday' | 'workday'> = {};
  const holidayNames: Record<string, string> = {};
  for (const r of rows) {
    holidays[r.date] = r.kind;
    holidayNames[r.date] = r.name;
  }
  return { shifts, requirements, holidays, holidayNames };
}

export function dayTypeAt(date: string, holidays: Record<string, 'holiday' | 'workday'>): DayType {
  const kind = holidays[date];
  if (kind === 'holiday') return 'holiday';
  if (kind === 'workday') return 'weekday';
  return isWeekend(date) ? 'weekend' : 'weekday';
}

export const DAY_TYPE_CN: Record<DayType, string> = { weekday: '平日', weekend: '周末', holiday: '法定节假日' };

export function demandInput(ctx: EngineContext, weekStart: string): EngineInput {
  return { weekStart, employees: [], shifts: ctx.shifts, requirements: ctx.requirements, holidays: ctx.holidays, existing: [], fixed: [] };
}

/**
 * 某段日期里每天每班的需求人数（含临时改人数）。
 * relief 是「压连休补进来的位子」计数（key = 日期|班次）：这些座是引擎自己加的，
 * 不算进该班人数的话，月表会把补进来的人标成「多 1 人」。
 */
export function demandGrid(ctx: EngineContext, dates: string[], relief?: Map<string, number>): SlotDemand[] {
  if (!dates.length) return [];
  const input = demandInput(ctx, weekStartDate(dates[0]));
  return dates.flatMap((date) => ctx.shifts.map((shift) => {
    const base = baseDemandFor(date, shift, input);
    const raw = demandFor(date, shift, input);
    const extra = relief?.get(date + '|' + shift.code) || 0;
    const demand = extra ? Math.min(REST_RELIEF_CAP, raw + extra) : raw;
    return { date, code: shift.code, name: shift.name, start_time: shift.start_time, demand, base, override: raw !== base };
  }));
}

export function weekDemand(weekStart: string): SlotDemand[] {
  return demandGrid(engineContext(), eachDate(weekStart, addDays(weekStart, 6)));
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-\d{2}$/.test(month) && Number(month.slice(5, 7)) >= 1 && Number(month.slice(5, 7)) <= 12;
}

export function monthEndOf(month: string): string {
  const total = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  return month + '-' + String(total).padStart(2, '0');
}

/** 与本月有交集的自然周（起点按设置的「一周起始日」，缺省周一） */
export function weeksOfMonth(month: string): string[] {
  const last = monthEndOf(month);
  const out: string[] = [];
  let cur = weekStartDate(month + '-01');
  while (cur <= last) {
    out.push(cur);
    cur = addDays(cur, 7);
  }
  return out;
}

/** 同月内同一「日期类型」的所有日期（用于「应用到本月所有同类日」） */
export function sameKindDates(date: string, ctx: EngineContext): string[] {
  const month = monthOf(date);
  const kind = dayTypeAt(date, ctx.holidays);
  return eachDate(month + '-01', monthEndOf(month)).filter((d) => dayTypeAt(d, ctx.holidays) === kind);
}

/* ------------------------------------------------------------------ */

export interface MonthShiftCell {
  code: string;
  name: string;
  start_time: string;
  demand: number;
  base: number;
  override: boolean;
  people: { id: number; name: string; source: string }[];
}

export interface MonthDay {
  date: string;
  day: number;
  weekday: string;
  day_type: DayType;
  day_type_cn: string;
  holiday_name: string | null;
  week_start: string;
  week_status: WeekStatus;
  /** B6：这一天有没有任何人员安排。整天 0 人（含「排过后又删空」）= 未排 → 界面显示「待排」 */
  scheduled: boolean;
  /** 单日锁定（问题③）：整周锁定时由周状态表达，这里只在「草稿周里的锁定日」为 true */
  day_locked: boolean;
  shifts: MonthShiftCell[];
  leaves: { employeeId: number; name: string; type: string }[];
}

export interface MonthPerson {
  employeeId: number;
  name: string;
  status: string;
  /** 需求②③④：徽章与规则展示用 */
  gender: string;
  seniority: string;
  can_teach: number;
  position: string;
  workDays: number;
  restDays: number;
  early: number;
  middle: number;
  night: number;
  /** 按已排窗口折算出来的月休要求（用于判断是否偏低） */
  restTarget: number;
}

export interface MonthSummary {
  month: string;
  month_label: string;
  weekdays: string[];
  total_days: number;
  scheduled_days: number;
  pending_days: number;
  weeks: { weekStart: string; weekEnd: string; status: WeekStatus; label: string }[];
  days: MonthDay[];
  people: MonthPerson[];
  shifts: { code: string; name: string; start_time: string; end_time: string }[];
  rest_requirement: number;
  /** 店长月休下限（0 = 不设下限） */
  manager_rest_requirement: number;
  draft_weeks: number;
  has_draft: boolean;
}

function employed(e: Employee, date: string): boolean {
  if (e.status === 'resigned') return Boolean(e.leave_date && e.leave_date >= date);
  if (e.hire_date && e.hire_date > date) return false;
  if (e.leave_date && e.leave_date < date) return false;
  return true;
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = (date: string) => WEEKDAY_CN[new Date(date + 'T00:00:00Z').getUTCDay()];

export function monthSummary(month: string): MonthSummary {
  const db = getDb();
  // B7 读数据时自愈：「锁定但 0 人」的周记录没有任何要保护的安排，先清掉再汇总，
  // 这样 10/21 之后这种周在月表里显示「待排」、一键排整月也能补上（幂等）。
  healEmptyLocks();
  const ctx = engineContext();
  const first = month + '-01';
  const last = monthEndOf(month);
  const dates = eachDate(first, last);

  const scheduleRows = db.prepare('SELECT week_start, week_end, status FROM schedules').all() as {
    week_start: string; week_end: string; status: 'draft' | 'locked';
  }[];
  // 起始日自选后窗口不再对齐全局周期：每天归到「包含它的排班窗口」，
  // 重叠时取起始日最晚的窗口（= 最近一次排班的口径），月表「临时人数」跳转才落得准
  const scheduleByDate = new Map<string, { week_start: string; status: WeekStatus }>();
  for (const s of [...scheduleRows].sort((a, b) => a.week_start.localeCompare(b.week_start))) {
    for (const d of eachDate(s.week_start, s.week_end)) scheduleByDate.set(d, { week_start: s.week_start, status: s.status });
  }

  const entryRows = db.prepare(
    `SELECT se.work_date, se.shift_code, se.employee_id, se.source, se.note, se.status, e.name AS employee_name
       FROM schedule_entries se LEFT JOIN employees e ON e.id = se.employee_id
      WHERE se.work_date BETWEEN ? AND ? AND se.is_rest = 0`
  ).all(first, last) as { work_date: string; shift_code: string; employee_id: number | null; source: string; note: string | null; status: string; employee_name: string | null }[];
  // 单日锁定：这一天有条目是 locked（整周锁定时也算，但那时由周状态统一表达，不重复标）
  const dayLockedDates = new Set(entryRows.filter((row) => row.status === 'locked').map((row) => row.work_date));

  // 压连休补进来的座：算进该班「该有几个人」，否则月表把引擎自己补的人标成「多 1 人」
  const relief = new Map<string, number>();
  for (const row of entryRows) {
    if (row.note !== 'relief') continue;
    const key = row.work_date + '|' + row.shift_code;
    relief.set(key, (relief.get(key) || 0) + 1);
  }
  const demand = demandGrid(ctx, dates, relief);
  const leaves = ctx.requirements.filter((r) => r.type === 'leave' && r.date_start && r.date_end);
  const employees = listEmployees();

  const days: MonthDay[] = dates.map((date) => {
    const hit = scheduleByDate.get(date);
    const weekStart = hit?.week_start ?? weekStartDate(date);
    const weekStatus: WeekStatus = hit?.status ?? 'none';
    // B6 显示口径：已排 = 这一天「有没有人」，与排班窗口记录（schedules 行）无关。
    // 删空的排班日（哪怕窗口记录还在）整天 0 人 → 视同未排：月表显示「待排」、计入 pending_days、
    // 不计入 scheduled_days 与出勤/休息统计；混合日（部分班次有人）整日仍算已排。
    // 草稿 / 锁定只影响 week_status（草稿=还能改，锁定=定稿），不再决定这一天算不算已排。
    const dayEntries = entryRows.filter((e) => e.work_date === date && e.employee_id);
    const scheduled = dayEntries.length > 0;
    const dayType = dayTypeAt(date, ctx.holidays);
    return {
      date,
      day: Number(date.slice(8, 10)),
      weekday: weekdayOf(date),
      day_type: dayType,
      day_type_cn: DAY_TYPE_CN[dayType],
      holiday_name: ctx.holidayNames[date] || null,
      week_start: weekStart,
      week_status: weekStatus,
      scheduled,
      day_locked: weekStatus !== 'locked' && dayLockedDates.has(date),
      shifts: ctx.shifts.map((shift) => {
        const cell = demand.find((d) => d.date === date && d.code === shift.code);
        return {
          code: shift.code,
          name: shift.name,
          start_time: shift.start_time,
          demand: cell?.demand ?? 0,
          base: cell?.base ?? 0,
          override: cell?.override ?? false,
          people: dayEntries
            .filter((e) => e.shift_code === shift.code)
            .map((e) => ({ id: e.employee_id as number, name: e.employee_name || '已删除员工', source: e.source })),
        };
      }),
      // 请假/月休标注：任何周都显示（属于「要求」，不是排班结果）
      leaves: leaves
        .filter((r) => r.date_start! <= date && r.date_end! >= date)
        .map((r) => ({
          employeeId: r.employee_id as number,
          name: employees.find((e) => e.id === r.employee_id)?.name || '未知员工',
          type: r.leave_type || '请假',
        })),
    };
  });

  const scheduledDates = days.filter((d) => d.scheduled).map((d) => d.date);
  const scheduledSet = new Set(scheduledDates);
  const totalDays = dates.length;
  const restRequired = getSettingNumber(SK.schedulerMinRestDays, 4);
  // 店长月休单独一项（问题②）：0 = 不设下限 → 目标 0、不标「月休偏低」；>0 才按已排天数折算
  const managerRestRequired = getSettingNumber(SK.schedulerManagerRestDays, 2);

  const people: MonthPerson[] = employees
    .filter((e) => e.status === 'active' || entryRows.some((row) => row.employee_id === e.id) || leaves.some((r) => r.employee_id === e.id))
    .map((e) => {
      const mine = entryRows.filter((row) => row.employee_id === e.id && scheduledSet.has(row.work_date));
      const eligible = scheduledDates.filter((d) => employed(e, d)).length;
      const workDays = new Set(mine.map((r) => r.work_date)).size;
      return {
        employeeId: e.id,
        name: e.name,
        status: e.status,
        gender: e.gender || '',
        seniority: e.seniority || '老人',
        can_teach: e.can_teach === undefined ? 1 : e.can_teach,
        position: e.position || '员工',
        workDays,
        restDays: Math.max(0, eligible - workDays),
        early: mine.filter((r) => r.shift_code === 'early').length,
        middle: mine.filter((r) => r.shift_code === 'middle').length,
        night: mine.filter((r) => r.shift_code === 'night').length,
        restTarget: (() => {
          const required = isManager(e) ? managerRestRequired : restRequired;
          return eligible && required > 0 ? Math.max(0, Math.round((eligible * required) / totalDays)) : 0;
        })(),
      };
    })
    .sort((a, b) => b.workDays - a.workDays || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  const weeks = weeksOfMonth(month).map((weekStart) => ({
    weekStart,
    weekEnd: addDays(weekStart, 6),
    status: (scheduleByDate.get(weekStart)?.status ?? 'none') as WeekStatus,
    label: weekStart.slice(5) + ' ~ ' + addDays(weekStart, 6).slice(5),
  }));

  return {
    month,
    month_label: month.slice(0, 4) + ' 年 ' + Number(month.slice(5, 7)) + ' 月',
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    total_days: totalDays,
    scheduled_days: scheduledDates.length,
    pending_days: totalDays - scheduledDates.length,
    weeks,
    days,
    people,
    shifts: ctx.shifts.map((s) => ({ code: s.code, name: s.name, start_time: s.start_time, end_time: s.end_time })),
    rest_requirement: restRequired,
    manager_rest_requirement: managerRestRequired,
    draft_weeks: weeks.filter((w) => w.status === 'draft').length,
    has_draft: weeks.some((w) => w.status === 'draft'),
  };
}
