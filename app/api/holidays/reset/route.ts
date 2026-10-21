import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asInt, ok, readJson, requireUser, route } from '@/lib/api';
import { insertPresetHolidays } from '@/lib/seed';
import { PRESET_YEARS, presetGroups } from '@/lib/holiday-presets';

export const dynamic = 'force-dynamic';

/** 恢复某年的预置节假日（已存在的日期不会重复写入，也不会覆盖手动改动过的同名日期） */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const year = asInt(body.year, '年份', { min: 2000, max: 2100, required: true });
  const years = presetGroups(year).length > 0 ? [year] : PRESET_YEARS;
  const inserted = insertPresetHolidays(getDb(), years);
  return ok({ years, inserted });
});
