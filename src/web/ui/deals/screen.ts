import { html } from '../../html.ts';
import { isoDate } from '../../../shared/dates.ts';
import { tripDay } from '../../../shared/deals.ts';
import { fmtCost } from '../../../shared/text.ts';
import type { V } from '../components/bits.ts';

/** The plan's strip on the Pantry; absent when there is no trip. */
export function dealsStrip({ st }: V) {
  const d = st.deals_summary;
  return d ? html`<button class="note" id="deals-strip" style="display:block;width:100%;text-align:left" data-a="go" data-p="deals">🛒 <b>${tripDay(d.date, isoDate(st.now))} at ${d.store_name}</b> · ${d.deal_count} item${d.deal_count === 1 ? '' : 's'}${d.saving_cents > 0 ? ` · save ${fmtCost(d.saving_cents, st.currency)}` : ''}</button>` : '';
}

export function dealsPage({ st, ui }: V) {
  const p = ui.dealsPlan, off = ui.online ? '' : 'disabled';
  const money = (c: number) => fmtCost(Math.round(c), st.currency);
  return html`
    <div class="row" style="margin-bottom:8px"><button id="deals-sync" class="btn alt right" data-a="syncDeals" ${off}>Sync now</button></div>
    ${!p ? html`<p class="small muted">Loading…</p>` : html`
      ${p.trips.length ? (p.total_saving_cents > 0 ? html`<p id="deals-total" class="small" style="margin:0 0 8px">Total saving <b>${money(p.total_saving_cents)}</b></p>` : '') : html`<p class="note">No shopping trip is worth planning right now.</p>`}
      ${p.trips.map((t, n) => html`<div class="card" id="trip-${n}">
        <h2 style="margin-top:0">${tripDay(t.date, p.today)} · ${t.store_emoji} ${t.store_name} ${t.saving_cents > 0 ? html`<span class="small muted">save ${money(t.saving_cents)}</span>` : ''}</h2>
        ${t.items.map(i => html`<div class="line"><span class="n">${i.emoji} <b>${i.name}</b> × ${i.packs}</span><span class="small muted">${money(i.unit_cents)}/unit</span></div>
          <p class="small muted" style="margin:2px 0 6px">${i.offer_title} · ${i.reason}</p>`)}
        ${t.date === p.today ? html`<div class="row"><button id="trip-${n}-bought" class="btn right" data-a="boughtTrip" data-store="${t.store_id}">Bought these</button></div>` : ''}
      </div>`)}
      ${p.items.some(i => !i.on_trip) ? html`<div class="card"><h2 style="margin-top:0">Other deals</h2>
        ${p.items.filter(i => !i.on_trip).map(i => html`<div class="line"><span class="n">${i.emoji} <b>${i.name}</b> <span class="small muted">${i.store_emoji} ${i.store_name} · ${i.valid_from} to ${i.valid_to}${i.pct_off > 0 ? ` · −${i.pct_off}%` : ''}</span></span></div>
          <p class="small muted" style="margin:2px 0 6px">${i.reason}</p>`)}
      </div>` : ''}`}`;
}

export function storesPage({ ui }: V) {
  const d = ui.dealsInfo, off = ui.online ? '' : 'disabled';
  if (!d) return html`<p class="small muted">Loading…</p>`;
  return html`
    <div class="card">
      <h2 style="margin-top:0">Stores</h2>
      ${d.stores.map(s => html`<label class="row" style="gap:8px;align-items:center;margin:8px 0;cursor:pointer">
        <input type="checkbox" id="store-${s.id}" data-c="toggleStore" data-id="${s.id}" ${s.enabled ? 'checked' : ''} ${off}>
        <span class="grow">${s.emoji} <b>${s.name}</b>
          <span class="small muted">${s.last_synced_at ? `synced ${new Date(s.last_synced_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` : 'never synced'}</span>
          ${s.last_error ? html`<span class="small" style="color:var(--bad,#b3261e)"> · ${s.last_error}</span>` : ''}</span></label>`)}
      <div class="row" style="margin-top:12px"><button id="stores-sync" class="btn alt right" data-a="syncDeals" ${off}>Sync now</button></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Location</h2>
      <label class="field" for="deal-lat">Latitude</label>
      <input id="deal-lat" type="text" inputmode="decimal" data-f="dealLat" value="${ui.f.dealLat ?? d.lat}" autocomplete="off">
      <label class="field" for="deal-lng">Longitude</label>
      <input id="deal-lng" type="text" inputmode="decimal" data-f="dealLng" value="${ui.f.dealLng ?? d.lng}" autocomplete="off">
      <label class="field" for="deal-radius">Radius (metres)</label>
      <input id="deal-radius" type="text" inputmode="numeric" data-f="dealRadius" value="${ui.f.dealRadius ?? d.radius_m}" autocomplete="off">
      <div class="row" style="margin-top:12px"><button id="deal-loc-save" class="btn right" data-a="saveDealLocation" ${off}>Save</button></div>
    </div>`;
}
