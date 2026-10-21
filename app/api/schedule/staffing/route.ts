import { NextRequest } from 'next/server';
import { ApiError, asInt, asString, asYmd, assert, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import { getDb } from '@/lib/db';
import { addDays } from '@/lib/date';
import { windowStartOf } from '@/lib/scheduler/week';
import { baseDemandFor, exclusionReasons, pairingPartnerName, shiftLabel, type Assignment } from '@/lib/scheduler/engine';
import { describeIssues, secretIssue, splitReasons, type Issue } from '@/lib/scheduler/redact';
import { DAY_TYPE_CN, dayTypeAt, demandInput, engineContext, sameKindDates } from '@/lib/scheduler/month';
import { loadEngineInput, dayLocked, weekData } from '@/lib/scheduler/store';

export const dynamic = 'force-dynamic';

/**
 * 工作台快捷改人数（P2）：把「某日某班的人数」写成一条 extra 记录，
 * 优先级高于班次模板的平日/周末/节假日三档，引擎生成与诊断会立即按新人数计算。
 * scope=day 只改本日；scope=same-kind 改本月所有同类日（平日/周末/法定节假日）。
 * 传回模板人数即「恢复默认」（删除该条 extra 记录）。
 *
 * 点名加派（employee_ids，仅 scope=day）：指定的人立即钉进该班（manual 条目，不用等重算），
 * 冲突校验与换人同一套判据（同日两班/休息红线/请假等）；dry_run 只查不写，force 跳过校验强制钉。
 * 点名后若总人数超过 count，自动把人数抬到实际人数（点名优先占座）。
 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  // 口令解锁状态只信服务端：未解锁时不搭班（保密）只给聚合提示，不给「谁和谁」
  const unlocked = await sensitiveUnlocked();
  const body = await readJson<Record<string, unknown>>(req);
  const date = asYmd(body.date, '日期', { required: true }) as string;
  const shiftCode = asString(body.shift_code, '班次', { required: true });
  const scope = asString(body.scope, '应用范围') || 'day';
  assert(scope === 'day' || scope === 'same-kind', '应用范围只能是「仅本日」或「本月同类日」');
  const count = asInt(body.count, '人数', { min: 0, max: 20, required: true });
  const force = body.force === true;
  const dryRun = body.dry_run === true;
  const employeeIds = (Array.isArray(body.employee_ids) ? body.employee_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  assert(scope === 'day' || employeeIds.length === 0, '只有「仅本日」才能指定具体的人');
  // 备注：不填就用默认文案（「临时加派」页填的备注以前会被丢掉）
  const note = asString(body.note, '备注', { max: 100 }) || '工作台快捷改人数';

  // 窗口起点 = 覆盖这一天的排班窗口（起始日自选后可能与全局周起点不同）
  const weekStart = windowStartOf(date);
  const week = weekData(weekStart).schedule;
  if (week?.status === 'locked') throw new ApiError('本周已锁定，请先解锁再改人数', 409);
  // 单日锁定：这一天的人员安排冻结，改人数 / 点名加派都要先解锁这一天
  if (dayLocked(date)) throw new ApiError('该日已锁定，先解锁', 409);

  const ctx = engineContext();
  const shift = ctx.shifts.find((s) => s.code === shiftCode);
  if (!shift) throw new ApiError('班次不存在或已停用', 404);

  const input = demandInput(ctx, weekStart);
  const requestedTargets = scope === 'same-kind' ? sameKindDates(date, ctx) : [date];
  const lockedWeeks = new Set<string>();
  const lockedDays: string[] = [];
  const targets = requestedTargets.filter((target) => {
    const targetWeek = windowStartOf(target);
    if (weekData(targetWeek).schedule?.status === 'locked') {
      lockedWeeks.add(targetWeek);
      return false;
    }
    // 单日锁定的日子同样跳过：批量改同类日不能把锁定日改掉
    if (dayLocked(target)) {
      lockedDays.push(target);
      return false;
    }
    return true;
  });
  if (!targets.length) {
    if (lockedDays.length && lockedDays.length === requestedTargets.length) {
      throw new ApiError('该日已锁定，先解锁', 409, { locked_days: lockedDays });
    }
    throw new ApiError('目标日期都在已锁定周，请先解锁后再改人数', 409, { locked_weeks: [...lockedWeeks], locked_days: lockedDays });
  }
  const db = getDb();
  const affected: { date: string; base: number; count: number; action: string }[] = [];

  // ---- 点名：冲突校验（与换人同一套判据）----
  const engineInput = loadEngineInput(weekStart);
  const frozen = new Set(engineInput.frozenSlots || []);
  const weekEntries = weekData(weekStart).entries;
  const asAssignments: Assignment[] = weekEntries.map((e) => ({ id: e.id, work_date: e.work_date, shift_code: e.shift_code, shift_id: e.shift_id as number, employee_id: e.employee_id }));
  // 已经开始的班不再拒绝加人（问题①）：只在成功回执里带一句提示
  const notices: string[] = [];
  if (employeeIds.length && frozen.has(date + '|' + shiftCode)) notices.push(date + shiftLabel(shiftCode) + '已经开始（加的是今天的班，请留意现场）');
  const toPin: { employee_id: number; name: string; forced: boolean; reasons: string[] }[] = [];
  const conflicts: { employee_id: number; name: string; reasons: string[] }[] = [];
  // 保密约束（不搭班）不挂到人身上：未解锁时只有一句聚合提示，解锁后才给「谁 × 谁，哪天哪个班」
  const secretIssues: Issue[] = [];
  let conflictCount = 0;
  for (const id of employeeIds) {
    const person = engineInput.employees.find((e) => e.id === id);
    if (!person) throw new ApiError('员工不存在（编号 ' + id + '）', 404);
    if (weekEntries.some((e) => e.work_date === date && e.shift_code === shiftCode && e.employee_id === id)) {
      toPin.push({ employee_id: id, name: person.name, forced: false, reasons: [] });
      continue;
    }
    const reasons = exclusionReasons(engineInput, asAssignments, person, date, shiftCode);
    const split = splitReasons(reasons);
    // 涉密原因无论走不走强制都单独攒起来：未解锁时只会聚合成一句话，姓名/日期/班次都不落响应。
    if (split.secret) secretIssues.push(secretIssue(person.name, date + shiftLabel(shiftCode),
      pairingPartnerName(engineInput, asAssignments, id, date, shiftCode)));
    if (reasons.length && !force) {
      conflictCount += 1;
      if (split.reasons.length) conflicts.push({ employee_id: id, name: person.name, reasons: split.reasons });
    // 强制生效时也不能把保密原因原文回给前端：姓名 +「冲突」同现就是泄露。
    // 这里只回可公开的原因；涉密那一部分由 secret_notice 统一聚合（未解锁只有一句话）。
    } else toPin.push({ employee_id: id, name: person.name, forced: reasons.length > 0, reasons: split.reasons });
  }
  const secretNotice = secretIssues.length ? describeIssues(secretIssues, unlocked).join('；') : null;
  if (dryRun) return ok({ dry_run: true, conflicts, secret_notice: secretNotice, notices, to_pin: toPin.map((p) => ({ employee_id: p.employee_id, name: p.name })) });
  if (conflictCount) throw new ApiError('点名的人违反排班约束', 409, { conflicts, secret_notice: secretNotice, notices });

  const tx = db.transaction(() => {
    for (const day of targets) {
      const base = baseDemandFor(day, shift, input);
      const rows = db
        .prepare("SELECT id, shift_codes FROM requirements WHERE type = 'extra' AND active = 1 AND date_start = ? AND date_end = ?")
        .all(day, day) as { id: number; shift_codes: string }[];
      const mine = rows.filter((row) => {
        try {
          return (JSON.parse(row.shift_codes || '[]') as string[]).includes(shiftCode);
        } catch {
          return false;
        }
      });

      // 点名的人立即钉进该班（manual，重算保留；报错不存历史快照，红字由实时体检给出）
      if (day === date && toPin.length) {
        const current = weekData(weekStart);
        let scheduleId = current.schedule?.id;
        if (!scheduleId) {
          scheduleId = Number(db.prepare("INSERT INTO schedules (week_start, week_end, status, generated_at) VALUES (?, ?, 'draft', datetime('now','localtime'))")
            .run(weekStart, addDays(weekStart, 6)).lastInsertRowid);
        }
        const insertEntry = db.prepare(`INSERT INTO schedule_entries (schedule_id, work_date, shift_id, shift_code, employee_id, status, source, is_rest, note)
          VALUES (?, ?, ?, ?, ?, 'draft', 'manual', 0, NULL)`);
        for (const p of toPin) {
          const already = db.prepare('SELECT id FROM schedule_entries WHERE work_date = ? AND shift_code = ? AND employee_id = ?').get(day, shiftCode, p.employee_id);
          if (already) continue;
          insertEntry.run(scheduleId, day, shift.id, shiftCode, p.employee_id);
        }
      }

      // 点名/手工钉住的人不会被自动撤下：座位数至少要容下他们（否则听你的 count）
      const manual = db.prepare("SELECT COUNT(*) AS n FROM schedule_entries WHERE work_date = ? AND shift_code = ? AND source = 'manual'").get(day, shiftCode) as { n: number };
      const finalCount = Math.max(count, manual.n);

      if (finalCount === base) {
        // 恢复默认：删掉临时记录（不残留“等于默认值”的脏数据）
        for (const row of mine) db.prepare('DELETE FROM requirements WHERE id = ?').run(row.id);
        affected.push({ date: day, base, count: finalCount, action: mine.length ? 'reset' : 'unchanged' });
        continue;
      }
      if (mine.length) {
        db.prepare(`UPDATE requirements SET override_count = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
          .run(finalCount, note, mine[0].id);
        for (const extra of mine.slice(1)) db.prepare('DELETE FROM requirements WHERE id = ?').run(extra.id);
        affected.push({ date: day, base, count: finalCount, action: 'updated' });
        continue;
      }
      db.prepare(`INSERT INTO requirements (type, employee_id, employee_id_2, leave_type, shift_codes, date_start, date_end, override_count, long_term, active, note)
        VALUES ('extra', NULL, NULL, NULL, ?, ?, ?, ?, 0, 1, ?)`)
        .run(JSON.stringify([shiftCode]), day, day, finalCount, note);
      affected.push({ date: day, base, count: finalCount, action: 'created' });
    }
  });
  tx();

  const after = weekData(weekStart);
  const affectedWeeks = [...new Set(affected.filter((a) => a.action !== 'unchanged').map((a) => windowStartOf(a.date)))];
  const staleWeeks = affectedWeeks.filter((start) => weekData(start).entries.length > 0);
  return ok({
    scope,
    shift: { code: shift.code, name: shift.name },
    week_start: weekStart,
    day_type: DAY_TYPE_CN[dayTypeAt(date, ctx.holidays)],
    base: affected[0]?.base ?? 0,
    count: affected[0]?.count ?? count,
    targets: affected,
    pinned: toPin,
    // 强制生效时也照常给聚合提示（未解锁只有一句话），让店长知道这里压了一条保密约束
    secret_notice: secretNotice,
    // 「已经开始的班」这类提示（问题①）：只提示，不拦
    notices,
    changed: affected.filter((a) => a.action !== 'unchanged').length,
    skipped_locked_weeks: [...lockedWeeks],
    skipped_locked_days: lockedDays,
    affected_weeks: affectedWeeks,
    stale_weeks: staleWeeks,
    has_schedule: Boolean(after.schedule),
    week_locked: after.schedule?.status === 'locked',
    need_regenerate: staleWeeks.length > 0,
  });
});
