import { getDb } from '../db';

/**
 * B7 存量自愈：锁只保护「有人的人员安排」。
 *
 * 早期版本允许把「一个人都没有」的周 / 天锁上（例如只开了「店长本周不休息」还没生成就点了锁定，
 * 或者锁定后又把条目清空）。这种「锁定 + 0 人」的状态三方卡死：
 *   - 周排班页显示 🔒、所有编辑按钮禁用 → 改不了；
 *   - 月度汇总按 B6 口径显示「待排」；
 *   - 一键排整月看到 locked 就跳过 → 永远补不上。
 * 这里在启动 / 读数据时把它清掉，让用户在现有数据上直接恢复可用。
 *
 * 清理口径（与 B6「0 人 = 待排」一致）：
 *   1) 锁定但没有任何人员的条目（employee_id 为空 / is_rest = 1 的占位）→ 直接删；
 *   2) 一周一个人都没有的窗口记录（无论 draft / locked）→ 直接删，让「一键排整月」能重新补；
 *      例外：带着窗口设置（schedules.note，例如「店长本周不休息」）的记录不删，只把锁定降级成草稿 ——
 *      否则用户刚打开的开关会被自愈顺手删掉，生成时又变回「给店长排休」。
 * 只有「有人员安排」的周 / 天保持原样：锁定的照旧锁定，草稿的照旧草稿。
 */
export interface HealResult {
  /** 清掉的「锁定但没有任何人员」的条目数 */
  removedEntries: number;
  /** 清掉的「一周一个人都没有」的排班窗口记录数 */
  removedWeeks: number;
  /** 带窗口设置而保留、只把锁定降级为草稿的记录数 */
  unlockedWeeks: number;
}

const NOTHING: HealResult = { removedEntries: 0, removedWeeks: 0, unlockedWeeks: 0 };

/** 有人员条目：真排了人（employee_id 非空且不是休息占位）—— 与月表 / 周视图 / Excel 的「有人」口径一致 */
const HAS_PEOPLE = 'employee_id IS NOT NULL AND is_rest = 0';
/** 无人员条目：没点名的空槽，或休息占位 */
const NO_PEOPLE = 'employee_id IS NULL OR is_rest = 1';
/** 「这一周一个人都没有」：窗口记录 s 下不存在任何有人员的条目 */
const WEEK_EMPTY = `NOT EXISTS (SELECT 1 FROM schedule_entries se WHERE se.schedule_id = s.id AND se.employee_id IS NOT NULL AND se.is_rest = 0)`;

export function healEmptyLocks(): HealResult {
  const db = getDb();
  // 先做一次只读体检：没有需要清理的状态就直接返回，读数据路径上不做无谓的写事务
  const pending = db.prepare(`SELECT
      (SELECT COUNT(*) FROM schedule_entries WHERE status = 'locked' AND (${NO_PEOPLE})) AS empty_locked_entries,
      (SELECT COUNT(*) FROM schedules s WHERE (s.note IS NULL OR s.note = '') AND ${WEEK_EMPTY}) AS empty_rows,
      (SELECT COUNT(*) FROM schedules s WHERE s.status = 'locked' AND ${WEEK_EMPTY}) AS locked_empty_rows`)
    .get() as { empty_locked_entries: number; empty_rows: number; locked_empty_rows: number };
  if (!pending.empty_locked_entries && !pending.empty_rows && !pending.locked_empty_rows) return NOTHING;
  return db.transaction((): HealResult => {
    // 1) 锁定但没有任何人员的条目：锁没有保护对象，直接清掉（空槽不再冒充「锁定日」）
    const removedEntries = db.prepare(`DELETE FROM schedule_entries WHERE status = 'locked' AND (${NO_PEOPLE})`).run().changes;
    // 2) 一周一个人都没有的窗口记录：整行删掉（条目不删也永远排不了人，留着只会挡住一键排整月）
    const removedWeeks = db.prepare(`DELETE FROM schedules WHERE (note IS NULL OR note = '')
      AND id NOT IN (SELECT DISTINCT schedule_id FROM schedule_entries WHERE ${HAS_PEOPLE})`).run().changes;
    // 3) 带窗口设置的记录保留内容，但绝不允许继续停在「锁定」上
    const unlockedWeeks = db.prepare(`UPDATE schedules SET status = 'draft', updated_at = datetime('now','localtime')
      WHERE status = 'locked' AND id NOT IN (SELECT DISTINCT schedule_id FROM schedule_entries WHERE ${HAS_PEOPLE})`).run().changes;
    return { removedEntries, removedWeeks, unlockedWeeks };
  })();
}
