import { addDays, daysInMonth, eachDate, isWeekend, shiftsOverlap, todayStr } from '../date';
import { isFemale, isManager, isMentor, isNewbie, type Employee, type Requirement, type ShiftTemplate } from '../types';
import { SECRET_REASON, dedupeIssues, secretIssue, splitReasons, type Issue } from './redact';

export interface Assignment {
  id?: number;
  work_date: string;
  shift_code: string;
  shift_id: number;
  employee_id: number;
  status?: 'draft' | 'locked';
  source?: 'auto' | 'manual' | 'swap';
  /** 备注。压连休多排的班次标记为 RELIEF_NOTE，用来把人数校验算准。 */
  note?: string;
}

export interface EngineInput {
  weekStart: string;
  employees: Employee[];
  shifts: ShiftTemplate[];
  requirements: Requirement[];
  holidays: Record<string, 'holiday' | 'workday'>;
  existing: Assignment[];
  fixed: Assignment[];
  /** 已开始的日期与班次，重排时保留原记录且不按新规则回头校验。 */
  frozenSlots?: string[];
  /**
   * 单日锁定的日期（整天的条目都锁定）：生成 / 重排一律跳过这些日子 ——
   * 既不删改已有条目，也不往这些日子补人。与「整周锁定」同一语义，只是粒度到天。
   */
  lockedDates?: string[];
  /** 已生成班表覆盖的日期；未生成日期不能被当作休息日统计。 */
  scheduledDates?: string[];
  allowMiddleEarly?: boolean;
  /** 每人每月最少休息天数（由设置页配置，经 store 传入；缺省 4 = P1 行为） */
  minRestDays?: number;
  /** 店长每月最少休息天数，单独设置，不跟员工天数绑在一起 */
  managerRestDays?: number;
  /** 店长每月最多夜班次数（设置里单独一项，默认 2；0 = 不上夜班） */
  managerMaxNights?: number;
  /** 店长本周不休息（周排班页开关）：本周不给店长排休息，月休目标临时归零 */
  managerNoRest?: boolean;
  /** 需求②：早班必须 ≥1 名女性（设置里可开关，缺省开） */
  requireFemaleEarly?: boolean;
  /** 连续休息最多几天（设置里可调，缺省 3；0 = 不限制） */
  maxRestStreak?: number;
  /** 压连休补位时优先补到哪个班（周排班页设置，缺省早班） */
  reliefShift?: 'early' | 'middle' | 'night';
  weights?: Partial<Weights>;
  seed?: number;
  restarts?: number;
}

export interface Weights {
  night: number;
  early: number;
  middle: number;
  rest: number;
  field: number;
  streak: number;
  changes: number;
  /** 需求②：早班女性尽量多（软约束，高权重） */
  female: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  night: 12, early: 5, middle: 3, rest: 6, field: 2, streak: 5, changes: 8, female: 6,
};

export interface MissingSlot {
  date: string;
  shift: string;
  missing: number;
  excluded: { employeeId: number; name: string; reasons: string[] }[];
  suggestion: string;
}

/** 需求②③：规则类问题（早班缺女性接待 / 新人无带教者） */
export interface RuleIssue {
  kind: 'gender' | 'mentor';
  date: string;
  shift: string;
  text: string;
  suggestion: string;
}

export interface Diagnosis {
  capacity: { demand: number; available: number; byMonth: { month: string; demand: number; available: number }[] };
  missing: MissingSlot[];
  /** 结构化冲突（脱敏用 Issue：secret 条目未解锁时只聚合展示） */
  conflicts: Issue[];
  suggestions: string[];
  /** 已排人数超过当前需求的日期班次（P2 新增：人数改小后的提示） */
  over?: { date: string; shift: string; assigned: number; count: number }[];
  /** 需求②③：早班缺女性 / 新人无带教 的说明与松绑建议 */
  ruleIssues?: RuleIssue[];
}

export interface Report {
  demand: number;
  assigned: number;
  coverage: number;
  score: number;
  people: { employeeId: number; name: string; early: number; middle: number; night: number; rest: number; month: string }[];
  warnings: string[];
  /** P2-fix：两层公平性体检明细（出勤天数均衡 > 晚班公平） */
  fairness: FairnessInfo[];
  /** 需求 E：每人本周汇总（出勤/休息/晚班 + 休息日期 + 距月休目标还差几天） */
  week: WeekPerson[];
  /** 需求②③：规则类问题（始终返回，便于随时提示） */
  ruleIssues: RuleIssue[];
  /**
   * 店长的月休提示：唯一口径由 restFloor / managerRestDays 决定。
   * 设置 0 = 不设下限 → 恒为 null（零提醒）；设置 >0 且店长本月已休低于该值才给一句话。
   */
  managerRestNotice: string | null;
  /** 店长月休下限（设置值，0 = 不设下限），界面文案与「距月休目标」共用 */
  managerRestDays: number;
  /**
   * 尽力排（B3）：本次结果里引擎动不了的残留问题（存量手工条目 / 已开始的班等）。
   * 结构化 Issue —— secret 条目未解锁口令时只允许聚合展示，禁止直接吐姓名。
   */
  residuals: Issue[];
}

/** 需求 E：周表休息显式化 */
export interface WeekPerson {
  employeeId: number;
  name: string;
  /** 本周出勤天数 */
  workDays: number;
  /** 本周休息天数（只统计本周内、且本人在职的日期） */
  restDays: number;
  /** 本周晚班次数 */
  nights: number;
  /** 本周休息的具体日期 */
  restDates: string[];
  /** 其中连续休息超过上限的日期，页面上标红 */
  longRest: string[];
  /** 本月已休天数（月初到本周为止） */
  monthRest: number;
  /** 距本月月休目标还差多少天（按「月初到现在」已休天数算） */
  monthlyRestGap: number;
}

export type EngineResult =
  | { ok: true; assignments: Assignment[]; report: Report; capacity: Diagnosis['capacity'] }
  | { ok: false; diagnosis: Diagnosis };

const names: Record<string, string> = { early: '早班', middle: '中班', night: '晚班' };
/** 班次中文名：脱敏文案（「谁 × 谁，哪天哪个班」）里统一用它 */
export function shiftLabel(code: string): string {
  return names[code] || code;
}
const monthOf = (s: string) => s.slice(0, 7);
const monthStart = (s: string) => monthOf(s) + '-01';
const monthEnd = (s: string) => monthOf(s) + '-' + String(daysInMonth(Number(s.slice(0, 4)), Number(s.slice(5, 7)))).padStart(2, '0');
const activeOn = (r: Requirement, date: string) => r.active === 1 && (!r.date_start || r.date_start <= date) && (!r.date_end || r.date_end >= date);

/** 需求②：早班女性规则是否启用（缺省开，可在设置里关） */
export function requireFemaleEarly(input: EngineInput): boolean {
  return input.requireFemaleEarly !== false;
}

/** 按 id 找员工（找不到返回 undefined） */
function employeeOf(input: EngineInput, id: number): Employee | undefined {
  return input.employees.find((e) => e.id === id);
}

/** 某人在某天是否请假 */
function onLeaveOn(input: EngineInput, employee: Employee, date: string): boolean {
  return input.requirements.some((r) => r.type === 'leave' && r.employee_id === employee.id && activeOn(r, date));
}

/** 店长的月休下限：设置里单独一项，不跟员工天数挂钩。 */
export function managerRestDays(input: EngineInput): number {
  const value = Number(input.managerRestDays);
  if (!Number.isFinite(value) || value < 0) return 2;
  return Math.min(Math.floor(value), 15);
}

/** 店长每月最多夜班次数：管事情的人以早中班为主，偶尔顶夜班，单独一项设置。 */
export function managerMaxNights(input: EngineInput): number {
  const value = Number(input.managerMaxNights);
  if (!Number.isFinite(value) || value < 0) return 2;
  return Math.min(Math.floor(value), 31);
 }

/** 这个人这个月至少要休几天。店长走自己的设置，其他人走员工设置。 */
export function restFloor(input: EngineInput, employee: { position?: string }): number {
  // 店长本周不休息：这一周先不给店长留休息，月休目标临时归零
  if (isManager(employee) && input.managerNoRest) return 0;
  return isManager(employee) ? managerRestDays(input) : minRestDays(input);
}

/**
 * 这一天是不是「单日锁定」。
 * 优先看显式传入的 lockedDates；没传时回落到 existing / fixed 里 status='locked' 的条目，
 * 保证 engine-test 直接构造的输入也能享受同一语义（锁定日 = 整天冻结，生成/重排跳过）。
 */
