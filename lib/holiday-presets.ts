import { addDays, eachDate } from './date';

export interface PresetGroup {
  name: string;
  kind: 'holiday' | 'workday';
  start: string;
  /** 结束日期（含）；不填表示单日 */
  end?: string;
  /** true = 官方通知未发布，按农历/惯例预估 */
  estimated?: boolean;
}

export interface PresetHoliday {
  date: string;
  name: string;
  kind: 'holiday' | 'workday';
  year: number;
  estimated: boolean;
}

/**
 * 2026 年：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号）
 *   元旦 1/1-1/3，1/4 上班；春节 2/15-2/23，2/14、2/28 上班；清明 4/4-4/6；
 *   劳动节 5/1-5/5，5/9 上班；端午 6/19-6/21；中秋 9/25-9/27；国庆 10/1-10/7，9/20、10/10 上班。
 */
const PRESET_2026: PresetGroup[] = [
  { name: '元旦', kind: 'holiday', start: '2026-01-01', end: '2026-01-03' },
  { name: '元旦调休上班', kind: 'workday', start: '2026-01-04' },
  { name: '春节', kind: 'holiday', start: '2026-02-15', end: '2026-02-23' },
  { name: '春节调休上班', kind: 'workday', start: '2026-02-14' },
  { name: '春节调休上班', kind: 'workday', start: '2026-02-28' },
  { name: '清明节', kind: 'holiday', start: '2026-04-04', end: '2026-04-06' },
  { name: '劳动节', kind: 'holiday', start: '2026-05-01', end: '2026-05-05' },
  { name: '劳动节调休上班', kind: 'workday', start: '2026-05-09' },
  { name: '端午节', kind: 'holiday', start: '2026-06-19', end: '2026-06-21' },
  { name: '中秋节', kind: 'holiday', start: '2026-09-25', end: '2026-09-27' },
  { name: '国庆节', kind: 'holiday', start: '2026-10-01', end: '2026-10-07' },
  { name: '国庆调休上班', kind: 'workday', start: '2026-09-20' },
  { name: '国庆调休上班', kind: 'workday', start: '2026-10-10' },
];

/**
 * 2027 年：国务院尚未发布 2027 年放假通知，以下按农历日期与近年惯例预排，
 * 全部标记为「预估」，官方通知发布后请在「节假日」页手动校对。
 */
const PRESET_2027: PresetGroup[] = [
  { name: '元旦（预估）', kind: 'holiday', start: '2027-01-01', end: '2027-01-03', estimated: true },
  { name: '春节（预估）', kind: 'holiday', start: '2027-02-05', end: '2027-02-12', estimated: true },
  { name: '清明节（预估）', kind: 'holiday', start: '2027-04-05', estimated: true },
  { name: '劳动节（预估）', kind: 'holiday', start: '2027-05-01', end: '2027-05-05', estimated: true },
  { name: '端午节（预估）', kind: 'holiday', start: '2027-06-09', estimated: true },
  { name: '中秋节（预估）', kind: 'holiday', start: '2027-09-15', estimated: true },
  { name: '国庆节（预估）', kind: 'holiday', start: '2027-10-01', end: '2027-10-07', estimated: true },
];

export const PRESET_YEARS = [2026, 2027];

export function presetGroups(year: number): PresetGroup[] {
  if (year === 2026) return PRESET_2026;
  if (year === 2027) return PRESET_2027;
  return [];
}

export function expandPresets(year: number): PresetHoliday[] {
  const out: PresetHoliday[] = [];
  for (const g of presetGroups(year)) {
    const end = g.end || g.start;
    const dates = end === g.start ? [g.start] : eachDateInclusive(g.start, end);
    for (const date of dates) {
      out.push({ date, name: g.name, kind: g.kind, year, estimated: Boolean(g.estimated) });
    }
  }
  return out;
}

function eachDateInclusive(start: string, end: string): string[] {
  return eachDate(start, end);
}

export { addDays };
