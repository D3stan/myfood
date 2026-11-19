import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { StatsQuery } from '../shared/types.ts';
import type { State } from '../shared/types.ts';
import type { BarcodeLookupFn } from './barcodes.ts';
import type { Db } from './db.ts';
import type { MatchOffers } from './deals/matcher.ts';

export type AppEnv = { Variables: { uid: number } };

/** What every feature's `registerXRoutes(app, deps)` receives. */
export interface RouteDeps {
  db: Db;
  now: () => number;
  state: (uid: number) => State;
  json: (c: Context) => Promise<unknown>;
  parse: <T>(schema: ZodType<T>, data: unknown) => T;
  id: (c: Context) => number;
  pushLow: (prevStocks: Map<number, number>) => Promise<void>;
  lookupBarcode?: BarcodeLookupFn;
  fetch?: typeof fetch;
  matchOffers?: MatchOffers;
}

/** Validated `?from&to` of the stats endpoints. */
export const statsRange = (c: Context, parse: RouteDeps['parse']): { from: string; to: string } =>
  parse(StatsQuery, { from: c.req.query('from'), to: c.req.query('to') });
