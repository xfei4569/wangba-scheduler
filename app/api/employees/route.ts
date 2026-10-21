import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asJsonArray, asString, asYmd, assert, ok, readJson, requireUser, route } from '@/lib/api';
import { listEmployees, mapEmployee } from '@/lib/repo';
import { EMPLOYEE_TAGS } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUSES = ['active', 'leave', 'resigned'];

const GENDERS = ['', '男', '女'];
const SENIORITIES = ['老人', '新人'];
const POSITIONS = ['店长', '员工'];

/** 解析性别/经验/可带教/职位（新增字段，缺省保持老行为：性别不填、老人、可带教、员工） */
function readProfile(body: Record<string, unknown>) {
  const gender = asString(body.gender, '性别');
  assert(GENDERS.includes(gender), '性别只能是 男 / 女 / 留空');
  const seniority = asString(body.seniority, '经验') || '老人';
  assert(SENIORITIES.includes(seniority), '经验只能是 老人 / 新人');
  const position = asString(body.position, '职位') || '员工';
  assert(POSITIONS.includes(position), '职位只能是 店长 / 员工');
  // 「默认老人=可带教」：不传时按经验给默认值（新人默认不可带教）
  const canTeach = body.can_teach === undefined ? (seniority === '老人' ? 1 : 0) : body.can_teach ? 1 : 0;
  return { gender, seniority, canTeach, position };
}

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const status = req.nextUrl.searchParams.get('status') || '';
  const keyword = (req.nextUrl.searchParams.get('q') || '').trim();
  let rows = listEmployees(STATUSES.includes(status) ? status : undefined);
  if (keyword) rows = rows.filter((e) => e.name.includes(keyword));
  return ok({ items: rows, total: rows.length });
});

export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);

  const name = asString(body.name, '姓名', { required: true, max: 32 });
  const status = asString(body.status, '状态') || 'active';
  assert(STATUSES.includes(status), '状态只能是 在职/暂停排班/离职');
  const tags = asJsonArray(body.tags, '标签').filter((t) => (EMPLOYEE_TAGS as readonly string[]).includes(t));
  const hireDate = asYmd(body.hire_date, '入职日期');
  const leaveDate = asYmd(body.leave_date, '离职日期');
  assert(!(hireDate && leaveDate) || hireDate <= leaveDate, '离职日期不能早于入职日期');
  const note = asString(body.note, '备注', { max: 200 });
  const profile = readProfile(body);

  const db = getDb();
  const dup = db.prepare('SELECT id FROM employees WHERE name = ? AND status != ?').get(name, 'resigned') as
    | { id: number }
    | undefined;
  assert(!dup, '已存在同名在职员工：' + name);

  const info = db
    .prepare(
      `INSERT INTO employees (name, tags, status, hire_date, leave_date, gender, seniority, can_teach, position, note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM employees))`
    )
    .run(name, JSON.stringify(tags), status, hireDate, leaveDate, profile.gender, profile.seniority, profile.canTeach, profile.position, note || null);

  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return ok({ item: mapEmployee(row) });
});
