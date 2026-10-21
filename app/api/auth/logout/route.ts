import { SESSION_COOKIE, SENSITIVE_COOKIE } from '@/lib/jwt';
import { ok, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async () => {
  const res = ok({ loggedOut: true });
  res.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  res.cookies.set({ name: SENSITIVE_COOKIE, value: '', path: '/', maxAge: 0 });
  return res;
});
