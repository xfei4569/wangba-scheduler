import { getDb, DB_PATH } from '@/lib/db';
import { ok, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { listShifts } from '@/lib/repo';
import { addDays, isWeekend, todayStr } from '@/lib/date';
import { weekStartDate } from '@/lib/scheduler/week';
import type { DayType, OverviewData } from '@/lib/types';
import { capacityFor, demandFor } from '@/lib/scheduler/engine';
import { loadEngineInput } from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';

function dayTypeOf(date: string, holidayMap: Map<string, string>): DayType {
  const kind = holidayMap.get(date);
  if (kind === 'holiday') return 'holiday';
  if (kind === 'workday') return 'weekday';
  return isWeekend(date) ? 'weekend' : 'weekday';
}

export const GET = route(async () => {
  await requireUser();
  const db = getDb();
  const today = todayStr();
  const weekStart = weekStartDate(today);
  const weekEnd = addDays(weekStart, 6);
  const year = Number(today.slice(0, 4));

  const employees = db.prepare('SELECT status, COUNT(*) AS c FROM employees GROUP BY status').all() as {
    status: string;
    c: number;
  }[];
  const empCount = { total: 0, active: 0, leave: 0, resigned: 0 };
  for (const e of employees) {
    empCount.total += e.c;
    if (e.status === 'active') empCount.active = e.c;
    if (e.status === 'leave') empCount.leave = e.c;
    if (e.status === 'resigned') empCount.resigned = e.c;
  }

  const shifts = listShifts();
  const enabledShifts = shifts.filter((s) => s.enabled === 1);
  const demand = {
    weekday: enabledShifts.reduce((sum, s) => sum + s.weekday_count, 0),
    weekend: enabledShifts.reduce((sum, s) => sum + s.weekend_count, 0),
    holiday: enabledShifts.reduce((sum, s) => sum + s.holiday_count, 0),
  };

  const holidayRows = db.prepare('SELECT date, kind, name, year FROM holidays ORDER BY date').all() as {
    date: string;
    kind: string;
    name: string;
    year: number;
  }[];
  const holidayMap = new Map(holidayRows.map((h) => [h.date, h.kind]));
  const todayType = dayTypeOf(today, holidayMap);
  const engineInput = loadEngineInput(weekStart);
  const todayDemand = engineInput.shifts.reduce((sum, shift) => sum + demandFor(today, shift, engineInput), 0);
  const todayAvailable = engineInput.employees.filter((employee) =>
    employee.status === 'active' &&
    (!employee.hire_date || employee.hire_date <= today) &&
    (!employee.leave_date || employee.leave_date >= today) &&
    !engineInput.requirements.some((requirement) => requirement.type === 'leave' && requirement.employee_id === employee.id &&
      (!requirement.date_start || requirement.date_start <= today) && (!requirement.date_end || requirement.date_end >= today))
  ).length;

  const yearHolidays = holidayRows.filter((h) => h.year === year);
  const statutory = yearHolidays.filter((h) => h.kind === 'holiday').length;
  const makeup = yearHolidays.filter((h) => h.kind === 'workday').length;

  // 统计本年「忙日」天数：周末（非调休上班）+ 法定节假日
  let busyDays = 0;
  const start = year + '-01-01';
  const end = year + '-12-31';
  let cur = start;
  while (cur <= end) {
    const t = dayTypeOf(cur, holidayMap);
    if (t !== 'weekday') busyDays += 1;
    cur = addDays(cur, 1);
  }

  const upcoming = holidayRows
    .filter((h) => h.kind === 'holiday' && h.date >= today)
    .slice(0, 3)
    .map((h) => ({ date: h.date, name: h.name }));

  const reqCounts: Record<string, number> = { leave: 0, avoid: 0, extra: 0, pairing: 0 };
  const rc = db.prepare('SELECT type, COUNT(*) AS c FROM requirements GROUP BY type').all() as {
    type: string;
    c: number;
  }[];
  for (const r of rc) reqCounts[r.type] = r.c;

  const unlocked = await sensitiveUnlocked();

  const sch = db.prepare('SELECT COUNT(*) AS c, MAX(week_start) AS latest FROM schedules').get() as {
    c: number;
    latest: string | null;
  };
  const currentWeek = db.prepare('SELECT status FROM schedules WHERE week_start = ?').get(weekStart) as { status: 'draft' | 'locked' } | undefined;
  const todaySchedule = db.prepare(`SELECT se.shift_code, st.name AS shift_name, st.start_time, st.end_time,
      e.name AS employee_name, se.source
    FROM schedule_entries se
    JOIN schedules s ON s.id = se.schedule_id
    JOIN shift_templates st ON st.id = se.shift_id
    LEFT JOIN employees e ON e.id = se.employee_id
    WHERE se.work_date = ? AND se.is_rest = 0
    ORDER BY CASE se.shift_code WHEN 'early' THEN 1 WHEN 'middle' THEN 2 ELSE 3 END, se.id`).all(today) as OverviewData['todaySchedule'];

  const data: OverviewData & { dbPath: string; sensitiveUnlocked: boolean } = {
    today,
    week_start: weekStart,
    week_end: weekEnd,
    employees: empCount,
    shifts: enabledShifts.map((s) => ({
      code: s.code,
      name: s.name,
      start_time: s.start_time,
      end_time: s.end_time,
      count: todayType === 'holiday' ? s.holiday_count : todayType === 'weekend' ? s.weekend_count : s.weekday_count,
      enabled: s.enabled,
    })),
    demand: { ...demand, today: todayDemand, today_type: todayType },
    holidays: { year, statutory, makeup_workday: makeup, busy_days: busyDays, upcoming },
    requirements: {
      leave: reqCounts.leave,
      avoid: reqCounts.avoid,
      extra: reqCounts.extra,
      // 未解锁时不返回条数，避免前台电脑上被顺手看到
      pairing: unlocked ? reqCounts.pairing : -1,
    },
    schedules: { total: sch.c, latest_week: sch.latest, current_week_status: currentWeek?.status ?? null },
    todaySchedule,
    capacity: { ...capacityFor(engineInput), todayAvailable },
    dbPath: DB_PATH,
    sensitiveUnlocked: unlocked,
  };

  return ok(data);
});
