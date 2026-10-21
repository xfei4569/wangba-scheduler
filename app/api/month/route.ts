import { NextRequest } from 'next/server';
import { assert, ok, requireUser, route } from '@/lib/api';
import { isValidMonth, monthSummary } from '@/lib/scheduler/month';
import { todayStr } from '@/lib/date';

export const dynamic = 'force-dynamic';

export const GET = route(async (req: NextRequest) => {
  await requireUser();
  const month = req.nextUrl.searchParams.get('month') || todayStr().slice(0, 7);
  assert(isValidMonth(month), '月份格式应为 YYYY-MM');
  return ok(monthSummary(month));
});
