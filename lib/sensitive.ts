import crypto from 'node:crypto';
import { getSetting, setSettings } from './settings';
import { SK } from './settings-defaults';
import { signToken, verifyToken } from './jwt';

/**
 * 「高级设置」敏感区（不搭班/组合避让）的二次口令。
 * 口令哈希与短时解锁令牌都在服务端校验：即使有人直接调接口，没解锁也拿不到数据。
 */
export function hasSensitivePin(): boolean {
  return getSetting(SK.sensitivePinHash, '').length > 0;
}

function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, 32).toString('hex');
}

export function setSensitivePin(pin: string): void {
  const salt = crypto.randomBytes(16).toString('hex');
  setSettings({ [SK.sensitivePinSalt]: salt, [SK.sensitivePinHash]: hashPin(pin, salt) });
}

export function verifySensitivePin(pin: string): boolean {
  const hash = getSetting(SK.sensitivePinHash, '');
  const salt = getSetting(SK.sensitivePinSalt, '');
  if (!hash || !salt) return false;
  const candidate = Buffer.from(hashPin(pin, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function autoLockMinutes(): number {
  const n = Number(getSetting(SK.sensitiveAutoLock, '10'));
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.max(Math.round(n), 1), 240);
}

export function sensitiveHidden(): boolean {
  return getSetting(SK.sensitiveHidden, '0') === '1';
}

export async function createSensitiveToken(): Promise<string> {
  return signToken({ scope: 'sensitive' }, autoLockMinutes() * 60);
}

export async function sensitiveTokenRemaining(token?: string | null): Promise<number> {
  const payload = await verifyToken<{ scope?: string; exp?: number }>(token);
  if (!payload || payload.scope !== 'sensitive' || !payload.exp) return 0;
  return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
}

export async function isUnlocked(token?: string | null): Promise<boolean> {
  if (!hasSensitivePin()) return false;
  return (await sensitiveTokenRemaining(token)) > 0;
}
