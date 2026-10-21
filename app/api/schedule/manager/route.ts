import { NextRequest } from 'next/server';
import { ApiError, assert, ok, readJson, requireUser, route } from '@/lib/api';
import { addDays } from '@/lib/date';
import { getDb } from '@/lib/db';
import { weekStartOf } from '@/lib/scheduler/week';

export const dynamic = 'force-dynamic';

/**
 * 「店长本周不休息」开关：记在这一个排班窗口上，不影响别的周。
 * 存在 schedules.note 里（JSON），不占新字段。
 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<{ week_start?: unknown; no_rest?: unknown }>(req);
  const weekStart = weekStartOf(body.week_start);
  assert(typeof body.no_rest === 'boolean', '请指定开或关');
  const noRest = body.no_rest as boolean;

  const db = getDb();
  const row = db.prepare('SELECT id, note, status FROM schedules WHERE week_start = ?').get(weekStart) as
    { id: number; note: string | null; status: string } | undefined;
  if (row?.status === 'locked') throw new ApiError('本周已锁定，请先解锁再改', 409);

  let note: Record<string, unknown> = {};
  if (row?.note) {
    try { note = JSON.parse(row.note) as Record<string, unknown>; } catch { note = {}; }
  }
  note.managerNoRest = noRest;
  const text = JSON.stringify(note);

  if (row) {
    db.prepare("UPDATE schedules SET note = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(text, row.id);
  } else {
    // week_end 必须是这一窗口的最后一天：月度汇总 / 锁定前体检 / 窗口归属都按 [week_start, week_end] 取数，
    // 写成 week_start 会让整周只剩 1 天算「已排」，其余 6 天在月表里变成「待排」。
    db.prepare(`INSERT INTO schedules (week_start, week_end, status, note, generated_at)
      VALUES (?, ?, 'draft', ?, datetime('now','localtime'))`).run(weekStart, addDays(weekStart, 6), text);
  }
  return ok({ weekStart, managerNoRest: noRest });
});
