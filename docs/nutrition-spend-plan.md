# Nutrition + spending tracking, settings page — plan

Status: proposal, 2026-11-17. Nothing implemented yet.

## 1. What exists today (so we build on it, not beside it)

| Area | Already there | Missing |
| --- | --- | --- |
| Nutrition data | `items.kcal/protein/fat_per_unit`; `event_lines.kcal/protein_g/fat_g` snapshotted on `eat` (`domain.ts` `snapshotLineNutrition`); `events.counts_nutrition` | **carbs** everywhere; per-user **goals** |
| Nutrition maths | `shared/stock.ts`: `eventLineNutrition`, `eventNutrition`, `computeDailyNutrition` (merges server totals + pending offline ops) | ranges beyond 30 days |
| Nutrition UI | History shows a per-day kcal/P/F pill, "My totals / Household" toggle | anything in Me, goals, charts, time frames |
| Spend data | `events.cost_cents`, `event_lines.cost_cents`, `expense_locks` (ISO week), `items.category` | ranges beyond 90 days, category breakdown |
| Spend UI | Spend tab: weeks, per-user subtotals, lock, CSV/JSON export | time-frame selector, chart, category / per-user views |
| Settings | All piled into Me (profile, currency, push, Siri tokens, guest code, presets) | a settings page; **any MCP UI** (MCP is a single env `MCP_SECRET`) |
| Navigation | `ui.tab` + bottom sheets | sub-pages with back |

Pain points that make new features expensive today:
`server/mcp.ts` 1692 lines (27 tools in one function), `server/domain.ts` 1184, `web/ui/actions.ts` 851 (one action map), `server/routes.ts` 524 (one function), `me.ts` mixes 7 concerns.

## 2. Architecture: feature modules (KISS, not a framework)

Rule: **a feature is a folder slice per layer, registered by one function call.**
No DI container, no classes for their own sake, no plugin system. Plain functions taking `(db, …)`,
matching how `domain.ts` already works. "OOP" where it pays: none needed yet — data is rows, logic is pure functions.

```
src/shared/
  nutrition.ts        pure: Macros type, add/scale/round, lineMacros(), dailyTotals(), vsGoal()   (moved out of stock.ts)
  spend.ts            pure: bucket(expenses, frame), byUser(), byCategory(), settle()
  period.ts           pure: Frame = 'day'|'week'|'month'|'year', periodRange(frame, offset, now) -> {from,to,label,buckets}
                      (builds on dates.ts isoWeek/weekRange)
src/server/
  nutrition/
    repo.ts           SQL only: dailyRows(userId|null, from, to), getGoals, setGoals
    routes.ts         registerNutritionRoutes(app, deps): GET /api/stats/nutrition, PUT /api/goals
    mcp.ts            registerNutritionTools(server, deps): get_daily_nutrition (moved), set_goals
  spend/
    repo.ts           expenseRows(from, to), categoryRows(from, to)   (+ move addExpense/lock/export here from domain.ts)
    routes.ts         registerSpendRoutes: existing /api/expenses/* + GET /api/stats/spend
    mcp.ts            registerSpendTools: add_expense, list_expenses, lock_expense_week (moved)
  routes.ts           shrinks to: auth middleware + registerXRoutes(app, deps) calls
  mcp.ts              shrinks to: server setup + registerXTools(server, deps) calls
src/web/ui/
  pages.ts            page stack (see §3)
  components/chart.ts barChart({ bars, goal?, stacked? }) -> inline SVG, ~60 lines, no dependency
  components/frame.ts frame selector: [Day|Week|Month] ‹ label ›
  nutrition/          screen pieces + actions for Me's nutrition cards and the goals subpage
  spend/              spend screen (moved from screens/spend.ts) + its actions
  settings/           settings index + one file per subpage (profile, household, notifications, siri, mcp, presets)
  actions.ts          merges feature action maps: { ...coreActions, ...nutritionActions, ...spendActions, ...settingsActions }
```

Why this split and not more:
- **SRP by reason-to-change**: SQL changes touch `repo.ts`; HTTP shape touches `routes.ts`; maths touches `shared/*.ts` (tested without DB or DOM, like `stock.ts` today).
- **Shared pure maths runs on both sides**: server for stats endpoints/MCP, client for offline-pending ops (same trick `computeDailyNutrition` already uses).
- **Move, don't rewrite**: existing expense/nutrition code moves into the new modules in a first refactor commit with zero behaviour change; tests stay green.
- **`State` stays the offline snapshot** (last 30/90 days). Anything wider is a **read-only stats endpoint** fetched on demand and cached in `ui`, never added to `State` (keeps `/api/state` small and polling cheap).

## 3. Navigation: a page stack

- `ui.page: string[]` (e.g. `['settings', 'settings/mcp']`). Empty = show the tab.
- `actions.go(el)` pushes `data-p`, `actions.back()` pops; both call `history.pushState/back` so iOS swipe-back and Android back work; `popstate` pops.
- `render.ts`: if `ui.page.length` render `PAGES[top]({st, ui})` with a header `‹ Back  Title`, else the tab. Tab bar stays visible.
- A page is just `(v: V) => Html` registered in `PAGES` — same contract as screens and sheets.

