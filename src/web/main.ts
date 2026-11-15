import '@fontsource/patrick-hand/latin-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import './styles.css';
import type { AssistantResult, CreateEventInput, PantryEvent, PantryItem, PantryState, Preset } from '../shared/types.ts';

type Screen = 'pantry' | 'history' | 'me';
let state: PantryState | null = null;
let screen: Screen = 'pantry';
let query = '';
let busy = false;
let loginRequired = false;
const app = document.querySelector<HTMLDivElement>('#app')!;
const cached = localStorage.getItem('myfood.state');
if (cached) {
  try { state = JSON.parse(cached) as PantryState; render(); } catch { localStorage.removeItem('myfood.state'); }
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('X-MyFood', '1');
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

async function refresh(): Promise<void> {
  state = await request<PantryState>('/api/state');
  localStorage.setItem('myfood.state', JSON.stringify(state));
  render();
}

function unitLabel(unit: PantryItem['unit']): string {
  return ({ pc: 'pcs', slice: 'slices', g: 'g', ml: 'ml', level: 'level' })[unit];
}
function qty(value: number): string {
  return new Intl.NumberFormat('da-DK', { maximumFractionDigits: 2 }).format(value);
}
function stockText(item: PantryItem): string {
  if (item.unit === 'level') return ['Out', 'Low', 'Half full', 'Mostly full', 'Full'][Math.min(4, Math.max(0, Math.round(item.stock * 4)))]!;
  return `${qty(item.stock)} ${unitLabel(item.unit)}`;
}
function isLow(item: PantryItem): boolean { return item.stock <= item.lowAt; }
function render(): void {
  if (!state) {
    if (loginRequired) {
      app.innerHTML = `<main class="loading"><div class="loading-sticker">🥬</div><h1>Welcome home</h1><p>Enter your kitchen PIN to open the shared pantry.</p><form class="login-form login-screen" id="login-form"><label for="pin">Kitchen PIN</label><div><input id="pin" name="pin" inputmode="numeric" autocomplete="current-password" type="password" maxlength="32" placeholder="6+ digit PIN" required><button class="button button-dark" type="submit">Open pantry →</button></div></form><small class="helper-note">Use your personal kitchen PIN.</small></main>`;
      return;
    }
    app.innerHTML = `<main class="loading"><div class="loading-sticker">🥬</div><h1>MyFood</h1><p>Waking up the pantry…</p><button class="button button-dark" data-action="retry">Try again</button></main>`;
    return;
  }
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#pantry" data-screen="pantry" aria-label="MyFood home"><span class="brand-mark">✳</span><span>myfood</span></a><div class="top-actions"><span class="sync-pill ${state.ai.available ? 'sync-live' : 'sync-demo'}"><i></i>${state.ai.mode === 'agy' && state.ai.available ? 'AI ready' : 'Demo AI'}</span><button class="avatar" data-screen="me" aria-label="Open profile">${esc(state.me.emoji)}</button></div></header>
    <main class="main-content">${screen === 'pantry' ? renderPantry() : screen === 'history' ? renderHistory() : renderMe()}</main>
    ${renderComposer()}
    <nav class="tabbar" aria-label="Main navigation"><button class="tab ${screen === 'pantry' ? 'selected' : ''}" data-screen="pantry"><span>▦</span>Pantry</button><button class="tab ${screen === 'history' ? 'selected' : ''}" data-screen="history"><span>◷</span>History</button><button class="tab ${screen === 'me' ? 'selected' : ''}" data-screen="me"><span>☺</span>Me</button></nav>
    <div id="overlay"></div><div id="toast" role="status" aria-live="polite"></div>
  </div>`;
}

function renderPantry(): string {
  const hour = new Date().getHours();
  const greeting = hour < 11 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const presets = state!.presets;
  const breakfast = presets.find((preset) => /breakfast|morgenmad/i.test(preset.name)) ?? presets[0];
  const filtered = state!.items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(filtered.map((item) => item.category))];
  const lowItems = filtered.filter(isLow);
  const today = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();
  return `<section class="welcome"><div><p class="eyebrow">YOUR SHARED KITCHEN · ${esc(today)}</p><h1>${greeting}, ${esc(state!.me.name.split(' ')[0])}<span class="greeting-spark">✦</span></h1><p class="welcome-copy">${state!.items.length} good things at home. What are we making?</p></div><span class="doodle-plate" aria-hidden="true">🍳</span></section>
  ${breakfast ? `<button class="breakfast-card" data-action="preset" data-id="${breakfast.id}"><span class="breakfast-icon">${esc(breakfast.emoji || '🍳')}</span><span class="breakfast-copy"><span class="eyebrow">YOUR USUAL</span><strong>${esc(breakfast.name)}</strong><small>Ready in one tap</small></span><span class="play-button" aria-label="Log ${esc(breakfast.name)}">→</span><span class="breakfast-scribble" aria-hidden="true">easy<br>peasy</span></button>` : ''}
  <div class="section-heading"><div><h2>The pantry</h2><span class="mini-count">${state!.items.length} items</span></div><button class="text-button" data-action="add-item">＋ Add food</button></div>
  <label class="search-box"><span>⌕</span><input id="search" type="search" placeholder="Find something…" value="${esc(query)}" autocomplete="off"><kbd>/</kbd></label>
  ${lowItems.length ? `<section class="low-strip"><div><span class="low-spark">✳</span><span><strong>Running low</strong><small>${lowItems.map((item) => esc(item.name)).join(' · ')}</small></span></div><button data-action="shopping-list" aria-label="Share shopping list">↗</button></section>` : ''}
  ${groups.map((group) => `<section class="food-group"><div class="group-title"><h3>${esc(group)}</h3><span>${filtered.filter((item) => item.category === group).length}</span></div><div class="food-grid">${filtered.filter((item) => item.category === group).map(renderItem).join('')}</div></section>`).join('')}
  ${filtered.length ? '' : `<div class="empty-state"><span>🕵️</span><h3>Nothing in this corner</h3><p>Try another search, or add something new.</p></div>`}
  <p class="demo-note"><span>✦</span> AI is in demo mode. Your pantry and meal logging work locally.</p>`;
}

function renderItem(item: PantryItem): string {
  const low = isLow(item);
  const itemJson = encodeURIComponent(JSON.stringify(item));
  return `<article class="food-card ${low ? 'is-low' : ''}"><button class="food-main" data-action="item" data-item="${itemJson}"><span class="food-emoji">${esc(item.emoji)}</span><span class="food-info"><strong>${esc(item.name)}</strong><small class="${low ? 'low-text' : ''}">${low ? '<i class="low-dot"></i>' : ''}${esc(stockText(item))}</small></span><span class="food-arrow">›</span></button><button class="quick-take" data-action="quick-eat" data-id="${item.id}" aria-label="Take usual amount of ${esc(item.name)}">−</button></article>`;
}

function renderHistory(): string {
  if (!state!.events.length) return `<section class="page-intro"><p class="eyebrow">THE LITTLE THINGS ADD UP</p><h1>Food stories</h1><p>Every buy, breakfast and bite will show up here.</p></section><div class="empty-state"><span>📒</span><h3>A fresh page</h3><p>Start by logging what you ate or bought below.</p></div>`;
  const groups = new Map<string, PantryEvent[]>();
  for (const event of state!.events) {
    const label = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(event.at));
    groups.set(label, [...(groups.get(label) ?? []), event]);
  }
  return `<section class="page-intro"><p class="eyebrow">A LITTLE LOOK BACK</p><h1>Food stories</h1><p>All the tiny kitchen moments, together.</p></section><div class="timeline">${[...groups].map(([day, events]) => `<section class="day-group"><h2>${esc(day)}</h2>${events.map((event) => `<article class="history-card"><span class="history-icon ${event.kind}">${event.kind === 'eat' ? '🍽️' : event.kind === 'buy' ? '🛍️' : '✎'}</span><div class="history-copy"><div><strong>${esc(event.note || (event.kind === 'eat' ? 'A little snack' : event.kind === 'buy' ? 'Stocked up' : 'Pantry update'))}</strong><time>${esc(new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(event.at)))}</time></div><p>${event.lines.map((line) => `${esc(line.emoji)} ${qty(line.qty)} ${esc(unitLabel(line.unit))} ${esc(line.name)}`).join('<span> · </span>')}</p><small>${esc(event.userName)}${event.source === 'ai' ? ' · ✨ AI assisted' : ''}</small></div><button class="undo-button" data-action="undo" data-id="${event.id}" aria-label="Undo this entry">↶</button></article>`).join('')}</section>`).join('')}</div>`;
}

function renderMe(): string {
  return `<section class="page-intro"><p class="eyebrow">YOUR LITTLE CORNER</p><h1>Kitchen pals</h1><p>A shared pantry feels better together.</p></section><button class="profile-card" type="button" data-action="edit-profile"><div class="profile-emoji">${esc(state!.me.emoji)}</div><div><strong>${esc(state!.me.name)}</strong><small>Pantry pal · Tap to edit profile or PIN</small></div><span class="profile-edit">✎</span></button><section class="settings-group"><h2>At a glance</h2><div class="setting-row"><span class="setting-icon">🧺</span><span><strong>In the pantry</strong><small>Food your household has logged</small></span><b>${state!.items.length}</b></div><div class="setting-row"><span class="setting-icon">🫶</span><span><strong>Sharing with</strong><small>${state!.users.map((user) => esc(user.name)).join(' & ')}</small></span><b>${state!.users.length}</b></div><div class="setting-row"><span class="setting-icon">✨</span><span><strong>AI helper</strong><small>${state!.ai.available && state!.ai.mode === 'agy' ? 'Connected and ready' : 'Demo mode · logging still works'}</small></span><span class="setting-status">${state!.ai.available && state!.ai.mode === 'agy' ? 'Ready' : 'Demo'}</span></div></section><section class="settings-group"><h2>Your kitchen PIN</h2><form class="login-form" id="pin-form"><label for="new-pin">Change PIN for ${esc(state!.me.name)}</label><div><input id="new-pin" name="pin" inputmode="numeric" autocomplete="new-password" type="password" minlength="6" maxlength="32" placeholder="New 6+ digit PIN" required><button class="button button-dark" type="submit">Save PIN</button></div></form><small class="helper-note">Must be at least 6 digits and different from your roommate’s PIN.</small></section><section class="settings-group"><h2>Switch kitchen pal</h2><form class="login-form" id="login-form"><label for="pin">Enter your PIN to log as the other person</label><div><input id="pin" name="pin" inputmode="numeric" autocomplete="current-password" type="password" maxlength="32" placeholder="6+ digit PIN" required><button class="button button-dark" type="submit">Switch →</button></div></form><small class="helper-note">Enter the other person’s PIN to switch profiles.</small></section><section class="settings-group"><h2>Your usuals</h2>${state!.presets.length ? state!.presets.map((preset) => `<button class="setting-row preset-row" data-action="preset" data-id="${preset.id}"><span class="setting-icon">${esc(preset.emoji)}</span><span><strong>${esc(preset.name)}</strong><small>${preset.lines.length} pantry favourites</small></span><span class="row-arrow">›</span></button>`).join('') : `<p class="muted-copy">Your favourite meals will live here.</p>`}</section><aside class="about-note">Made for the home you share.<br><strong>Small meals, happy shelves.</strong> 🌱</aside>`;
}

function renderComposer(): string {
  return `<form class="composer" id="composer"><span class="composer-star">✳</span><input name="text" aria-label="Tell MyFood what happened" placeholder="“I had 2 eggs” or “bought milk”…" autocomplete="off" required><button type="submit" aria-label="Send message">↑</button></form>`;
}

function toast(message: string): void {
  const node = document.querySelector<HTMLDivElement>('#toast');
  if (!node) return;
  node.innerHTML = `<span>✦</span>${esc(message)}`;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 2600);
}

function openModal(content: string): void {
  const overlay = document.querySelector<HTMLDivElement>('#overlay');
  if (!overlay) return;
  overlay.innerHTML = `<div class="sheet-backdrop" data-action="close"><section class="sheet" role="dialog" aria-modal="true">${content}</section></div>`;
  document.body.classList.add('sheet-open');
}
function closeModal(): void {
  const overlay = document.querySelector<HTMLDivElement>('#overlay');
  if (overlay) overlay.innerHTML = '';
  document.body.classList.remove('sheet-open');
}

function itemSheet(item: PantryItem): void {
  const exact = item.unit === 'level' ? item.stock : Math.max(item.step, item.step * Math.round(Math.max(item.step, item.stock) / item.step));
  openModal(`<button class="sheet-close" data-action="close" aria-label="Close">×</button><div class="sheet-hero">${esc(item.emoji)}</div><p class="eyebrow">${esc(item.category)}</p><h2>${esc(item.name)}</h2><p class="sheet-stock">You have <strong>${esc(stockText(item))}</strong></p><div class="quantity-control"><button data-action="step" data-delta="-1" aria-label="Decrease amount">−</button><strong id="amount" data-value="${exact}">${qty(exact)}</strong><button data-action="step" data-delta="1" aria-label="Increase amount">＋</button><small>${esc(unitLabel(item.unit))}</small></div><div class="sheet-actions"><button class="button button-dark" data-action="eat" data-id="${item.id}">I ate this</button><button class="button button-light" data-action="buy" data-id="${item.id}">Add to pantry</button></div><button class="adjust-link" data-action="adjust" data-id="${item.id}">Set exact pantry amount</button>`);
}

function addItemSheet(): void {
  openModal(`<button class="sheet-close" data-action="close" aria-label="Close">×</button><div class="sheet-hero">🧺</div><p class="eyebrow">MAKE ROOM FOR MORE</p><h2>Add food</h2><p class="sheet-stock">Add an item to your shared pantry.</p><form class="add-item-form" id="add-item-form"><label>Food name<input name="name" placeholder="e.g. Oat milk" required maxlength="70"></label><div class="form-pair"><label>Emoji<input name="emoji" value="🥛" maxlength="4"></label><label>Category<input name="category" value="Fridge" maxlength="40"></label></div><div class="form-pair"><label>Counted in<select name="unit"><option value="pc">pieces</option><option value="slice">slices</option><option value="g">grams</option><option value="ml">millilitres</option><option value="level">levels</option></select></label><label>Pack size<input name="packSize" type="number" min="0.5" step="0.5" value="1"></label></div><button class="button button-dark full-button" type="submit">Add to pantry →</button></form>`);
}

function editProfileSheet(): void {
  if (!state) return;
  openModal(`<button class="sheet-close" data-action="close" aria-label="Close">×</button><div class="sheet-hero">${esc(state.me.emoji)}</div><p class="eyebrow">KITCHEN PAL</p><h2>Edit profile & PIN</h2><p class="sheet-stock">Update details for <strong>${esc(state.me.name)}</strong></p><form class="add-item-form" id="profile-form"><div class="form-pair"><label>Name<input name="name" value="${esc(state.me.name)}" required maxlength="40"></label><label>Emoji<input name="emoji" value="${esc(state.me.emoji)}" required maxlength="8"></label></div><label>New PIN (optional, 6+ digits)<input name="pin" inputmode="numeric" autocomplete="new-password" type="password" minlength="6" maxlength="32" placeholder="Leave blank to keep current PIN"></label><button class="button button-dark full-button" type="submit">Save changes →</button></form>`);
}

async function createEvent(kind: CreateEventInput['kind'], lines: CreateEventInput['lines'], extra: Partial<CreateEventInput> = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    state = await request<PantryState>('/api/events', { method: 'POST', body: JSON.stringify({ cid: crypto.randomUUID(), kind, lines, ...extra }) satisfies string });
    localStorage.setItem('myfood.state', JSON.stringify(state));
    closeModal(); render();
    toast(kind === 'eat' ? 'Logged. Enjoy! 🌼' : kind === 'buy' ? 'Added to the pantry!' : 'Pantry updated.');
  } catch (error) { toast(error instanceof Error ? error.message : 'Could not save that yet.'); }
  finally { busy = false; }
}

function currentItem(): PantryItem | undefined {
  const amount = document.querySelector<HTMLElement>('#amount');
  if (!amount) return undefined;
  const dialog = amount.closest('.sheet');
  const itemId = dialog?.querySelector<HTMLElement>('[data-action="eat"]')?.dataset.id;
  return state!.items.find((item) => item.id === Number(itemId));
}

app.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action], [data-screen]');
  if (!target) return;
  const screenTarget = target.dataset.screen as Screen | undefined;
  if (screenTarget) { screen = screenTarget; render(); return; }
  const action = target.dataset.action;
  if (action === 'close') { if (target.classList.contains('sheet-backdrop') || target.classList.contains('sheet-close')) closeModal(); return; }
  if (action === 'retry') { try { await refresh(); } catch { toast('Still looking for the pantry server…'); } }
  if (action === 'item' && target.dataset.item) { itemSheet(JSON.parse(decodeURIComponent(target.dataset.item)) as PantryItem); }
  if (action === 'add-item') addItemSheet();
  if (action === 'edit-profile') editProfileSheet();
  if (action === 'step') {
    const amount = document.querySelector<HTMLElement>('#amount'); const item = currentItem();
    if (amount && item) { const next = Math.max(item.step, Number(amount.dataset.value) + Number(target.dataset.delta) * item.step); amount.dataset.value = String(next); amount.textContent = qty(next); }
  }
  if (action === 'eat' || action === 'buy' || action === 'adjust') {
    const item = state!.items.find((row) => row.id === Number(target.dataset.id)); const amount = Number(document.querySelector<HTMLElement>('#amount')?.dataset.value ?? 1);
    if (item) {
      if (action === 'adjust') { const value = window.prompt(`Set ${item.name} to how much?`, String(item.stock)); if (value !== null && Number.isFinite(Number(value))) await createEvent('adjust', [{ itemId: item.id, qty: Number(value) }], { note: `Set ${item.name}` }); }
      else await createEvent(action, [{ itemId: item.id, qty: amount }]);
    }
  }
  if (action === 'quick-eat') {
    const item = state!.items.find((row) => row.id === Number(target.dataset.id));
    if (item) await createEvent('eat', [{ itemId: item.id, qty: item.step }]);
  }
  if (action === 'preset') {
    const preset = state!.presets.find((row) => row.id === Number(target.dataset.id));
    if (preset) await createEvent('eat', preset.lines, { presetId: preset.id, note: preset.name });
  }
  if (action === 'undo') {
    try { state = await request<PantryState>(`/api/events/${target.dataset.id}`, { method: 'DELETE' }); localStorage.setItem('myfood.state', JSON.stringify(state)); render(); toast('Undone. We all make little oopsies.'); }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not undo that.'); }
  }
  if (action === 'shopping-list') {
    const list = state!.items.filter(isLow).map((item) => `${item.emoji} ${item.name}`).join('\n');
    if (navigator.share) { try { await navigator.share({ title: 'MyFood shopping list', text: list }); } catch { /* share sheet closed */ } }
    else { await navigator.clipboard.writeText(list); toast('Shopping list copied!'); }
  }
});

app.addEventListener('input', (event) => {
  if ((event.target as HTMLElement).id === 'search') { query = (event.target as HTMLInputElement).value; const position = (event.target as HTMLInputElement).selectionStart; render(); const search = document.querySelector<HTMLInputElement>('#search'); search?.focus(); search?.setSelectionRange(position, position); }
});

app.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  if (form.id === 'login-form') {
    event.preventDefault();
    const pin = String(new FormData(form).get('pin') ?? '').trim();
    try { state = await request<PantryState>('/api/login', { method: 'POST', body: JSON.stringify({ pin }) }); loginRequired = false; localStorage.setItem('myfood.state', JSON.stringify(state)); render(); toast(`Hi, ${state.me.name}!`); }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not switch kitchen pal.'); }
  }
  if (form.id === 'pin-form') {
    event.preventDefault();
    const pin = String(new FormData(form).get('pin') ?? '').trim();
    try {
      state = await request<PantryState>('/api/me', { method: 'PATCH', body: JSON.stringify({ pin }) });
      localStorage.setItem('myfood.state', JSON.stringify(state));
      render();
      toast('Your PIN is updated! 🔐');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update your PIN.');
    }
  }
  if (form.id === 'profile-form') {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim();
    const emoji = String(data.get('emoji') ?? '').trim();
    const pin = String(data.get('pin') ?? '').trim();
    try {
      const payload: { name?: string; emoji?: string; pin?: string } = { name, emoji };
      if (pin) payload.pin = pin;
      state = await request<PantryState>('/api/me', { method: 'PATCH', body: JSON.stringify(payload) });
      localStorage.setItem('myfood.state', JSON.stringify(state));
      closeModal();
      render();
      toast(pin ? 'Profile & PIN updated! 🔐' : 'Profile updated!');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not update your profile.');
    }
  }
  if (form.id === 'composer') {
    event.preventDefault();
    const data = new FormData(form); const text = String(data.get('text') ?? '').trim(); if (!text) return;
    const input = form.querySelector<HTMLInputElement>('input'); if (input) input.value = '';
    try {
      const result = await request<AssistantResult>('/api/assistant', { method: 'POST', body: JSON.stringify({ text }) });
      await refresh(); toast(result.reply);
    } catch (error) { toast(error instanceof Error ? error.message : 'The helper could not hear that.'); }
  }
  if (form.id === 'add-item-form') {
    event.preventDefault(); const data = new FormData(form);
    try {
      const payload = { name: String(data.get('name')), emoji: String(data.get('emoji') || '🥫'), category: String(data.get('category') || 'Other'), unit: String(data.get('unit')), step: String(data.get('unit')) === 'slice' ? 0.5 : String(data.get('unit')) === 'g' ? 50 : 1, packSize: Number(data.get('packSize')), lowAt: 1 };
      state = await request<PantryState>('/api/items', { method: 'POST', body: JSON.stringify(payload) }); localStorage.setItem('myfood.state', JSON.stringify(state)); closeModal(); render(); toast('A new pantry friend!');
    } catch (error) { toast(error instanceof Error ? error.message : 'Could not add that item.'); }
  }
});

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); document.querySelector<HTMLInputElement>('#search')?.focus(); } });
window.addEventListener('online', () => { void refresh().catch(() => undefined); });
void refresh().catch((error) => {
  if (error instanceof Error && error.message.includes('PIN sign-in required')) {
    state = null;
    localStorage.removeItem('myfood.state');
    loginRequired = true;
    render();
    return;
  }
  if (!state) render();
  toast('Pantry server is offline.');
});
