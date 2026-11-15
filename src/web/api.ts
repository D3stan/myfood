import type { State } from '../shared/types.ts';

export class ApiError extends Error {
  /** 0 = the server could not be reached. */
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Fake = (method: string, path: string, body?: unknown) => Promise<State>;
let fake: Fake | null = null;
/** Dev only: answer every call locally (see main.ts, ?fixture). */
export const useFake = (f: Fake): void => { fake = f; };

let unauthorized: () => void = () => {};
export const onUnauthorized = (f: () => void): void => { unauthorized = f; };

export async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<State> {
  if (fake) return fake(method, path, body);
  const headers: Record<string, string> = {};
  const init: RequestInit = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') headers['X-MyFood'] = '1';
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, "Can't reach the server"); }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') unauthorized();
    throw new ApiError(res.status, data?.error ?? 'Something went wrong');
  }
  return data as State;
}
