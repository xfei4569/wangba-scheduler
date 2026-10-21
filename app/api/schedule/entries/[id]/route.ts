import { NextRequest } from 'next/server';
import { ApiError, assert, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { getDb } from '@/lib/db';
import { exclusionReasons, pairingPartnerName, shiftLabel } from '@/lib/scheduler/engine';
import { describePersonIssues } from '@/lib/scheduler/redact';
import { loadEngineInput } from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';

interface EntryRow {
  id: number; work_date: string; shift_code: string; employee_id: number;
  status: string; week_start: string; week_status: string;
}

function findEntry(id: number): EntryRow {
  const db = getDb();
  const entry = db.prepare(`SELECT se.*, s.week_start, s.status AS week_status FROM schedule_entries se
    JOIN schedules s ON s.id = se.schedule_id WHERE se.id = ?`).get(id) as EntryRow | undefined;
  if (!entry) throw new ApiError('班次明细不存在', 404);
  return entry;
}

/**
 * 通用护栏：只拦「锁定」。
 * - 整周锁定 → 先解锁本周；
 * - 单日锁定（该日条目 status='locked'）→ 先解锁这一天。
 * 「已经开始的班」不再拦截手动调整（换人 / 挪班 / 撤下都要能改回来），只在试查里作为提示给出。
 */
function assertEditable(entry: EntryRow): void {
  if (entry.week_status === 'locked') throw new ApiError('本周已锁定，请先解锁', 409);
  if (entry.status === 'locked') throw new ApiError('该日已锁定，先解锁', 409);
}

/** 目标日是否被单日锁定（挪班要挪进的那一天） */
function assertTargetEditable(date: string): void {
  const db = getDb();
  const hit = db.prepare("SELECT 1 AS hit FROM schedule_entries WHERE work_date = ? AND status = 'locked' LIMIT 1").get(date);
  if (hit) throw new ApiError('该日已锁定，先解锁', 409);
}

/** 「这个班已经开始」只是一句提示，不再拒绝：手动排错要能改回来 */
function startedNotices(input: { frozenSlots?: string[] }, date: string, code: string): string[] {
  return (input.frozenSlots || []).includes(date + '|' + code)
    ? [date + shiftLabel(code) + '已经开始（改的是今天的班，请留意现场）']
    : [];
}

export const PATCH = route(async (req: NextRequest, ctx) => {
  await requireUser();
  // 口令解锁状态只信服务端：未解锁时不搭班（保密）只给聚合文案，不给「谁和谁」
  const unlocked = await sensitiveUnlocked();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '班次明细编号不正确');
  const body = await readJson<Record<string, unknown>>(req);
  const entry = findEntry(id);
  assertEditable(entry);

  // 模式②：互换 —— 两个人对调班次（拖拽换班走这里）
  const swapWith = Number(body.swap_with);
  if (body.swap_with !== undefined) {
    assert(Number.isInteger(swapWith) && swapWith > 0 && swapWith !== id, '互换对象不正确');
    const other = findEntry(swapWith);
    assertEditable(other);
    if (other.work_date === entry.work_date && other.shift_code === entry.shift_code) {
      throw new ApiError('同一个班的两个人不需要互换', 400);
    }
    const inputA = loadEngineInput(entry.week_start);
    const inputB = loadEngineInput(other.week_start);
    const empA = inputA.employees.find((e) => e.id === entry.employee_id);
    const empB = inputB.employees.find((e) => e.id === other.employee_id);
    if (!empA || !empB) throw new ApiError('员工不存在', 404);
    // 换完目标班里不能已有这个人。按「天+班+人」数，不按记录编号：
    // 窗口重叠时同一个人会有两条记录，按编号排除会把自己漏过去，撞上唯一键变成 500。
    const taken = (rows: { work_date: string; shift_code: string; employee_id: number }[], date: string, code: string, person: number) =>
      rows.some((a) => a.work_date === date && a.shift_code === code && a.employee_id === person);
    const dup: string[] = [];
    if (taken(inputA.existing, other.work_date, other.shift_code, entry.employee_id)) dup.push(empA.name + '已在那个班次');
    if (taken(inputB.existing, entry.work_date, entry.shift_code, other.employee_id)) dup.push(empB.name + '已在这个班次');
    if (dup.length) throw new ApiError('互换会造成同班重复：' + dup.join('、'), 409, { reasons: dup });
    const drop = (rows: typeof inputA.existing) => rows.filter((a) => a.employee_id !== entry.employee_id && a.employee_id !== other.employee_id);
    const reasonsA = exclusionReasons(inputA, drop(inputA.existing), empB, entry.work_date, entry.shift_code);
    const reasonsB = exclusionReasons(inputB, drop(inputB.existing), empA, other.work_date, other.shift_code);
    // 文案统一走脱敏：保密原因不落到「谁和谁」，未解锁时只有聚合提示。
    // valid / force 仍按原始原因判断——脱敏只改文案，不改拦截行为（强制生效照旧可用）。
    const shownA = describePersonIssues(reasonsA, entry.work_date + shiftLabel(entry.shift_code), empB.name,
      pairingPartnerName(inputA, drop(inputA.existing), other.employee_id, entry.work_date, entry.shift_code), unlocked, (r) => empB.name + '：' + r);
    const shownB = describePersonIssues(reasonsB, other.work_date + shiftLabel(other.shift_code), empA.name,
      pairingPartnerName(inputB, drop(inputB.existing), entry.employee_id, other.work_date, other.shift_code), unlocked, (r) => empA.name + '：' + r);
    const reasons = [...new Set([...shownA, ...shownB])];
    const conflictCount = reasonsA.length + reasonsB.length;
    // 「已经开始的班」只提示不拦截（问题①）：改今天的班是刚需，排错了要能改回来
    const notices = [...new Set([...startedNotices(inputA, entry.work_date, entry.shift_code),
      ...startedNotices(inputB, other.work_date, other.shift_code)])];
    if (body.dryRun === true) return ok({ valid: conflictCount === 0, reasons, notices });
    if (conflictCount && body.force !== true) throw new ApiError('互换违反排班约束', 409, { reasons, notices });
    const db = getDb();
    const tx = db.transaction(() => {
      db.prepare(`UPDATE schedule_entries SET employee_id = ?, source = 'manual', note = NULL, updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(other.employee_id, id);
      db.prepare(`UPDATE schedule_entries SET employee_id = ?, source = 'manual', note = NULL, updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(entry.employee_id, swapWith);
    });
    tx();
    return ok({ id, swapWith, forced: conflictCount > 0, reasons, notices });
  }

  // 模式③：挪班 —— 同一人换到本周另一个班（拖到空格/格子上走这里）
  if (body.work_date !== undefined || body.shift_code !== undefined) {
    const workDate = String(body.work_date || '');
    const shiftCode = String(body.shift_code || '');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(workDate) && shiftCode, '目标班次不正确');
    const weekEnd = new Date(entry.week_start + 'T00:00:00');
    weekEnd.setDate(weekEnd.getDate() + 6);
    const target = new Date(workDate + 'T00:00:00');
    assert(target >= new Date(entry.week_start + 'T00:00:00') && target <= weekEnd, '只能把人挪到本周内的班');
    if (workDate === entry.work_date && shiftCode === entry.shift_code) return ok({ id, moved: false, notices: [] });
    assertTargetEditable(workDate);
    const input = loadEngineInput(entry.week_start);
    const employee = input.employees.find((e) => e.id === entry.employee_id);
    if (!employee) throw new ApiError('员工不存在', 404);
    const others = input.existing.filter((a) => a.id !== id);
    if (others.some((a) => a.work_date === workDate && a.shift_code === shiftCode && a.employee_id === entry.employee_id)) {
      throw new ApiError('该员工已在本班次，不能重复', 409);
    }
    const reasons = exclusionReasons(input, others, employee, workDate, shiftCode);
    const shown = describePersonIssues(reasons, workDate + shiftLabel(shiftCode), employee.name,
      pairingPartnerName(input, others, employee.id, workDate, shiftCode), unlocked, (r) => r);
    const notices = startedNotices(input, workDate, shiftCode);
    if (body.dryRun === true) return ok({ valid: reasons.length === 0, reasons: shown, notices });
    if (reasons.length && body.force !== true) throw new ApiError('挪班违反排班约束', 409, { reasons: shown, notices });
    getDb().prepare(`UPDATE schedule_entries SET work_date = ?, shift_code = ?, source = 'manual', note = NULL, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(workDate, shiftCode, id);
    return ok({ id, workDate, shiftCode, moved: true, forced: reasons.length > 0, reasons: shown, notices });
  }

  // 模式①：换人（原有行为）
  const employeeId = Number(body.employee_id);
  assert(Number.isInteger(employeeId) && employeeId > 0, '请选择员工');
  const input = loadEngineInput(entry.week_start);
  const employee = input.employees.find((e) => e.id === employeeId);
  if (!employee) throw new ApiError('员工不存在', 404);
  const others = input.existing.filter((a) => a.id !== id);
  const reasons = exclusionReasons(input, others, employee, entry.work_date, entry.shift_code);
  const shown = describePersonIssues(reasons, entry.work_date + shiftLabel(entry.shift_code), employee.name,
    pairingPartnerName(input, others, employee.id, entry.work_date, entry.shift_code), unlocked, (r) => r);
  if (others.some((a) => a.work_date === entry.work_date && a.shift_code === entry.shift_code && a.employee_id === employeeId)) {
    throw new ApiError('该员工已在本班次，不能重复', 409, { reasons: shown });
  }
  const notices = startedNotices(input, entry.work_date, entry.shift_code);
  if (body.dryRun === true) return ok({ valid: reasons.length === 0, reasons: shown, notices });
  if (reasons.length && body.force !== true) throw new ApiError('换人违反排班约束', 409, { reasons: shown, notices });
  // 违反原因不写进 note 当历史快照：界面红字由 GET 的实时体检给出，修完即消
  const db = getDb();
  db.prepare(`UPDATE schedule_entries SET employee_id = ?, source = 'manual', note = NULL, updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(employeeId, id);
  return ok({ id, employeeId, source: 'manual', forced: reasons.length > 0, reasons: shown, notices });
});

/** 撤下：把人从班里移除。已经开始的班也允许撤（排错了要能改回来）；锁定的周 / 锁定的一天要先解锁。 */
export const DELETE = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '班次明细编号不正确');
  const entry = findEntry(id);
  assertEditable(entry);
  const input = loadEngineInput(entry.week_start);
  const notices = startedNotices(input, entry.work_date, entry.shift_code);
  getDb().prepare('DELETE FROM schedule_entries WHERE id = ?').run(id);
  return ok({ id, removed: true, notices });
});
