import { NextRequest } from 'next/server';
import { ApiError, asYmd, assert, ok, readJson, requireUser, route } from '@/lib/api';
import { getDb } from '@/lib/db';
import { windowStartOf } from '@/lib/scheduler/week';
import { hasPeople, weekData } from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';

/**
 * 单日锁定（问题③）：只冻结这一天的人员安排，粒度到天，不动别的日子。
 *
 * 语义与「锁定本周」对齐（都落在 schedule_entries.status）：
 * - 锁定 = 该日全部条目 status='locked'；解锁 = 恢复 'draft'；
 * - 锁定日拒绝：生成 / 重排不往里补人（引擎侧跳过 locked 日）、换人 / 挪班 / 加人 / 点名加派 / 删除 一律 409；
 * - 整周锁定时由 schedules.status 统一管控，单日按钮不可用（这里也直接拒绝）；
 * - B7：0 人（只有空槽 / 休息占位）的一天没有可保护的对象 → 锁定被拒绝，不允许再产生「锁定 + 0 人」的存量。
 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const date = asYmd(body.date, '日期', { required: true }) as string;
  assert(body.locked === true || body.locked === false, '请指定锁定或解锁');

  const weekStart = windowStartOf(date);
  const data = weekData(weekStart);
  if (data.schedule?.status === 'locked') {
    throw new ApiError(body.locked ? '本周已锁定，不用再单独锁这一天' : '本周已锁定，请先在右上角解锁本周', 409);
  }
  const mine = data.entries.filter((entry) => entry.work_date === date);
  if (!mine.length) throw new ApiError('这一天还没有排班，先排班再锁定', 404);
  // B7：锁只保护「有人的安排」。这一天只有空槽 / 休息占位（0 人）→ 拒绝锁定。
  if (body.locked === true && !hasPeople(mine)) throw new ApiError('这一天还没有排班，先排班再锁定', 404);

  const db = getDb();
  const status = body.locked ? 'locked' : 'draft';
  // 只改这一天的条目，别的日子（含别的排班窗口落在同一天的重叠条目）一律不碰
  const info = db.prepare(`UPDATE schedule_entries SET status = ?, updated_at = datetime('now','localtime') WHERE work_date = ?`)
    .run(status, date);
  return ok({ date, weekStart, locked: body.locked, changed: info.changes });
});
