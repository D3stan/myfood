# MyFood — plan

A shared pantry for two roommates. Photograph a receipt (Danish is fine) or type
"had breakfast" and the stock updates. Runs on the homelab, opens from the iPhone
home screen.

Status: v2, revised after an independent review on 2026-11-15. Section 13 lists what
the review changed.

## 1. What the user asked for

- Receipt photo or screenshot (often Danish) → AI adds the food to a catalog.
- Tell the AI what was eaten or bought in plain words, or change quantities by hand.
- "I made breakfast with this and this" is applied automatically and can be changed later.
- Things counted in the unit they are eaten in: eggs by piece, cheese and bacon by
  slice (fractions allowed: 1.5 slices), pasta and minced meat by weight, spices
  without counting grams.
- A default amount when taking something (breakfast = 2 bacon, 1.5 cheese, 3 eggs, 3 bread).
- Two users (roommate), light authentication.
- TypeScript, a database, an AI workflow that runs through the `agy` CLI
  (Antigravity) on the user's subscription. The user only authenticates `agy` at the end.
- Own VM on the homelab, public through a Cloudflare tunnel on a subdomain.
- Web app that installs to the iPhone home screen, fast to open, works from local storage.
- UI: minimal, cartoonish, in the style of `/Users/puddu/Documents/GitHub/fit-or-pivot`.
- Few features, but suggest more.

Assumption to confirm with the user: "AGI harness" was dictation for `agy`
(installed on the Mac, version 1.5.9, verified working headless).

## 2. Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node 26, TypeScript run directly by Node (type stripping) | No server build step; same major as the Mac |
| Server | Hono + zod | Routing, cookies, static files, validation |
| Database | SQLite through `node:sqlite` | Built in, one file, two users |
| Frontend | Vite + vanilla TypeScript, screens return HTML through an auto-escaping `html` tag, `idiomorph` patches the DOM | fit-or-pivot's pattern; morphing keeps focus, scroll and CSS transitions |
| PWA | `vite-plugin-pwa` (precached shell), manifest, iOS meta tags | Home-screen install, instant open |
| Styling | fit-or-pivot tokens: paper background, ink borders, hard offset shadows, Patrick Hand + Permanent Marker, self-hosted | The style the user pointed at |
| AI | `agy -p` with `--json-schema`, run as its own unix user, one call per job, the model only returns JSON | The model can read the job folder and nothing else |
| Tests | Vitest | Same as fit-or-pivot |
| Hosting | VM 101 `myfood`, 192.168.2.32, systemd, own Cloudflare tunnel, `food.0xpuddu.com` | Isolated from Dokploy |

One package:

```
src/shared/     types.ts (zod contract), stock.ts (pure stock maths), text.ts (alias + number parsing)
src/server/     main.ts, db.ts, schema.sql, auth.ts, routes.ts, domain.ts, jobs.ts
src/server/ai/  agy.ts (runAi), prompt.ts, schema.json
src/web/        index.html, main.ts, store.ts, api.ts, outbox.ts, html.ts,
                ui/{render,events}.ts, ui/screens/*, ui/components/*, styles/*, public/
tests/          stock.test.ts, domain.test.ts, auth.test.ts, ai.test.ts, web.test.ts
scripts/        deploy.sh, backup.sh, seed.ts, fake-agy.mjs, run-agy.sh
deploy/         systemd units, sudoers line, nftables rule
```

Rules for all code: `.ts` extensions on relative imports, `import type` for types,
no enums or namespaces (Node strips types, it does not compile).

## 3. Data model

Stock is never stored. It is computed from the events that are not undone, by one
pure function in `src/shared/stock.ts` that both server and web use.

