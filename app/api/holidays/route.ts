import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { asString, asYmd, assert, fail, ok, readJson, requireUser, route } from '@/lib/api';
import { buildDayMap, listHolidays } from '@/lib/repo';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const year = Number(req.nextUrl.searchParams.get('year') || new Date().getFullYear());
  assert(Number.isInteger(year) && year >= 2000 && year <= 2100, '年份不正确');
  return ok({ year, items: listHolidays(year), days: buildDayMap(year) });
});

/** 勾选/取消：该日期已有任一标记则删除，否则按 kind 新增 */
export const POST = route(async (req: NextRequest) => {
  await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const date = asYmd(body.date, '日期', { required: true }) as string;
  const kind = (asString(body.kind, '类型') || 'holiday') as 'holiday' | 'workday';
  assert(kind === 'holiday' || kind === 'workday', '类型只能是 法定节假日 或 调休上班日');

  const db = getDb();
  const existing = db.prepare('SELECT * FROM holidays WHERE date = ?').get(date) as
    | { id: number; kind: string }
    | undefined;

  if (existing && existing.kind === kind) {
    db.prepare('DELETE FROM holidays WHERE id = ?').run(existing.id);
    return ok({ date, action: 'removed', previous_kind: existing.kind });
  }

  if (existing) {
    const name = kind === 'holiday' ? '法定节假日（手动标记）' : '调休上班日（手动标记）';
    db.prepare(`UPDATE holidays SET kind = ?, name = ?, is_preset = 0, estimated = 0,
      note = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(kind, name, '手动标记', existing.id);
    return ok({ date, action: 'changed', kind, previous_kind: existing.kind });
  }

  const year = Number(date.slice(0, 4));
  const defaultName = kind === 'holiday' ? '法定节假日（手动标记）' : '调休上班日（手动标记）';
  const name = asString(body.name, '名称', { max: 40 }) || defaultName;
  db.prepare(
    `INSERT INTO holidays (date, name, kind, year, is_preset, estimated, note)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  ).run(date, name, kind, year, '手动标记');

  return ok({ date, action: 'added', kind });
});

export const DELETE = route(async (req: NextRequest) => {
  await requireUser();
  const date = asYmd(req.nextUrl.searchParams.get('date'), '日期', { required: true }) as string;
  const db = getDb();
  const info = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
  if (info.changes === 0) return fail('该日期没有标记', 404);
  return ok({ date, removed: true });
});