export function lockedDatesOf(input: EngineInput): Set<string> {
  if (input.lockedDates) return new Set(input.lockedDates);
  const out = new Set<string>();
  for (const a of [...(input.existing || []), ...(input.fixed || [])]) {
    if (a.status === 'locked') out.add(a.work_date);
  }
  return out;
}

/** 连续休息最多几天：来自设置，缺省 3；0 = 不限制 */
export function maxRestStreak(input: EngineInput): number {
  const value = Number(input.maxRestStreak);
  if (!Number.isFinite(value) || value < 0) return 3;
  return Math.min(Math.floor(value), 14);
}

export function minRestDays(input: EngineInput): number {
  const value = Number(input.minRestDays);
  if (!Number.isFinite(value) || value <= 0) return 4;
  return Math.min(Math.floor(value), 15);
}

interface AssignmentIndex { byEmployee: Map<number, Assignment[]>; bySlot: Map<string, Assignment[]> }
const slotKey = (date: string, shift: string) => date + '|' + shift;
export const frozenSlotKey = slotKey;
function addToIndex(index: AssignmentIndex, a: Assignment) {
  const own = index.byEmployee.get(a.employee_id) || [];
  own.push(a);
  index.byEmployee.set(a.employee_id, own);
  const key = slotKey(a.work_date, a.shift_code);
  const peers = index.bySlot.get(key) || [];
  peers.push(a);
  index.bySlot.set(key, peers);
}
function indexOf(assignments: Assignment[]): AssignmentIndex {
  const index = { byEmployee: new Map<number, Assignment[]>(), bySlot: new Map<string, Assignment[]>() };
  for (const a of assignments) addToIndex(index, a);
  return index;
}

/** 模板人数：按日期类型取平日/周末/法定节假日三档（不含临时改人数） */
export function baseDemandFor(date: string, shift: ShiftTemplate, input: EngineInput): number {
  if (!shift.enabled) return 0;
  const kind = input.holidays[date];
  return kind === 'workday' ? shift.weekday_count : kind === 'holiday' ? shift.holiday_count : isWeekend(date) ? shift.weekend_count : shift.weekday_count;
}

/** 实际需求人数：该日该班的临时改人数（extra）优先于模板三档 */
export function demandFor(date: string, shift: ShiftTemplate, input: EngineInput): number {
  const base = baseDemandFor(date, shift, input);
  if (!shift.enabled) return 0;
  const overrides = input.requirements.filter((r) => r.type === 'extra' && activeOn(r, date) && r.shift_codes.includes(shift.code) && r.override_count !== null);
  return overrides.length ? overrides[overrides.length - 1].override_count! : base;
}

function shiftOf(input: EngineInput, code: string): ShiftTemplate | undefined {
  return input.shifts.find((shift) => shift.code === code);
}

/** 带教看的是上班时间有没有重叠，不要求同一个班。早班有老人时，中班新人算有人带。 */
function mentorAround(input: EngineInput, assignments: Assignment[], employeeId: number, date: string, shift: string, index?: AssignmentIndex): boolean {
  const mine = shiftOf(input, shift);
  if (!mine) return false;
  const sameDay = index ? [...index.byEmployee.values()].flat() : assignments;
  return sameDay.some((row) => {
    if (row.work_date !== date || row.employee_id === employeeId) return false;
    const person = employeeOf(input, row.employee_id);
    const other = shiftOf(input, row.shift_code);
    return Boolean(person && isMentor(person) && other && shiftsOverlap(mine.start_time, mine.end_time, other.start_time, other.end_time));
  });
}

function employed(e: Employee, date: string): boolean {
  return e.status === 'active' && (!e.hire_date || e.hire_date <= date) && (!e.leave_date || e.leave_date >= date);
}

export function exclusionReasons(input: EngineInput, assignments: Assignment[], employee: Employee, date: string, shift: string, index?: AssignmentIndex, depth = 0): string[] {
  const out: string[] = [];
  if (!employed(employee, date)) out.push('离职或尚未入职');
  const reqs = input.requirements.filter((r) => activeOn(r, date));
  if (reqs.some((r) => r.type === 'leave' && r.employee_id === employee.id)) out.push('请假');
  if (reqs.some((r) => r.type === 'avoid' && r.employee_id === employee.id && r.shift_codes.includes(shift))) out.push('避班');
  const own = index ? (index.byEmployee.get(employee.id) || []) : assignments.filter((a) => a.employee_id === employee.id);
  if (own.some((a) => a.work_date === date)) out.push('同日已有班次');
  const peers = (index ? (index.bySlot.get(slotKey(date, shift)) || []) : assignments.filter((a) => a.work_date === date && a.shift_code === shift))
    .filter((a) => a.employee_id !== employee.id);
  if (reqs.some((r) => r.type === 'pairing' && peers.some((p) =>
    (r.employee_id === employee.id && r.employee_id_2 === p.employee_id) ||
    (r.employee_id_2 === employee.id && r.employee_id === p.employee_id)))) out.push(SECRET_REASON);
  const prev = own.find((a) => a.work_date === addDays(date, -1));
  const next = own.find((a) => a.work_date === addDays(date, 1));
  if ((prev?.shift_code === 'night' && (shift === 'early' || shift === 'middle')) ||
    (shift === 'night' && (next?.shift_code === 'early' || next?.shift_code === 'middle')) ||
    (input.allowMiddleEarly === false && ((prev?.shift_code === 'middle' && shift === 'early') ||
      (shift === 'middle' && next?.shift_code === 'early')))) out.push('休息红线');
  if (new Set(own.filter((a) => monthOf(a.work_date) === monthOf(date)).map((a) => a.work_date)).size >=
    daysInMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7))) - restFloor(input, employee)) out.push('月休上限');
  // 店长夜班限额（设置）：以早中班为主，夜班每月封顶
  if (isManager(employee) && shift === 'night'
    && own.filter((a) => a.shift_code === 'night' && monthOf(a.work_date) === monthOf(date)).length >= managerMaxNights(input)) out.push('店长夜班限额');

  const shiftTemplate = input.shifts.find((s) => s.code === shift);
  const demand = shiftTemplate ? demandFor(date, shiftTemplate, input) : 0;
  // 本次占位后还剩几个空位（<=0 表示这是最后一个空位）
  const slotsLeft = demand - peers.length - 1;

  // 需求②：「早班 ≥1 名女性」硬约束（设置可关）。最后一个空位必须留给女性；
  // 若当天完全没有女性可用，则不做限制（由体检报告给出「早班缺少女性接待」的说明与建议）。
  if (shift === 'early' && requireFemaleEarly(input) && !isFemale(employee) && slotsLeft <= 0 && depth === 0) {
    const peersFemale = peers.some((p) => {
      const peer = employeeOf(input, p.employee_id);
      return Boolean(peer && isFemale(peer));
    });
    if (!peersFemale) {
      const femaleAvailable = input.employees.some((e) => e.status === 'active' && isFemale(e)
        && exclusionReasons(input, assignments, e, date, shift, index, depth + 1).length === 0);
      if (femaleAvailable) out.push('早班需要女性');
    }
  }

  // 带教看上班时间是否重叠：早班有老人时，同时段的中班新人也算有人带。
  if (isNewbie(employee) && depth === 0) {
    const mentors = input.employees.filter((e) => e.status === 'active' && isMentor(e) && !isNewbie(e));
    if (!mentorAround(input, assignments, employee.id, date, shift, index)) {
      const mentorAvailable = slotsLeft > 0 && mentors.some((m) =>
        exclusionReasons(input, assignments, m, date, shift, index, depth + 1).length === 0);
      if (!mentorAvailable) out.push('这个时间段没有可带教的人');
    }
  }
  // 需求③（对称一侧）：班里已经排了新人但还没有带教者时，最后一个空位必须留给可带教者
  if (!isNewbie(employee) && !isMentor(employee) && depth === 0 && slotsLeft <= 0) {
    const hasNewbiePeer = peers.some((p) => { const pe = employeeOf(input, p.employee_id); return Boolean(pe && isNewbie(pe)); });
    const hasMentorPeer = peers.some((p) => { const pe = employeeOf(input, p.employee_id); return Boolean(pe && isMentor(pe)); });
    if (hasNewbiePeer && !hasMentorPeer) {
      const mentorAvailable = input.employees.some((m) => m.status === 'active' && isMentor(m) && !isNewbie(m)
        && exclusionReasons(input, assignments, m, date, shift, index, depth + 1).length === 0);
      if (mentorAvailable) out.push('本班需要可带教者');
    }
  }
  return out;
}

