# Level items: count containers, not just one level

## Goal
A `level` item (spices, oil, condiments) can be more than one container: `stock = sealed spares + open level`.
Garlic powder with one new bottle and one half-used bottle = `1.5`, shown as "½ +1".

- sealed(stock) = `max(0, ceil(round(stock)) - 1)`; open = `stock - sealed` (0 when stock ≤ 0).
- Stock 2 = one sealed + an open one that is full. Stock 1 is always "an open one, full". It can't mean
  "one sealed, open one empty", and that's acceptable.

## Data model: no schema change
Stock is replayed from event lines (`computeStock` src/shared/stock.ts:16, `applyOps` :134-137).
Today `toLines` (stock.ts:28) gives a line `is_set` only when the item is `level` or the kind is `adjust`.
So **an `is_set` line in an `eat` event is always a level item's "open container is now X"**. We derive the
open-level behavior from `kind = eat` + `is_set`, with no new column and no migration.

- One shared helper `nextStock(prev, line, kind)`:
  `is_set && kind === 'eat' ? sealed(prev) + qty : is_set ? qty : prev + qty`.
  `computeStock` takes lines that carry `kind` (or `{ kind, line }` pairs). It's used by `applyOps` (`b.kind`).
- Server stock queries also select `e.kind`: `allStock` domain.ts:50-57 and push.ts `loadStockMap` :72-78.
- `editEvent` (domain.ts:523) re-runs `toLines` with the stored kind, so edits replay correctly.
- Existing data replays the same: level stock never went above 1, so `sealed(prev)` was always 0.

## toLines rules for `level` items (stock.ts:23)
| kind | stored line | meaning |
|---|---|---|
| buy | `+qty`, delta | containers bought (UI and receipts send 1) |
| eat | `qty`, is_set | "the open one is now ½ / ¼ / out"; spares kept |
| adjust | `qty`, is_set | exact total count (e.g. 2.5) |

**What changes for existing behavior:** buying a level item used to *set it to full*. Now it *adds one*
(0.25 → 1.25 = "¼ +1").

## Nutrition: fix a client/server mismatch (review finding #1)
The server skips `is_set` lines in nutrition (domain.ts:193/242/331, mcp.ts:898). The client doesn't:
`eventLineNutrition` / `eventNutrition` (stock.ts:45-72) count them, which affects `applyOps` pending eats
and undo (:126/:151), the event sheet (sheets.ts:133) and the `computeDailyNutrition` fallback (:90).
Level eats become the main path, so this would show phantom kcal on every Half/Low tap.
**Fix:** `eventLineNutrition` returns zeros for `is_set` lines.

## Cook path (domain.ts:599/619/763/770)
Level ingredients go through `toLines` kind eat, so they become "set open level", and recipes replay that qty.
**Decision:** cook leaves out level ingredients for both stock deduction and nutrition
(nobody measures the salt in a stew). The cook sheet (cook.ts:87) hides the stepper for them or skips them.

## UI (web)
- Shared `levelParts(stock) -> { open, sealed }` in src/shared/stock.ts, reused by:
  - bits.ts:11-15 `levelName` / `amount`: label "half +1" when sealed > 0.
  - pantry.ts:21/61 and sheets.ts:52/79: bars show the `open` fraction plus a "+N" badge.
  - guest.ts:73-77 drops its duplicate and uses the shared helper.
- Item sheet for level (sheets.ts:87-88):
  - Full/Half/Low/Out send **kind `eat`** (actions.ts:356-359, currently `adjust`). "Out" with a spare = the next one opens full.
  - Show a "+1 bought" button and the cost field. The `pack` action (actions.ts:343-348) sends **qty 1 for level**
    (not `pack_size`, which users can change).
  - "Set exact count" uses the existing `setExact` (adjust, absolute). `stepOf` level is already 0.25.
- Labels: a level `is_set` line in an eat event is not "ate". History (VERB bits.ts:9 + `lineText` :18) and
  the toast (`ate()` actions.ts:85) read "🧄 Garlic: half +1" / "set". One helper, used by both.
- Unchanged: `overdrawWarning` (actions.ts:185) and cook.ts:83 already skip level items.
- Old cached clients still send level buttons as `adjust`, which wipes spares. Bump the service-worker cache version.

## Low stock
`isLow` (stock.ts:161) compares total stock with `low_at`, so "low" means ≤ ¼ **with no spares**. No change.
push.ts and guest.ts use the same rule.

## Expiry
`applyPurchasedLineMeta` (domain.ts:440) keeps the earliest expiry when buying a spare. After "Out" the
item keeps the old date. Spices mostly have no expiry, so we leave this as is (no per-container expiry).

## AI and MCP text
- prompt.ts:23: level qty meanings per kind (buy = containers bought, eat = level of the open one,
  adjust = total containers e.g. 1.5). prompt.ts:25 "level item bought -> qty 1" stays (now adds one).
- prompt.ts:26 audit: adjust is absolute. Add "do not adjust level items unless every container is visible".
- mcp.ts:965 unit, mcp.ts:1062 `log_event` lines, the `list_events` / `get_item.recent_events` descriptions
  (an eat with is_set on a level item = remaining level), and the types.ts:333-335 EventBody doc.

## Tests
- tests/stock.test.ts:
  - `computeStock` cases: 1.5 → eat 0 → 1; 2 → eat ½ → 1.5; 0 → eat ½ → ½; negative → eat; old histories unchanged.
  - `toLines` per kind for level (:37 `buy` level becomes a delta).
  - `eventNutrition` gives zero for level eat lines.
  - `applyOps` pending level eat on 1.5, plus undo.
  - `levelParts` labels.
- tests/domain.test.ts:71-81 rewritten: buy +1, eat-level keeps spares, adjust absolute, editing an old event replays right, undo.
- A jobs receipt test buying a level item: 0.25 → 1.25.
- A cook test with a level ingredient: stock and kcal untouched.
- A push low-crossing test: 1.25 → eat 0 → 1, not low.

## Not doing
- No sealed/open split in MCP `get_item` output.
- No per-container expiry.
