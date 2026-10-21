import { authConfig } from '@/lib/auth';
import { currentUser, ok, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  const user = await currentUser();
  const cfg = authConfig();
  return ok({
    loggedIn: Boolean(user),
    username: user,
    usingDefaultCredentials: cfg.usingDefaultCredentials,
    usingFallbackSecret: cfg.usingFallbackSecret,
  });
});
