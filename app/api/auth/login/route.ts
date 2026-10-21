import { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/jwt';
import {
  authConfig,
  checkLoginRateLimit,
  clearLoginFailures,
  createSessionToken,
  recordLoginFailure,
  sessionMaxAgeSeconds,
  verifyCredentials,
} from '@/lib/auth';
import { asString, fail, ok, readJson, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const POST = route(async (req: NextRequest) => {
  const body = await readJson<{ username?: string; password?: string }>(req);
  const username = asString(body.username, '账号', { required: true, max: 64 });
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) return fail('密码不能为空');

  // 限流键不能用 X-Forwarded-For：这个头由请求方自己填，随便换一个就绕过限流。
  // 排班台是单机 / 局域网部署，按账号分桶就够（同名账号共享一个桶）。
  const key = 'login|' + username;
  const limit = checkLoginRateLimit(key);
  if (!limit.allowed) {
    return fail('登录失败次数过多，请 ' + Math.ceil(limit.retryAfterSeconds / 60) + ' 分钟后再试', 429);
  }

  if (!verifyCredentials(username, password)) {
    recordLoginFailure(key);
    return fail('账号或密码不正确', 401);
  }

  clearLoginFailures(key);
  const token = await createSessionToken(username);
  const res = ok({ username, sessionDays: authConfig().sessionDays });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionMaxAgeSeconds(),
  });
  return res;
});