/**
 * 需求②：「当天这个班次真的能上」的女性名单 —— 与贪心选人（exclusionReasons）同一套判据。
 * 注意不能用「在职 + 没请假」这种宽松判据：她可能已经排了别的班、被晚班后的休息红线挡住、
 * 或已到月休上限，这些情况下她当天根本上不了早班，不该被判成「有人可用却没排」。
 * 这里先把她已占的该班次席位摘掉再判断（等价于问「当时这个空位她能不能坐」）。
 */
function placeableFemales(input: EngineInput, assignments: Assignment[], date: string, shift: string): Employee[] {
  const others = assignments.filter((a) => !(a.work_date === date && a.shift_code === shift));
  return input.employees.filter((e) => isFemale(e) && exclusionReasons(input, others, e, date, shift, undefined, 0).length === 0);
}

/** 压连休多排的班次，note 里写这个标记，用来把人数校验算准 */
export const RELIEF_NOTE = 'relief';

/** 周末和节假日的早班、晚班，为压连休最多加到这么多人 */
export const REST_RELIEF_CAP = 3;

/**
 * 这一班实际该有几个人：模板人数，加上为压连休补进来的人，上限 3。
 * 周/月表的人数也要用它（只 export 给展示层），否则压连休补进来的位子会被当成「多 1 人」标紫。
 */
export function expectedCount(input: EngineInput, assignments: Assignment[], date: string, shift: ShiftTemplate): number {
  const base = demandFor(date, shift, input);
  // 为压连休补进来的人，每个班最多补到 3 人
  const extra = assignments.filter((a) => a.work_date === date && a.shift_code === shift.code && a.note === RELIEF_NOTE).length;
  return Math.min(REST_RELIEF_CAP, base + extra);
}

/**
 * 这个人到 date 为止已经连续休息几天。只数「已经排过班的日子」里的休息，
 * 跨周也算；没排过的天、请假的天不算。
 */
function restStreakAt(input: EngineInput, assignments: Assignment[], employee: Employee, date: string): number {
  const worked = new Set(assignments.filter((a) => a.employee_id === employee.id).map((a) => a.work_date));
  const month = date.slice(0, 7);
  const scheduled = new Set([...(input.scheduledDates || []), ...assignments.map((a) => a.work_date)]
    .filter((d) => d.slice(0, 7) === month));
  let run = 0;
  for (let cursor = date; cursor.slice(0, 7) === month; cursor = addDays(cursor, -1)) {
    if (!scheduled.has(cursor) || !employed(employee, cursor)) break;
    if (input.requirements.some((r) => r.type === 'leave' && r.employee_id === employee.id && activeOn(r, cursor))) break;
    if (worked.has(cursor)) break;
    run += 1;
  }
  return run;
}

/**
 * 店长本周不休息：把店长补进这一周还没排到的每一天。
 * 有空位就占空位，没空位就补一个位子（走压连休那套人数校验，每个班最多 3 人）。
 * 补之前先体检，补不动就保持原样。
 */
function fillManagerWeek(input: EngineInput, assignments: Assignment[]): void {
  if (!input.managerNoRest) return;
  const boss = input.employees.find((e) => isManager(e) && e.status === 'active');
  if (!boss) return;
  const frozen = new Set(input.frozenSlots || []);
  const locked = lockedDatesOf(input);
  for (const date of eachDate(input.weekStart, addDays(input.weekStart, 6))) {
    // 已经过去的日子 / 已经开始的班是历史，绝不回填
    if (date < todayStr()) continue;
    if (locked.has(date)) continue; // 单日锁定：整天不动，也不往里补人
    if (assignments.some((a) => a.employee_id === boss.id && a.work_date === date)) continue;
    if (!employed(boss, date)) continue;
    for (const code of ['early', 'middle', 'night'] as const) {
      if (frozen.has(slotKey(date, code))) continue;
      const shift = shiftOf(input, code);
      if (!shift) continue;
      const got = assignments.filter((a) => a.work_date === date && a.shift_code === code);
      const need = expectedCount(input, assignments, date, shift);
      const room = got.length < need || (code !== 'middle' && got.length < REST_RELIEF_CAP);
      if (!room) continue;
      const candidate: Assignment = {
        work_date: date, shift_code: code, shift_id: shift.id, employee_id: boss.id,
        status: 'draft', source: 'auto', note: got.length < need ? undefined : RELIEF_NOTE,
      };
      if (validateAssignments(input, [...assignments, candidate]).length === 0) {
        assignments.push(candidate);
        break;
      }
    }
  }
}

/**
 * 压连休：排完之后，若有人再休息一天就会超过连休上限，就在周末/节假日的早班或晚班
 * 补一个位子把他排上（每个班最多 3 人）。补之前先体检一遍，补不动就保持原样。
 * 这样不会挤掉别人的位子，整周永远排得下。
 */
function relieveLongRest(input: EngineInput, assignments: Assignment[]): void {
  const cap = maxRestStreak(input);
  if (cap <= 0) return;
  // 补到哪个班：优先用周排班页设的那个，补不下再试另外两个
  const prefer = input.reliefShift === 'middle' ? 'middle' : input.reliefShift === 'night' ? 'night' : 'early';
  const order = [prefer, ...(['early', 'middle', 'night'] as const).filter((c) => c !== prefer)];
  const frozen = new Set(input.frozenSlots || []);
  const locked = lockedDatesOf(input);
  // 需求⑤：忙日补人 —— 周末 / 法定节假日排前面（连休本来也多是忙日压出来的），
  // 忙日补不下再退回平日，保证「补不动就不补，绝不让整周排不下」这条底线不变。
  const weekDates = eachDate(input.weekStart, addDays(input.weekStart, 6)).filter((date) => date >= todayStr() && !locked.has(date));
  const busy = (date: string) => Boolean(input.holidays?.[date] === 'holiday' || isWeekend(date));
  const dates = [...weekDates.filter(busy), ...weekDates.filter((date) => !busy(date))];
  for (const date of dates) {
    for (const code of order) {
      if (frozen.has(slotKey(date, code))) continue; // 已经开始的班不回填
      const shift = shiftOf(input, code);
      if (!shift) continue;
      const got = assignments.filter((a) => a.work_date === date && a.shift_code === code);
      if (got.length < demandFor(date, shift, input)) continue; // 还没排满，交给重算去补
      if (got.length >= REST_RELIEF_CAP) continue;
      const waiting = input.employees.filter((e) =>
        employed(e, date)
        && !assignments.some((a) => a.employee_id === e.id && a.work_date === date)
        && restStreakAt(input, assignments, e, addDays(date, -1)) >= cap);
      for (const person of waiting) {
        const candidate: Assignment = { work_date: date, shift_code: code, shift_id: shift.id, employee_id: person.id, status: 'draft', source: 'auto', note: RELIEF_NOTE };
        // 补之前先体检：补进去不能让任何人违反规则。补不动就保持原样，整周永远排得下。
        if (validateAssignments(input, [...assignments, candidate]).length === 0) {
          assignments.push(candidate);
          break;
        }
      }
      if (assignments.some((a) => a.work_date === date && a.shift_code === code && a.note === RELIEF_NOTE)) break;
    }
  }
}

function slots(input: EngineInput, dates: string[]) {
  return dates.flatMap((date) => input.shifts.filter((s) => s.enabled).map((shift) => ({ date, shift, count: demandFor(date, shift, input) })));
}

function capacity(input: EngineInput): Diagnosis['capacity'] {
  const months = [...new Set(eachDate(input.weekStart, addDays(input.weekStart, 6)).map(monthOf))];
  const byMonth = months.map((month) => {
    const start = month + '-01';
    const end = monthEnd(start);
    const dates = eachDate(start, end);
    const demand = slots(input, dates).reduce((n, s) => n + s.count, 0);
    const available = input.employees.reduce((n, e) => {
      const possible = dates.filter((d) => employed(e, d) && !input.requirements.some((r) => r.type === 'leave' && r.employee_id === e.id && activeOn(r, d))).length;
      return n + Math.min(dates.length - restFloor(input, e), possible);
    }, 0);
    return { month, demand, available };
  });
  return { demand: byMonth.reduce((n, m) => n + m.demand, 0), available: byMonth.reduce((n, m) => n + m.available, 0), byMonth };
}

