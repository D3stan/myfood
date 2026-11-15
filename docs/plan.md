# MyFood — plan

A shared pantry for two roommates. Photograph a receipt (Danish is fine) or type
"had breakfast" and the stock updates. Runs on the homelab, opens from the iPhone
home screen.

Status: draft v1, before review.

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
| Runtime | Node 24, TypeScript run directly by Node (type stripping) | No server build step |
| Server | Hono + zod | Routing, cookies, static files, validation |
| Database | SQLite through `node:sqlite` | Built in, one file, two users |
| Frontend | Vite + vanilla TypeScript, screens return HTML strings, `idiomorph` to patch the DOM | Same pattern as fit-or-pivot; morphing keeps focus, scroll and CSS transitions |
| PWA | `vite-plugin-pwa` (precached shell), manifest, iOS meta tags | Home-screen install, instant open |
| Styling | fit-or-pivot tokens: paper background, ink borders, hard offset shadows, Patrick Hand + Permanent Marker (self-hosted) | The style the user pointed at |
| AI | `agy -p` with `--json-schema`, one call per job, the model only returns JSON | No tools for the model beyond reading the uploaded image |
| Tests | Vitest | Same as fit-or-pivot |
| Hosting | New VM 101 `myfood`, 192.168.2.32, systemd service, own Cloudflare tunnel, `food.0xpuddu.com` | Isolated from Dokploy; `agy` login lives in a normal home directory |

One package, no monorepo:

```
src/shared/     types.ts (zod schemas shared by server and web), stock.ts (pure helpers)
src/server/     main.ts, db.ts, schema.sql, auth.ts, routes.ts, domain.ts, jobs.ts, ai/agy.ts, ai/prompt.ts
src/web/        index.html, main.ts, store.ts, api.ts, outbox.ts, format.ts, ui/{render,events}.ts,
                ui/screens/*, ui/components/*, styles/{tokens,base,components}.css, public/ (icons)
tests/          domain.test.ts, auth.test.ts, ai.test.ts, web-store.test.ts
scripts/        deploy.sh, backup.sh, seed.ts, fake-agy.mjs
deploy/         myfood.service, myfood-backup.service, myfood-backup.timer
```

Dependencies: `hono`, `@hono/node-server`, `zod`, `idiomorph`. Dev: `vite`,
`vite-plugin-pwa`, `vitest`, `typescript`, `@fontsource/patrick-hand`,
`@fontsource/permanent-marker`.

## 3. Data model

Stock is never stored. It is the sum of the deltas of the events that are not undone.
That makes "change it later" and undo free, and there is no counter to drift.

```sql
users(id, name UNIQUE, emoji, pin_hash, created_at)
sessions(token_hash PRIMARY KEY, user_id, created_at, last_seen_at)
items(id, name, emoji, category, unit, step, pack_size, low_at, archived_at, created_at)
aliases(text PRIMARY KEY, item_id)            -- normalised receipt line → item
events(id, cid UNIQUE, user_id, at, kind, source, note, preset_id, job_id, undone_at)
event_lines(id, event_id, item_id, delta)     -- signed, in the item's unit
presets(id, user_id, name, emoji, hour)
preset_lines(preset_id, item_id, qty)
jobs(id, user_id, text, images, status, result, error, event_ids, created_at, finished_at)
```

- `unit`: `pc`, `slice`, `g`, `ml`, `level`.
- `step`: what one tap of the stepper changes (0.5 for slices, 1 for eggs, 50 for grams).
- `pack_size`: units in one bought pack (bacon 8 slices, eggs 10, pasta 1000 g). A
  receipt line "BACON I SKIVER ×2" becomes +16 slices.
- `level` items (spices, oil, salt): stock is 1, 0.5, 0.25 or 0 and shows as
  full / half / low / out. Buying sets it to full. Nobody counts grams of oregano.
- `kind`: `buy`, `eat`, `adjust` (set to an exact amount; stored as the difference).
- `source`: `manual`, `preset`, `ai`, `receipt`.
- `cid`: client-generated id, so a retried or offline-queued request is applied once.
- An `eat` line is clamped when written so stock does not go below zero. Display
  also clamps at zero (an undone purchase can leave a negative sum).

Edge cases from the brief, and how they land:

| Food | Unit | Step | Pack | Notes |
| --- | --- | --- | --- | --- |
| Eggs | pc | 1 | 10 | |
| Cheese, bacon, bread | slice | 0.5 | AI estimate, editable | 1.5 slices works |
| Pasta, minced meat | g | 50 | 500 / 1000 | "half the pack" → AI converts to grams |
| Spices | level | — | 1 | four-step bar, tap to set |

## 4. Defaults when taking food

