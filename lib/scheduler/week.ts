import { assert } from '../api';
import { addDays, eachDate, isValidYmd, todayStr } from '../date';
import { getDb } from '../db';
import { getSettingNumber, SK } from '../settings';

/** 一周从周几开始：1=周一 … 7=周日（设置页的「一周起始日」决定）。 */
export function weekStartWeekday(): number {
  const v = Math.round(Number(getSettingNumber(SK.schedulerWeekStart, 1)));
  return v >= 1 && v <= 7 ? v : 1;
}

/** 把任意日期对齐到所在周的起始日（按设置的周起点，缺省周一）。 */
export function weekStartDate(value: string): string {
  const day = new Date(value + 'T00:00:00Z').getUTCDay(); // 0=周日
  const iso = day === 0 ? 7 : day;
  return addDays(value, -((iso - weekStartWeekday() + 7) % 7));
}

export function weekStartOf(value: unknown): string {
  // 排班窗口的起始日由用户自选（滚动排：接着上次排到的那天往下排），不再强行对齐「一周起始日」设置；
  // 设置只用于月度汇总的分组与缺省值。窗口 = [起始日, 起始日+6]。
  const raw = value === undefined || value === null || value === '' ? addDays(weekStartDate(todayStr()), 7) : String(value).slice(0, 10);
  assert(isValidYmd(raw), '请提供排班起始日（YYYY-MM-DD）');
  return raw;
}

/**
 * 某一天属于哪个排班窗口的起点。
 * 起始日自选后窗口不再对齐「一周起始日」设置，不能再拿 weekStartDate(date) 当窗口起点用；
 * 重叠时取起始日最晚的那个（= 最近一次排班的口径）。没有任何窗口时回退到全局周期。
 */
export function windowStartOf(date: string): string {
  const row = getDb()
    .prepare('SELECT week_start FROM schedules WHERE week_start <= ? AND week_end >= ? ORDER BY week_start DESC LIMIT 1')
    .get(date, date) as { week_start: string } | undefined;
  return row?.week_start ?? weekStartDate(date);
}

/** 这段日期里，已经生成过班表、且还没锁定的周。改了请假或避班后用来提醒重算。 */
export function staleWeeksBetween(start: string | null, end: string | null): string[] {
  const from = start && isValidYmd(start) ? start : todayStr();
  const to = end && isValidYmd(end) ? end : addDays(from, 62);
  const weeks = [...new Set(eachDate(from, to).map(weekStartDate))];
  const db = getDb();
  return weeks.filter((week) => {
    const row = db.prepare(`SELECT s.status FROM schedules s
      JOIN schedule_entries se ON se.schedule_id = s.id
      WHERE s.week_start = ? AND se.employee_id IS NOT NULL LIMIT 1`).get(week) as { status: string } | undefined;
    return row?.status === 'draft';
  });
}
