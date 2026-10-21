import { addDays } from '../date';

/**
 * B7：一键排整月的反馈文案（页面与自测共用同一段口径）。
 *
 * 旧文案「整月排班完成：共处理 N 周」把「已锁定，跳过」的周也算成处理过的周，
 * 用户以为排了、其实一周没动。现在按结果细分：
 *   新排 X 周（起 ~ 止），跳过已锁定 Y 周（起 ~ 止）。要改已锁定的周，先在周排班页点「解锁本周」
 */
export interface MonthGenerateOutcome {
  /** 真正新排出来的周起点（YYYY-MM-DD） */
  generated_weeks?: string[];
  /** 因为「已锁定且有人」被跳过的周起点 */
  skipped_weeks?: string[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function cleanWeeks(weeks: string[] | undefined): string[] {
  return [...new Set((weeks || []).filter((week) => YMD.test(week)))].sort();
}

/** 把周起点列表折成「起 ~ 止（含周末）」文案；空列表返回空串 */
export function weekSpan(weeks: string[]): string {
  const rows = cleanWeeks(weeks);
  if (!rows.length) return '';
  return rows[0] + ' ~ ' + addDays(rows[rows.length - 1], 6);
}

export function monthGenerateFeedback(outcome: MonthGenerateOutcome): string {
  const generated = cleanWeeks(outcome.generated_weeks);
  const skipped = cleanWeeks(outcome.skipped_weeks);
  let text = generated.length ? '新排 ' + generated.length + ' 周（' + weekSpan(generated) + '）' : '没有新排的周';
  if (skipped.length) {
    text += '，跳过已锁定 ' + skipped.length + ' 周（' + weekSpan(skipped) + '）';
    text += '。要改已锁定的周，先在周排班页点「解锁本周」';
  }
  return text;
}
