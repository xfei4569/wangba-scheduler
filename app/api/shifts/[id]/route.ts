import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asInt, asString, assert, fail, ok, readJson, requireUser, route } from '@/lib/api';
import { mapShift } from '@/lib/repo';

export const dynamic = 'force-dynamic';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const PUT = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '班次编号不正确');

  const db = getDb();
  const exists = db.prepare('SELECT id FROM shift_templates WHERE id = ?').get(id);
  if (!exists) return fail('班次不存在', 404);

  const body = await readJson<Record<string, unknown>>(req);
  const name = asString(body.name, '班次名称', { required: true, max: 20 });
  const startTime = asString(body.start_time, '开始时间', { required: true });
  const endTime = asString(body.end_time, '结束时间', { required: true });
  assert(TIME_RE.test(startTime), '开始时间格式应为 HH:mm');
  assert(TIME_RE.test(endTime), '结束时间格式应为 HH:mm');

  const crossDay = body.cross_day ? 1 : 0;
  const weekdayCount = asInt(body.weekday_count, '平日人数', { min: 0, max: 20, required: true });
  const weekendCount = asInt(body.weekend_count, '周末人数', { min: 0, max: 20, required: true });
  const holidayCount = asInt(body.holiday_count, '法定节假日人数', { min: 0, max: 20, required: true });
  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;
  const note = asString(body.note, '备注', { max: 100 });

  assert(
    startTime !== endTime || crossDay === 1,
    '开始时间与结束时间不能完全相同（跨天班次请勾选「跨天」）'
  );

  db.prepare(
    `UPDATE shift_templates
        SET name = ?, start_time = ?, end_time = ?, cross_day = ?,
            weekday_count = ?, weekend_count = ?, holiday_count = ?, enabled = ?, note = ?,
            updated_at = datetime('now','localtime')
      WHERE id = ?`
  ).run(name, startTime, endTime, crossDay, weekdayCount, weekendCount, holidayCount, enabled, note || null, id);

  const row = db.prepare('SELECT * FROM shift_templates WHERE id = ?').get(id) as Record<string, unknown>;
  return ok({ item: mapShift(row) });
});
