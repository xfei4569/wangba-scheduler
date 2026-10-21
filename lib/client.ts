'use client';

/**
 * 前端统一请求封装：
 * - 自动带 Cookie（同源）
 * - 401 直接跳登录页
 * - 把服务端返回的中文错误原样抛出，页面 message.error 即可
 */
export interface ApiFailure extends Error {
  code?: string;
  status?: number;
  issues?: string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });

  if (res.status === 401 && typeof window !== 'undefined') {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = '/login?next=' + next;
    throw new Error('登录已过期，请重新登录');
  }

  let payload: { ok?: boolean; data?: T; error?: string; code?: string; issues?: unknown } | null = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || !payload || payload.ok === false) {
    const err = new Error(payload?.error || '请求失败（HTTP ' + res.status + '）') as ApiFailure;
    err.code = payload?.code;
    err.status = res.status;
    if (Array.isArray(payload?.issues)) err.issues = payload.issues.filter((issue): issue is string => typeof issue === 'string');
    throw err;
  }
  return payload.data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>(url),
  post: <T,>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T,>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T,>(url: string, body?: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T,>(url: string, body?: unknown) =>
    request<T>(url, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }),
};
