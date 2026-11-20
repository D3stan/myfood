# Plan: 75% level button + human location picker

## Bug 1 — level items have no 75% button

**Where:** `src/web/ui/components/sheets.ts:112` renders `Full 1 / Half 0.5 / Low 0.25 / Out 0`.
The step is already 0.25 (`stepOf` in `bits.ts:14`), the server accepts any qty, and the pantry
gauge already draws 4 bars, so only the UI and the name are missing.

1. `sheets.ts:112`: add `['¾', 0.75]` between Full and Half.
2. `src/shared/stock.ts:20` `levelName`: add `n >= 0.75 ? '¾'` so 0.75 is not read back as "half"
   (pantry aria-label, item sheet stock line, event labels like "🧄 Garlic: ¾ +1").
3. Test in `tests/stock.test.ts`: `levelName(0.75) === '¾'`, `levelName(0.5) === 'half'`.

## Bug 2 — deal location is raw lat/lng text inputs

**Where:** `src/web/ui/deals/screen.ts:45-54` (Location card on the Stores page) and
`saveDealLocation` in `src/web/ui/deals/actions.ts:38-43`. Server `PUT /api/deals/location`
and `DealLocationBody` stay unchanged.

Replace the two text inputs with:

1. **"📍 Use my location" button** (`data-a="useMyLocation"`): `navigator.geolocation.getCurrentPosition`,
   on success put `lat`/`lng` (rounded to 5 decimals) into `ui.f.dealLat` / `ui.f.dealLng` and re-render;
   on error/unsupported, toast a plain message. No new dependency.
2. **Tap-to-pick map** using Leaflet (`leaflet` npm dep, imported dynamically from the stores page so it
   stays out of the main bundle; its CSS imported in the same lazy module):
   - A `<div id="deal-map">` (~240px tall) in the Location card. Marker at the current
     (draft or saved) point, a circle for `radius_m`. Click/tap the map or drag the marker → sets
     `ui.f.dealLat/dealLng` (5 decimals) and moves marker + circle.
   - OSM tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png` with the required attribution.
   - **Idiomorph caveat:** `render.ts:60` morphs `#app` on every render and would wipe Leaflet's DOM.
     Keep the container out of the morph: use Idiomorph's `callbacks.beforeNodeMorphed` (return
     `false` for `#deal-map`) in `render.ts`, and init the map once when `#deal-map` appears without
     a map (and `map.remove()` / forget it when the element leaves the DOM). Update marker/circle
     from state after each render.
   - **CSP** `src/server/routes.ts:75`: add `https://tile.openstreetmap.org` to `img-src`.
   - Offline: if tiles fail the button and the readout still work.
3. Show the picked point as a read-only line (e.g. `55.67610, 12.56830`) so the user sees what will be saved.
   Keep the Radius input (numeric) but make it a `<select>` or keep text — keep text, unchanged.
4. `saveDealLocation` keeps its validation; it already reads `f.dealLat ?? d.lat`, so no change beyond
   what the new inputs feed it.
5. Demo mode (`src/web/demo.ts`) needs no change: same endpoint.

**Tests:** `tests/web.test.ts:831` renders the stores page. Update/add: the page has `#deal-map` and a
`useMyLocation` button and no `#deal-lat` text input; `useMyLocation` with a stubbed
`navigator.geolocation` sets `ui.f.dealLat/dealLng`. Map code itself is not unit-tested (jsdom has no layout).

## Skipped on purpose
- Address search (geocoding via Nominatim): sends typed addresses to a third party; map + GPS cover it.
- Radius slider / drag-to-resize circle.

## Checks
`npm run typecheck`, `npm test`, `npm run build`, then click through Stores page in the dev preview
(demo mode) — tap map, use-my-location (permission), Save; and the ¾ button on a level item.

## Amendments after review
- `levelName(0.75)` returns `'three quarters'` (screen readers and MCP text read words reliably). The button
  shows `¾` with `aria-label="Three quarters"`. Insert the branch before `>= 0.5`.
- Update unused `LEVELS` in `src/shared/types.ts:28-29` to `[1, 0.75, 0.5, 0.25, 0]`, and the MCP description in
  `src/server/events/mcp.ts:96` to list 0.75.
- Tests: `levelName(0.75)`, `levelLabel(1.75) === 'three quarters +1'`.
- Map: use `L.circleMarker` (not the default image marker, whose icon URLs break under Vite). Map clicks/drags write
  `ui.f.dealLat/dealLng` directly and update the marker/circle/readout in place, no `commit()` per move.
  Init is idempotent and keyed on the `#deal-map` node identity; a no-op under the web.test.ts stubs.
- `Referrer-Policy: same-origin` (routes.ts:154) strips the Referer OSM requires: set the tile layer's
  `referrerPolicy: 'strict-origin-when-cross-origin'` option.
- Keep `data-f="dealRadius"` (asserted by the existing test).
