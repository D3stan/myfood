import type {
  ApiTokenInfo,
  BarcodeLinkBody,
  BarcodeLookup,
  CookBody,
  DataInfo,
  DealsInfo,
  DealsPlan,
  ExpenseBody,
  ItemDeals,
  ItemPrice,
  JobMode,
  LockPeriodBody,
  PushSubscribeBody,
  PushUnsubscribeBody,
  SettingsBody,
  State,
  StatsMap,
  TokenBody,
} from '../shared/types.ts';

export class ApiError extends Error {
  /** 0 = the server could not be reached. */
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Fake = (method: string, path: string, body?: unknown) => Promise<unknown>;
let fake: Fake | null = null;
/** Answer every call locally (used by ?fixture and interactive demo mode). */
export const useFake = (f: Fake | null): void => { fake = f; };

let unauthorized: () => void = () => {};
export const onUnauthorized = (f: () => void): void => { unauthorized = f; };

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (fake) return fake(method, path, body) as unknown as Promise<T>;
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
  return data as T;
}

export function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<State> {
  return request<State>(method, path, body);
}

export const cookMeal = (body: CookBody): Promise<State> => api('POST', '/api/meals/cook', body);
export const addExpense = (body: ExpenseBody): Promise<State> => api('POST', '/api/expenses', body);
export const lockExpenses = (body: LockPeriodBody): Promise<State> => api('POST', '/api/expenses/lock', body);
export const settle = (): Promise<State> => api('POST', '/api/settle', {});
export const exportExpensesUrl = (period: string, format: 'csv' | 'json'): string =>
  `/api/expenses/export?period=${encodeURIComponent(period)}&format=${encodeURIComponent(format)}`;

export const lookupBarcode = (code: string, opts?: { refresh?: boolean }): Promise<BarcodeLookup> =>
  request<BarcodeLookup>('GET', `/api/barcodes/${encodeURIComponent(code)}${opts?.refresh ? '?refresh=1' : ''}`);
export const linkBarcode = (body: BarcodeLinkBody): Promise<State> => api('POST', '/api/barcodes/link', body);

export const createToken = (body: TokenBody): Promise<{ token: string; info: ApiTokenInfo; state: State }> =>
  request<{ token: string; info: ApiTokenInfo; state: State }>('POST', '/api/tokens', body);
export const revokeToken = (id: number): Promise<State> => api('DELETE', `/api/tokens/${id}`);

export const subscribePush = (body: PushSubscribeBody): Promise<State> => api('POST', '/api/push/subscribe', body);
export const unsubscribePush = (body: PushUnsubscribeBody): Promise<State> => api('DELETE', '/api/push/subscribe', body);
export const testPush = (): Promise<{ ok: true; sent: number; pruned: number }> =>
  request<{ ok: true; sent: number; pruned: number }>('POST', '/api/push/test');

export const saveSettings = (body: SettingsBody): Promise<State> => api('PATCH', '/api/settings', body);

export const startJob = (text: string, images: Blob[], mode: JobMode = 'auto'): Promise<State> => {
  const fd = new FormData();
  fd.append('text', text);
  fd.append('mode', mode);
  for (const img of images) fd.append('images', img, img instanceof File ? img.name : 'photo.jpg');
  return api('POST', '/api/jobs', fd);
};
export const postJob = startJob;

export const getStats = <K extends keyof StatsMap>(kind: K, from: string, to: string): Promise<StatsMap[K]> =>
  request<StatsMap[K]>('GET', `/api/stats/${kind}?from=${from}&to=${to}`);
export const getItemPrices = (id: number): Promise<ItemPrice[]> => request<ItemPrice[]>('GET', `/api/items/${id}/prices`);
export const getItemDeals = (id: number): Promise<ItemDeals> => request<ItemDeals>('GET', `/api/items/${id}/deals`);
export const getDealsPlan = (): Promise<DealsPlan> => request<DealsPlan>('GET', '/api/deals/plan');
export const getDealsInfo = (): Promise<DealsInfo> => request<DealsInfo>('GET', '/api/deals/catalogs');
export const syncDeals = (): Promise<unknown> => request<unknown>('POST', '/api/deals/sync');
export const getData = (): Promise<DataInfo> => request<DataInfo>('GET', '/api/data');
export const rotateCode = (): Promise<{ code: string; state: State }> => request<{ code: string; state: State }>('POST', '/api/me/code');
