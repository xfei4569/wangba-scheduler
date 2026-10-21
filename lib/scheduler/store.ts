import { getDb } from '../db';
import { addDays, daysInMonth, eachDate, todayStr } from '../date';
import { listEmployees, listShifts, mapRequirement } from '../repo';
import { getAllSettings } from '../settings';
import type { Requirement } from '../types';
import { generate, type Assignment, type EngineInput, type EngineResult, type Weights } from './engine';
import { healEmptyLocks } from './heal';
import { weekStartDate } from './week';

type EntryRow = Assignment & { schedule_id: number; employee_name: string | null };

/** 这一批条目里有没有「真正排了人」的（employee_id 非空且不是休息占位）—— 锁只保护有人的安排 */
export function hasPeople(entries: { employee_id: number | null; is_rest?: number }[]): boolean {
  return entries.some((entry) => entry.employee_id && !entry.is_rest);
}

/** 这一周（7 天窗口）里有没有真正排了人：0 人的周无论锁没锁都视同未排（要照排 / 可改） */
export function weekHasPeople(weekStart: string): boolean {
  const db = getDb();
  return Boolean(db.prepare(`SELECT 1 AS hit FROM schedule_entries
    WHERE work_date BETWEEN ? AND ? AND employee_id IS NOT NULL AND is_rest = 0 LIMIT 1`).get(weekStart, addDays(weekStart, 6)));
}

/**
 * 改「一周起始日」后把现有班表按新周期重新分组：谁上哪天不变，只改「一周」的边界。
 * 每个班次归到它日期所在的新周；新周的锁定状态 = 该周所有班次都锁定才算锁定。
 */
export function regroupWeeks(): number {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare('SELECT id, work_date, status, schedule_id FROM schedule_entries').all() as { id: number; work_date: string; status: string; schedule_id: number }[];
    const oldStatus = new Map((db.prepare('SELECT id, status FROM schedules').all() as { id: number; status: string }[]).map((s) => [s.id, s.status]));
    const groups = new Map<string, { ids: number[]; locked: boolean }>();
    for (const row of rows) {
      const week = weekStartDate(row.work_date);
      const g = groups.get(week) || { ids: [], locked: true };
      g.ids.push(row.id);
      if (row.status !== 'locked' || oldStatus.get(row.schedule_id) !== 'locked') g.locked = false;
      groups.set(week, g);
    }
    const find = db.prepare('SELECT id FROM schedules WHERE week_start = ?');
    const create = db.prepare('INSERT INTO schedules (week_start, week_end, status, generated_at) VALUES (?, ?, ?, datetime(\'now\',\'localtime\'))');
    const widen = db.prepare('UPDATE schedules SET week_end = ?, status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?');
    const move = db.prepare('UPDATE schedule_entries SET schedule_id = ? WHERE id = ?');
    for (const [week, g] of groups) {
      const weekEnd = addDays(week, 6);
      const status = g.locked ? 'locked' : 'draft';
      const existing = find.get(week) as { id: number } | undefined;
      const id = existing ? (widen.run(weekEnd, status, existing.id), existing.id) : Number(create.run(week, weekEnd, status).lastInsertRowid);
      for (const entryId of g.ids) move.run(id, entryId);
    }
    db.prepare('DELETE FROM schedules WHERE id NOT IN (SELECT DISTINCT schedule_id FROM schedule_entries)').run();
    return groups.size;
  })();
}

export function weekData(weekStart: string) {
  const db = getDb();
  // B7 读数据时自愈：把「锁定但 0 人」的存量状态清掉（幂等，无事可做时零写入），
  // 保证用户翻到任何一周看到的都是「锁只保护有人的安排」。
  healEmptyLocks();
  const schedule = db.prepare('SELECT * FROM schedules WHERE week_start = ?').get(weekStart) as { id: number; status: 'draft' | 'locked'; week_end: string; note: string | null } | undefined;
  // 按日期窗口取条目（不限本窗口的 schedule）：起始日自选后窗口会重叠，
  // 上一窗口已排的天必须照常显示、且不被本窗口的重算动到（runSchedule 只删自己 schedule 的条目）
  const entries = db.prepare(`SELECT se.*, e.name AS employee_name FROM schedule_entries se
    LEFT JOIN employees e ON e.id = se.employee_id WHERE se.work_date BETWEEN ? AND ? ORDER BY se.work_date, se.shift_code, se.id`)
    .all(weekStart, addDays(weekStart, 6)) as EntryRow[];
  return { schedule: schedule ?? null, entries };
}

/** 某一天（或某一窗口）被「单日锁定」的日期：整天条目都是 locked 的日子 */
export function lockedDatesBetween(from: string, to: string): string[] {
  const db = getDb();
  return (db.prepare(`SELECT DISTINCT work_date FROM schedule_entries
    WHERE work_date BETWEEN ? AND ? AND status = 'locked' ORDER BY work_date`).all(from, to) as { work_date: string }[])
    .map((row) => row.work_date);
}

