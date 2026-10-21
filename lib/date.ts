/** 纯日期工具（全部按 UTC 计算，避免时区漂移；日期一律 YYYY-MM-DD 字符串） */

const pad = (n: number) => String(n).padStart(2, '0');

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayStr(): string {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function isValidYmd(s: unknown): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseYmd(s);
  return ymd(d) === s;
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** 0=周日 … 6=周六 */
export function weekday(s: string): number {
  return parseYmd(s).getUTCDay();
}

export function isWeekend(s: string): boolean {
  const w = weekday(s);
  return w === 0 || w === 6;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 本周周一 */
export function mondayOf(s: string): string {
  const w = weekday(s);
  return addDays(s, -((w + 6) % 7));
}

export function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  if (!isValidYmd(start) || !isValidYmd(end)) return out;
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

/** 两个区间是否有交集（用于重叠校验） */
export function rangesOverlap(a1: string, a2: string, b1: string, b2: string): boolean {
  return a1 <= b2 && b1 <= a2;
}

export function formatCn(s?: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  return y + '年' + Number(m) + '月' + Number(d) + '日';
}

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function weekdayCn(s: string): string {
  return WEEK_CN[weekday(s)];
}

export function formatRangeCn(start?: string | null, end?: string | null): string {
  if (!start && !end) return '长期有效';
  if (start && end && start === end) return formatCn(start);
  return formatCn(start) + ' 至 ' + formatCn(end);
}

/** 两个班次的上班时间有没有重叠。跨过午夜的班，结束时间加一天再比。 */
export function shiftsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const minutes = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  const span = (start: string, end: string) => {
    const from = minutes(start);
    let to = minutes(end);
    if (to <= from) to += 24 * 60;
    return [from, to] as const;
  };
  const [a0, a1] = span(aStart, aEnd);
  const [b0, b1] = span(bStart, bEnd);
  const hit = (x0: number, x1: number, y0: number, y1: number) => x0 < y1 && y0 < x1;
  return hit(a0, a1, b0, b1) || hit(a0, a1, b0 + 1440, b1 + 1440) || hit(a0 + 1440, a1 + 1440, b0, b1);
}

export function nowStamp(): string {
  const d = new Date();
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}
