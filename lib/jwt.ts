import { SignJWT, jwtVerify } from 'jose';

/** 登录会话 Cookie 名 */
export const SESSION_COOKIE = 'wb_session';
/** 高级设置（敏感区）临时解锁 Cookie 名 */
export const SENSITIVE_COOKIE = 'wb_sensitive';

/** 公开版不提供共享备用密钥；未配置时拒绝签发会话。 */
export function jwtSecret(): Uint8Array {
  const raw = (process.env.JWT_SECRET || '').trim();
  if (raw.length < 32) throw new Error('请先运行 npm run setup 配置本机 JWT_SECRET（至少 32 字符）');
  return new TextEncoder().encode(raw);
}

export function usingFallbackSecret(): boolean {
  return (process.env.JWT_SECRET || '').trim().length < 32;
}

export async function signToken(payload: Record<string, unknown>, maxAgeSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .sign(jwtSecret());
}

export async function verifyToken<T = Record<string, unknown>>(token?: string | null): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    return payload as T;
  } catch {
    return null;
  }
}