```sql
users(id, name UNIQUE, emoji, code_hash UNIQUE, created_at)
sessions(token_hash PRIMARY KEY, user_id, created_at, last_seen_at)
items(id, name, name_key UNIQUE, emoji, category, unit, step, pack_size, low_at, archived_at, created_at)
aliases(text PRIMARY KEY, item_id)        -- normalised receipt line → item
events(cid PRIMARY KEY, seq, user_id, at, kind, source, note, preset_id, job_id, undone_at)
event_lines(event_cid, item_id, qty, is_set)
presets(id, user_id, name, emoji, hour)
preset_lines(preset_id, item_id, qty)
jobs(id, user_id, text, images, status, result, error, created_at, finished_at)
meta(key PRIMARY KEY, value)              -- rev counter
```

- `unit`: `pc`, `slice`, `g`, `ml`, `level`.
- `step`: what one tap of the stepper changes (0.5 for slices, 1 for eggs, 50 for grams).
- `pack_size`: units in one bought pack (bacon 8 slices, eggs 10, pasta 1000 g).
- `name_key`: lower-cased, trimmed name. Unique, so the AI cannot add "Eggs" next to "eggs".
- Events are keyed by `cid`, an id the client generates. A retry or an offline replay
  of the same event is a no-op that returns the current state. `seq` orders events
  that share a millisecond.
- A line stores what the user said. `qty` is signed for `buy` (+) and `eat` (−) and is
  never clamped. For `adjust`, and for every line on a `level` item, `is_set = 1` and
  `qty` is the absolute amount.
- Stock of an item = the `qty` of its latest set line, plus every later signed line
  (or all signed lines if there is no set). The result is floored at 0 for display
  only. So logging breakfast before the receipt still ends at the right number, and
  editing or undoing an old event cannot change the meaning of a later "set to 6".
- `level` items (spices, oil, salt): 1, 0.5, 0.25 or 0, shown as full / half / low /
  out. Buying sets full.
- `rev`: bumped on every mutation and returned with every state.

| Food | Unit | Step | Pack |
| --- | --- | --- | --- |
| Eggs | pc | 1 | 10 |
| Cheese, bacon, bread | slice | 0.5 | AI estimate, editable |
| Pasta, minced meat | g | 50 | 500 / 1000 ("half the pack" → the AI converts to grams) |
| Spices | level | — | — |

## 4. Defaults when taking food

Both per user:

1. Usual amount: the stepper opens on the amount this user took last time for that
   item. Each pantry card has a one-tap "take my usual" button.
2. Meal presets: "Breakfast" = 2 bacon, 1.5 cheese, 3 eggs, 3 bread. One tap logs it;
   tapping the card body opens steppers first. A preset has a typical hour (set when
   created, editable). The preset nearest to now (within 3 hours, not logged yet
   today) is the hero card at the top of the pantry. Any logged event can be saved
   as a preset.

The AI sees the user's presets, so "made breakfast but only 2 eggs" works.

## 5. AI workflow

`runAi(input) → AiResult` in `src/server/ai/agy.ts` is the only code that knows about `agy`.

- Input: the user's text, image paths, and context built by `prompt.ts`: items
  (id, name, unit, pack size; stock only for text jobs), the user's presets, and for
  receipts the known aliases.
- It spawns the command in `AI_CMD` with an argument array (never a shell string),
  `cwd` set to the job folder, a hard timeout that kills the process group, and
  parses `structured_output`.
- Production: `AI_CMD` is `sudo -n -u agy /usr/local/bin/run-agy`. The `agy` user owns
  the Antigravity login and can read only `/var/lib/myfood/jobs`. The database is
  mode 600 and owned by `myfood`. An nftables rule stops the `agy` user from reaching
  the home LAN.
- Tests and local development: `AI_CMD` points at `scripts/fake-agy.mjs`.

Output, validated with zod before anything is applied:

```json
{ "reply": "Logged breakfast.",
  "events": [ { "kind": "eat", "preset_id": 1,
      "lines": [ { "item_id": 4, "new_item": null, "qty": 3, "raw": null } ] } ] }
```

- Text only, all items known: applied at once. The app shows what changed with Undo,
  and the event can be edited in History.
