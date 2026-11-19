# Smart Groceries: catalog deals, normal prices, stock-up advice

Status: revised plan — 2026-11-19. It replaces the 2026-11-18 draft after a review against the code and the live data.

## Goal

Pull the weekly offers (this week and next) of Netto, Lidl and Coop 365 in Copenhagen. Match them to pantry items. Compare them with what we usually pay. Say **where and when to shop, and how much to buy**. Push a notice when a new catalog changes that advice.

## What the live data says (2026-11-19)

20 shoppable items, 9 with a price, 1 with a barcode, 18 buys, about 4 days of history, 15 adjust events against 20 eat events. So:

- most items have fewer than 3 priced buys: a "normal price" needs fallbacks;
- burn rates are noise for now: the maths must say "unknown" and still be useful;
- a barcode-driven source (Prej) would help exactly one item: deferred;
- adjust events carry much of the real consumption: burn rate counts them.

## Sources (checked 2026-11-19 with anonymous GETs)

| Source | Status | Use |
|---|---|---|
| Tjek `squid-api.tjek.com/v2` (`/dealers`, `/catalogs`, `/offers`) | Works with no key. Netto `9ba51`, Lidl `71c90`, 365discount `DWZE1w`. Lists next week's catalogs. Offers have `pricing.price`, `pricing.pre_price`, `quantity`, `run_from`, `run_till`. Unofficial; terms not read. | **The only provider in this plan.** |
| Schwarz `endpoints.leaflets.schwarz/v4` | Works with no key; prices are bare strings, no unit or pre-price. | Deferred; add only if Tjek misses Lidl offers. |
| Prej `api.prej.app` | Needs a key; free tier 25 req/day, non-commercial; `/v1/offers` is today only. | Deferred. |
| Salling food-waste | Needs a token. | Deferred. |

Cadence (from Tjek): Netto Sat–Fri, Lidl Sun–Sat, Coop 365 Thu–Wed. A catalog can start before its offers (Lidl flyer from the 18th, offers from the 22nd), so **validity is read from each offer**, never from its catalog.

## Decisions

1. **Normal price** of an item, in cents per 1 item unit, first that exists:
   1. the offer's own `pre_price` (per unit) — for "is this offer a deal";
   2. median of up to 10 recent priced buys (`PRICED_BUYS` in `src/server/events/repo.ts`, so total-only single-line buys count), **leaving out promo buys**: a buy is promo when it fell inside a matched offer's dates at a unit price within 5% of the offer's;
   3. `items.cost_per_unit_cents`.
   With none of these, the item gets no "% off", only the offer price.
2. **No stored plan.** `GET /api/deals/plan` computes it on every call (cheap at this size), from `now`. Days in the past are never proposed. Nothing goes stale after a buy.
3. **Stores**: `stores.sources` is a JSON array of `{ provider, config }`. Stores are disabled, never deleted. Nothing cascades from stores, catalogs or items into offers: the offer archive is permanent.
4. **Offers**: unique on `(store_id, source, external_id)`; `catalog_id` is nullable. Before counting discount frequency, offers for the same item and store whose date ranges overlap or touch (gap ≤ 1 day) merge into one **campaign**.
5. **Burn rate** replays stock over the last 30 days and sums every decrease: eat lines and downward adjusts. Presets are not counted (their taps are already eat events). `level` items and cooked meals are left out. With under 14 days of history or under 3 decreases, the rate is `null` ("unknown").
6. **Quantity**: need ≤ 0 → buy 0. `max_per_customer` caps; the pack minimum only applies once the quantity is above 0. Rate unknown → no stock-up advice; the item is still flagged when it is low and on offer.
7. **No per-event store** (`events.store_id`) and no receipt store detection in this plan: it touches event schemas, offline sync, MCP and demo data. Deferred.
8. Currency: offers are stored in the source's minor unit with a `currency` column; offers whose currency differs from `meta.currency` are ignored by the maths.

## Data model — `migrate()` version 7 (the database is at 6)

All `CREATE TABLE IF NOT EXISTS` go in `schema.sql`; seeds and the version bump go in `migrate()`.

```sql
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,                 -- 'netto-dk'
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🏪',
  sources TEXT NOT NULL DEFAULT '[]',  -- JSON [{ "provider": "tjek", "config": { "dealer_id": "9ba51" } }]
  enabled INTEGER NOT NULL DEFAULT 1,
  last_synced_at INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS catalogs (
  id INTEGER PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  valid_from TEXT NOT NULL,            -- YYYY-MM-DD, Europe/Copenhagen
  valid_to TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (store_id, source, external_id)
);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  catalog_id INTEGER REFERENCES catalogs(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  offer_key TEXT NOT NULL,             -- aliasKey(title + ' ' + size text)
  price_cents INTEGER NOT NULL,        -- per pack
  pre_price_cents INTEGER,
  currency TEXT NOT NULL,
  unit TEXT,                           -- 'g' | 'ml' | 'pc' | NULL, normalised from the source
  unit_qty REAL,                       -- per pack, in `unit`
  max_per_customer INTEGER,
  ean TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (store_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS offers_key ON offers(offer_key);
CREATE INDEX IF NOT EXISTS offers_dates ON offers(valid_to, valid_from);
CREATE TABLE IF NOT EXISTS offer_matches (
  offer_key TEXT PRIMARY KEY,
  item_id INTEGER,                     -- no FK: an archived/deleted item just stops matching; NULL = ignored
  qty_per_pack REAL,                   -- pack size in items.unit
  confidence REAL NOT NULL DEFAULT 1,
  source TEXT NOT NULL,                -- 'barcode' | 'ai' | 'manual'
  updated_at INTEGER NOT NULL
);
```

