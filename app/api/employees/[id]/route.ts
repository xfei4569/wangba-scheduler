import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { ApiError, asJsonArray, asString, asYmd, assert, fail, ok, readJson, requireSensitive, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { mapEmployee } from '@/lib/repo';
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

export const PUT = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  assert(Number.isInteger(id) && id > 0, '员工编号不正确');

  const db = getDb();
  const exists = db.prepare('SELECT id FROM employees WHERE id = ?').get(id);
  assert(exists, '员工不存在或已被删除', 404);

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

  const dup = db
    .prepare('SELECT id FROM employees WHERE name = ? AND id != ? AND status != ?')
    .get(name, id, 'resigned') as { id: number } | undefined;
  assert(!dup, '已存在同名在职员工：' + name);

  db.prepare(
    `UPDATE employees
        SET name = ?, tags = ?, status = ?, hire_date = ?, leave_date = ?,
            gender = ?, seniority = ?, can_teach = ?, position = ?, note = ?,
            updated_at = datetime('now','localtime')
      WHERE id = ?`
  ).run(name, JSON.stringify(tags), status, hireDate, leaveDate,
    profile.gender, profile.seniority, profile.canTeach, profile.position, note || null, id);

  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Record<string, unknown>;
  return ok({ item: mapEmployee(row) });
});

export const DELETE = route(async (req: NextRequest, ctx) => {
  await requireUser();
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail('员工编号不正确');

  const db = getDb();
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!emp) return fail('员工不存在或已被删除', 404);

  const entryCount = (db.prepare('SELECT COUNT(*) AS c FROM schedule_entries WHERE employee_id = ?').get(id) as { c: number }).c;
  if (entryCount > 0) throw new ApiError('该员工已有历史班次，请改为「离职」以保留班表姓名', 409);
  // 「不搭班」是保密约束：条数不能回传（能反推保密记录数），删除也要先解锁，
  // 否则登录但没解锁的人可以绕过口令把保密约束销毁。
  const reqCount = (db.prepare("SELECT COUNT(*) AS c FROM requirements WHERE type <> 'pairing' AND (employee_id = ? OR employee_id_2 = ?)").get(id, id) as { c: number }).c;
  const pairingCount = (db.prepare("SELECT COUNT(*) AS c FROM requirements WHERE type = 'pairing' AND (employee_id = ? OR employee_id_2 = ?)").get(id, id) as { c: number }).c;
  if (pairingCount > 0) await requireSensitive();

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM requirements WHERE employee_id = ? OR employee_id_2 = ?').run(id, id);
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
  });
  tx();

  return ok({ deleted: true, id, removed_requirements: reqCount, kept_schedule_entries: entryCount,
    // 保密条数只在已解锁时才说出来
    removed_pairing: (await sensitiveUnlocked()) ? pairingCount : undefined });
});
