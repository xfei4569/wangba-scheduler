import { NextRequest } from 'next/server';
import { SENSITIVE_COOKIE } from '@/lib/jwt';
import { checkLoginRateLimit, clearLoginFailures, recordLoginFailure } from '@/lib/auth';
import { asString, assert, fail, ok, readJson, requireUser, route, sensitiveUnlocked } from '@/lib/api';
import {
  autoLockMinutes,
  createSensitiveToken,
  hasSensitivePin,
  sensitiveHidden,
  sensitiveTokenRemaining,
  setSensitivePin,
  verifySensitivePin,
} from '@/lib/sensitive';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export const GET = route(async () => {
  await requireUser();
  const token = (await cookies()).get(SENSITIVE_COOKIE)?.value;
  const remaining = await sensitiveTokenRemaining(token);
  return ok({
    hasPin: hasSensitivePin(),
    unlocked: remaining > 0,
    remainingSeconds: remaining,
    autoLockMinutes: autoLockMinutes(),
    hidden: sensitiveHidden(),
  });
});

export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  const body = await readJson<Record<string, unknown>>(req);
  const action = asString(body.action, '操作', { required: true });
  // 口令是 4 位起的短口令，必须和登录一样限流：否则可以无成本地跑一遍 0000-9999。
  const limitKey = 'sensitive|' + user;
  const limit = checkLoginRateLimit(limitKey);
  if (!limit.allowed && (action === 'unlock' || action === 'set-pin')) {
    return fail('口令错误次数过多，请 ' + Math.ceil(limit.retryAfterSeconds / 60) + ' 分钟后再试', 429);
  }

  if (action === 'unlock') {
    assert(hasSensitivePin(), '还没有设置店长口令，请先设置');
    const pin = asString(body.pin, '口令', { required: true, max: 64 });
    if (!verifySensitivePin(pin)) {
      recordLoginFailure(limitKey);
      return fail('口令不正确', 403);
    }
    clearLoginFailures(limitKey);
    const token = await createSensitiveToken();
    const res = ok({ unlocked: true, autoLockMinutes: autoLockMinutes() });
    res.cookies.set({
      name: SENSITIVE_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: autoLockMinutes() * 60,
    });
    return res;
  }

  if (action === 'lock') {
    const res = ok({ unlocked: false });
    res.cookies.set({ name: SENSITIVE_COOKIE, value: '', path: '/', maxAge: 0 });
    return res;
  }

  if (action === 'set-pin') {
    const newPin = asString(body.newPin, '新口令', { required: true, max: 64 });
    assert(newPin.length >= 4, '口令至少 4 位');
    if (hasSensitivePin()) {
      // 已设过口令：必须已解锁（或提供当前口令）才能修改
      const unlocked = await sensitiveUnlocked();
      if (!unlocked) {
        const currentPin = asString(body.pin, '当前口令');
        if (!currentPin || !verifySensitivePin(currentPin)) {
          recordLoginFailure(limitKey);
          return fail('当前口令不正确', 403);
        }
      }
    }
    clearLoginFailures(limitKey);
    setSensitivePin(newPin);
    const token = await createSensitiveToken();
    const res = ok({ hasPin: true, unlocked: true });
    res.cookies.set({
      name: SENSITIVE_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: autoLockMinutes() * 60,
    });
    return res;
  }

  return fail('不支持的操作：' + action);
});
