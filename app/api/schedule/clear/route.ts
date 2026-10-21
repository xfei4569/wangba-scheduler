import { NextRequest } from 'next/server';
import { ApiError, assert, ok, readJson, requireUser, route } from '@/lib/api';
import { addDays, isValidYmd } from '@/lib/date';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * 删掉一段排班。scope=day 删一天，week 删从 from 起的 7 天，month 删 from 所在的整月。
 * 已经锁定的日期不动，其余全部删掉。删完没有班次的周记录一并清掉。
 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<{ scope?: string; from?: string }>(req);
  assert(body.scope === 'day' || body.scope === 'week' || body.scope === 'month', '请选择删除这一天、这一周或这个月');
  assert(isValidYmd(body.from), '日期不正确');
  const from = body.from as string;
  const start = body.scope === 'month' ? from.slice(0, 7) + '-01' : from;
  const end = body.scope === 'day' ? from : body.scope === 'week' ? addDays(from, 6) : addDays(addDays(start, 32).slice(0, 7) + '-01', -1);

  const db = getDb();
  const locked = db.prepare(`SELECT DISTINCT se.work_date FROM schedule_entries se
    JOIN schedules s ON s.id = se.schedule_id
    WHERE se.work_date BETWEEN ? AND ? AND (se.status = 'locked' OR s.status = 'locked')
    ORDER BY se.work_date`).all(start, end) as { work_date: string }[];
  if (body.scope !== 'month' && locked.length) {
    // 单日锁定的日子：统一提示「该日已锁定，先解锁」（与换人 / 挪班 / 加人同一句）
    if (body.scope === 'day') throw new ApiError('该日已锁定，先解锁', 409, { locked_days: locked.map((r) => r.work_date) });
    throw new ApiError('这段里有已锁定的日期，请先解锁再删除：' + locked.map((r) => r.work_date).join('、'), 409);
  }
  const removed = db.transaction(() => {
    const info = db.prepare(`DELETE FROM schedule_entries WHERE work_date BETWEEN ? AND ?
      AND schedule_id NOT IN (SELECT id FROM schedules WHERE status = 'locked')
      AND status <> 'locked'`).run(start, end);
    db.prepare('DELETE FROM schedules WHERE id NOT IN (SELECT DISTINCT schedule_id FROM schedule_entries)').run();
    return info.changes;
  })();
  return ok({ removed, kept_locked: locked.map((r) => r.work_date) });
});