function diagnosis(input: EngineInput, current: Assignment[], cap: Diagnosis['capacity'], preflight = false, conflicts: Issue[] = []): Diagnosis {
  const frozen = new Set(input.frozenSlots || []);
  // 单日锁定的日子不进诊断：它们已经冻结，不该再提示「去补人 / 去松绑」
  const locked = lockedDatesOf(input);
  const weekSlots = slots(input, eachDate(input.weekStart, addDays(input.weekStart, 6)))
    .filter((slot) => !frozen.has(slotKey(slot.date, slot.shift.code)) && !locked.has(slot.date));
  const shortByDate = new Map<string, number>();
  if (preflight) for (const date of eachDate(input.weekStart, addDays(input.weekStart, 6))) {
    const demand = weekSlots.filter((s) => s.date === date).reduce((n, s) => n + s.count, 0);
    const available = input.employees.filter((e) => employed(e, date) && !input.requirements.some((r) => r.type === 'leave' && r.employee_id === e.id && activeOn(r, date))).length;
    shortByDate.set(date, Math.max(0, demand - available));
  }
  const dailyDeficits = new Map(shortByDate);
  const missing = weekSlots.flatMap((slot) => {
    const assigned = current.filter((a) => a.work_date === slot.date && a.shift_code === slot.shift.code).length;
    let deficit = Math.max(0, slot.count - assigned);
    if (preflight) {
      const remaining = shortByDate.get(slot.date) || 0;
      deficit = Math.min(deficit, remaining);
      shortByDate.set(slot.date, remaining - deficit);
    }
    if (!deficit) return [];
    const excluded = input.employees.map((e) => ({ employeeId: e.id, name: e.name, reasons: exclusionReasons(input, current, e, slot.date, slot.shift.code) }))
      .filter((e) => e.reasons.length);
    // 人数松绑建议：该日该班被临时调高过，就明确告诉店长可以降回模板人数
    const base = baseDemandFor(slot.date, slot.shift, input);
    const relax = slot.count > base ? `；或将 ${slot.date}${slot.shift.name}从 ${slot.count} 人降回 ${base} 人` : '';
    return [{ date: slot.date, shift: slot.shift.name, missing: deficit, excluded,
      suggestion: `为 ${slot.date}${slot.shift.name} 增加 ${deficit} 名可出勤员工，或调低该班人数${relax}` }];
  });
  // 已排人数超过当前需求（多半是调低人数或锁定后改人数导致）
  const over = weekSlots.flatMap((slot) => {
    const assigned = current.filter((a) => a.work_date === slot.date && a.shift_code === slot.shift.code).length;
    if (assigned <= slot.count) return [];
    return [{ date: slot.date, shift: slot.shift.name, assigned, count: slot.count }];
  });
  const suggestions = preflight
    ? [...dailyDeficits].filter(([, n]) => n > 0).map(([date, n]) => `${date} 增加至少 ${n} 名可出勤替班人员，或调整当日请假和班次人数`)
    : missing.map((m) => m.suggestion);
  for (const m of cap.byMonth.filter((x) => !frozen.size && x.demand > x.available)) {
    suggestions.push(`${m.month} 增加至少 ${m.demand - m.available} 个可出勤人次，或降低当月班次人数（当前每人月休要求 ${minRestDays(input)} 天）`);
  }
  for (const o of over) {
    suggestions.push(`${o.date}${o.shift} 已排 ${o.assigned} 人，超过当前需求 ${o.count} 人；可重算未来班次，或手动去掉多余的人`);
  }
  if (conflicts.length) suggestions.unshift('先调整被标记的手工条目，或确认后覆盖未来手工调整');
  // 人数松绑建议：不管走 preflight 还是逐槽位诊断，都把「降回模板人数」明确列出来
  for (const slot of weekSlots) {
    const base = baseDemandFor(slot.date, slot.shift, input);
    if (slot.count <= base) continue;
    const tip = `将 ${slot.date}${slot.shift.name}从 ${slot.count} 人降回 ${base} 人`;
    if (!suggestions.some((s) => s.includes(tip))) suggestions.push(tip);
  }
  // 需求②③：规则类问题（早班缺女性、新人无带教）也进诊断与建议
  const ruleIssues = collectRuleIssues(input, current);
  for (const issue of ruleIssues) {
    if (!suggestions.some((s) => s.includes(issue.text))) suggestions.push(issue.text + '：' + issue.suggestion);
  }
  if (!suggestions.length) suggestions.push('增加可出勤员工，或调整受限日期的班次人数');
  return { capacity: cap, missing, conflicts, suggestions, over, ruleIssues };
}

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

function counts(assignments: Assignment[], id: number, month: string, index?: AssignmentIndex) {
  const rows = (index ? (index.byEmployee.get(id) || []) : assignments.filter((a) => a.employee_id === id))
    .filter((a) => monthOf(a.work_date) === month);
  return { total: new Set(rows.map((a) => a.work_date)).size,
    early: rows.filter((a) => a.shift_code === 'early').length,
    middle: rows.filter((a) => a.shift_code === 'middle').length,
    night: rows.filter((a) => a.shift_code === 'night').length };
}

function scheduledDatesFor(input: EngineInput, assignments: Assignment[], month: string): Set<string> {
  const dates = new Set((input.scheduledDates || []).filter((date) => monthOf(date) === month));
  for (const date of assignments.filter((a) => monthOf(a.work_date) === month).map((a) => a.work_date)) dates.add(date);
  return dates;
}

/* ------------------------------------------------------------------
 * P2-fix：公平性软约束重定义为两层（优先级从高到低）
 *   第一优先：出勤天数均衡 —— 同一周期内各人出勤天数差 ≤ 2；
 *             可用性受限者（避班/请假导致可上班次变少）在其可上班次池内优先补班，
 *             已达其可排上限的人豁免比较，并在体检报告里单独标注。
 *   第二优先：晚班公平 —— 只在「可上晚班的人」之间比较，次数差 ≤ 1；不可上晚班者不参与。
 * 月休 = 周期天数 − 出勤天数，自然跟随第一层，不再单独比较。
 * ------------------------------------------------------------------ */

/** 第一优先：出勤天数差容差（天） */
export const ATTENDANCE_TOLERANCE = 2;
/** 第二优先：可上晚班人员之间的晚班次数差容差（次） */
export const NIGHT_TOLERANCE = 1;
/**
 * 「早班尽量排女性」是软约束（需求②），只能当**同分时的偏好**，不能压过出勤均衡（需求④）。
 * 以前它写在排序比较器的最前面（字典序优先），等于把软约束做成了硬约束：
 * 早班 2 个座几乎全给女性，男性只能挤中班/晚班，结果出勤天数差被拉到 8~12 天
 * （可用性受限者不被迫多休、差 ≤2 这条硬指标直接失效）。折成 0.4 天分量后，
 * 出勤缺口 ≥1 天的人会优先补上，缺口持平时仍然优先女性。
 */
export const FEMALE_EARLY_BONUS = 0.4;

export interface PersonAvailability {
  /** 当月最多能上几天班（当天有至少一个没被避掉的班次且没请假才算） */
  cap: number;
  /** 当月是否还有任何一天可以上晚班 */
  canNight: boolean;
}

export interface FairnessPerson {
  employeeId: number;
  name: string;
  total: number;
  night: number;
  cap: number;
  canNight: boolean;
}

export interface FairnessInfo {
  month: string;
  /** 公平水位（人均目标出勤天数，已考虑各人可排上限） */
  level: number;
  people: FairnessPerson[];
  /** 出勤天数差（只比较还有补班空间的人） */
  attendanceSpread: number;
  /** 可上晚班人员之间的晚班次数差 */
  nightSpread: number;
  /** 已达可排上限的可用性受限人员 */
  limited: { employeeId: number; name: string; total: number; cap: number }[];
}

/** 某人在某月的可上班次池（天数上限 + 能否上晚班） */
export function availabilityOf(input: EngineInput, employee: Employee, month: string): PersonAvailability {
  const dates = eachDate(month + '-01', monthEnd(month + '-01'));
  let cap = 0;
  let canNight = false;
  for (const date of dates) {
    if (!employed(employee, date)) continue;
    const reqs = input.requirements.filter((r) => activeOn(r, date));
    if (reqs.some((r) => r.type === 'leave' && r.employee_id === employee.id)) continue;
    const avoided = new Set<string>();
    for (const r of reqs) if (r.type === 'avoid' && r.employee_id === employee.id) for (const code of r.shift_codes) avoided.add(code);
    const usable = input.shifts.filter((s) => s.enabled && !avoided.has(s.code));
    if (!usable.length) continue;
    cap += 1;
    if (usable.some((s) => s.code === 'night')) canNight = true;
  }
  return { cap, canNight };
}

/** 公平水位：把当期总人次尽量平均地分给每个人，同时不超过各自可排上限 */
export function fairLevel(caps: number[], demand: number): number {
  if (!caps.length) return 0;
  const maxCap = Math.max(...caps);
  let level = 0;
  while (level < maxCap) {
    const next = level + 1;
    const total = caps.reduce((sum, cap) => sum + Math.min(cap, next), 0);
    if (total > demand) break;
    level = next;
  }
  return level;
}

