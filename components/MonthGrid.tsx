'use client';

import { daysInMonth, parseYmd } from '@/lib/date';

export interface DayCellInfo {
  type: 'weekday' | 'weekend' | 'holiday';
  name?: string;
  kind?: 'holiday' | 'workday';
  estimated?: boolean;
}

const HEAD = ['一', '二', '三', '四', '五', '六', '日'];

export default function MonthGrid({
  year,
  month,
  info,
  today,
  onToggle,
}: {
  year: number;
  month: number;
  info: (date: string) => DayCellInfo;
  today: string;
  onToggle: (date: string, current: DayCellInfo) => void;
}) {
  const total = daysInMonth(year, month);
  const mm = String(month).padStart(2, '0');
  const first = parseYmd(year + '-' + mm + '-01');
  const lead = (first.getUTCDay() + 6) % 7; // 周一为第一列

  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= total; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="mg-wrap">
      <div className="mg-title">{month} 月</div>
      <div className="mg-head">
        {HEAD.map((h) => (
          <div key={h}>{h}</div>
        ))}
      </div>
      <div className="mg-grid">
        {cells.map((d, idx) => {
          if (d === null) return <div key={'e' + idx} className="mg-cell mg-empty" />;
          const date = year + '-' + mm + '-' + String(d).padStart(2, '0');
          const inf = info(date);
          const cls =
            inf.kind === 'workday' ? 'mg-workday' : inf.type === 'holiday' ? 'mg-holiday' : inf.type === 'weekend' ? 'mg-weekend' : 'mg-weekday';
          const title =
            date +
            ' ' +
            (inf.kind === 'workday'
              ? (inf.name || '调休上班日') + '（平日）'
              : inf.type === 'holiday'
                ? (inf.name || '法定节假日') + '（忙日）' + (inf.estimated ? ' · 预估' : '')
                : inf.type === 'weekend'
                  ? '周末（忙日）'
                  : '平日');
          return (
            <button
              type="button"
              key={date}
              className={
                'mg-cell ' + cls + (inf.estimated ? ' mg-estimated' : '') + (date === today ? ' mg-today' : '')
              }
              title={title}
              aria-label={title}
              onClick={() => onToggle(date, inf)}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
