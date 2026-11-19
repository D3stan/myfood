# Deals: full MCP support and related features

Status: revised after review — 2026-11-19. It follows `docs/deals-catalog-plan.md` (PRs D3stan/myfood#3–#6). Line references are to branch `deals/4-plan-ui`.

## Where MCP stands today

The deals tools in `src/server/deals/mcp.ts` are `get_shopping_plan`, `search_offers`, `sync_catalogs` and `link_offer`. Every gap below was checked against the code.

| # | Gap | Where |
|---|---|---|
| G1 | `get_state` builds its payload by hand and leaves out `deals_summary`. (`me.notify_deals` is already there via `buildState`.) | `src/server/mcp.ts:87-99` |
| G2 | `set_settings` has no `notify_deals`. Its description, the 400 message (`:152`) and the hand-built `updatedUser` (`:157-183`) all list only `notify_low` / `notify_expiry`. | `src/server/mcp.ts:134-183` |
| G3 | There is no MCP way to see stores, sync status and location, or to enable a store or set the location. | `deals/routes.ts:13,19,26` |
| G4 | `get_item` shows no deals, normal price or price history; `itemPrices` is only reachable over HTTP. | `items/mcp.ts`, `items/routes.ts:21` |
| G5 | AI matches can't be reviewed (there is no list of matches by item, source or ignored). | — |
| G6 | `mcp-stdio.ts` passes no `matchOffers`, so stdio setups only ever get barcode matches. Stdio also has no scheduler; only `main.ts` runs `checkDealsSync`. | `mcp-stdio.ts:30` |
| G7 | `sync_catalogs` waits for one AI batch: about 70 s typically, up to the 180 s AI timeout. | `ai/agy.ts:59` |
| G8 | `search_offers` has four problems: no item or store names, offers from disabled stores and other currencies are included, no way to tell "ignored" (`item_id` null with a match row) from "never matched", and a query of only symbols (aliasKey → `''`) matches every offer. (LIKE escaping isn't needed: `aliasKey` strips `%` and `_`.) | `deals/mcp.ts:44-51` |
| G9 | Only one deals MCP test (`tests/deals-plan.test.ts:221`). `tests/mcp.test.ts` asserts the exact tool count (34) and has to be updated in every PR that adds tools. | tests |

Facts every tool description must state:
- `offer_key` is the same across stores (`aliasKey(heading + size)`, `tjek.ts:42`), so linking or ignoring one key affects that product in **every** store.
- Store and location settings are **household-wide**. Any per-user MCP token can change them, the same as over HTTP. That's acceptable for one household, and the descriptions say so.

## Part A — MCP parity (PR A, adds 2 tools: 34 → 36)

1. **`get_state`**: add `deals_summary` (a small payload, reusing `dealsSummary`) to the compact and full output.
2. **`set_settings`**: add `notify_deals`, with the same user resolution as `notify_low` (`forcedUserId` wins). Update the description, the 400 message and `updatedUser`.
3. **`get_shopping_plan`** gains `stores` (id, name, emoji, enabled, last_synced_at, last_error), `location` and `unmatched_offer_count`, instead of a separate read tool. Move the `GET /api/deals/catalogs` body into a `dealsInfo(db, today)` repo function shared by both.
4. **`set_deal_settings`** (new, idempotent write) takes `stores?: { id, enabled }[]` and `location?: { lat, lng, radius_m }`. Move the PUT route bodies into repo functions and call them from both the routes and the tool. The description says the change is household-wide.
5. **`get_item`** gains `normal_price`, `deals` (live and upcoming matched offers, from `itemDeals`) and `prices` (last 10 buys, from `itemPrices`). No separate `get_item_deals` tool.
6. **`list_offer_matches`** (new, read):
   - filters: `item_id?`, `source?` (`ai|manual|barcode`), `ignored?`;
   - returns up to 100 rows, newest first: offer_key, a sample title, the stores carrying it, item name, qty_per_pack, confidence, source;
   - it exists so an assistant can audit AI matches and correct them with `link_offer`;
   - `query_sql` covers anything beyond that.
7. **`search_offers`**:
   - join items and stores, keeping enabled stores and the household currency only;
   - add `status: 'matched' | 'ignored' | 'unmatched'`, plus `item_name`, `store_name`, and `unit_cents` when the match has a pack size;
   - reject a query whose `aliasKey` is empty.
8. **`link_offer`**: the description says the link applies to every store carrying that key. There is no `reset`: `item_id: null` ignores an offer, and the matcher already asks again about stale AI ignores.
9. **`sync_catalogs`**:
   - `match?: boolean`, **default `true`**, because stdio setups have no scheduler and would otherwise never match;
   - `match: false` skips the AI batch (barcode matching still runs) and returns in seconds;
   - the description gives the typical duration and says one sync matches at most 300 new names, so `unmatched_offer_count` can stay above 0.
10. **stdio**: build `matchOffersAi(jobsDir)` in `mcp-stdio.ts`, with `jobsDir = JOBS_DIR ?? DATA_DIR/jobs` and the same `mkdirSync` mode as `main.ts`. Document in the tool text and README that stdio-only setups get no scheduled sync.
11. **Tests**: new `tests/deals-mcp.test.ts` (following `tests/mcp.test.ts`) and the tool count updated to 36. It covers:
    - each new or changed tool;
    - `forcedUserId` on `notify_deals`;
    - the `search_offers` status values, store filtering and the empty-query rejection;
    - `match: false` never calling the matcher;
    - stdio wiring through a small exported factory.

## Part B — related features

### B0. Data fixes that B1 needs (PR B0, no new tools)
- **Trip items carry what a buy needs.** Add `qty_per_pack` and `price_cents` (the offer's pack price) to `PlanTripItem` (`shared/types.ts:318`, filled in `plan.ts:87-93`). Without them the client can't build a buy offline.
- **Normal price is not polluted by deal buys.**
  - The learned `items.cost_per_unit_cents` averages the last 3 buys, promo or not (`events/repo.ts:206-214`). That's right for spend valuation, since it is what was paid, so learning stays as it is.
  - `normalPrice` falls back to that value when every recent buy was a promo (`deals/repo.ts:56`). Change it: it falls back to `cost_per_unit_cents` only when there are **no** priced buys at all. When every buy was a promo, it returns `null`, so `pct_off` uses the offer's own `pre_price` or shows none.
  - Add a test for it.

### B1. Log a trip as bought (PR B1, adds 1 tool: 36 → 37)
- **The "Bought these" button** on the Deals page appears only on a trip dated today. That avoids a future-dated trip being logged with `at` capped to now (`events/repo.ts:271`), outside the offer's dates.
  - It builds a normal `EventBody` on the client: one `buy`, each line `qty = packs × qty_per_pack` and `cost_cents = packs × price_cents`, with the store name as the note. The event is queued through the normal pending-op path, so it works offline.
  - The cost logged is the offer price. The real receipt, if scanned later, stays the precise path, and the event can be edited.
- **Period locks**:
  - `createEvent` returns 409 for a locked week, and the outbox drops any op rejected with a 4xx (`web/outbox.ts:20-24`).
  - Check that the dropped op's error message reaches the existing error toast. If it doesn't, show a toast for it.
  - Test with a locked current week.
- **The `log_trip` MCP tool** takes `{ store_id, items?: { item_id, packs }[] }` and logs today's trip at that store, defaulting to its planned items. It goes through `createEvent` with `source: 'manual'`, so expiry, price learning, locks and low-stock pushes all apply.
  - It rejects store/item pairs with no offer live today.
  - There is no HTTP route; the web app uses the offline path above.

### B2. Shopping list grouped by store (PR B2, no new tools)
- A pure `shoppingList(items, plan | null)` in `src/shared/deals.ts` groups low and planned items under their trip's day and store, with packs ("2 × Butter"). Items with no trip go under "Anywhere".
- It replaces the body of `shoppingText` (`pantry.ts:20`), which keeps its name and its single caller. The Deals page gets the same "Share list" button.
- `get_shopping_plan` gains `shopping_list_text` instead of a new tool.
- The list carries no prices, and it must never be rendered into the guest page (`guest.ts`).

### B3. Demo data for deals (PR B3)
- Seed a small plan (2 stores, 4 items, one trip today) in the existing `/api/deals/*` stubs (`src/web/demo.ts:1207-1212`), and set `deals_summary` in the demo state, so the strip and Deals page show in demo mode.
- Add one tour step pointing at the strip.

## Deferred
- **Price and deal history per item** ("on offer about every 16 days"). The maths exist (`campaigns`, `promoCadence`), but no one has asked for it yet.
- **Adding more Tjek stores** (føtex, REMA 1000, Bilka). That's a new surface; `query_sql` and a manual insert cover it for now.
- **A watchlist** for products not in the pantry.
- **MCP resources and prompts.**
- **Per-user plans.**

## Order
1. PR A. It is cheap and safe, and the `get_state` and `set_settings` items could even ship alone.
2. PR B0 (data fixes).
3. PR B1 (log trip).
4. PR B2 (shopping list).
5. PR B3 (demo).

Each PR updates the tool-count assertion in `tests/mcp.test.ts` when it adds tools: 34 → 36 → 37.
