import { NextRequest } from 'next/server';
import { asString, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { todayStr } from '@/lib/date';
import { assert } from '@/lib/api';
import { isValidMonth, weeksOfMonth } from '@/lib/scheduler/month';
import { hasPeople, runSchedule, weekData, weekHasPeople } from '@/lib/scheduler/store';
import { redactDiagnosis } from '@/lib/scheduler/redact';
import type { EngineResult } from '@/lib/scheduler/engine';
import { getDb } from '@/lib/db';
import { addDays } from '@/lib/date';

export const dynamic = 'force-dynamic';

interface WeekResult { weekStart: string; ok: boolean; skipped?: string; assigned?: number; locked?: boolean; error?: string }

/**
 * 一键排整月：按自然周依次生成，遇到排不下的周立即停止并返回诊断。
 * B7：「已锁定」只跳过「锁定且有人」的周 —— 锁保护的是已有的人员安排；
 * 0 人的周（空周 / 只开了窗口设置）无论锁没锁都照排，否则用户点一次整月就再也补不上这一段。
 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const month = asString(body.month, '月份') || todayStr().slice(0, 7);
  assert(isValidMonth(month), '月份格式应为 YYYY-MM');
  const autoLock = body.lock === true;

  const results: WeekResult[] = [];
  const db = getDb();
  const generatedWeeks: string[] = [];
  const skippedWeeks: string[] = [];
  let failure: { weekStart: string; diagnosis: Extract<EngineResult, { ok: false }>['diagnosis'] } | undefined;
  const tx = db.transaction(() => {
    for (const weekStart of weeksOfMonth(month)) {
      const existing = weekData(weekStart);
      // 跳过判定收紧：只有「锁定 + 有人」的周才跳过（0 人的周照排）
      if (existing.schedule?.status === 'locked' && hasPeople(existing.entries)) {
        skippedWeeks.push(weekStart);
        results.push({ weekStart, ok: true, skipped: '已锁定，跳过' });
        continue;
      }
      const result = runSchedule(weekStart, 'generate');
      if (!result.ok) {
        failure = { weekStart, diagnosis: result.diagnosis };
        throw new Error('month generation failed');
      }
      results.push({ weekStart, ok: true, assigned: result.assignments.length });
      generatedWeeks.push(weekStart);
    }
    if (!autoLock) return;
    for (const weekStart of generatedWeeks) {
      // 自动锁定也只锁「有人」的周：0 人的周锁上没有任何意义，只会再造一个卡死状态
      if (!weekHasPeople(weekStart)) continue;
      db.prepare("UPDATE schedules SET status = 'locked', updated_at = datetime('now','localtime') WHERE week_start = ?").run(weekStart);
      db.prepare("UPDATE schedule_entries SET status = 'locked', updated_at = datetime('now','localtime') WHERE schedule_id = (SELECT id FROM schedules WHERE week_start = ?)").run(weekStart);
      const row = results.find((item) => item.weekStart === weekStart);
      if (row) row.locked = true;
    }
  });
  try {
    tx();
  } catch (error) {
    if (!failure) throw error;
    return ok({ ok: false, weekStart: failure.weekStart, diagnosis: redactDiagnosis(failure.diagnosis, await sensitiveUnlocked()),
      results: results.filter((item) => item.skipped), rolled_back_weeks: generatedWeeks, month });
  }
  return ok({ ok: true, month, weeks: results.length, results, autoLock,
    // B7 反馈细分用的明细：真正新排了哪几周、因为「已锁定且有人」跳过了哪几周（界面按起止区间显示）
    generated_weeks: generatedWeeks, skipped_weeks: skippedWeeks,
    weeksInMonth: weeksOfMonth(month).length, range: month + '-01 ~ ' + addDays(weeksOfMonth(month)[weeksOfMonth(month).length - 1], 6) });
});