## 4. Data model changes (one migration step, `user_version` 3 (2 was already taken by the fat columns))

```sql
ALTER TABLE items        ADD COLUMN carbs_per_unit REAL;
ALTER TABLE event_lines  ADD COLUMN carbs_g REAL;
ALTER TABLE barcodes     ADD COLUMN carbs_per_unit REAL;
ALTER TABLE users        ADD COLUMN goal_kcal REAL;      -- NULL = no goal
ALTER TABLE users        ADD COLUMN goal_protein_g REAL;
ALTER TABLE users        ADD COLUMN goal_fat_g REAL;
ALTER TABLE users        ADD COLUMN goal_carbs_g REAL;
ALTER TABLE items        ADD COLUMN cost_per_unit_cents REAL;  -- last known price per item unit, NULL = unknown
ALTER TABLE event_lines  ADD COLUMN value_cents INTEGER;       -- eat lines: snapshot of qty × item price
```
All via the existing `addCol` helper in `db.ts:migrate()`.

- **Carbs** flow through every place protein/fat do: item form, barcode (OpenFoodFacts `carbohydrates_100g`), AI prompt schema, cook batch, `snapshotLineNutrition`, MCP item tools. Old rows stay NULL = "unknown", never 0; the UI shows "—" for an unknown carbs total rather than a wrong number.
- **Goals** are columns on `users` (one row per user, same lifecycle as `notify_*`); the reviewer argued a separate table buys nothing at this size and I agree. `State.me` carries them (needed offline).
- **Item price** works the way nutrition already does: a per-unit rate on the item, snapshotted onto each eat line.
  - *Learned*: a buy line that has `cost_cents` sets `items.cost_per_unit_cents = cost_cents / qty`, in the same place `applyPurchasedLineMeta` updates expiry. The last price wins. That's the simplest rule, and an average can come later.
  - *Manual*: an editable field in the item form and on the MCP `create_item` / `update_item` tools. This covers expenses that have no lines.
  - *Snapshot*: when the eat line is stored, `snapshotLineNutrition` also writes `value_cents = round(qty × cost_per_unit_cents)`, so a later price change doesn't rewrite history.
  - *Cooked meals*: `applyCookBatch` gives the meal item a price from the sum of its ingredient prices divided by the portions, the same way it already does for kcal.
  - `value_cents` is a separate column from `cost_cents` on purpose. `cost_cents` means "money paid", `value_cents` means "value consumed", and mixing them would break rule 2.
- The stats-range index (`events(kind, at)`) waits until the stats endpoints (phase 4) exist.

## 5. Correctness rules every new query/view must follow

1. **Nutrition filter**: `kind='eat' AND counts_nutrition=1 AND undone_at IS NULL AND is_set=0`. Cook events log ingredients with `counts_nutrition=0` and the meal as its own line; dropping the filter double-counts. Lift it into one `nutritionRows()` in `server/nutrition/repo.ts`, used by State, stats and MCP.
2. **Spending truth is `events.cost_cents`**, never the sum of line costs (lines can be missing, AI `total_cost` can differ, `addExpense` has no lines). This is also why the category breakdown is deferred.
3. **Day buckets come from the server** (`isoDate` in server TZ `Europe/Copenhagen`). The client uses `daily_nutrition[].day` strings and the same `isoDate` for pending ops; never recompute days in the phone's zone.
4. **Rolling windows**: State holds `now-30d` nutrition / `now-90d` expenses. A "month" frame whose start is older than the window is labelled partial (or fetched from the stats endpoint once phase 4 lands).
5. **Goals are optional**: null goal = no bar target; over-goal is shown, not clamped. Items with no nutrition are skipped, so add a small "n items without kcal" hint on Today so the number isn't silently low.
6. **MCP user identity**: once per-user MCP tokens exist, the token's `user_id` wins over any `user_id` tool argument (today `resolveUserId` falls back to a default user, so one roommate could log for the other).
7. Undo inside a locked week is already rejected (`undoEvent` → `assertPeriodUnlocked`), so locked totals and charts can't drift. Keep it that way for any new mutation.

## 6. Features

Reviewed by an independent subagent against the code; its verdicts are folded in. Where I overrode it, it says so.

### Kept (this plan)

**Nutrition, in Me**
| # | Feature | Data source | Notes |
| --- | --- | --- | --- |
| N1 | **Carbs** as 4th macro | new columns (§4) | Confirmed by you. Mechanical: follow every `fat_per_unit`/`fat_g`. |
| N2 | **Goals** per user (kcal, P, F, C), edited in Settings → Nutrition goals | `users.goal_*` | all optional |
| N3 | **Today card** at top of Me: kcal bar vs goal + 4 thin macro bars | `daily_nutrition` + pending ops via `computeDailyNutrition` | UI only |
| N4 | **Frame selector** Week / Month with ‹ › | `shared/period.ts` | Day = N3, so no Day frame |
| N5 | **kcal bar chart** for the frame, dashed goal line | same | `components/chart.ts` |
| N6 | **Averages** for the frame (kcal, P, F, C) | same | average over *logged* days, show "x of y days logged" |
| N7 | **Logged-days count / streak** | `daily_nutrition` days | one line under the chart |

