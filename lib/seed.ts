import type BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_SETTINGS } from './settings-defaults';
import { PRESET_YEARS, expandPresets } from './holiday-presets';

/** 预置班次模板：早 2 人 / 中 1 人 / 晚 2 人，三档日期类型默认一致 */
export const DEFAULT_SHIFTS = [
  {
    code: 'early', name: '早班', start_time: '09:00', end_time: '21:00', cross_day: 0,
    weekday_count: 2, weekend_count: 2, holiday_count: 2, sort_order: 1,
  },
  {
    code: 'middle', name: '中班', start_time: '13:00', end_time: '01:00', cross_day: 1,
    weekday_count: 1, weekend_count: 1, holiday_count: 1, sort_order: 2,
  },
  {
    code: 'night', name: '晚班', start_time: '21:00', end_time: '09:00', cross_day: 1,
    weekday_count: 2, weekend_count: 2, holiday_count: 2, sort_order: 3,
  },
];

/** 写入预置节假日（INSERT OR IGNORE，可重复调用） */
export function insertPresetHolidays(db: BetterSqlite3.Database, years: number[] = PRESET_YEARS): number {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO holidays (date, name, kind, year, is_preset, estimated, note) VALUES (?, ?, ?, ?, 1, ?, ?)'
  );
  let inserted = 0;
  const tx = db.transaction(() => {
    for (const year of years) {
      for (const h of expandPresets(year)) {
        const r = stmt.run(
          h.date,
          h.name,
          h.kind,
          h.year,
          h.estimated ? 1 : 0,
          h.estimated ? '官方通知未发布，按农历与惯例预估，请以国务院通知为准' : null
        );
        inserted += r.changes;
      }
    }
  });
  tx();
  return inserted;
}

/** 首次启动初始化：班次模板、节假日预置、默认配置 */
export function seedIfEmpty(db: BetterSqlite3.Database): void {
  const shiftCount = (db.prepare('SELECT COUNT(*) AS c FROM shift_templates').get() as { c: number }).c;
  if (shiftCount === 0) {
    const stmt = db.prepare(
      `INSERT INTO shift_templates
       (code, name, start_time, end_time, cross_day, weekday_count, weekend_count, holiday_count, sort_order)
       VALUES (@code, @name, @start_time, @end_time, @cross_day, @weekday_count, @weekend_count, @holiday_count, @sort_order)`
    );
    const tx = db.transaction(() => {
      for (const s of DEFAULT_SHIFTS) stmt.run(s);
    });
    tx();
    console.log('[排班台] 已写入预置班次模板（早 2 / 中 1 / 晚 2）');
  }

  const holidayCount = (db.prepare('SELECT COUNT(*) AS c FROM holidays').get() as { c: number }).c;
  if (holidayCount === 0) {
    const n = insertPresetHolidays(db, PRESET_YEARS);
    console.log('[排班台] 已写入预置节假日 ' + n + ' 条（2026 官方 / 2027 预估）');
  }

  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx2 = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) stmt.run(k, v);
  });
  tx2();
}