- Any image, or any line with `new_item`: the job stops at `review`. A sheet lists the
  lines (editable, removable, re-matchable to an existing item) and one button applies
  them. Applying is one transaction and a repeat returns the state, so a double tap
  cannot double a purchase. Confirming stores `raw` → item as an alias.
- Receipt images are deleted once the job is applied, dismissed or failed.
- Two lanes: one job with images at a time, and one text job at a time, so "ate 2
  eggs" does not wait behind a receipt. At most 3 unfinished jobs per user.
- Unfinished jobs and proposals waiting for review are part of `/api/state`, so they
  survive the phone suspending the app.
- If `agy` fails or is not logged in the job fails with a readable message and
  everything manual still works. `/api/health` and `state.ai.ready` report the result
  of the last job; they never start one.

Verified on the Mac: headless `agy` returns `structured_output` matching the schema;
a fake REMA 1000 receipt was parsed correctly. To settle in the AI work package: why
a folder-scoped `read_file` rule was denied (only `read_file(*)` worked), and the 104 s
run time. Target: under 30 s for a receipt, under 10 s for text.

## 6. API

JSON under `/api`, session cookie. Every mutation returns the full state.
Errors are `{ "error": "message" }` with 400, 401, 404, 409 or 429.

```
POST   /api/login            { code }                 → State
POST   /api/logout
GET    /api/state            → State
POST   /api/events           EventBody                → State   (same cid again = 200, no change)
PATCH  /api/events/:cid      { lines }                → State
DELETE /api/events/:cid      undo                     → State
POST   /api/items            ItemBody                 → State
PATCH  /api/items/:id        ItemPatch                → State
DELETE /api/items/:id        archive                  → State
POST   /api/presets          PresetBody               → State
PATCH  /api/presets/:id      PresetBody               → State
DELETE /api/presets/:id                               → State
POST   /api/jobs             multipart: text, images  → State
POST   /api/jobs/:id/apply   { events }               → State
DELETE /api/jobs/:id         dismiss                  → State
PATCH  /api/me               { name?, emoji? }        → State
GET    /api/health           → { ok, build, ai }
```

State: `{ rev, build, now, me, users, items[+stock], presets, usual, events (last 100), jobs, ai }`.

## 7. Authentication and security

- One household, no sign-up. `scripts/seed.ts` creates the two users and prints a
  random access code for each (`xxxx-xxxx-xxxx`, about 60 bits). The code is typed
  once; it both identifies and authenticates. Stored as SHA-256. A new code can be issued with `node scripts/seed.ts --rotate <name>` or from Settings → Profile; the old code and sessions stop working.
- Session token: 32 random bytes, stored hashed, cookie `HttpOnly; Secure;
  SameSite=Lax`, one year, renewed on use.
- Login throttle: 5 failures per minute per client, keyed on `CF-Connecting-IP`
  (the server only listens on localhost, so that header comes from Cloudflare), plus
  a Cloudflare rate-limit rule on `/api/login`. No global lock-out.
- Mutating requests must carry the header `X-MyFood: 1`.
- Uploads: JPEG, PNG or WebP, 8 MB each, four per job, random names, in the job
  folder, never served back.
- All HTML is built with the `html` tagged template in `src/web/html.ts`, which
  escapes every interpolated value unless it is itself an `html` result. Item names
  come from receipts, the AI and the other user. A Content-Security-Policy header
  (`default-src 'self'; frame-ancestors 'none'`, inline styles allowed) backs it up.
- The server listens on 127.0.0.1 only. The tunnel is the only way in.
- AI output is data: known item ids, 0 ≤ qty ≤ 100000, at most 60 lines.

## 8. Frontend

Three tabs and a composer.

- Pantry: hero preset, other presets as chips, search, a "Running low" strip with a
  share button (`navigator.share`, a plain-text shopping list), then items by
  category. A card shows emoji, name and stock. The round button takes your usual;
  tapping the card opens a sheet with a stepper, Eat, Add a pack, set exact amount,
  and the item's settings.
