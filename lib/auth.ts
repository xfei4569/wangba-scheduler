import crypto from 'node:crypto';
import { signToken, usingFallbackSecret } from './jwt';


export interface AuthConfig {
  username: string;
  password: string;
  sessionDays: number;
  usingDefaultCredentials: boolean;
  usingFallbackSecret: boolean;
}

export function authConfig(): AuthConfig {
  const username = (process.env.SCHEDULER_USERNAME || '').trim();
  const password = process.env.SCHEDULER_PASSWORD || '';
  const days = Number(process.env.SESSION_DAYS || 7);
  return {
    username,
    password,
    sessionDays: Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 7,
    usingDefaultCredentials: !username || password.length < 12,
    usingFallbackSecret: usingFallbackSecret(),
  };
}

/** 定长比较，避免时序侧信道 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyCredentials(username: string, password: string): boolean {
  const cfg = authConfig();
  if (cfg.usingDefaultCredentials || cfg.usingFallbackSecret) return false;
  const okUser = safeEqual(username, cfg.username);
  const okPass = safeEqual(password, cfg.password);
  return okUser && okPass;
}

export function sessionMaxAgeSeconds(): number {
  return authConfig().sessionDays * 24 * 60 * 60;
}

export async function createSessionToken(username: string): Promise<string> {
  return signToken({ sub: username, scope: 'session' }, sessionMaxAgeSeconds());
}

/* ---------------- 登录失败限流（内存计数，重启即清零） ---------------- */
const MAX_FAILURES = 6;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const rec = failures.get(key);
  if (!rec) return { allowed: true, retryAfterSeconds: 0 };
  if (Date.now() - rec.first > WINDOW_MS) {
    failures.delete(key);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (rec.count >= MAX_FAILURES) {
    return { allowed: false, retryAfterSeconds: Math.ceil((rec.first + WINDOW_MS - Date.now()) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(key: string): void {
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}
