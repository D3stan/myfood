# Eat out: count kcal/macros without adding food to the pantry

## Goal
"Had a pizza at Gino's", "kebab after the gym", "dinner at my mum's": count an **estimated** kcal and
macros in the day's nutrition, show it in history as a 🃏 **jolly** line, and create **no pantry item**,
no stock, no low-stock push, no shopping or deals noise.

- AI first: say it in the normal "Tell me" box (or Siri, or MCP). The AI spots the eat-out and estimates it.
- Manual fallback: one quiet link, not a new tab or button on the main screens.

## Key decision: reuse events, back them with one hidden "jolly" item

Eat-outs are ordinary `eat` events. That gives us undo, edit, history, offline sync (cid / pending ops),
per-user totals, goals and charts at no extra cost.

`event_lines.item_id` is `NOT NULL` with a FK, so every line still needs an item. We add **one** system item,
the jolly:

| field | value | why |
|---|---|---|
| name / emoji | `Eat out` / 🃏 | what history shows |
| `name_key` | `__jolly__` | `nameKey()` never makes this, so AI "new item" or cooking name matches can't hit it or un-archive it (jobs.ts:176, cooking/repo.ts:159, items/repo.ts:24) |
| `unit` / `step` | `portion` / 1 | qty is always 1 |
| `owner_id` | NULL | one shared jolly; per-person totals come from `events.user_id` |
| `archived_at` | set at creation | every existing `archived_at IS NULL` filter hides it: pantry/state, AI catalog, aliases, push low/expiry, deals matcher and plan, guest, barcodes, Siri cooked list, name lookups |

The line carries the numbers: `kcal`, `protein_g`, `fat_g`, `carbs_g` (columns already exist), plus
`value_cents = 0` so the day doesn't get an "unpriced" warning. `events.note` holds the description
("Pizza margherita, Gino's"). `eventLineNutrition` (src/shared/nutrition.ts:14) already prefers line
values over item rates, and `dailyNutrition` (src/server/nutrition/repo.ts) already sums them. **No change to
the nutrition math.**

Its stock goes negative. Nobody sees it, since the item is archived, so leave it.

Rejected:
- Nullable `item_id`: a table rebuild plus every join, `computeStock` and the client replay. Too wide.
- Its own `eat_out` table: re-builds undo, edit, sync and history merging for nothing.
- An `is_jolly` column: ~18 server files query `items`. Archiving gives the same filtering with zero edits there.

## Steps

### 1. Jolly item (server)
- `db.ts`: after migrations, `ensureJolly(db)` inserts the row if no `name_key = '__jolly__'` exists. Idempotent.
- `jollyId(db)` helper next to it, used by steps 2–4.
- `domain.ts:24` `unitOf`: also accept the jolly id. It rejects archived items today, so without this
  logging an eat-out fails validation. Only eat lines may use it: reject buy/adjust on the jolly.
- `state.ts`: add `jolly_id` to `State`. The item itself stays out of `st.items`.

### 2. AI path (the main way)
- `shared/types.ts`: `AiEatOut = { note: string ≤80, kcal, protein_g, fat_g, carbs_g (nullable) }`,
  plus `eat_out: z.array(AiEatOut).max(6).optional()` on `AiResult`. It mirrors `cook`.
- `ai/prompt.ts` rule: *"Food eaten away from the pantry (restaurant, takeaway, canteen, at a friend's,
  'ate out'), or a dish not made from catalog items → eat_out[], never new_item or eat lines. Estimate a
  normal portion; use what the message says about size."* Add one example to `tests/ai.test.ts`.
- `jobs.ts` `applyProposalToDb`: each `eat_out` entry becomes one `eat` event, `source 'ai'`, note set,
  a single jolly line with qty 1 and the macros. `validateProposal`: clamp to sane ranges (kcal 0–5000).
- `components/compose.ts` `reviewSheet`: an "Eat out" block like the cooked block, with 🃏, the note,
  an **editable kcal** input (macros shown small) and ×. "Add to pantry" stays and applies everything.
- Siri: `runShortcutAi` goes through the same apply path. Check that it does; if so it works for free.

### 3. Manual path (no UI pollution)
- In the "Tell me" sheet (non-audit mode only) add a small text link under Send: **"Ate out? Enter it
  by hand"**. It opens a tiny sheet: description, kcal (required), P/F/C (optional, collapsed). Save
  posts a normal eat event through the existing `log`/pending-ops path with the jolly line.
- Editing later: history → edit event shows the same fields for jolly lines (check `edit_event` keeps
  line kcal/macros; extend `EventBody` lines if it drops them).
- Not adding: a FAB, a pantry tile, presets for eat-outs, or a "favourite restaurants" list.

### 4. MCP (Claude does the work from chat)
- `nutrition/mcp.ts`: `log_eat_out({ note, kcal, protein_g?, fat_g?, carbs_g?, at? })`, a thin wrapper over
  the step-3 server function. The tool description tells the model to estimate and to leave the pantry alone.
- `log_event` / `create_item` descriptions get one line: "for restaurant/takeaway food use log_eat_out".

### 5. Display
- `screens/history.ts`: a line whose `item_id === st.jolly_id` renders `🃏 Eat out · <note> · ~850 kcal`
  with a small `estimate` tag. The `~` and the tag mark it as a guess.
- Nutrition cards and charts: nothing to do, they already read line macros.
- `demo.ts`: give the fake state a `jolly_id` and one sample eat-out so the demo and tour show it.

### 6. Tests (one file, `tests/eat-out.test.ts`)
- `ensureJolly` twice → one row; it doesn't appear in state items, the AI catalog or `nameKey` matching.
- An AI result with `eat_out` → one eat event; `dailyNutrition` includes its kcal; `unpriced` stays 0.
- An AI new item called "Eat out" does **not** un-archive or reuse the jolly.
- Buy/adjust on the jolly is rejected. Undo removes it from the day's totals.

## Order and size
1 → 2 → 5 is a shippable slice (AI only). 3 and 4 follow, small and independent.
Roughly: server ~120 lines, web ~80, prompt +1 rule, 1 test file. No schema change, no new table, one seed row.

## Open questions
- Optional money: record what the meal cost as an expense in the same step? Proposal: not now.
  `add_expense` already exists, and the AI could emit both later.
- Should eat-outs be personal-only, never split? They already are, through `events.user_id`.
