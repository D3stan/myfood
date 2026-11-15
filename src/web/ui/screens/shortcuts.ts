// The two Siri Shortcuts, as plain text. Paste it into Shortcuts' AI builder ("describe your shortcut"),
// or follow the numbered steps by hand: they are the same either way.
export type ShortcutKind = 'ai' | 'log';

export const SHORTCUTS: Record<ShortcutKind, { name: string; blurb: string }> = {
  ai: { name: 'MyFood AI', blurb: 'Say or type anything ("had two eggs and a coffee", "bought milk and bread") and the AI logs it.' },
  log: { name: 'Log meal', blurb: 'Pick a preset or cooked meal from your list (it preselects the one for this time of day) and it is logged at once.' },
};

export function shortcutText(kind: ShortcutKind, origin: string, token?: string | null): string {
  const tok = token || '<PASTE YOUR TOKEN HERE>';
  const auth = `Header "Authorization" = "Bearer ${tok}"`;
  const { name } = SHORTCUTS[kind];
  return kind === 'ai'
    ? `Create a shortcut named "${name}" that works with Siri (say "${name}"):
1. Dictate Text (or Ask for Input, type Text, prompt "What did you eat or buy?").
2. Get Contents of URL: URL "${origin}/api/shortcut", Method POST, ${auth}, Header "Content-Type" = "application/json", Request Body JSON with two Text fields: "mode" = "ai" and "text" = the Dictated Text from step 1.
3. Get Dictionary Value for the key "reply" from the Contents of URL.
4. Speak Text and Show Result with that value.`
    : `Create a shortcut named "${name}" that works with Siri (say "${name}"):
1. Get Contents of URL: URL "${origin}/api/shortcut/meals", Method GET, ${auth}.
2. Get Dictionary Value for the key "meals" from the Contents of URL, then Choose from List with prompt "Which meal?" (preselect the value of the key "suggested" if you can; a dictated name works too).
3. Get Contents of URL: URL "${origin}/api/shortcut", Method POST, ${auth}, Header "Content-Type" = "application/json", Request Body JSON with two Text fields: "mode" = "log" and "meal" = the Chosen Item from step 2.
4. Get Dictionary Value for the key "reply" from the Contents of URL.
5. Speak Text and Show Result with that value.`;
}
