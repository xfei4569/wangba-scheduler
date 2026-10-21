import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asString, assert, fail, ok, readJson, requireSensitive, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { listRequirements, mapRequirement } from '@/lib/repo';
import { normalizeRequirement } from '@/lib/requirements';
import { staleWeeksBetween } from '@/lib/scheduler/week';
import type { ReqType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TYPES: ReqType[] = ['leave', 'pairing', 'avoid', 'extra'];

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const type = (req.nextUrl.searchParams.get('type') || 'leave') as ReqType;
  assert(TYPES.includes(type), '类型不正确');
  // 敏感区（高级设置里的组合避让）必须解锁后才能读取
  if (type === 'pairing' && !(await sensitiveUnlocked())) {
    return fail('该区域已加密，请先输入店长口令解锁', 403, { code: 'SENSITIVE_LOCKED' });
  }
  return ok({ items: listRequirements(type) });
});

export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const type = (asString(body.type, '类型') || '') as ReqType;
  assert(TYPES.includes(type), '类型不正确');
  if (type === 'pairing') await requireSensitive();

  const data = await normalizeRequirement(type, body);
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO requirements
        (type, employee_id, employee_id_2, leave_type, shift_codes, date_start, date_end, override_count, long_term, note)
       VALUES (@type, @employee_id, @employee_id_2, @leave_type, @shift_codes, @date_start, @date_end, @override_count, @long_term, @note)`
    )
    .run(data);

  const row = db
    .prepare(
      `SELECT r.*, e1.name AS employee_name, e2.name AS employee_name_2
         FROM requirements r
         LEFT JOIN employees e1 ON e1.id = r.employee_id
         LEFT JOIN employees e2 ON e2.id = r.employee_id_2
        WHERE r.id = ?`
    )
    .get(info.lastInsertRowid) as Record<string, unknown>;
  return ok({ item: mapRequirement(row), stale_weeks: data.type === 'leave' || data.type === 'avoid' ? staleWeeksBetween(data.date_start, data.date_end) : [] });
});
