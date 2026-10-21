/**
 * 文案级脱敏（派工单 B3 · 修复 2 / A 案「聚合脱敏」）。
 *
 * 「不搭班」（pairing）是保密约束：未解锁高级设置口令时，任何界面、接口响应、日志里
 * 都不允许出现「谁和谁不能排一起」——两行姓名并排、姓名和「冲突」同现都算泄露。
 *
 * 做法：
 *   1. 引擎只产出结构化的 Issue（secret 标记哪一条来自保密约束，names 记下配对双方）；
 *   2. 所有对外的报错 / 诊断 / 弹窗文案统一走 describeIssues(issues, unlocked)：
 *      secret 条目在未解锁时只聚合成一句话（不带姓名、不带日期、不带班次）；
 *   3. 非保密原因（请假 / 避班 / 离职 / 月休上限 / 带教……）照旧带姓名显示。
 *
 * 禁止任何地方再自行拼 pairing 文案 —— 这里是唯一的出口。
 * 本文件的运行时代码必须保持零依赖（只允许 type-only import）：engine-test 会把
 * engine.ts 和它一起单独转译运行。
 */
import type { Diagnosis, MissingSlot, Report } from './engine';

/** 引擎判定「不搭班」命中时使用的统一原因文案（保密）。各处只允许引用这个常量。 */
export const SECRET_REASON = '与已排人员存在冲突';

/** 未解锁时的聚合文案尾巴（不带姓名、不带日期、不带班次） */
export const SECRET_HINT = '详情需在高级设置输入口令查看';

/**
 * 一条待展示的排班问题。
 * secret=true 表示来自「不搭班」保密约束：未解锁时姓名 / 日期 / 班次都不得出现在文案里。
 */
export interface Issue {
  /** 是否来自保密约束（不搭班 / pairing） */
  secret: boolean;
  /** 明文文案：非 secret 条目随时可见；secret 条目仅在已解锁时可见 */
  text: string;
  /** secret 条目涉及的双方姓名（用于聚合计数与解锁后的「谁 × 谁」） */
  names?: string[];
  /** 同一处问题的定位键（同一天同一个班），用于聚合去重 */
  slot?: string;
}

/** 这条原因文案是不是保密约束（不搭班） */
export function isSecretReason(reason: string): boolean {
  return reason.includes(SECRET_REASON);
}

/** 把一组排除原因拆成「可公开」与「是否含保密原因」两部分 */
export function splitReasons(reasons: string[]): { reasons: string[]; secret: boolean } {
  return { reasons: reasons.filter((reason) => !isSecretReason(reason)), secret: reasons.some(isSecretReason) };
}

/** 未解锁时的聚合文案：不带姓名、不带日期、不带班次 */
export function secretSummary(issues: Issue[]): string {
  const people = new Set<string>();
  for (const issue of issues) for (const name of issue.names || []) if (name) people.add(name);
  const scope = people.size ? `（涉及 ${people.size} 人）` : '';
  return `有 ${issues.length} 处保密约束冲突${scope}，${SECRET_HINT}`;
}

/**
 * 一条保密（不搭班）问题：slotLabel 是「哪天哪个班」，partnerName 是配对另一方。
 * 未解锁时 describeIssues 只把它聚合成一句，姓名 / 日期 / 班次都不会出现在文案里。
 */
export function secretIssue(personName: string, slotLabel: string, partnerName?: string): Issue {
  const pair = [personName, ...(partnerName ? [partnerName] : [])].filter(Boolean).sort();
  return { secret: true, names: pair, slot: slotLabel, text: `${slotLabel}${pair.join(' × ')}：${SECRET_REASON}` };
}

/**
 * 把「一个人身上的一组违规原因」转成可展示文案（接口层统一用）。
 * - 非保密原因按 format 拼（各接口沿用自己原来的写法，可以带姓名）；
 * - 保密原因单独成条 → 未解锁只有聚合文案，解锁后是「谁 × 谁，哪天哪个班」。
 */
export function describePersonIssues(
  reasons: string[],
  slotLabel: string,
  personName: string,
  partnerName: string | undefined,
  unlocked: boolean,
  format: (reason: string) => string,
): string[] {
  const split = splitReasons(reasons);
  const out = split.reasons.map(format);
  if (split.secret) out.push(...describeIssues([secretIssue(personName, slotLabel, partnerName)], unlocked));
  return out;
}

/** 同一处问题只留一条：保密条目按「哪天哪个班 + 涉及谁」去重（两人各报一行其实是一处） */
export function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const issue of issues) {
    const key = issue.secret ? 'secret|' + (issue.slot || '') + '|' + (issue.names || []).join(',') : 'plain|' + issue.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/**
 * 统一出口：所有报错 / 诊断 / 弹窗文案都从这里生成。
 * - 非保密原因：原样输出（可以带姓名 / 日期 / 班次）；
 * - 保密原因：已解锁 → 输出「谁 × 谁，哪天哪个班」的明细；未解锁 → 只输出一条聚合文案。
 */
export function describeIssues(issues: Issue[], unlocked: boolean): string[] {
  const list = dedupeIssues(issues);
  const out = list.filter((issue) => !issue.secret && issue.text).map((issue) => issue.text);
  const secret = list.filter((issue) => issue.secret);
  if (!secret.length) return out;
  if (unlocked) out.push(...secret.map((issue) => issue.text));
  else out.push(secretSummary(secret));
  return out;
}


/* ------------------------------------------------------------------
 * 对外口径（服务端唯一出口）
 * 引擎产出的是结构化 Issue；接口返回给前端之前必须过一遍下面两个函数，
 * 未解锁时把 secret 条目换成聚合文案 —— 前端拿到的永远是「可以直接显示」的字符串。
 * ------------------------------------------------------------------ */

/** 诊断卡：conflicts 变成可直接渲染的文案；被排除的人只保留可公开原因 */
export type PresentedDiagnosis = Omit<Diagnosis, 'conflicts' | 'missing'> & {
  conflicts: string[];
  missing: (Omit<MissingSlot, 'excluded'> & { excluded: { employeeId: number; name: string; reasons: string[] }[] })[];
};

/** 体检报告：残留问题同上，未解锁时只有聚合文案 */
export type PresentedReport = Omit<Report, 'residuals'> & { residuals: string[] };

export function redactDiagnosis(diagnosis: Diagnosis, unlocked: boolean): PresentedDiagnosis {
  const secret: Issue[] = [];
  const missing = diagnosis.missing.map((slot) => {
    const names: string[] = [];
    // 只有保密原因的人整条撤掉：留一个「某人：」的空行反而暗示他还有说不出口的问题
    const excluded = slot.excluded.flatMap((person) => {
      const split = splitReasons(person.reasons);
      if (!split.secret) return [{ employeeId: person.employeeId, name: person.name, reasons: split.reasons }];
      names.push(person.name);
      return split.reasons.length ? [{ employeeId: person.employeeId, name: person.name, reasons: split.reasons }] : [];
    });
    // 同一天同一个班里被保密约束挡住的人合成一处（判断依据不外泄，人数照实说）
    if (names.length) {
      const pair = [...names].sort();
      secret.push({ secret: true, names: pair, slot: slot.date + '|' + slot.shift, text: `${slot.date}${slot.shift}${pair.join(' × ')}：${SECRET_REASON}` });
    }
    return { ...slot, excluded };
  });
  return { ...diagnosis, missing, conflicts: describeIssues([...diagnosis.conflicts, ...secret], unlocked) };
}

export function redactReport(report: Report, unlocked: boolean): PresentedReport {
  return { ...report, residuals: describeIssues(report.residuals, unlocked) };
}