export interface FairnessBase {
  month: string;
  demand: number;
  level: number;
  caps: Map<number, number>;
  canNight: Map<number, boolean>;
  /** 每个人的出勤公平目标 = min(可排上限, 水位) */
  targets: Map<number, number>;
}

/**
 * 公平性基础数据：只跟员工 / 请假 / 避班 / 班次模板有关，跟排班结果无关，
 * 因此一次生成只算一遍（性能：原来放进打分会重复算几十次）。
 */
export function buildFairnessBase(input: EngineInput, months: string[]): Map<string, FairnessBase> {
  const out = new Map<string, FairnessBase>();
  const list = input.employees.filter((e) => e.status === 'active' && !isManager(e));
  const managers = input.employees.filter((e) => e.status === 'active' && isManager(e));
  for (const month of months) {
    const availability = list.map((e) => availabilityOf(input, e, month));
    const demand = slots(input, eachDate(month + '-01', monthEnd(month + '-01'))).reduce((n, s) => n + s.count, 0);
    const level = fairLevel(availability.map((a) => a.cap), demand);
    const managerAvail = managers.map((e) => availabilityOf(input, e, month));
    out.set(month, {
      month,
      demand,
      level,
      caps: new Map([
        ...list.map((e, i) => [e.id, availability[i].cap] as const),
        ...managers.map((e, i) => [e.id, managerAvail[i].cap] as const),
      ]),
      canNight: new Map(list.map((e, i) => [e.id, availability[i].canNight])),
      targets: new Map([
        ...list.map((e, i) => [e.id, Math.min(availability[i].cap, level)] as const),
        // 店长不参与员工的出勤拉平，目标按他自己的月休天数算
        ...managers.map((e, i) => [e.id, managerAvail[i].cap] as const),
      ]),
    });
  }
  return out;
}

/** 两层公平性的当期体检结果 */
export function monthFairness(input: EngineInput, assignments: Assignment[], month: string, index?: AssignmentIndex, base?: FairnessBase): FairnessInfo {
  const b = base ?? buildFairnessBase(input, [month]).get(month)!;
  const list = input.employees.filter((e) => e.status === 'active' && !isManager(e));
  const people: FairnessPerson[] = list.map((e) => {
    const c = counts(assignments, e.id, month, index);
    return { employeeId: e.id, name: e.name, total: c.total, night: c.night, cap: b.caps.get(e.id) ?? 0, canNight: b.canNight.get(e.id) ?? false };
  });
  // 出勤均衡只比较「还有补班空间」的人：已达可排上限的受限者豁免（边界情形）
  const days = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  // 出勤均衡只比较「还能多上」的人：已达上限（可排天数与月休下限取小）的人豁免——他们不可能更多
  const room = people.filter((p) => {
    const person = input.employees.find((x) => x.id === p.employeeId);
    return p.total < Math.min(p.cap, days - restFloor(input, person || {}));
  });
  const attendanceSpread = room.length > 1 ? Math.max(...room.map((p) => p.total)) - Math.min(...room.map((p) => p.total)) : 0;
  // 晚班公平只在可上晚班的人之间比较
  const nightCapable = people.filter((p) => p.canNight);
  const nightSpread = nightCapable.length > 1
    ? Math.max(...nightCapable.map((p) => p.night)) - Math.min(...nightCapable.map((p) => p.night))
    : 0;
  const limited = people
    .filter((p) => p.cap < days && p.total >= p.cap)
    .map((p) => ({ employeeId: p.employeeId, name: p.name, total: p.total, cap: p.cap }));
  return { month, level: b.level, people, attendanceSpread, nightSpread, limited };
}

function score(input: EngineInput, assignments: Assignment[], base?: Map<string, FairnessBase>): number {
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  const months = [...new Set(eachDate(input.weekStart, addDays(input.weekStart, 6)).map(monthOf))];
  const index = indexOf(assignments);
  const shared = base ?? buildFairnessBase(input, months);
  let penalty = 0;
  for (const month of months) {
    const fair = monthFairness(input, assignments, month, index, shared.get(month));
    if (!fair.people.length) continue;
    // 第一优先：出勤天数均衡（超容差部分平方放大，确保压过内外场/连上/改动量等其它软约束；
    // 已达可排上限的受限者已在 monthFairness 里豁免）
    const attendanceOver = Math.max(0, fair.attendanceSpread - ATTENDANCE_TOLERANCE);
    penalty += attendanceOver * attendanceOver * w.rest;
    // 第二优先：可上晚班人员之间的晚班公平（不可上晚班的人不参与比较）
    const nightOver = Math.max(0, fair.nightSpread - NIGHT_TOLERANCE);
    penalty += nightOver * nightOver * w.night;
  }
  for (const date of eachDate(input.weekStart, addDays(input.weekStart, 6))) {
    for (const shift of input.shifts) {
      const pair = index.bySlot.get(slotKey(date, shift.code)) || [];
      if (pair.length === 2) {
        const emp = pair.map((a) => input.employees.find((e) => e.id === a.employee_id));
        if (!(emp.some((e) => e?.tags.includes('内场')) && emp.some((e) => e?.tags.includes('外场')))) penalty += w.field;
      }
    }
  }
  for (const e of input.employees) {
    const dates = [...new Set((index.byEmployee.get(e.id) || []).map((a) => a.work_date))].sort();
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
      streak = dates[i] === addDays(dates[i - 1], 1) ? streak + 1 : 1;
      if (streak > 5) penalty += w.streak;
    }
    // 连休超限扣分：把休息摊开，不要连着休好几天（上限来自设置 scheduler_max_rest_streak）
    const restCap = maxRestStreak(input);
    if (restCap > 0) {
      for (const date of eachDate(input.weekStart, addDays(input.weekStart, 6))) {
        if (dates.includes(date) || !employed(e, date)) continue;
        const run = restStreakAt(input, assignments, e, date);
        if (run > restCap) penalty += w.streak;
      }
    }
  }
  const old = input.existing.filter((a) => a.work_date >= input.weekStart && a.work_date <= addDays(input.weekStart, 6));
  for (const a of old) if (!(index.bySlot.get(slotKey(a.work_date, a.shift_code)) || []).some((b) => b.employee_id === a.employee_id)) penalty += w.changes;
  // 需求②软约束：早班女性越多越好（权重 scheduler_weight_female）
  if (requireFemaleEarly(input)) {
    let earlyFemale = 0;
    for (const date of eachDate(input.weekStart, addDays(input.weekStart, 6))) {
      for (const a of index.bySlot.get(slotKey(date, 'early')) || []) {
        const e = employeeOf(input, a.employee_id);
        if (e && isFemale(e)) earlyFemale += 1;
      }
    }
    penalty -= earlyFemale * w.female;
  }
  return -penalty;
}

/** 需求②③：规则类问题的说明与松绑建议（早班缺女性接待 / 新人无带教者） */
export function collectRuleIssues(input: EngineInput, assignments: Assignment[]): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const weekDates = eachDate(input.weekStart, addDays(input.weekStart, 6));
  const frozen = new Set(input.frozenSlots || []);
  const byId = new Map(input.employees.map((e) => [e.id, e]));
  const label = (code: string) => names[code] || code;

  if (requireFemaleEarly(input)) {
    const females = input.employees.filter((e) => e.status === 'active' && isFemale(e));
    for (const date of weekDates) {
      if (frozen.has(slotKey(date, 'early'))) continue;
      const need = slots(input, [date]).filter((s) => s.shift.code === 'early').reduce((n, s) => n + s.count, 0);
      if (!need) continue;
      const got = assignments.filter((a) => a.work_date === date && a.shift_code === 'early');
      const hasFemale = got.some((a) => { const e = byId.get(a.employee_id); return Boolean(e && isFemale(e)); });
      if (hasFemale) continue;
      // 「真的能上这天早班」才算可用（与贪心同一判据）：她可能已排了别的班 / 被晚班后休息红线挡住 / 到月休上限
      const available = placeableFemales(input, assignments, date, 'early');
      if (available.length) continue; // 真能上却没排上，属硬约束问题（会在校验里报错），这里只提示「没人可用」
      const onLeave = females.filter((e) => onLeaveOn(input, e, date)).length;
      issues.push({
        kind: 'gender', date, shift: '早班',
        text: `${date} 早班缺少女性接待（可用女性：0 / 请假 ${onLeave} 人）`,
        suggestion: '临时让男性顶早班接待，或当天早班降为 1 人；也可以调整女员工的请假/避班安排',
      });
    }
  }

  const newbiePool = input.employees.filter((e) => e.status === 'active' && isNewbie(e));
  const mentorPool = input.employees.filter((e) => e.status === 'active' && isMentor(e) && !isNewbie(e));
  if (newbiePool.length && !mentorPool.length) {
    issues.push({
      kind: 'mentor', date: weekDates[0], shift: '',
      text: `全店没有可带教者（在职新人 ${newbiePool.length} 人）`,
      suggestion: '把店长或老人设为「可带教」，或当天不排新人',
    });
  }

  for (const date of weekDates) {
    for (const shift of input.shifts.filter((s) => s.enabled)) {
      if (frozen.has(slotKey(date, shift.code))) continue;
      const got = assignments.filter((a) => a.work_date === date && a.shift_code === shift.code);
      if (!got.length) continue;
      const people = got.map((a) => byId.get(a.employee_id)).filter((e): e is Employee => Boolean(e));
      const newbies = people.filter((e) => isNewbie(e));
      if (!newbies.length) continue;
      const alone = newbies.filter((person) => !mentorAround(input, assignments, person.id, date, shift.code));
      if (!alone.length) continue;
      issues.push({
        kind: 'mentor', date, shift: shift.name,
        text: `${date} ${label(shift.code)}：新人${alone.map((e) => e.name).join('、')}这个时间段没有可带教的人`,
        suggestion: '安排店长或老人上一个时间重叠的班，或当天不排新人',
      });
    }
  }
  return issues;
}

