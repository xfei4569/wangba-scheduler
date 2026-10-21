import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, SENSITIVE_COOKIE, verifyToken } from './jwt';
import { isUnlocked } from './sensitive';
import { bootstrap } from './bootstrap';

export class ApiError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(message: string, status = 400, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function ok<T>(data: T): NextResponse {
  return NextResponse.json({ ok: true, data });
}

export function fail(error: string, status = 400, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

export function assert(cond: unknown, message: string, status = 400): asserts cond {
  if (!cond) throw new ApiError(message, status);
}

/** 取当前登录账号（中间件已挡一层，这里是接口内的二次确认） */
export async function currentUser(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const payload = await verifyToken<{ sub?: string; scope?: string }>(token);
  if (!payload || payload.scope !== 'session' || !payload.sub) return null;
  return payload.sub;
}

export async function requireUser(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new ApiError('未登录或登录已过期', 401);
  return user;
}

/** 敏感区（高级设置）是否已解锁 */
export async function sensitiveUnlocked(): Promise<boolean> {
  const token = (await cookies()).get(SENSITIVE_COOKIE)?.value;
  return isUnlocked(token);
}

export async function requireSensitive(): Promise<void> {
  if (!(await sensitiveUnlocked())) {
    throw new ApiError('该区域已加密，请先在页面上输入店长口令解锁', 403, { code: 'SENSITIVE_LOCKED' });
  }
}

export async function readJson<T = Record<string, unknown>>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

/* ------------------------- 入参校验小工具 ------------------------- */

export function asString(v: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string {
  const s = typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
  if (!s) {
    if (opts.required) throw new ApiError(field + '不能为空');
    return '';
  }
  if (opts.max && s.length > opts.max) throw new ApiError(field + '过长（最多 ' + opts.max + ' 个字符）');
  return s;
}

export function asInt(v: unknown, field: string, opts: { min?: number; max?: number; required?: boolean; fallback?: number } = {}): number {
  if (v === null || v === undefined || v === '') {
    if (opts.required) throw new ApiError(field + '不能为空');
    return opts.fallback ?? 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ApiError(field + '必须是整数');
  if (opts.min !== undefined && n < opts.min) throw new ApiError(field + '不能小于 ' + opts.min);
  if (opts.max !== undefined && n > opts.max) throw new ApiError(field + '不能大于 ' + opts.max);
  return n;
}

export function asYmd(v: unknown, field: string, opts: { required?: boolean } = {}): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (opts.required) throw new ApiError(field + '不能为空');
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError(field + '格式应为 YYYY-MM-DD');
  return s;
}

export function asJsonArray(v: unknown, field: string): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      /* 落到下面的报错 */
    }
  }
  if (v === null || v === undefined || v === '') return [];
  throw new ApiError(field + '格式不正确');
}

/** 统一异常出口（顺带保证数据库已初始化、当日备份已执行） */
export function route(fn: (req: NextRequest, ctx: { params: Record<string, string> }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      bootstrap();
      return await fn(req, { params: await ctx.params });
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status, err.extra);
      console.error('[API 错误]', req.method, req.nextUrl.pathname, err);
      return fail('服务器内部错误：' + (err instanceof Error ? err.message : String(err)), 500);
    }
  };
}
