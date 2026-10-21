import { ok, route } from '@/lib/api';
import { DB_PATH } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** 公开探活接口（不需要登录，方便排查「服务是否起来了」） */
export const GET = route(async () => {
  return ok({
    status: 'up',
    name: '网吧排班台',
    time: new Date().toISOString(),
    db: DB_PATH,
  });
});