**Spending, in Spend tab**
| # | Feature | Data source | Notes |
| --- | --- | --- | --- |
| S1 | **Frame selector** Week / Month with ‹ › (same component as N4) | `expenses` (90d) | replaces the endless list of weeks; the week list stays as the "Week" view's body |
| S2 | **Bar chart stacked by user** for the frame (days in a week, weeks in a month) | `expenses[].user_id/cost_cents` | same `chart.ts` |
| S3 | **Per-user totals + share %** for the frame (household total on top) | existing per-user subtotals | "in general and for each user" |
| S4 | **"Me" filter** (All / Mine) like History's toggle | `user_id` | per-user drill-down without a new page |
| S5 | **Item price** (learned from priced buys, editable) | `items.cost_per_unit_cents` | shown in the item sheet; this is the base for S6 |
| S6 | **Paid vs ate** per user for the frame: "🙂 paid 420 kr · ate 310 kr" | `events.cost_cents` (paid) vs eat `event_lines.value_cents` (ate) | eaten value is a lower bound: items without a price are counted and shown as "n items unpriced" |

**Settings (gear ⚙︎ top-right of Me)**
| Page | Contents (moved from Me unless noted) |
| --- | --- |
| Settings (root) | list rows → subpages; build id and Sign out at the bottom |
| Profile | name, emoji, notifications toggles + push enable/test |
| Nutrition goals | **new**: 4 number fields |
| Household | currency, guest code |
| Presets | preset list + edit (sheets unchanged) |
| Siri Shortcut | token create/revoke + the two shortcut texts (`shortcuts.ts`) |
| MCP | **new**: per-user token with `mcp` scope, copyable connector URL `…/mcp/<token>`, short how-to for claude.ai / Claude Code. Server: accept `api_tokens` with scope `mcp` in the `/mcp/:token?` auth **alongside** `MCP_SECRET`, which keeps working unchanged (your call). A per-user token binds tools to its user (rule 6). The global secret keeps today's behaviour: `user_id` argument, otherwise the default user. |

Me after the move: Today card → frame selector → chart → averages. Nothing else.

### Deferred (good, but not "a base")
- **Stats endpoints** `/api/stats/{nutrition,spend}` for history beyond 30/90 days, plus Year frame. Only needed when someone looks further back.
- **Top foods by kcal** in a frame: needs line-level data, not in State.
- **Spend by category**: blocked by rule 2 (lineless expenses → big "uncategorized" bucket).
- **Settle up / who owes whom**: S6 provides the numbers (paid − ate). What's still missing is the "settled" state, which the week lock doesn't record. Next step after S6.
- **Price history per item / cost per kcal**: S5 keeps only the latest price. A history view would read the priced buy lines.

### Cut
- **Monthly budget**: a new setting and UI for two people; the chart already shows the trend.
- **Weight log**: different domain, new table, no input path today.

## 7. Phases (each is one PR, tests green, deployable alone)

1. **Refactor only, no behaviour change.**
   Page stack (§3) + Settings pages moved out of `me.ts`; split `actions.ts` into feature maps; move nutrition maths to `shared/nutrition.ts` and expense code to `server/spend/*`; split `mcp.ts` tool registration per feature; `registerXRoutes` in `routes.ts`. `tests/web.test.ts` snapshot of Me/Spend updated, everything else untouched.
2. **Nutrition base**: migration (carbs + goals + item price columns), carbs through items/barcode/AI/cook/MCP, Goals page, Today card. Tests: `shared/nutrition.ts` (carbs null-vs-0, goal maths), migration on a v1 DB fixture, cook-event no-double-count.
3. **Item price**: learn the price on buy, item form field, MCP fields, snapshot `value_cents` on eat, cook meal price. Tests: a priced buy sets the rate; an unpriced buy keeps the old rate; eating snapshots the value; changing the price later doesn't change past lines; a cooked meal's price per portion.
4. **Frames + charts**: `shared/period.ts`, `components/frame.ts`, `components/chart.ts`; Me trend (N4–N7) and Spend (S1–S4, S6). Tests: `periodRange` (ISO week across year end, month edges, partial window), chart SVG output for empty / single / stacked.
5. **MCP page + per-user MCP tokens** (independent of 2–4; `MCP_SECRET` stays).
6. *(later)* deferred items as needed: settle up first, then stats endpoints.

## 8. Decisions (2026-11-17)
- Carbs: **in**, phase 2.
- Spend per user = **who paid**; items carry a price so **who ate** can be valued too (S5, S6).
- `MCP_SECRET`: **kept working** alongside per-user tokens.