`meta`: `deals_lat`, `deals_lng`, `deals_radius_m` (default Copenhagen 55.6761, 12.5683, 5000), `deals_sync_slot`. Seeded stores: `netto-dk`, `lidl-dk`, `coop365-dk`. Phase 4 adds `users.notify_deals INTEGER NOT NULL DEFAULT 1` in `migrate()` version 8.

## Layout (one folder per layer, registered by one call, plain `(db, …)` functions)

```
src/shared/deals.ts            pure maths, no DB/DOM
src/server/deals/
  providers/tjek.ts            fetch + normalise (fetch injected for tests)
  repo.ts                      stores, catalogs, offers, matches, normal prices
  sync.ts                      syncStores(db, deps): upsert, match, returns what changed
  matcher.ts                   barcode → offer_matches → one batched AI call
  routes.ts                    registerDealsRoutes(app, deps)
  mcp.ts                       registerDealsTools(server, ctx)
src/web/ui/deals/              screen + actions
src/web/ui/settings/stores.ts
tests/deals-*.test.ts, tests/samples/tjek-*.json
```

## Phases — one PR each, stacked

### Phase 1 — Ingestion (Tjek only)
- Schema + `migrate()` v7 + seeded stores and meta defaults.
- `providers/tjek.ts`: `fetchOffers(store, { lat, lng, radius }, fetch)` → catalogs (current and upcoming) and normalised offers. Prices to minor units; quantity to `g`/`ml`/`pc` (kg→g ×1000, l→ml ×1000, cl ×10); dates to local `YYYY-MM-DD`.
- `sync.ts`: `syncStores(db, { fetch, now })` upserts catalogs and offers per enabled store, records `last_synced_at` / `last_error` per store (one store failing does not stop the others), returns counts of new offers. `bumpRev` only when something changed.
- `POST /api/deals/sync`, `GET /api/deals/catalogs` (stores, catalogs, sync status).
- Tests on recorded Tjek JSON in `tests/samples/`: normalisation, idempotent re-sync, failure isolation, migration on an existing v6 DB.

### Phase 2 — Matching and normal prices
- Split `src/server/ai/agy.ts`: a general `runAgy(prompt, jsonSchema, dir)` plus the existing `runAi` built on it. Add a `matchOffers` dependency next to `runAi` in `Deps` so tests fake it.
- `matcher.ts`: per new `offer_key`: offer EAN in `barcodes` → `offer_matches` → one batched AI call (non-archived, non-cooked, non-`level` items: `id, name, category, unit, pack_size`; unmatched offers: `offer_key, title, unit, unit_qty`) returning `{ offer_key, item_id|null, qty_per_pack, confidence }`. Matches under 0.6 confidence are stored as ignored. Sync runs it after upsert.
- `repo.ts`: `normalPrice(db, itemId)` per Decision 1, reusing `PRICED_BUYS`.
- `POST /api/deals/match` (set / ignore an `offer_key`) and `GET /api/items/:id/deals` (live and upcoming matched offers with % off).
- Item sheet: a deal badge next to the existing price history.

### Phase 3 — Pure maths (`src/shared/deals.ts`)
- `burnRate(lines, now)` per Decision 5.
- `campaigns(offers)` merging per Decision 4; `promoCadence(campaignStarts, category)` = `(n0·μcat + Σgaps) / (n0 + gaps)` with n0 = 2, μ: dairy/bakery/produce 14, meat 18, other 28 days.
- `stockUp({ stock, lowAt, rate, normal, offer, cadence, shelfLife, nextCheaperIn })` per Decision 6: horizon = 7 days if < 10% off, else `cadence × clamp(0.8 + 1.5δ, 0.75, 1.35)`, clamped by a cheaper upcoming offer, shelf life (default 60) and 60 days; packs = `ceil(max(0, rate·H − stock) / qty_per_pack)` capped by `max_per_customer`; plus a reason string.
- `planTrips(needs, offers, today)`: candidate (day, store) pairs from today to the last offer end; best single trip; a second trip only when it saves ≥ 25 kr more; items past their deadline must be covered by the first trip.
- Exhaustive unit tests, no DB.

### Phase 4 — Plan, automation, UI, MCP
- `GET /api/deals/plan` builds inputs from the DB and calls the Phase 3 functions. `State` gets only `deals_summary: { best_day, store_name, saving_cents, deal_count } | null`.
- Scheduler in `main.ts`: the existing 15-min timer also runs `syncStores` once per slot (06:00 and 17:00 local; slot key in `meta.deals_sync_slot`). After a sync, compute the plan and, if the trips changed, push to users with `notify_deals` (dedupe key = hash of the trips in `push_log`). `migrate()` v8 adds `users.notify_deals`.
- UI: deals page (trips, items, quantities, reasons), Pantry strip, Settings → Stores (enable/disable, location, sync now, last error), notify toggle. Stubs for `/api/deals/*` in `src/web/demo.ts` and the fixture fake in `src/web/main.ts`.
- MCP: `get_shopping_plan`, `search_offers`, `sync_catalogs`, `link_offer`; add the new tables to the `query_sql` description.

## Deferred
Per-event store + receipt store detection; Prej; Schwarz; PDF/AI flyer reader; Salling food-waste; per-store currency conversion.
