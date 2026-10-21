/** 全站共用的类型与中文文案映射（前后端通用，不含任何 Node/浏览器专有 API） */

export type EmployeeStatus = 'active' | 'leave' | 'resigned';
export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: '在职',
  leave: '暂停排班',
  resigned: '离职',
};
export const EMPLOYEE_STATUS_OPTIONS = (Object.keys(EMPLOYEE_STATUS_LABEL) as EmployeeStatus[]).map((v) => ({
  value: v,
  label: EMPLOYEE_STATUS_LABEL[v],
}));

/** 员工标签（内外场） */
export const EMPLOYEE_TAGS = ['内场', '外场'] as const;
export type EmployeeTag = (typeof EMPLOYEE_TAGS)[number];

/** 性别：不填 = 未填写（不参与「早班女性」规则计数） */
export const EMPLOYEE_GENDERS = ['男', '女'] as const;
export type EmployeeGender = (typeof EMPLOYEE_GENDERS)[number] | '';

/** 经验：新人必须与「可带教者」同班 */
export const EMPLOYEE_SENIORITIES = ['老人', '新人'] as const;
export type EmployeeSeniority = (typeof EMPLOYEE_SENIORITIES)[number];

/** 职位：店长默认可带教；每家店可以有多个店长，也可以没有 */
export const EMPLOYEE_POSITIONS = ['店长', '员工'] as const;
export type EmployeePosition = (typeof EMPLOYEE_POSITIONS)[number];

export interface Employee {
  id: number;
  name: string;
  tags: string[];
  status: EmployeeStatus;
  hire_date: string | null;
  leave_date: string | null;
  gender: EmployeeGender;
  seniority: EmployeeSeniority;
  /** 1=可带教（默认老人可带教，可手动关；店长始终视为可带教） */
  can_teach: number;
  position: EmployeePosition;
  note: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface MentorFields { position?: string; can_teach?: number; seniority?: string }

/** 能否当带教者：店长始终算；否则要「老人 + 可带教开关打开」 */
export function isMentor(e: MentorFields): boolean {
  return e.position === '店长' || (e.can_teach === 1 && e.seniority === '老人');
}

/** 是否新人（新人必须与至少 1 名带教者同班） */
export function isNewbie(e: { seniority?: string }): boolean {
  return e.seniority === '新人';
}

/** 店长（忙的时候可以少休，不跟员工的月休天数绑在一起） */
export function isManager(e: { position?: string }): boolean {
  return e.position === '店长';
}

/** 是否女性（早班女性规则只认「女」，不填不算） */
export function isFemale(e: { gender?: string }): boolean {
  return e.gender === '女';
}

export type DayType = 'weekday' | 'weekend' | 'holiday';
export const DAY_TYPE_LABEL: Record<DayType, string> = {
  weekday: '平日',
  weekend: '周末',
  holiday: '法定节假日',
};
export const DAY_TYPE_SHORT: Record<DayType, string> = {
  weekday: '平日',
  weekend: '周末·忙日',
  holiday: '节假日·忙日',
};

export interface ShiftTemplate {
  id: number;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  cross_day: number;
  weekday_count: number;
  weekend_count: number;
  holiday_count: number;
  enabled: number;
  sort_order: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type HolidayKind = 'holiday' | 'workday';
export interface Holiday {
  id: number;
  date: string;
  name: string;
  kind: HolidayKind;
  year: number;
  is_preset: number;
  estimated: number;
  note: string | null;
}

export type ReqType = 'leave' | 'pairing' | 'avoid' | 'extra';
export const REQ_TYPE_LABEL: Record<ReqType, string> = {
  leave: '请假登记',
  pairing: '高级设置',
  avoid: '避班',
  extra: '临时加派',
};
export const LEAVE_TYPES = ['事假', '病假', '月休'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export interface Requirement {
  id: number;
  type: ReqType;
  employee_id: number | null;
  employee_id_2: number | null;
  employee_name?: string | null;
  employee_name_2?: string | null;
  leave_type: string | null;
  shift_codes: string[];
  date_start: string | null;
  date_end: string | null;
  override_count: number | null;
  long_term: number;
  active: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRow {
  id: number;
  week_start: string;
  week_end: string;
  status: 'draft' | 'locked';
  note: string | null;
}

export interface OverviewData {
  today: string;
  week_start: string;
  week_end: string;
  employees: { total: number; active: number; leave: number; resigned: number };
  shifts: { code: string; name: string; start_time: string; end_time: string; count: number; enabled: number }[];
  demand: { weekday: number; weekend: number; holiday: number; today: number; today_type: DayType };
  holidays: { year: number; statutory: number; makeup_workday: number; busy_days: number; upcoming: { date: string; name: string }[] };
  requirements: { leave: number; avoid: number; extra: number; pairing: number };
  schedules: { total: number; latest_week: string | null; current_week_status: 'draft' | 'locked' | null };
  todaySchedule: { shift_code: string; shift_name: string; start_time: string; end_time: string; employee_name: string; source: string }[];
  capacity: { demand: number; available: number; todayAvailable: number };
  /** 数据库路径（首页底部展示，方便排查） */
  dbPath?: string;
  /** 高级设置当前是否已解锁（未解锁时 requirements.pairing 为 -1） */
  sensitiveUnlocked?: boolean;
}
