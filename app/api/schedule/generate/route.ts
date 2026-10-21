import { NextRequest } from 'next/server';
import { ApiError, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { addDays } from '@/lib/date';
import { loadEngineInput, runSchedule, weekData, windowFlags } from '@/lib/scheduler/store';
import { capacityFor, exclusionReasons, expectedCount, reportFor } from '@/lib/scheduler/engine';
import { redactDiagnosis, redactReport, splitReasons } from '@/lib/scheduler/redact';
import { weekDemand } from '@/lib/scheduler/month';
import { weekStartOf } from '@/lib/scheduler/week';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const unlocked = await sensitiveUnlocked();
  const weekStart = weekStartOf(req.nextUrl.searchParams.get('week_start'));
  const data = weekData(weekStart);
  const flags = windowFlags(data.schedule?.note);
  const input = loadEngineInput(weekStart, [], flags.managerNoRest);
  // 实时体检：每个班次当前违反了哪条约束。修完立即消失——报错不存历史快照。
  // 文案统一走脱敏：不搭班（保密）那一条不挂到具体人身上，只在体检报告里聚合成一句。
  const assignments = data.entries.map((e) => ({ id: e.id as number, work_date: e.work_date, shift_code: e.shift_code, shift_id: e.shift_id as number, employee_id: e.employee_id, note: e.note }));
  const frozen = new Set(input.frozenSlots || []);
  const issues: Record<number, string[]> = {};
  for (const a of assignments) {
    if (frozen.has(a.work_date + '|' + a.shift_code)) continue; // 已开始的班是既成事实，不回头挑错
    const person = input.employees.find((e) => e.id === a.employee_id);
    if (!person) continue;
    const reasons = exclusionReasons(input, assignments.filter((x) => x.id !== a.id), person, a.work_date, a.shift_code);
    const open = splitReasons(reasons).reasons;
    if (open.length) issues[a.id] = open;
  }
  return ok({ weekStart, weekEnd: addDays(weekStart, 6), ...data, issues, managerNoRest: flags.managerNoRest,
    // P2：每天每班的需求人数（含工作台临时改人数 + 压连休补进来的位子）+ 当前月休要求。
    // 压连休补位是引擎自己加的座，必须算进「该有几个人」，否则同一屏的体检报告说覆盖 100%、
    // 表格却给这一格标「多 1 人」。
    demand: weekDemand(weekStart).map((slot) => {
      const shift = input.shifts.find((s) => s.code === slot.code);
      if (!shift) return slot;
      const need = expectedCount(input, assignments, slot.date, shift);
      return need === slot.demand ? slot : { ...slot, demand: need };
    }),
    restRequirement: input.minRestDays ?? 4,
    // 店长月休下限（问题②）：界面上的店长提醒与「距月休目标」都以它为准，0 = 不设下限
    managerRestRequirement: input.managerRestDays ?? 2,
    reliefShift: input.reliefShift ?? 'early',
    // 体检报告的残留问题（尽力排提醒）在这里按解锁状态脱敏
    report: data.schedule ? redactReport(reportFor(input), unlocked) : null,
    capacity: data.schedule ? capacityFor(input) : null,
    frozenSlots: input.frozenSlots || [],
    // 单日锁定：这一周里被整天冻结的日期（生成 / 重排会跳过它们）
    lockedDays: input.lockedDates || [] });
});

export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const unlocked = await sensitiveUnlocked();
  const body = await readJson<Record<string, unknown>>(req);
  const weekStart = weekStartOf(body.week_start);
  if (weekData(weekStart).schedule?.status === 'locked') throw new ApiError('本周已锁定，请先解锁', 409);
  const result = runSchedule(weekStart, 'generate', body.full === true);
  if (!result.ok) return ok({ ...result, diagnosis: redactDiagnosis(result.diagnosis, unlocked) });
  return ok({ ...result, report: redactReport(result.report, unlocked), ...weekData(weekStart) });
});
