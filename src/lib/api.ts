// Browser-side fetch helpers: JSON in/out, errors surface as toasts.
import { toast } from 'svelte-sonner';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: data !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: data !== undefined ? JSON.stringify(data) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401 && !url.startsWith('/api/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new ApiError(401, 'login required');
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : '') || `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

/** Run an API call, toast the error (and optionally a success message). */
export async function attempt<T>(label: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (success) toast.success(success);
    return out;
  } catch (e) {
    toast.error(`${label}: ${(e as Error).message}`);
    return undefined;
  }
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, data: unknown = {}) => api<T>('POST', url, data);
export const put = <T>(url: string, data: unknown) => api<T>('PUT', url, data);
export const del = <T>(url: string) => api<T>('DELETE', url);
