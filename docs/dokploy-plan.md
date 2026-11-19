# MyFood — move to the homelab Dokploy, AI through a pluggable provider

Status: draft v3, 2026-11-19, revised with the user's feedback and checked against the
code by an independent review (fixes folded in). Nothing changed yet,
in the repo or in the lab.

## 1. Goal

- Run MyFood as a Docker app in the **homelab Dokploy** (VM 100, 192.168.2.31,
  MCP entry `dokploy-thinkcentre`), not as systemd units in its own VM 101.
- Make the AI step **provider-agnostic**: one module with two providers today —
  an **OpenAI-compatible HTTP API** (used on Dokploy) and the **`agy` CLI** (kept for
  local runs) — and room for a native Gemini API provider later.
- Final address: **`myfood.0xpuddu.com`** (tested there first, then kept).
- Backups: **Dokploy's own backup feature** to an R2 destination the user adds. No custom backup code.
- VM 101 is removed **one week** after the cut-over.

## 2. What exists today (read 2026-11-19)

| Thing | Where | Source |
|---|---|---|
| App | VM 101 (192.168.2.32), `myfood.service`, user `pantry`, `127.0.0.1:3000` | homelab doc, Services |
| Data | `/var/lib/myfood/myfood.db`, embedded SQLite (`node:sqlite`, WAL mode) | `src/server/db.ts`, `schema.sql:3` |
| AI | `agy` via `sudo -u agy run-agy`; never worked in prod (not installed / not signed in) | homelab Changelog 2026-11-15 |
| Ingress | tunnel `MYFOOD` (cloudflared.service in VM 101) → `localhost:3000`, host `food.0xpuddu.com` | `deploy/cloudflared.service` |
| Backups | `myfood-backup.timer`, `sqlite3 .backup` + R2 upload (R2 token never added) | `scripts/backup.sh`, `backup-r2.mjs` |
| Homelab Dokploy | projects `cloudflare` (app `tunnel`) and `Turing Council`; no `myfood` project | `dokploy-thinkcentre` project.all |
| `myfood.0xpuddu.com` | DNS record and VPS tunnel rule deleted 2026-11-15, so the name is free | homelab Changelog 2026-11-15 |

## 3. Why not "GitHub app + separate DB service" like the RSP e-commerce?

The RSP shop (Laravel) talks to its database **over the network**: the database is a
separate server process (MySQL/Postgres). Dokploy can run that server as its own
*database service* and back it up with the engine's dump tool (`pg_dump`,
`mysqldump`) on a schedule. That is the "DB backup" feature in Dokploy.

MyFood has no database server. SQLite is a **library inside the Node process** that
reads and writes one file (`myfood.db`). There is nothing for Dokploy to connect to,
so its database-service backups cannot see it. The file has to live on a **volume**
attached to the app — and Dokploy backs that up with its **Volume Backups** feature
(same S3/R2 destinations, same schedule UI). So "use what Dokploy provides" here means
Volume Backups, not database backups.

Could we switch to a real DB service? Yes, but it is not a config change:

