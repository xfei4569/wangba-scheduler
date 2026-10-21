import { getDb } from './db';
import type { Employee, Holiday, Requirement, ShiftTemplate } from './types';

type Row = Record<string, unknown>;

export function safeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function mapEmployee(row: Row): Employee {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    tags: safeJsonArray(row.tags),
    status: (row.status as Employee['status']) ?? 'active',
    hire_date: (row.hire_date as string) ?? null,
    leave_date: (row.leave_date as string) ?? null,
    gender: ((row.gender as string) ?? '') as Employee['gender'],
    seniority: ((row.seniority as string) || '老人') as Employee['seniority'],
    can_teach: Number(row.can_teach ?? 1),
    position: ((row.position as string) || '员工') as Employee['position'],
    note: (row.note as string) ?? null,
    sort_order: Number(row.sort_order ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function mapShift(row: Row): ShiftTemplate {
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    start_time: String(row.start_time),
    end_time: String(row.end_time),
    cross_day: Number(row.cross_day ?? 0),
    weekday_count: Number(row.weekday_count ?? 0),
    weekend_count: Number(row.weekend_count ?? 0),
    holiday_count: Number(row.holiday_count ?? 0),
    enabled: Number(row.enabled ?? 1),
    sort_order: Number(row.sort_order ?? 0),
    note: (row.note as string) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function mapHoliday(row: Row): Holiday {
  return {
    id: Number(row.id),
    date: String(row.date),
    name: String(row.name),
    kind: (row.kind as Holiday['kind']) ?? 'holiday',
    year: Number(row.year),
    is_preset: Number(row.is_preset ?? 0),
    estimated: Number(row.estimated ?? 0),
    note: (row.note as string) ?? null,
  };
}

export function mapRequirement(row: Row): Requirement {
  return {
    id: Number(row.id),
    type: row.type as Requirement['type'],
    employee_id: row.employee_id === null || row.employee_id === undefined ? null : Number(row.employee_id),
    employee_id_2: row.employee_id_2 === null || row.employee_id_2 === undefined ? null : Number(row.employee_id_2),
    employee_name: (row.employee_name as string) ?? null,
    employee_name_2: (row.employee_name_2 as string) ?? null,
    leave_type: (row.leave_type as string) ?? null,
    shift_codes: safeJsonArray(row.shift_codes),
    date_start: (row.date_start as string) ?? null,
    date_end: (row.date_end as string) ?? null,
    override_count: row.override_count === null || row.override_count === undefined ? null : Number(row.override_count),
    long_term: Number(row.long_term ?? 0),
    active: Number(row.active ?? 1),
    note: (row.note as string) ?? null,
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function listEmployees(status?: string): Employee[] {
  const sql =
    'SELECT * FROM employees' +
    (status ? ' WHERE status = ?' : '') +
    " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'leave' THEN 1 ELSE 2 END, sort_order, id";
  const rows = (status ? getDb().prepare(sql).all(status) : getDb().prepare(sql).all()) as Row[];
  return rows.map(mapEmployee);
}

export function listShifts(onlyEnabled = false): ShiftTemplate[] {
  const rows = getDb()
    .prepare('SELECT * FROM shift_templates' + (onlyEnabled ? ' WHERE enabled = 1' : '') + ' ORDER BY sort_order, id')
    .all() as Row[];
  return rows.map(mapShift);
}

export function listHolidays(year: number): Holiday[] {
  const rows = getDb().prepare('SELECT * FROM holidays WHERE year = ? ORDER BY date').all(year) as Row[];
  return rows.map(mapHoliday);
}

export function listRequirements(type: string): Requirement[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*, e1.name AS employee_name, e2.name AS employee_name_2
         FROM requirements r
         LEFT JOIN employees e1 ON e1.id = r.employee_id
         LEFT JOIN employees e2 ON e2.id = r.employee_id_2
        WHERE r.type = ?
        ORDER BY COALESCE(r.date_start, '9999-99-99'), r.id DESC`
    )
    .all(type) as Row[];
  return rows.map(mapRequirement);
}

/** 某年的日期类型表：返回 { 'YYYY-MM-DD': { type, name, kind, estimated } } */
export function buildDayMap(year: number) {
  const holidays = listHolidays(year);
  const map: Record<string, { type: 'weekday' | 'weekend' | 'holiday'; name?: string; kind?: 'holiday' | 'workday'; estimated?: boolean }> = {};
  for (const h of holidays) {
    map[h.date] = {
      type: h.kind === 'holiday' ? 'holiday' : 'weekday',
      name: h.name,
      kind: h.kind,
      estimated: Boolean(h.estimated),
    };
  }
  return map;
}
