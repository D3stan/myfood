import { html } from '../../html.ts';
import { hourToTime } from '../components/bits.ts';
import type { V } from '../components/bits.ts';

export const me = ({ st, ui }: V) => html`<h1>Me</h1>
  <div class="card">
    <label class="field" for="me-name">Name</label>
    <input id="me-name" type="text" maxlength="60" data-f="meName" value="${ui.f.meName ?? st.me.name}" autocomplete="off">
    <label class="field" for="me-emoji">Emoji</label>
    <input id="me-emoji" type="text" maxlength="8" data-f="meEmoji" value="${ui.f.meEmoji ?? st.me.emoji}" autocomplete="off">
    <div class="row" style="margin-top:12px"><button class="btn right" data-a="saveMe" ${ui.online ? '' : 'disabled'}>Save</button></div>
  </div>
  <h2>Presets</h2>
  ${st.presets.map(p => html`<div class="line" id="pre-${p.id}"><span class="emoji">${p.emoji}</span><span class="n">${p.name} <span class="muted small">${hourToTime(p.hour)}</span></span>
    <button class="btn alt icon" data-a="open" data-s="presetEdit" data-id="${p.id}" aria-label="Edit ${p.name}">✏️</button>
    <button class="btn alt icon" data-a="delPreset" data-id="${p.id}" aria-label="Delete ${p.name}" ${ui.online ? '' : 'disabled'}>🗑️</button></div>`)}
  <div class="row" style="margin:12px 0"><button class="btn" data-a="open" data-s="presetEdit">New preset</button></div>
  ${ui.standalone ? '' : html`<p class="note">Install it: tap Share, then Add to Home Screen. Sign in inside the installed app.</p>`}
  <div class="row" style="margin-top:20px"><button class="linkbtn" data-a="logout">Sign out</button><span class="small muted right">build ${__BUILD__}</span></div>`;
