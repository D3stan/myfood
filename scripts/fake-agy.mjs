#!/usr/bin/env node
// Stand-in for `agy` in tests and local development (AI_CMD="node scripts/fake-agy.mjs").
// FAKE_AGY: ok (default) | garbage | wrong-shape | denied | exit-nonzero | not-signed-in | slow
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const mode = process.env.FAKE_AGY || 'ok';
const out = (o) => console.log(JSON.stringify({ conversation_id: 'fake', status: 'SUCCESS', duration_seconds: 0.1, num_turns: 1, ...o }));

// The part of the prompt between the markers is what the user typed; the images line names the receipts.
const user = (prompt.match(/USER MESSAGE[^\n]*\n([\s\S]*?)\nEND DATA-/) ?? [])[1] ?? '';
const hasImages = /RECEIPT IMAGES \(read only these\)/.test(prompt);

if (mode === 'garbage') { console.log('this is not json'); process.exit(0); }
if (mode === 'wrong-shape') { out({ structured_output: { reply: 5, events: 'none' } }); process.exit(0); }
if (mode === 'denied') { out({ response: '', denied_actions: [{ action: 'read_file' }] }); process.exit(0); }
if (mode === 'not-signed-in') { console.error('Error: you are not logged in. Run agy to sign in.'); process.exit(1); }
if (mode === 'exit-nonzero') { console.error('boom'); process.exit(3); }
if (mode === 'slow') {
  // A grandchild in the same process group: the timeout has to kill it too.
  const kid = spawn('sleep', ['60'], { stdio: 'ignore' });
  if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, `${process.pid} ${kid.pid}`);
  setTimeout(() => {}, 60_000);
} else {
  let result = { reply: 'Nothing to log from that.', events: [] };
  const preset = /breakfast/i.test(user) && prompt.match(/^(\d+) \| Breakfast \| (.*)$/im);
  if (preset) {
    const lines = [...preset[2].matchAll(/item (\d+) x ([\d.]+)/g)].map((m) => ({ item_id: +m[1], new_item: null, qty: +m[2], raw: null }));
    result = { reply: 'Logged your breakfast.', events: [{ kind: 'eat', preset_id: +preset[1], lines }] };
  } else if (hasImages) {
    const first = prompt.match(/^(\d+) \| [^|]+ \| (?:pc|slice|g|ml|level) \|/m); // first catalog item, if any
    const lines = [{ item_id: null, new_item: { name: 'Butter', emoji: '🧈', category: 'dairy', unit: 'g', step: 10, pack_size: 250 }, qty: 250, raw: 'LURPAK SMØR 250G' }];
    if (first) lines.push({ item_id: +first[1], new_item: null, qty: 1, raw: 'FIRST CATALOG ITEM' });
    result = { reply: `Found ${lines.length} things on the receipt.`, events: [{ kind: 'buy', preset_id: null, lines }] };
  }
  out({ structured_output: result });
}
