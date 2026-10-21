import { ok, requireUser, route } from '@/lib/api';
import { listShifts } from '@/lib/repo';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireUser();
  return ok({ items: listShifts() });
});