/** 这一天是不是被单日锁定了（整周锁定时由 schedules.status 判断，不在这里重复） */
export function dayLocked(date: string): boolean {
  const db = getDb();
  return Boolean(db.prepare("SELECT 1 AS hit FROM schedule_entries WHERE work_date = ? AND status = 'locked' LIMIT 1").get(date));
}

export function loadEngineInput(weekStart: string, fixed: Assignment[] = [], managerNoRest = false): EngineInput {
  const db = getDb();
  const weekEnd = addDays(weekStart, 6);
  const start = addDays(weekStart.slice(0, 7) + '-01', -1);
  const farEnd = addDays(weekEnd.slice(0, 7) + '-' + String(daysInMonth(Number(weekEnd.slice(0, 4)), Number(weekEnd.slice(5, 7)))).padStart(2, '0'), 1);
  const rows = db.prepare(`SELECT se.* FROM schedule_entries se WHERE se.work_date BETWEEN ? AND ? AND se.employee_id IS NOT NULL AND se.is_rest = 0`).all(start, farEnd) as Assignment[];
  const scheduledDates = (db.prepare(`SELECT DISTINCT se.work_date FROM schedule_entries se
    JOIN schedules s ON s.id = se.schedule_id
    WHERE se.work_date BETWEEN ? AND ? AND se.employee_id IS NOT NULL AND se.is_rest = 0`).all(start, farEnd) as { work_date: string }[])
    .map((row) => row.work_date);
  // 单日锁定：生成 / 重排 / 诊断都要跳过这些日子（空槽也算锁定日，所以单独查一遍）
  const lockedDates = lockedDatesBetween(weekStart, weekEnd);
  const requirements = (db.prepare('SELECT * FROM requirements WHERE active = 1 ORDER BY id').all() as Record<string, unknown>[]).map(mapRequirement) as Requirement[];
  const holidays = Object.fromEntries((db.prepare('SELECT date, kind FROM holidays').all() as { date: string; kind: 'holiday' | 'workday' }[]).map((h) => [h.date, h.kind]));
  const settings = getAllSettings();
  const weights: Partial<Weights> = {};
  for (const key of ['night', 'early', 'middle', 'rest', 'field', 'streak', 'changes', 'female'] as const) {
    const value = Number(settings['scheduler_weight_' + key]);
    if (Number.isFinite(value) && value >= 0) weights[key] = value;
  }
  // P2：每人每月最少休息天数（2-10，默认 4）由设置页配置，这里读出来交给引擎
  const configuredRest = Number(settings.scheduler_min_rest_days);
  const minRestRest = Number.isFinite(configuredRest) && configuredRest >= 2 ? Math.min(Math.floor(configuredRest), 10) : 4;
  const configuredManagerRest = Number(settings.scheduler_manager_rest_days);
  const managerRest = Number.isFinite(configuredManagerRest) && configuredManagerRest >= 0 ? Math.min(Math.floor(configuredManagerRest), 10) : 2;
  const configuredManagerNights = Number(settings.scheduler_manager_max_nights);
  const managerNights = Number.isFinite(configuredManagerNights) && configuredManagerNights >= 0 ? Math.min(Math.floor(configuredManagerNights), 10) : 2;
  const today = todayStr();
  const now = new Date();
  const clock = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const templates = listShifts();
  const frozenSlots = eachDate(weekStart, weekEnd).flatMap((date) => templates
    .filter((shift) => date < today || (date === today && shift.start_time <= clock))
    .map((shift) => date + '|' + shift.code));
  return { weekStart, employees: listEmployees(), shifts: templates.filter((shift) => shift.enabled === 1), requirements, holidays, existing: rows, fixed, scheduledDates, frozenSlots, lockedDates,
    allowMiddleEarly: settings.scheduler_allow_middle_early !== '0', weights, minRestDays: minRestRest, managerRestDays: managerRest,
    managerMaxNights: managerNights, managerNoRest,
    // 需求②：早班必须 ≥1 名女性（设置里可关，默认开）
    requireFemaleEarly: settings.scheduler_require_female_early !== '0',
    // 连续休息上限（1-14，默认 3；0 = 不限制）
    maxRestStreak: (() => { const n = Number(settings.scheduler_max_rest_streak); return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 14) : 3; })(),
    // 压连休补位排到哪个班（周排班页设置）
    reliefShift: (settings.scheduler_relief_shift === 'middle' || settings.scheduler_relief_shift === 'night'
      ? settings.scheduler_relief_shift : 'early') };
}

export type ScheduleRunResult = EngineResult & { seed: number };

/** 从 schedules.note 里读「店长本周不休息」这类窗口设置 */
export function windowFlags(note: string | null | undefined): { managerNoRest: boolean } {
  if (!note) return { managerNoRest: false };
  try {
    const parsed = JSON.parse(note) as { managerNoRest?: unknown };
    return { managerNoRest: parsed.managerNoRest === true };
  } catch {
    return { managerNoRest: false };
  }
}

/**
 * 生成/重排一周。
 * 注意：随机种子必须每次都变 —— 固定种子会让「全量重排」生成出和上一次完全一样的班表，
 * 用户看起来就像按钮没反应（本次修复的 bug）。显式传 input.seed 的入口仍然保留给测试用（可复现）。
 */
