import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asString, assert, fail, ok, readJson, requireSensitive, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { mapRequirement } from '@/lib/repo';
import { normalizeRequirement } from '@/lib/requirements';
import { staleWeeksBetween } from '@/lib/scheduler/week';
import type { ReqType } from '@/lib/types';

export const dynamic = 'force-dynamic';

export const PUT = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '记录编号不正确');

  const db = getDb();
  const current = db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as
    | { id: number; type: ReqType }
    | undefined;
  if (!current) return fail('记录不存在或已被删除', 404);
  // 未解锁时对保密记录统一回 404：否则它和「普通记录参数不对」的 400 能区分开，
  // 拿 id 扫一遍就能把「哪几条是不搭班」全部枚举出来。
  if (current.type === 'pairing' && !(await sensitiveUnlocked())) return fail('记录不存在或已被删除', 404);

  const body = await readJson<Record<string, unknown>>(req);
  const type = (asString(body.type, '类型') || current.type) as ReqType;
  assert(type === current.type, '不能修改记录类型（请删除后重新录入）');
  if (type === 'pairing') await requireSensitive();

  const data = await normalizeRequirement(type, body);
  db.prepare(
    `UPDATE requirements
        SET employee_id = @employee_id, employee_id_2 = @employee_id_2, leave_type = @leave_type,
            shift_codes = @shift_codes, date_start = @date_start, date_end = @date_end,
            override_count = @override_count, long_term = @long_term, note = @note,
            updated_at = datetime('now','localtime')
      WHERE id = @id`
  ).run({ ...data, id });

  const row = db
    .prepare(
      `SELECT r.*, e1.name AS employee_name, e2.name AS employee_name_2
         FROM requirements r
         LEFT JOIN employees e1 ON e1.id = r.employee_id
         LEFT JOIN employees e2 ON e2.id = r.employee_id_2
        WHERE r.id = ?`
    )
    .get(id) as Record<string, unknown>;
  return ok({ item: mapRequirement(row), stale_weeks: type === 'leave' || type === 'avoid' ? staleWeeksBetween(data.date_start, data.date_end) : [] });
});

export const DELETE = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '记录编号不正确');

  const db = getDb();
  const current = db.prepare('SELECT type, date_start, date_end FROM requirements WHERE id = ?').get(id) as { type: ReqType; date_start: string | null; date_end: string | null } | undefined;
  if (!current) return fail('记录不存在或已被删除', 404);
  // 同 PUT：未解锁时保密记录一律 404，不给出「这条是保密记录」的信号
  if (current.type === 'pairing' && !(await sensitiveUnlocked())) return fail('记录不存在或已被删除', 404);
  if (current.type === 'pairing') await requireSensitive();

  db.prepare('DELETE FROM requirements WHERE id = ?').run(id);
  const stale = current.type === 'leave' || current.type === 'avoid' ? staleWeeksBetween(current.date_start, current.date_end) : [];
  return ok({ deleted: true, id, stale_weeks: stale });
});