- History: by day, who did what. Tap an event to change quantities, undo it, or save
  it as a preset.
- Me: name, emoji, presets, install hint, sign out.
- Composer: a bar above the tab bar that looks like a text field. Tapping it opens a
  sheet anchored to the top of the screen with the text field and a photo button, so
  the iOS keyboard never covers the field. Jobs in progress and proposals show as
  cards at the top of the pantry.
- Every change shows a toast with Undo.

How it stays fast and correct:

- The shell is precached; the last state is kept in `localStorage` and rendered
  before the network answers.
- What is on screen is always `applyOps(serverState, pendingOps)`. A server response
  with a lower `rev` than the one held is dropped. Pending operations stay applied
  until the server confirms them.
- The outbox (in `localStorage`) holds only two kinds of operation: create an event
  on existing items, and undo an event. Both are idempotent by `cid`. Everything
  else is disabled while offline.
- State refreshes on focus and every 30 seconds while visible.
- `build` in the state differs from the running bundle → update the service worker
  and reload when no sheet is open. `/api/*` is never cached.
- Sheets are one persistent node moved with a CSS transform. No View Transitions.
- `viewport-fit=cover` and safe-area padding, standalone display, theme colour of the
  paper, apple-touch-icon, no tap highlight, 19 px inputs (no focus zoom), 44 px
  targets, `touch-action: manipulation`, `overscroll-behavior` contained in sheets,
  reduced motion respected, no `:hover` styles outside `@media (hover:hover)`.
- Number fields accept "1,5" as well as "1.5".
- Photo input has no `capture` attribute, so screenshots can be picked too. Photos
  are scaled to 1600 px JPEG in the browser before upload.
- Sign in inside the installed app (iOS gives it separate storage from Safari).

## 9. Features

In the first version:

1. Usual amount per person and item.
2. Meal presets with a time-aware hero card, and "save as preset" from history.
3. Undo and editable history for every change, with who did it.
4. Receipt memory (aliases).
5. Running-low list that shares as a shopping list.
6. Level tracking for spices and other things nobody measures.
7. Offline outbox for logging and undo.

Suggested for later, not built:

- Fridge audit: photograph the open fridge, the AI proposes corrections.
- "What can I cook" from what is in stock.
- Expiry estimates and an "eat soon" strip.
- Push notifications when something runs low (works for installed web apps on iOS).
- Cost split between roommates from receipt prices.
- Mine / shared flag on items.
- A Siri Shortcut that posts "log breakfast" to the API.
- Barcode scan for things bought without a receipt.
- Protein and calorie totals per day.
- Presets that learn their hour from use.
- Native app (Expo) once there is an Apple developer account.

## 10. Infrastructure

Follows the homelab Agent Protocol: Changelog entry before and after (R6), state
read back as evidence (R7), Config tabs updated (R10), no secrets in the doc (R17).

1. Changelog entry, status in-progress. Done 2026-11-15 09:15 UTC.
2. VM 101 `myfood`: Debian 13 cloud image (SHA512 verified), 2 vCPU, 4 GiB RAM,
   16 GiB on local-lvm, vmbr0, 192.168.2.32/24, start on boot, guest agent,
   cloud-init user `myfood` with the Mac's SSH key. Done. Rollback: destroy VM 101.
3. In the VM: Node 26, `cloudflared` from Cloudflare's apt repository, `sqlite3`,
   time zone Europe/Copenhagen, a second unix user `agy` with the Antigravity CLI.
4. Spike before the build fans out: can a systemd service use an `agy` login made
   over SSH? If the login lives in a session keyring, give the `agy` user a
   lingering user session with its own D-Bus and keyring, and have `run-agy` join it.
5. Cloudflare: new tunnel `MYFOOD`, ingress `food.0xpuddu.com` → `http://localhost:3000`,
   proxied CNAME, one rate-limit rule for `/api/login`. Existing tunnels are untouched.
