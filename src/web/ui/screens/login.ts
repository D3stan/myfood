import { html } from '../../html.ts';
import type { Ui } from '../../store.ts';

export const login = (ui: Ui) => html`<form class="login" data-submit="login">
  <h1 class="brand">MyFood</h1>
  <p>Type your access code.</p>
  <input id="code" class="pin" type="text" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"
    placeholder="xxxx-xxxx-xxxx" data-f="code" value="${ui.f.code ?? ''}" aria-label="Access code">
  <button class="btn big" type="submit">Let me in</button>
  <p class="note small">Add the app to your home screen first (Share → Add to Home Screen), then sign in there. The installed app keeps its own login.</p>
</form>`;