| Option | What changes | Size |
|---|---|---|
| **A. Keep SQLite on a volume + Dokploy Volume Backups (recommended)** | nothing in the code | 0 |
| B. Dokploy **libSQL** service (SQLite over the network; this Dokploy lists `libsql` as a service type) | SQL stays the same, but the client is async: every one of the ~111 query calls and 36 transactions across 28 files becomes `await`, `transaction()` must be rewritten for an async client, and the MCP `query_sql` read-only guard must be re-checked. Whether Dokploy backs up libSQL services: UNVERIFIED (check the service's Backups tab). | days |
| C. Dokploy **Postgres** service | everything in B, plus a dialect port of `schema.sql` (191 lines), the `PRAGMA`-based migrations in `db.ts`, and 41 SQLite-specific spots (`INSERT OR`, `strftime`, `PRAGMA`, …) | a week+ |

For two users on one host, B and C add a network hop and a second container for no
gain. A is recommended; B/C only if you want DB-level backups/restores in the Dokploy UI.

**SQLite + volume backup caveat:** a byte copy of a live WAL database can be torn.
The Volume Backup must stop the app during the copy (Dokploy has an option for this —
UNVERIFIED on this version, check the Volume Backups form; the cost is a seconds-long
nightly stop at 03:30). Swarm stop-first only protects deploys, not backups. If the form
has no stop option, a backup taken mid-write can be torn: then the restore test
(section 9) decides whether that is acceptable or whether option B is worth it.

## 4. AI module (repo)

`RunAi = (input: AiInput) => Promise<AiResult>` (`jobs.ts:34`) stays the same type, so `jobs.ts`,
`routes.ts` and `tests/jobs.test.ts` do not change. What does change: `main.ts:4` imports
`runAi` from `./ai/index.ts`; `tests/ai.test.ts:8-9` and `scripts/ai-smoke.ts:5` update their imports.

```
src/server/ai/
  index.ts     runAi(): picks the provider from AI_PROVIDER, runs it, validates the result
  prompt.ts    rules() + data(input, { imageRefs }) — shared by every provider
  agy.ts       provider "agy": today's CLI code, unchanged behaviour (@file images)
  openai.ts    provider "openai": POST {AI_BASE_URL}/chat/completions
  (gemini.ts)  later, same signature, only if the OpenAI-compatible route is not enough
```

1. **Provider contract**: `(input: AiInput, env) => Promise<unknown>` — returns the model's
   raw JSON object or throws an `Error` with one of the shared user-facing messages
   (`slow`, `login`, `photo`, `nonsense`, `failed`, `missing`; move `E` into `index.ts`).
2. **`index.ts`**: `AI_PROVIDER=openai|agy` (default `agy`, so local dev and the existing
   tests behave as today). After the provider returns, run the checks that live in
   `agy.ts` now — `AiResult.safeParse`, exactly one of `item_id`/`new_item`, cook needs
   portions or total_g and a name if new — once, for every provider. That is the trust boundary.
3. **`prompt.ts`**: split the current `buildPrompt` into `rules()` and `data(input, { imageRefs })`.
   `data()` keeps the injection guards exactly as today: one random `DATA-…` tag per call, the closing
   tag stripped from the user text, `clean`/`noAt`, the size caps. With `imageRefs: true` (agy) the image
   line lists `@path`s; with `false` (openai) it says "N images attached, in order" and names no paths.
   Keep `buildPrompt()` = `rules() + data(…, { imageRefs: true })` so the injection and size tests
   (`tests/ai.test.ts:102-145`) keep running unchanged.
4. **`openai.ts`** (~60 lines, `fetch`, no new dependency):
   - body: `model: AI_MODEL`, `temperature: 0`, `messages`. JSON mode by `AI_JSON_MODE`:
     default `object` → `response_format: { type: 'json_object' }` with the JSON schema
     (`z.toJSONSchema(AiResult)`) pasted into the system prompt; `schema` → `json_schema` with `strict: true`
     as opt-in only, because strict mode rejects schemas with optional properties (`cook`) or `max`
     constraints (`types.ts:103-110`). The zod check is the real gate either way.
   - images: one `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,…' } }` per file in
     `input.images`. The server saves only `jpg|png|webp` (`routes.ts:48-51`), so map
     `{ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }`.
   - `AbortSignal.timeout(AI_TIMEOUT_MS)`; header `Authorization: Bearer ${AI_API_KEY}`.
   - `AI_MODEL` is required for this provider (the agy default `gemini-3.8-flash-low` must not leak in).
     Missing `AI_BASE_URL`/`AI_MODEL` → `missing`; missing key, 401, 403 → `login` (reworded "The AI key on
     the server is missing or wrong."); abort → `slow`; 429, 5xx, network → `failed`; missing or unparsable
     `choices[0].message.content` → `nonsense`.
   - Known side effect, accepted: any throw sets `ai.ready=false` (`jobs.ts`), so a transient 429/timeout
     shows "Not working" in Settings until the next good job.
   - Gemini's API also exposes an OpenAI-compatible endpoint, so "future Gemini" may need only env changes.
5. **Env** (`.env.example` + README): `AI_PROVIDER`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`,
   `AI_TIMEOUT_MS`, optional `AI_JSON_MODE`; agy keeps `AI_CMD`, `AI_EFFORT` (and `AI_MODEL`).
   The user fills the Dokploy values (provider, URL, model, key) in the Dokploy UI.
6. **Tests**:
   - keep `tests/ai.test.ts` cases for agy (via `scripts/fake-agy.mjs`), pointed at the new `index.ts`;
   - add `openai` cases against a `node:http` fake server started in the test: ok, image sent as a base64
     part, garbage, wrong shape, 401, 500, slow;
   - `scripts/ai-smoke.ts` gets `AI_PROVIDER` support for a real call with a sample from `tests/samples`.
7. **Photo size**: already handled. The web client shrinks photos to 1600 px JPEG 0.8 before upload
   (`src/web/ui/jobs/actions.ts:5-13`), so a receipt is a few hundred KB. Server limits stay as they are.

Kept: `agy.ts`, `scripts/fake-agy.mjs`, `scripts/run-agy.sh`, `JOBS_DIR` (all used by the agy provider
locally). Only the VM-specific `deploy/` files go, at decommission (section 10).

## 5. Container

- **`Dockerfile`** (multi-stage):
  - build: `node:26-slim` (prod runs 26.13.1; verify the tag), `npm ci`, `npm run build`
    (`tsc --noEmit` over `src`, `tests`, `scripts` per `tsconfig.json:16`, then vite writes `dist/web`
    including `build.txt`, which `/api/health` reports). So `tests/` and `scripts/` must be in the build
    context. `ARG BUILD_ID` → `ENV BUILD_ID` before the build so health shows the commit
    (`vite.config.ts:7`; Dokploy: build arg from the commit SHA, else a time hash, which is fine).
  - runtime: `node:26-slim`, `npm ci --omit=dev` (all server imports are in `dependencies`), copy
    `package*.json`, `src/` (the server reads `src/server/schema.sql`), `dist/web` from the build stage.
  - `ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data JOBS_DIR=/tmp/jobs WEB_DIR=/app/dist/web TZ=Europe/Copenhagen AI_PROVIDER=openai`
    — `JOBS_DIR` outside the volume so in-flight photos never land in backups (jobs do not survive a restart anyway).
  - Time zone: local time drives expiry pushes and day boundaries. Check `date` inside the image; if
    `TZ` is ignored, `apt-get install -y tzdata` in the runtime stage.
  - `RUN mkdir /data && chown node:node /data` then `USER node` (a new named volume copies this ownership).
  - `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`
  - `CMD ["node", "src/server/main.ts"]` (as today; Node 26 runs the TS directly).
  - `agy` is not installed in the image.
- **`.dockerignore`**: `node_modules`, `dist`, `data`, `.env`, `.git`, `deploy` (not `tests`/`scripts`: typecheck needs them).
- Guest code: printed once at boot (`main.ts:41`), so read it in the Dokploy app logs; README:147 changes
  from `journalctl` to that.
- Local check: `docker build -t myfood .` then
  `docker run -p 3000:3000 -v myfood-data:/data --env-file .env myfood`; `/api/health`, sign in,
  one text job and one receipt job against the real provider.

## 6. Dokploy setup (homelab only: `dokploy-thinkcentre`, never `dokploy-vps`, rule R3)

1. Project **`myfood`**, environment `production`, application **`myfood`**.
2. Source: GitHub `D3stan/myfood`, branch `main`, build type **Dockerfile**. Auto deploy on push
   (replaces `scripts/deploy.sh`).
3. Env (user types secrets in the Dokploy UI; never in git or the homelab doc, R17):
   `AI_PROVIDER=openai`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`*, `MCP_SECRET`*.
   (`VAPID_SUBJECT` is only read when the DB has none, `push.ts:41-45`; the copied DB has one, see section 8.)
4. Volume: named volume `myfood-data` → `/data`.
5. **1 replica, update order stop-first** (Swarm settings): SQLite has one writer and the app resets
   `queued/running` jobs at boot, so two containers must never overlap. A few seconds of downtime per deploy.
6. Limits: 1 CPU, 512 MiB.
7. **Domain**: `myfood.0xpuddu.com` — see section 7. No published port.
8. **Volume Backups**: on `myfood-data`, nightly, to the R2 destination the user adds in Dokploy
   (bucket `myfood-backups` already exists), with "stop the container during backup" if offered.

## 7. Ingress: `myfood.0xpuddu.com`

1. UNVERIFIED first: which Cloudflare tunnel the Dokploy app `cloudflare/tunnel` runs, whether its
   ingress is managed in the Cloudflare dashboard, and how it reaches apps (straight to the service
   name on `dokploy-network`, or via Traefik and a Dokploy domain). Check with the `cloudflare-homelab`
   MCP and the Dokploy app settings. Follow whichever pattern that tunnel already uses.
2. Add the public hostname `myfood.0xpuddu.com` to that tunnel (proxied CNAME is created with it).
3. Test on it with a **copy** of the database while VM 101 keeps serving `food.0xpuddu.com`.
4. At cut-over (section 8) it becomes the real address and stays.
5. Login throttle: the zone rule "MyFood login throttle" matches `/api/login`; check that its expression
   is not tied to the host `food.0xpuddu.com`, otherwise add `myfood.0xpuddu.com`. The app reads
   `cf-connecting-ip` already (`routes.ts:132`).

**A new hostname is a new origin.** Everything the browser keeps per origin starts fresh:

- both users sign in again and re-add the app to the iPhone home screen;
- push: allow notifications again (old subscriptions in the DB stay but point at the old origin's SW);
- MCP clients (Claude connectors, `.mcp.json`, Codex) change the URL to `https://myfood.0xpuddu.com/mcp…`;
- Siri Shortcuts that call the old URL are re-created from Settings → Siri;
- code/docs: `push.ts:35` default VAPID subject, `barcodes.ts:82` User-Agent, README MCP URLs
  (lines 65, 73, 87, 104, 117). The web UI builds every URL from `location.origin` (MCP and Siri
  settings, household invite), so **no web code changes**.

Recommended: after the cut-over, a Cloudflare redirect rule `food.0xpuddu.com/*` → `myfood.0xpuddu.com/$1`
(301) for the week until decommission, so old bookmarks and links land on the new app. API calls and MCP
over a redirect are not reliable, so clients still need the new URL.

## 8. Cut-over (data migration, once)

1. Snapshot VM 101 (`pre-dokploy-YYYYMMDD`, R8).
2. `sudo systemctl stop myfood.service` on VM 101 (downtime starts).
3. `sqlite3 /var/lib/myfood/myfood.db ".backup /tmp/myfood.db"` (consistent copy incl. WAL), then
   `sqlite3 /tmp/myfood.db "PRAGMA integrity_check;"` must print `ok`. On the copy:
   `UPDATE meta SET value='mailto:admin@myfood.0xpuddu.com' WHERE key='vapid_subject';` and
   `DELETE FROM push_subscriptions;` (they belong to the old origin and would only fail). Copy to VM 100.
4. Stop the Dokploy app, put the file into the volume
   (`/var/lib/docker/volumes/myfood-data/_data/myfood.db`, owner uid 1000, remove any old `-wal`/`-shm`),
   start the app.
5. Check: `/api/health` shows the new build; both users sign in; `SELECT COUNT(*)` of `items` and `events`
   match the VM 101 numbers; one text job and one receipt job succeed.
6. Turn on the `food.0xpuddu.com` redirect; tell both users (section 7 list).
7. Rollback: turn off the redirect, `systemctl start myfood.service` on VM 101. Anything written on
   Dokploy after the cut-over is lost on rollback unless copied back the same way.

## 9. Backups

- Dokploy **Volume Backups** on `myfood-data` (section 6.8) → R2 destination added by the user.
- No custom backup code. `scripts/backup.sh` and `scripts/backup-r2.mjs` are deleted with `deploy/`.
- **Restore test** before decommission: download the newest backup from R2, open the `.db` with
  `sqlite3 x.db "PRAGMA integrity_check; SELECT COUNT(*) FROM events;"`.

## 10. Decommission VM 101 (one week after cut-over)

Each step needs a yes in chat (R5), with a Changelog entry before and after (R6).

1. Stop VM 101.
2. Remove the `food.0xpuddu.com` redirect, DNS record and tunnel `MYFOOD` in Cloudflare.
3. Destroy VM 101 (`qm destroy 101 --purge`) with its snapshots.
4. Repo: delete `deploy/` (systemd units, env files, sudoers, nftables), `scripts/deploy.sh`,
   `scripts/backup.sh`, `scripts/backup-r2.mjs`; update `README.md`, `docs/plan.md`.
   The agy provider, `run-agy.sh` and `fake-agy.mjs` stay.
5. Homelab doc: Services (MyFood → Dokploy, new address), Guests (remove VM 101), Overview suggestion (R12).

## 11. Order of work

| # | Step | Where | Needs user |
|---|---|---|---|
| 1 | AI module (`index`/`prompt`/`agy`/`openai`), tests | repo | — |
| 2 | `Dockerfile`, `.dockerignore`, hostname strings, README (MCP URLs, guest code), local `docker run` test | repo | an API key for the real-call test |
| 3 | Typecheck + `vitest run` green | repo | — |
| 4 | Changelog entry; Dokploy project, app, volume, env; deploy | VM 100 | yes (R5); fills env |
| 5 | `myfood.0xpuddu.com` on the Dokploy tunnel; test with a DB copy | Cloudflare, Dokploy | yes |
| 6 | Add R2 destination; Volume Backup; restore test | Dokploy, R2 | adds destination |
| 7 | Cut-over (section 8) + redirect + tell users | VM 101, VM 100, Cloudflare | yes |
| 8 | Decommission after one week (section 10) | Proxmox, Cloudflare, repo | yes |

Steps 1–3 are one PR; nothing in the lab changes before step 4.

## 12. Open questions

- Option A (SQLite + Volume Backups) vs B/C (separate DB service) — section 3. Recommended: A.
- Auto deploy on push to `main`, or deploy by hand from Dokploy?