/** 需求 E：每人本周出勤/休息/晚班 + 休息日期 + 距月休目标还差几天 */
export function weekSummary(input: EngineInput, assignments: Assignment[], index?: AssignmentIndex): WeekPerson[] {
  const weekEnd = addDays(input.weekStart, 6);
  const weekDates = eachDate(input.weekStart, weekEnd);
  return input.employees.filter((e) => e.status === 'active').map((e) => {
    const all = index ? index.byEmployee.get(e.id) || [] : assignments.filter((a) => a.employee_id === e.id);
    const own = all.filter((a) => a.work_date >= input.weekStart && a.work_date <= weekEnd);
    const workDates = new Set(own.map((a) => a.work_date));
    const scheduled = new Set((input.scheduledDates || []).filter((d) => d >= input.weekStart && d <= weekEnd));
    for (const date of all.map((a) => a.work_date)) {
      if (date >= input.weekStart && date <= weekEnd) scheduled.add(date);
    }
    const restDates = weekDates.filter((d) => scheduled.has(d) && !workDates.has(d) && employed(e, d));
    // 连续休息超过上限的那几天标红。往前看到这个月里已排过的天，跨周的连休也算
    const cap = maxRestStreak(input);
    const longRest: string[] = [];
    if (cap > 0) {
      const month = input.weekStart.slice(0, 7);
      const monthScheduled = [...new Set([...(input.scheduledDates || []), ...all.map((a) => a.work_date)])]
        .filter((d) => d.slice(0, 7) === month && employed(e, d)).sort();
      const workedAll = new Set(all.map((a) => a.work_date));
      let run: string[] = [];
      const flush = () => { if (run.length > cap) longRest.push(...run.filter((d) => restDates.includes(d))); run = []; };
      for (const date of monthScheduled) {
        if (run.length && date !== addDays(run[run.length - 1], 1)) flush();
        if (!workedAll.has(date)) run.push(date);
        else flush();
      }
      flush();
    }
    const monthFrom = monthStart(input.weekStart);
    const monthEndDate = monthEnd(input.weekStart);
    const monthWork = new Set(all.filter((a) => a.work_date >= monthFrom && a.work_date <= weekEnd).map((a) => a.work_date));
    const month = monthOf(input.weekStart);
    const scheduledMonth = new Set([...scheduledDatesFor(input, assignments, month)].filter((d) => d <= weekEnd));
    const monthRest = eachDate(monthFrom, weekEnd < monthEndDate ? weekEnd : monthEndDate)
      .filter((d) => scheduledMonth.has(d) && !monthWork.has(d) && employed(e, d)).length;
    return {
      employeeId: e.id,
      name: e.name,
      workDays: workDates.size,
      restDays: restDates.length,
      nights: own.filter((a) => a.shift_code === 'night').length,
      restDates,
      longRest,
      monthRest,
      monthlyRestGap: Math.max(0, restFloor(input, e) - monthRest),
    };
  });
}

function report(input: EngineInput, assignments: Assignment[], base?: Map<string, FairnessBase>, residuals: Issue[] = []): Report {
  const weekDates = eachDate(input.weekStart, addDays(input.weekStart, 6));
  const frozen = new Set(input.frozenSlots || []);
  const demand = slots(input, weekDates).filter((s) => !frozen.has(slotKey(s.date, s.shift.code)))
    .reduce((n, s) => n + expectedCount(input, assignments, s.date, s.shift), 0) + assignments.filter((a) =>
      weekDates.includes(a.work_date) && frozen.has(slotKey(a.work_date, a.shift_code))).length;
  const assigned = assignments.filter((a) => weekDates.includes(a.work_date)).length;
  const months = [...new Set(weekDates.map(monthOf))];
  const index = indexOf(assignments);
  const people = months.flatMap((month) => input.employees.filter((e) => e.status === 'active').map((e) => {
    const c = counts(assignments, e.id, month, index);
    const scheduledDays = scheduledDatesFor(input, assignments, month).size;
    return { employeeId: e.id, name: e.name, early: c.early, middle: c.middle, night: c.night,
      rest: Math.max(0, scheduledDays - c.total), month };
  }));
  const shared = base ?? buildFairnessBase(input, months);
  const fairness = months.map((month) => monthFairness(input, assignments, month, index, shared.get(month)));
  const warnings: string[] = [];
  for (const fair of fairness) {
    // 第一优先：出勤天数均衡（月休 = 周期天数 − 出勤天数，自然跟随，不再单独比较）
    if (fair.attendanceSpread > ATTENDANCE_TOLERANCE) {
      warnings.push(fair.month + ' 出勤天数差 ' + fair.attendanceSpread + ' 天，超过 ' + ATTENDANCE_TOLERANCE + ' 天');
    }
    // 第二优先：可上晚班人员之间的晚班公平
    if (fair.nightSpread > NIGHT_TOLERANCE) {
      warnings.push(fair.month + ' 可上晚班人员之间的晚班次数差 ' + fair.nightSpread + ' 次，超过 ' + NIGHT_TOLERANCE + ' 次');
    }
    // 边界情形：可用性受限者已达其可排上限
    for (const p of fair.limited) {
      warnings.push(p.name + ' 受可用性限制，出勤 ' + p.total + ' 天已达其可排上限（可排 ' + p.cap + ' 天）');
    }
  }
  const shortRest = people.filter((p) => {
    const full = months.some((month) => p.month === month && scheduledDatesFor(input, assignments, month).size === daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))));
    const person = input.employees.find((e) => e.id === p.employeeId);
    return full && p.rest < restFloor(input, person || {});
  });
  if (shortRest.length) warnings.push(shortRest.map((p) => p.name).join('、') + ' 月休不足');
  const week = weekSummary(input, assignments, index);
  // 规则提示（早班女性 / 新人带教）单独放在 ruleIssues 里，工作台用独立 Alert 展示，
  // 不再重复塞进 warnings —— 否则同一条提示会在同一张卡片里出现两次。
  const ruleIssues = collectRuleIssues(input, assignments);
  const managerFloor = managerRestDays(input);
  return { demand, assigned, coverage: demand ? assigned / demand : 1, score: score(input, assignments, shared), people, warnings, fairness, week, ruleIssues,
    managerRestNotice: managerRestNoticeOf(input, week, assignments), managerRestDays: managerFloor, residuals };
}

/**
 * 店长月休提示（问题②）：唯一口径 = restFloor / managerRestDays，不再另立标准。
 * - 设置 0（不设下限）→ 恒为 null：零报错、零提醒；
 * - 「店长本周不休息」开着 → 本周本来就不给店长排休，不提示；
 * - 设置 >0 → 店长本月已休低于该值才提示，且要求整月已排完（与 warnings 的「月休不足」同一口径，
 *   避免月中还没排到的日子被当成欠休）。
 */
