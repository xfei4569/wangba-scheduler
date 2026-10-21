import { NextRequest } from 'next/server';
import { ApiError, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { runSchedule, weekData } from '@/lib/scheduler/store';
import { redactDiagnosis, redactReport } from '@/lib/scheduler/redact';
import { weekStartOf } from '@/lib/scheduler/week';

export const dynamic = 'force-dynamic';

export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const unlocked = await sensitiveUnlocked();
  const body = await readJson<Record<string, unknown>>(req);
  const weekStart = weekStartOf(body.week_start);
  const data = weekData(weekStart);
  if (!data.schedule) throw new ApiError('本周还没有排班，请先一键生成', 404);
  if (data.schedule.status === 'locked') throw new ApiError('本周已锁定，请先解锁再重排剩余', 409);
  const result = runSchedule(weekStart, 'regenerate');
  if (!result.ok) return ok({ ...result, diagnosis: redactDiagnosis(result.diagnosis, unlocked) });
  return ok({ ...result, report: redactReport(result.report, unlocked), ...weekData(weekStart) });
});