Two mechanisms, both per user:

1. Usual amount. For each item the stepper opens on the amount this user takes
   most often (mode of their last 10 `eat` lines, most recent wins a tie). No setup.
   Each pantry card has a one-tap "take my usual" button.
2. Meal presets. "Breakfast" = 2 bacon, 1.5 cheese, 3 eggs, 3 bread. One tap logs
   it; the sheet shows steppers first if you tap the card body. A preset has a
   typical hour, moved toward the hour it is actually used. The preset closest to
   now (within 3 hours, not logged yet today) is the hero card at the top of the pantry.
   Any logged event can be saved as a preset.

The AI sees the user's presets, so "made breakfast but only 2 eggs" works.

## 5. AI workflow

One job type. Input: free text, zero to four images. The server builds a prompt with
the current items (id, name, unit, pack size, stock), the user's presets, known
receipt aliases, and the user's message, then runs:

```
agy -p "<prompt>" --output-format json --json-schema <schema> --print-timeout 120s \
    --model <AI_MODEL> --settings '{"permissions":{"allow":["read_file(<job dir>)"]}}'
```

Output, validated with zod before anything is applied:

```json
{ "reply": "Logged breakfast.",
  "events": [ { "kind": "eat", "preset_id": 1,
      "lines": [ { "item_id": 4, "new_item": null, "qty": 3, "raw": null } ] } ] }
```

`new_item` carries name, emoji, category, unit, step and pack size for food that is
not in the catalog yet. `qty` is positive and in the item's unit; for `adjust` it is
the target amount. `raw` is the receipt line text.

- Text only: applied at once. The app shows what changed with an Undo button, and
  the event can be edited in History.
- With an image: the result is a proposal. A review sheet lists the lines (editable,
  removable, re-matchable to an existing item) and one button adds them. Confirming
  stores each `raw` → item pair as an alias, so the next receipt matches by itself.
- Non-food lines (bag, deposit) are dropped by the prompt.
- Jobs run one at a time in the server process. The client polls the job. A job
  left `running` by a restart is marked failed.
- If `agy` fails or is not logged in, the job fails with a readable message and
  everything manual still works. `/api/health` reports whether the AI answered.
- `AI_CMD` can point at `scripts/fake-agy.mjs` for tests and local development.

Verified on the Mac on 2026-11-15: headless `agy` returns `structured_output` that
matches the schema; a fake REMA 1000 receipt was parsed correctly, duplicates merged,
slices estimated, bag and deposit flagged as non-food. Open points: the narrow
`read_file(<dir>)` rule was denied in two probes while `read_file(*)` worked; and
the run took 104 seconds with `gemini-3.8-flash-medium`, which needs tuning.

## 6. API

JSON under `/api`, session cookie. Every mutation returns the full state, so the
client has one code path: replace state, render.

```
POST   /api/login            { pin }                  → state
POST   /api/logout
GET    /api/state            → { me, users, items[+stock], presets, usual, events (last 100), ai }
POST   /api/events           { cid, kind, lines[{item_id, qty}], preset_id?, note? }
PATCH  /api/events/:id       { lines }
DELETE /api/events/:id       (undo)
POST   /api/items            PATCH /api/items/:id     DELETE /api/items/:id (archive)
POST   /api/presets          PATCH /api/presets/:id   DELETE /api/presets/:id
POST   /api/jobs             multipart: text, images  → { job }
GET    /api/jobs/:id         → { job, state? }
POST   /api/jobs/:id/apply   { events }               (receipt review)
PATCH  /api/me               { name?, emoji?, pin? }
GET    /api/uploads/:file    (receipt image, signed-in users only)
GET    /api/health
```

## 7. Authentication and security

- One household, no sign-up. Two users are seeded by `scripts/seed.ts`, each with a
  random six-digit PIN that also identifies them, so login is one field.
- PIN stored with scrypt. Session token: 32 random bytes, stored hashed, cookie
  `HttpOnly; Secure; SameSite=Lax`, one year, renewed on use.
- Login throttle: 5 failures per IP per minute, and 20 failures overall in 15
  minutes pause all logins for 15 minutes.
- Mutating requests must carry the header `X-MyFood: 1` (a cross-site form cannot set it).
- Uploads: JPEG, PNG or WebP, 8 MB each, random names, stored outside the web root.
- Every string that reaches `innerHTML` goes through `esc()`. Item names come from
  receipts, the AI and the other user.
- The server listens on 127.0.0.1 only. The tunnel is the only way in.
- The model has no command, network or write permission. Its output is data that
  is validated and bounded (known item ids, 0 < qty ≤ 100000, at most 60 lines).

## 8. Frontend

Three tabs and a composer that is always there.