function managerRestNoticeOf(input: EngineInput, week: WeekPerson[], assignments: Assignment[]): string | null {
  const floor = managerRestDays(input);
  if (floor <= 0) return null;
  if (input.managerNoRest) return null;
  const boss = input.employees.find((e) => isManager(e) && e.status === 'active');
  if (!boss) return null;
  const row = week.find((p) => p.employeeId === boss.id);
  if (!row) return null;
  const month = monthOf(input.weekStart);
  const total = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  if (scheduledDatesFor(input, assignments, month).size !== total) return null;
  if (row.monthRest >= floor) return null;
  return '店长本月已休 ' + row.monthRest + ' 天，低于设置的 ' + floor + ' 天；可在设置里把「店长每月最少休息天数」调低或改成 0，或手动给店长补休';
}

/** 不搭班（pairing）命中时，找出同一个班里与之配对的那一方（用于脱敏聚合与解锁后的「谁 × 谁」） */
function pairingPeer(input: EngineInput, others: Assignment[], a: Assignment): Employee | undefined {
  const reqs = input.requirements.filter((r) => r.type === 'pairing' && activeOn(r, a.work_date));
  const peer = others.find((p) => p.work_date === a.work_date && p.shift_code === a.shift_code
    && reqs.some((r) => (r.employee_id === a.employee_id && r.employee_id_2 === p.employee_id)
      || (r.employee_id_2 === a.employee_id && r.employee_id === p.employee_id)));
  return peer ? employeeOf(input, peer.employee_id) : undefined;
}

/**
 * 接口层用：某人某天某班命中不搭班时，配对另一方的姓名。
 * 换人 / 拖拽 / 点名这些试查入口靠它把「谁 × 谁」交给统一的脱敏出口，
 * 未解锁时那一步只会输出聚合文案，姓名不会落到响应里。
 */
export function pairingPartnerName(input: EngineInput, assignments: Assignment[], employeeId: number, date: string, shift: string): string | undefined {
  return pairingPeer(input, assignments, { work_date: date, shift_code: shift, shift_id: 0, employee_id: employeeId })?.name;
}

/**
 * 结构化残留问题（B3）：
 * - secret=true 的条目来自「不搭班」保密约束，未解锁口令时只允许聚合展示；
 * - text 是完整明文（已解锁时的详情 / 内部校验文案），禁止在未解锁的响应里直接使用。
 * 判据与原来的 validateAssignments 完全一致，只是把「谁和谁」拆成结构化字段，便于统一脱敏。
 */
export function residualIssues(input: EngineInput, assignments: Assignment[]): Issue[] {
  const issues: Issue[] = [];
  const frozen = new Set(input.frozenSlots || []);
  for (const slot of slots(input, eachDate(input.weekStart, addDays(input.weekStart, 6)))) {
    if (frozen.has(slotKey(slot.date, slot.shift.code))) continue;
    const got = assignments.filter((a) => a.work_date === slot.date && a.shift_code === slot.shift.code);
    const need = expectedCount(input, assignments, slot.date, slot.shift);
    if (got.length !== need) issues.push({ secret: false, text: `${slot.date}${slot.shift.name}人数 ${got.length}/${need}` });
  }
  for (const a of assignments.filter((x) => x.work_date >= input.weekStart && x.work_date <= addDays(input.weekStart, 6))) {
    if (frozen.has(slotKey(a.work_date, a.shift_code))) continue;
    const employee = input.employees.find((e) => e.id === a.employee_id);
    if (!employee) { issues.push({ secret: false, text: `${a.work_date}员工不存在` }); continue; }
    const others = assignments.filter((b) => b !== a);
    const reasons = exclusionReasons(input, others, employee, a.work_date, a.shift_code);
    if (!reasons.length) continue;
    const shiftName = shiftLabel(a.shift_code);
    const split = splitReasons(reasons);
    // 保密原因单独成条：两个人各一行时，行内只有「配对双方 ×」这一种写法，
    // 同一个人其它原因（请假等）另起一行 —— 姓名与「冲突」字样永远不同现。
    if (split.secret) {
      const peer = pairingPeer(input, others, a);
      issues.push(secretIssue(employee.name, `${a.work_date}${shiftName}`, peer?.name));
    }
    if (split.reasons.length) issues.push({ secret: false, text: `${a.work_date}${shiftName}${employee.name}: ${split.reasons.join('、')}` });
  }
  const weekDates = eachDate(input.weekStart, addDays(input.weekStart, 6));
  // 需求②：早班 ≥1 名女性（当天确实有女性可排时才算违规；一个女员工都没有时只做提示）
  if (requireFemaleEarly(input)) {
    for (const date of weekDates) {
      if (frozen.has(slotKey(date, 'early'))) continue;
      const daySlots = slots(input, [date]).filter((s) => s.shift.code === 'early' && s.count > 0);
      if (!daySlots.length) continue;
      const got = assignments.filter((a) => a.work_date === date && a.shift_code === 'early');
      if (got.some((a) => { const e = employeeOf(input, a.employee_id); return Boolean(e && isFemale(e)); })) continue;
      // 同一条判据：只有「真的能上这天早班」的女性才算可排。
      // 修 bug：原先用「在职 + 没请假」的宽松判据，会把已排别的班 / 被休息红线挡住的女员工也算成可排，
      // 于是引擎明明已经尽力（那天确实没有女性能上早班）却被判违规，「全量重排」随机到这种解就报「排不下」。
      const femalePool = placeableFemales(input, assignments, date, 'early');
      if (femalePool.length) issues.push({ secret: false, text: `${date}早班缺少女员工（当天可排女性 ${femalePool.length} 人）` });
    }
  }
  // 新人上班的时间段里，要有老人或店长的班与他重叠。
  for (const date of weekDates) {
    for (const a of assignments.filter((x) => x.work_date === date)) {
      if (frozen.has(slotKey(a.work_date, a.shift_code))) continue;
      const e = employeeOf(input, a.employee_id);
      if (!e || !isNewbie(e)) continue;
      if (!mentorAround(input, assignments, e.id, date, a.shift_code)) {
        issues.push({ secret: false, text: `${date}${names[a.shift_code] || a.shift_code}${e.name}（新人）这个时间段没有可带教的人` });
      }
    }
  }
  return issues;
}

/**
 * 明细校验文案（内部校验 / 锁定前体检用）。
 * 判据与 residualIssues 完全一致，保密条目在这里是明文 —— 对外的接口必须再走
 * describeIssues(issues, unlocked) 脱敏，禁止把这里的字符串直接回给未解锁的前端。
 */
export function validateAssignments(input: EngineInput, assignments: Assignment[]): string[] {
  return dedupeIssues(residualIssues(input, assignments)).map((issue) => issue.text);
}

/** 体检报告（不生成）：残留问题照常实时算一遍，供「需要你看一眼的 N 处」展示 */
export function reportFor(input: EngineInput): Report {
  return report(input, input.existing, undefined, residualIssues(input, input.existing));
}

export function capacityFor(input: EngineInput): Diagnosis['capacity'] {
  return capacity(input);
}

