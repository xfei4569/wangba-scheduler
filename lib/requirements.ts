import { getDb } from './db';
import { asInt, asJsonArray, asString, asYmd, assert } from './api';
import { LEAVE_TYPES, type ReqType } from './types';

export const SHIFT_CODES = ['early', 'middle', 'night'];

export interface NormalizedRequirement {
  type: ReqType;
  employee_id: number | null;
  employee_id_2: number | null;
  leave_type: string | null;
  shift_codes: string;
  date_start: string | null;
  date_end: string | null;
  override_count: number | null;
  long_term: number;
  note: string | null;
}

/**
 * 把前端提交的表单统一校验/规整成数据库字段。
 * 四类要求（请假 / 组合避让 / 避班 / 加派）共用一条写入路径，校验规则集中在这里。
 */
export async function normalizeRequirement(
  type: ReqType,
  body: Record<string, unknown>
): Promise<NormalizedRequirement> {
  const db = getDb();
  const employeeExists = (id: number) => Boolean(db.prepare('SELECT id FROM employees WHERE id = ?').get(id));

  const base: NormalizedRequirement = {
    type,
    employee_id: null,
    employee_id_2: null,
    leave_type: null,
    shift_codes: '[]',
    date_start: null,
    date_end: null,
    override_count: null,
    long_term: 0,
    note: asString(body.note, '备注', { max: 100 }) || null,
  };

  if (type === 'leave') {
    const employeeId = asInt(body.employee_id, '员工', { min: 1, required: true });
    assert(employeeExists(employeeId), '所选员工不存在');
    const leaveType = asString(body.leave_type, '请假类型', { required: true });
    assert((LEAVE_TYPES as readonly string[]).includes(leaveType), '请假类型只能是 事假/病假/月休');
    const start = asYmd(body.date_start, '开始日期', { required: true }) as string;
    const end = asYmd(body.date_end, '结束日期', { required: true }) as string;
    assert(start <= end, '结束日期不能早于开始日期');
    return { ...base, employee_id: employeeId, leave_type: leaveType, date_start: start, date_end: end };
  }

  if (type === 'avoid') {
    const employeeId = asInt(body.employee_id, '员工', { min: 1, required: true });
    assert(employeeExists(employeeId), '所选员工不存在');
    const codes = asJsonArray(body.shift_codes, '班次').filter((c) => SHIFT_CODES.includes(c));
    assert(codes.length > 0, '请至少选择一个班次');
    const longTerm = body.long_term ? 1 : 0;
    const start = asYmd(body.date_start, '开始日期');
    const end = asYmd(body.date_end, '结束日期');
    if (!longTerm) {
      assert(start && end, '非长期避班必须指定日期区间');
      assert(start! <= end!, '结束日期不能早于开始日期');
    }
    return {
      ...base,
      employee_id: employeeId,
      shift_codes: JSON.stringify(codes),
      date_start: longTerm ? null : start,
      date_end: longTerm ? null : end,
      long_term: longTerm,
    };
  }

  if (type === 'extra') {
    const codes = asJsonArray(body.shift_codes, '班次').filter((c) => SHIFT_CODES.includes(c));
    assert(codes.length === 1, '临时加派一次只能指定一个班次');
    const date = asYmd(body.date_start, '日期', { required: true }) as string;
    const count = asInt(body.override_count, '覆盖人数', { min: 0, max: 20, required: true });
    return { ...base, shift_codes: JSON.stringify(codes), date_start: date, date_end: date, override_count: count };
  }

  // pairing —— 高级设置里的「组合避让」
  const a = asInt(body.employee_id, '员工一', { min: 1, required: true });
  const b = asInt(body.employee_id_2, '员工二', { min: 1, required: true });
  assert(employeeExists(a) && employeeExists(b), '所选员工不存在');
  assert(a !== b, '不能选择同一个人');
  const dup = db
    .prepare(
      `SELECT id FROM requirements WHERE type = 'pairing' AND active = 1
        AND ((employee_id = ? AND employee_id_2 = ?) OR (employee_id = ? AND employee_id_2 = ?))`
    )
    .get(a, b, b, a) as { id: number } | undefined;
  assert(!dup, '这两人已经存在一条组合记录');
  const longTerm = body.long_term === undefined ? 1 : body.long_term ? 1 : 0;
  const start = asYmd(body.date_start, '开始日期');
  const end = asYmd(body.date_end, '结束日期');
  if (!longTerm) {
    assert(start && end, '非长期记录必须指定日期区间');
    assert(start! <= end!, '结束日期不能早于开始日期');
  }
  return {
    ...base,
    employee_id: a,
    employee_id_2: b,
    shift_codes: '[]',
    date_start: longTerm ? null : start,
    date_end: longTerm ? null : end,
    long_term: longTerm,
  };
}
