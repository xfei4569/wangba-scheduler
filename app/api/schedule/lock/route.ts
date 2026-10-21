import { NextRequest } from 'next/server';
import { ApiError, assert, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { getDb } from '@/lib/db';
import { weekStartOf } from '@/lib/scheduler/week';
import { hasPeople, loadEngineInput, weekData } from '@/lib/scheduler/store';
import { residualIssues } from '@/lib/scheduler/engine';
import { describeIssues } from '@/lib/scheduler/redact';

export const dynamic = 'force-dynamic';

export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const unlocked = await sensitiveUnlocked();
  const body = await readJson<Record<string, unknown>>(req);
  const weekStart = weekStartOf(body.week_start);
  assert(body.locked === true || body.locked === false, '请指定锁定或解锁');
  const db = getDb();
  const data = weekData(weekStart);
  const schedule = data.schedule;
  if (!schedule) throw new ApiError('本周还没有排班，先排班再锁定', 404);
  if (body.locked === true) {
    // B7：锁只保护「有人的安排」。0 人的周没有可保护的对象 → 拒绝锁定（与单日锁定同一句文案），
    // 否则又会造出「锁定 + 0 人」这种三方卡死的状态。
    if (!hasPeople(data.entries)) throw new ApiError('本周还没有排班，先排班再锁定', 409);
    const input = loadEngineInput(weekStart);
    const weekEnd = schedule.week_end;
    const history = input.existing.filter((entry) => entry.work_date < weekStart || entry.work_date > weekEnd);
    // 文案统一脱敏：未解锁时涉密条目只给聚合提示，不给「谁和谁」
    const issues = describeIssues(residualIssues(input, [...history, ...data.entries]), unlocked);
    if (issues.length) {
      throw new ApiError('班表还有问题，修正后才能锁定', 409, { issues: issues.slice(0, 30) });
    }
  }
  const status = body.locked ? 'locked' : 'draft';
  db.transaction(() => {
    db.prepare(`UPDATE schedules SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(status, schedule.id);
    db.prepare(`UPDATE schedule_entries SET status = ?, updated_at = datetime('now','localtime') WHERE schedule_id = ?`).run(status, schedule.id);
  })();
  return ok({ weekStart, status });
});