export function runSchedule(weekStart: string, mode: 'generate' | 'regenerate', full = false): ScheduleRunResult {
  const db = getDb();
  const existing = weekData(weekStart);
  // 锁只保护「有人的安排」：锁定但一个人都没有的周（存量脏数据 / 只开了窗口设置的周）不拦生成，
  // 生成时顺手把窗口记录降级成草稿，否则新排出来的班还会挂着一个锁死的周状态。
  const protectLock = existing.schedule?.status === 'locked' && hasPeople(existing.entries);
  if (protectLock && mode === 'generate') throw new Error('本周已锁定，请先解锁');
  const flags = windowFlags(existing.schedule?.note);
  const input = loadEngineInput(weekStart, [], flags.managerNoRest);
  const kept = new Set(existing.entries.filter((e) => e.employee_id).map((e) => e.work_date + '|' + e.shift_code));
  const frozen = new Set([...(input.frozenSlots || [])].filter((key) => kept.has(key)));
  const ownId = existing.schedule?.id;
  const weekEnd = addDays(weekStart, 6);
  // 离职人员的班先撤掉再排：不管它属于哪个窗口。否则重叠窗口里留下的离职班会被原样保留，
  // 重排时判「离职或尚未入职」，整周排不出来，只报错不解决。
  const gone = new Set(input.employees.filter((e) => e.status !== 'active').map((e) => e.id));
  if (gone.size) {
    const mine = existing.entries.filter((e) => e.employee_id && gone.has(e.employee_id) && e.work_date >= weekStart && e.work_date <= weekEnd);
    for (const entry of mine) db.prepare('DELETE FROM schedule_entries WHERE id = ?').run(entry.id);
    if (mine.length) {
      db.prepare('DELETE FROM schedules WHERE id NOT IN (SELECT DISTINCT schedule_id FROM schedule_entries)').run();
      existing.entries = existing.entries.filter((e) => !mine.some((m) => m.id === e.id));
    }
  }
  /** 这天在别的排班窗口里已经有人：重叠部分不重排，保持先排的结果 */
  const claimed = new Set((db.prepare(`SELECT DISTINCT se.work_date FROM schedule_entries se
    JOIN schedules s ON s.id = se.schedule_id
    WHERE se.work_date BETWEEN ? AND ? AND se.employee_id IS NOT NULL AND s.week_start <> ?`).all(weekStart, weekEnd, weekStart) as { work_date: string }[])
    .map((r) => r.work_date));
  /** 别的窗口的条目，或落在已被别的窗口排过的天上的条目，都不归本次管 */
  const isForeign = (e: EntryRow) => ownId === undefined || e.schedule_id !== ownId || claimed.has(e.work_date);
  const fixed = existing.entries.filter((e) => e.employee_id && (
    isForeign(e)
    || e.status === 'locked' || frozen.has(e.work_date + '|' + e.shift_code) || (!full && e.source === 'manual')));
  const seed = Date.now() % 1000000;
  const result = generate({ ...input, fixed, seed });
  if (!result.ok) return { ...result, seed };
  const tx = db.transaction(() => {
    let scheduleId = existing.schedule?.id;
    if (!scheduleId) {
      scheduleId = Number(db.prepare(`INSERT INTO schedules (week_start, week_end, status, generated_at)
        VALUES (?, ?, 'draft', datetime('now','localtime'))`).run(weekStart, addDays(weekStart, 6)).lastInsertRowid);
    } else {
      // 顺手修好历史脏数据：week_end 必须是窗口最后一天（店长牛马开关在没有周记录时会先建行，
      // 早期版本把 week_end 写成了 week_start，会让月表把整周 6 天当成「待排」）。
      // B7：锁定但 0 人的周记录在这里降级成草稿 —— 这一周没有要保护的安排，锁不能挡生成。
      if (!protectLock) db.prepare("UPDATE schedules SET status = 'draft' WHERE id = ? AND status = 'locked'").run(scheduleId);
      db.prepare(`UPDATE schedules SET week_end = ?, generated_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(addDays(weekStart, 6), scheduleId);
    }
    const fixedIds = new Set(fixed.map((e) => e.id));
    // 只删本窗口自己 schedule 的记录；重叠窗口里别人的记录一律不碰
    for (const entry of existing.entries) {
      if (isForeign(entry)) continue;
      if (!fixedIds.has(entry.id)) db.prepare('DELETE FROM schedule_entries WHERE id = ?').run(entry.id);
    }
    const insert = db.prepare(`INSERT INTO schedule_entries (schedule_id, work_date, shift_id, shift_code, employee_id, status, source, is_rest, note)
      VALUES (?, ?, ?, ?, ?, 'draft', 'auto', 0, ?)`);
    for (const a of result.assignments) if (!a.id) insert.run(scheduleId, a.work_date, a.shift_id, a.shift_code, a.employee_id, a.note ?? null);
  });
  tx();
  return { ...result, seed };
}