export function generate(input: EngineInput): EngineResult {
  const weekEnd = addDays(input.weekStart, 6);
  const base = [...input.existing.filter((a) => a.work_date < input.weekStart || a.work_date > weekEnd), ...input.fixed];
  const frozen = new Set(input.frozenSlots || []);
  // 单日锁定：这些日子的条目在 base（fixed）里原样保留，重排既不删也不补人
  const locked = lockedDatesOf(input);
  const countIn = (date: string, code: string) => base.filter((a) => a.work_date === date && a.shift_code === code).length;
  // 槽位只有在「已满」或「已开始且已有人」时才跳过。不能因为槽里有手工条目就整槽跳过：
  // 2 人班只钉 1 个手工时，剩下那个座必须继续补人，否则整周永远缺人、重排永远失败。
  const weekSlots = slots(input, eachDate(input.weekStart, weekEnd)).filter((s) => {
    if (s.date < todayStr()) return false; // 已过去的日子不回填：历史班表保持原样，只排今天起
    if (locked.has(s.date)) return false; // 单日锁定：整天跳过，不删不补
    const n = countIn(s.date, s.shift.code);
    return n <= 0 || (!frozen.has(slotKey(s.date, s.shift.code)) && n < s.count);
  });
  const cap = capacity(input);
  const localShort = weekSlots.some((slot) => {
    const eligible = input.employees.filter((e) => employed(e, slot.date) && !input.requirements.some((r) => r.type === 'leave' && r.employee_id === e.id && activeOn(r, slot.date))).length;
    const dayDemand = weekSlots.filter((s) => s.date === slot.date).reduce((n, s) => n + Math.max(0, s.count - countIn(s.date, s.shift.code)), 0);
    return eligible < dayDemand;
  });
  if ((!frozen.size && cap.byMonth.some((m) => m.demand > m.available)) || localShort) return { ok: false, diagnosis: diagnosis(input, base, cap, true) };
  // P2-fix：先算好每个月的公平目标（人均出勤天数，已考虑各人可排上限）。
  // 生成时优先补「离目标最缺」的人 —— 第一优先是出勤天数均衡，第二优先才是晚班公平。
  const fairnessBase = buildFairnessBase(input, [...new Set(eachDate(input.weekStart, weekEnd).map(monthOf))]);
  const random = rng(input.seed ?? 20260928);
  let best: Assignment[] | null = null;
  let bestScore = -Infinity;
  let bestPartial = base;
  for (let attempt = 0; attempt < Math.max(1, input.restarts ?? 60); attempt++) {
    const current = [...base];
    const index = indexOf(current);
    const remaining = weekSlots.map((s) => ({ ...s, left: s.count - current.filter((a) => a.work_date === s.date && a.shift_code === s.shift.code).length }));
    if (remaining.some((s) => s.left < 0)) return { ok: false, diagnosis: diagnosis(input, current, cap) };
    // 慢轮换（业界固定班次做法）：先定「本周晚班组」—— 本月晚班最少、且本周真能上晚班的人。
    // 夜班优先给组员、早中班优先给其他人：一个人一周尽量停在同一个班，组与组之间按月轮换，晚班自然摊平。
    const weekMonths = [...new Set(eachDate(input.weekStart, weekEnd).map(monthOf))];
    const nightsSoFar = (id: number) => weekMonths.reduce((n, m) => n + counts(base, id, m, undefined).night, 0);
    // 店长不进晚班组（他以早中班为主、夜班封顶），避免被组偏好夹住没班上
    const canNight = input.employees.filter((e) => e.status === 'active' && !isManager(e)
      && eachDate(input.weekStart, weekEnd).some((d) => exclusionReasons(input, base, e, d, 'night').length === 0));
    const crewSize = Math.min(Math.max(2, Math.round(weekSlots.filter((s) => s.shift.code === 'night').reduce((n, s) => n + s.count, 0) / 4)),
      Math.max(1, input.employees.filter((e) => e.status === 'active').length - 3), canNight.length);
    const nightCrew = new Set(canNight
      .map((e) => ({ e, nights: nightsSoFar(e.id), tie: random() }))
      .sort((a, b) => a.nights - b.nights || a.tie - b.tie)
      .slice(0, Math.max(1, crewSize))
      .map((x) => x.e.id));
    let guard = 0;
    while (remaining.some((s) => s.left > 0) && guard < 40) {
      guard += 1;
      const open = remaining.filter((s) => s.left > 0).map((s) => ({ slot: s,
        candidates: input.employees.filter((e) => exclusionReasons(input, current, e, s.date, s.shift.code, index).length === 0) }));
      open.sort((a, b) => a.slot.date.localeCompare(b.slot.date) ||
        (a.candidates.length - a.slot.left) - (b.candidates.length - b.slot.left) ||
        a.candidates.length - b.candidates.length ||
        (a.slot.shift.code === 'night' ? -1 : b.slot.shift.code === 'night' ? 1 : 0));
      const { slot, candidates } = open[0];
      if (candidates.length < slot.left) break;
      // 需求③：这个班里是否「有新人、缺带教者」
      const slotPeers = (index.bySlot.get(slotKey(slot.date, slot.shift.code)) || [])
        .map((a) => employeeOf(input, a.employee_id))
        .filter((e): e is Employee => Boolean(e));
      const needMentorHere = slotPeers.some((p) => isNewbie(p)) && !slotPeers.some((p) => isMentor(p));
      const choices = candidates.map((e) => {
        const c = counts(current, e.id, monthOf(slot.date), index);
        const last = (index.byEmployee.get(e.id) || []).filter((a) => a.work_date < slot.date).map((a) => a.work_date).sort().at(-1);
        const rest = last ? (Date.parse(slot.date) - Date.parse(last)) / 86400000 : 99;
        // 出勤缺口：离当月公平目标还差多少天（越缺越优先补）
        const deficit = (fairnessBase.get(monthOf(slot.date))?.targets.get(e.id) ?? 0) - c.total;
        // 需求②软约束：早班优先排女性（早班 2 人时尽量 2 女，其次 1 女 1 男）
        const femaleFit = slot.shift.code === 'early' && requireFemaleEarly(input) && isFemale(e) ? 0 : 1;
        // 需求③：本班已经有新人但还没带教者时，优先把可带教者排进来
        const mentorFit = isMentor(e) ? 0 : 1;
        // 周内固定班次（业界慢轮换）：本周已经上过这个班的人优先继续上同一个班，
        // 不要今天早班明天中班夜班换来换去。黏性封顶 2 天：出勤缺口更大的人还是会轮上来。
        const weekOwn = (index.byEmployee.get(e.id) || []).filter((a) => a.work_date >= input.weekStart && a.work_date <= weekEnd);
        const stick = Math.min(2, weekOwn.filter((a) => a.shift_code === slot.shift.code && a.work_date < slot.date).length);
        // 晚班公平只看本月「其它周」的晚班次数：周内靠黏性成块，周与周之间靠它轮换
        const nightBase = c.night - weekOwn.filter((a) => a.shift_code === 'night').length;
        // 晚班组归属（非对称）：夜班给晚班组（2.5 天分量，保晚班班底稳、跨周轮换不乱）；
        // 早中班给其他人但只给 1.5 天分量（不让组员卡在角色缝里没班上）。
        const role = slot.shift.code === 'night' ? (nightCrew.has(e.id) ? 0 : 2.5) : (nightCrew.has(e.id) ? 1.5 : 0);
        // 综合优先分（越小越先）：夜班欠账（仅夜班）+ 角色分量 − 出勤缺口 − 周内同班黏性（系数 0.7，防叠加偏差）
        const rank = (slot.shift.code === 'night' ? nightBase * 2 : 0) + role + femaleFit * FEMALE_EARLY_BONUS - deficit - stick * 0.7;
        return { e, c, rest, tie: random(), femaleFit, mentorFit, rank, bossFit: isManager(e) ? 1 : 0 };
      });
      // 落地顺序：
      //   带教（本班有新人没带教者）/ 店长少上夜班 —— 角色类硬规则优先；
      //   综合优先分 rank（含早班女性软偏好、晚班组归属、周内黏性、出勤缺口）；
      //   其余按该班次数/总出勤/休息间隔/随机收尾。
      // 注意：早班女性只在 rank 里占 FEMALE_EARLY_BONUS 天分量，不再单独做字典序前缀 ——
      // 否则软约束会压过「出勤天数差 ≤2」这条硬指标（见 FEMALE_EARLY_BONUS 注释）。
      choices.sort((a, b) =>
        (needMentorHere ? a.mentorFit - b.mentorFit : 0) ||
        (slot.shift.code === 'night' ? a.bossFit - b.bossFit : 0) ||
        a.rank - b.rank ||
        a.c[slot.shift.code as 'early' | 'middle' | 'night'] - b.c[slot.shift.code as 'early' | 'middle' | 'night'] ||
        a.c.total - b.c.total || b.rest - a.rest || a.tie - b.tie);
      const chosen = choices[0].e;
      const assignment: Assignment = { work_date: slot.date, shift_code: slot.shift.code, shift_id: slot.shift.id, employee_id: chosen.id, status: 'draft', source: 'auto' };
      current.push(assignment);
      addToIndex(index, assignment);
      slot.left--;
    }
    if (current.length > bestPartial.length) bestPartial = current;
    if (remaining.some((s) => s.left > 0)) continue;
    const value = score(input, current, fairnessBase);
    if (value > bestScore) { best = current; bestScore = value; }
  }
  // 先排满基础人数，再为压连休补位子（补不动就不补，绝不让整周排不下）
  if (best) relieveLongRest(input, best);
  // 店长本周不休息：把店长补进这一周的每一天
  if (best) fillManagerWeek(input, best);
  // B3 尽力排（A 案）：只要生成器排出了完整方案就落库 —— 校验残留不再一票否决。
  // 残留多半来自引擎动不了的存量（手工钉的条目、已开始的班、已锁定条目），
  // 它们永远修不掉，过去会把整份结果扣下、让「重排」原地报错。
  // 现在残留进体检报告当提醒；只有完全无解（容量预检不过 / 生成器排不出完整覆盖）才 ok:false。
  if (!best) return { ok: false, diagnosis: diagnosis(input, bestPartial, cap) };
  const residuals = residualIssues(input, best);
  return { ok: true, assignments: best.filter((a) => a.work_date >= input.weekStart && a.work_date <= weekEnd),
    report: report(input, best, fairnessBase, residuals), capacity: cap };
}