- Pantry: hero preset, other presets as chips, search, a "Running low" strip with a
  share button (`navigator.share`, a plain-text shopping list), then items by
  category. A card shows emoji, name and stock. Tap the small button to take your
  usual; tap the card for a sheet with a stepper, Eat, Add a pack, set exact amount,
  and the item's settings.
- History: by day, who did what, with the receipt thumbnail when there is one. Tap
  an event to change quantities, undo it, or save it as a preset.
- Me: name, emoji, PIN, presets, install hint, sign out.
- Composer: a text field ("ate 2 eggs", "bought milk") and a camera button, above
  the tab bar. Results arrive as a card, receipts open the review sheet.
- Every change shows a toast with Undo.

What makes it feel native:

- Shell precached by the service worker; the last state is kept in `localStorage`
  and rendered before the network answers.
- Changes apply locally first. Requests that fail offline wait in an outbox in
  `localStorage` and are sent on reconnect, deduplicated by `cid`.
- State refreshes on focus and every 30 seconds while visible, which is how the two
  roommates stay in sync.
- View Transitions for sheets and tab changes, off under reduced motion.
- `viewport-fit=cover` with safe-area padding, standalone display, theme colour
  matching the paper, apple-touch-icon, no tap highlight, no zoom on input focus,
  no pull-to-refresh bounce inside sheets, 44 px touch targets.
- Photos are scaled to 1600 px JPEG in the browser before upload.

## 9. Features

Built in the first version, because they are cheap and each removes a daily step:

1. Usual amount per person and item.
2. Time-aware meal presets, and "save as preset" from history.
3. Undo and editable history for every change, with who did it.
4. Receipt memory (aliases).
5. Running-low list that shares as a shopping list.
6. Level tracking for spices and other things nobody measures.
7. Offline outbox.

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
- Native app (Expo) once there is an Apple developer account.

## 10. Infrastructure

Follows the homelab Agent Protocol: Changelog entry before and after (R6), state
read back as evidence (R7), Config tabs updated (R10), no secrets in the doc (R17).

1. Changelog entry, status in-progress.
2. VM 101 `myfood`: Debian 13 cloud image (checksum verified), 2 vCPU, 4 GiB RAM,
   16 GiB on local-lvm, vmbr0, 192.168.2.32/24, start on boot, guest agent,
   cloud-init user `myfood` with the Mac's SSH key. Rollback: stop and delete VM 101.
3. In the VM: Node 24, `agy` from the official install script, `cloudflared` from
   Cloudflare's apt repository, `sqlite3`, time zone Europe/Copenhagen.
4. Cloudflare: new tunnel `MYFOOD`, ingress `food.0xpuddu.com` → `http://localhost:3000`,
   proxied CNAME. Existing tunnels are not touched. Rollback: delete the DNS record and the tunnel.
5. `scripts/deploy.sh`: rsync to `/opt/myfood`, `npm ci`, `npm run build`, restart `myfood.service`.
6. Data in `/var/lib/myfood` (database, uploads, job folders). Nightly `sqlite3 .backup`
   kept for 14 days on the same disk; the lab has no second disk yet.
7. Seed the two users, hand the PINs to the user in chat.
8. The one step left for the user: `ssh -t myfood@192.168.2.32 agy`, open the URL
   it prints, paste the code back.
9. Update Guests, Network, Services and Access; close the Changelog entry.

Risk: `agy` keeps its login in the OS keyring, and a headless Debian VM has none.
Check on the VM what `agy` does without a keyring before the hand-off, and set up
`dbus` + `gnome-keyring` for the `myfood` user if needed, so the systemd service
can read the login.

## 11. Build order

1. Orchestrator: repository scaffold, `src/shared/types.ts`, `schema.sql`, this plan.
2. In parallel, Sonnet agents, each owning its own files:
   - server: database, domain, auth, routes, jobs, tests;
   - AI: `src/server/ai/*`, prompt, schema, fake CLI, timing and permission tuning against real `agy`;
   - web: the whole of `src/web`;
   - meanwhile the orchestrator builds the VM, the tunnel and the deploy files.
3. Orchestrator: integrate, run locally, drive the app in a phone-sized browser, fix.
4. Deploy, check the public URL end to end with the fake AI, then hand over for the `agy` login.

## 12. Tests

- Domain: stock from events, clamping, undo, edit, `adjust`, level items, usual amount, preset hour.
- Auth: login, throttle, session expiry, the header check.
- AI: schema validation, new items, unknown item ids rejected, receipt proposal → apply → aliases, failure paths, all with the fake CLI.
- Web store: local apply matches server stock, outbox replay, `esc()` on hostile names.
- Manual: the breakfast flow and a receipt on a real iPhone after deployment.