6. `scripts/deploy.sh`: build on the Mac, rsync `dist/`, `src/`, `package*.json` to
   `/opt/myfood`, `npm ci --omit=dev`, restart `myfood.service`.
7. Data in `/var/lib/myfood` (database, job folders). Nightly `sqlite3 .backup` kept
   for 14 days. This is on the same disk, so it protects against a bad change, not a
   dead disk. An off-node copy waits for the lab's backup decision (homelab Backlog).
8. Seed the two users; give the access codes to the user in chat only.
9. The one step left for the user: log `agy` in on the VM (exact command in the hand-off).
10. Update Guests, Network, Services and Access; close the Changelog entry.

## 11. Build order

1. Orchestrator freezes the contract: `src/shared/*` with tests, `schema.sql`,
   `package.json`, configs, base CSS, a fixture state, the `runAi` signature.
2. In parallel, Sonnet agents, each owning its own files and running only its own tests:
   - server: `src/server/*` except `ai/`, `scripts/seed.ts`, `tests/domain.test.ts`, `tests/auth.test.ts`;
   - AI: `src/server/ai/*`, `scripts/fake-agy.mjs`, `scripts/run-agy.sh`, `tests/ai.test.ts`, timing and permission tuning against real `agy`;
   - web: `src/web/*`, `tests/web.test.ts`;
   - the orchestrator sets up the VM, the tunnel and `deploy/`.
3. Orchestrator: integrate, run locally, drive the app in a phone-sized browser, fix.
4. Deploy, check the public URL with the fake AI, then hand over for the `agy` login.

## 12. Tests

- Stock: sets and deltas, undo, out-of-order logging, level items, floor at 0.
- Domain: idempotent `cid`, edit, usual amount, presets, unique item names.
- Auth: login, throttle, session renewal, the header check.
- AI: schema validation, new items go to review, unknown item ids rejected, proposal →
  apply once → aliases, timeouts and failures, a prompt-injection sample, all with the fake CLI.
- Web: `html` escaping with hostile names, `applyOps`, stale `rev` dropped, outbox replay.
- Manual: the breakfast flow and a receipt on a real iPhone after deployment.

## 13. What the review changed

| Finding | Change |
| --- | --- |
| `agy` login may not be visible to a systemd service | Spike on the VM first (10.4) |
| `read_file(*)` exposed the database and credentials to the model | Separate `agy` unix user, database mode 600, LAN blocked for that user |
| Six-digit PIN was guessable and the global lock-out was a denial of service | 60-bit access code, throttle per real client IP, Cloudflare rule, no lock-out, no PIN change |
| Clamping and difference-based `adjust` made stock depend on logging order | Store what was said, absolute sets, one shared fold |
| Poll responses overwrote optimistic changes | `rev`, `applyOps(server, pending)`, `cid` as the event key |
| 104 s per receipt on a single queue | Two lanes, jobs in state, longer timeout with process-group kill, tuning target |
| Receipt apply could run twice | One transaction, repeat is a no-op |
| Contract too thin for parallel agents | Orchestrator freezes shared code, tests and fixture first |
| `esc()` by convention | Auto-escaping `html` tag and a CSP; receipt images no longer served |
| Fixed bottom input under the iOS keyboard | Composer opens a top-anchored sheet |
| View Transitions drop fast taps | Removed; persistent sheet with CSS transform |
| Installed app keeps a stale shell for weeks | Build id in state triggers an update |
| AI could add near-duplicate items | New items always go to review; unique `name_key` |
| Health check could burn the subscription | Reports the last job only; job cap per user |
| Same-disk backup, flat LAN | Stated plainly; LAN blocked for the AI user; off-node copy left as a lab decision |
| Over-built | Cut: adaptive preset hour, mode-of-ten usual amount, PIN change, receipt thumbnails |

Not taken: turning on the Proxmox datacenter firewall (it would affect every guest
and is an open decision in the homelab Backlog; the nftables rule inside the VM
covers the AI user instead).
