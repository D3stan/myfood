#!/usr/bin/env node
// Stand-in for `agy` in tests and local development (AI_CMD="node scripts/fake-agy.mjs").
// FAKE_AGY: ok (default) | garbage | wrong-shape | denied | exit-nonzero | not-signed-in | slow
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const mode = process.env.FAKE_AGY || 'ok';
const out = (o) => console.log(JSON.stringify({ conversation_id: 'fake', status: 'SUCCESS', duration_seconds: 0.1, num_turns: 1, ...o }));

// The part of the prompt between the markers is what the user typed; the images line names the receipts or fridge photos.
const user = (prompt.match(/USER MESSAGE[^\n]*\n([\s\S]*?)\nEND DATA-/) ?? [])[1] ?? '';
const isAudit = /^Mode:\s*audit$/m.test(prompt);
const hasImages = /(?:RECEIPT|FRIDGE AUDIT) IMAGES \(read only these\)/.test(prompt);

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
  const cooked = /\bportion/i.test(user) && prompt.match(/^(\d+) \| ([^|]+) \| (?:g|portion) \|[^\n]*\| cooked\b/m);
  if (preset) {
    const lines = [...preset[2].matchAll(/item (\d+) x ([\d.]+)/g)].map((m) => ({ item_id: +m[1], new_item: null, qty: +m[2], raw: null }));
    result = { reply: 'Logged your breakfast.', events: [{ kind: 'eat', preset_id: +preset[1], lines }] };
  } else if (isAudit) {
    const first = prompt.match(/^(\d+) \| [^|]+ \| (?:pc|slice|g|ml|level|portion) \|/m);
    if (first) {
      result = {
        reply: 'Checked your fridge photo against pantry stock.',
        events: [{
          kind: 'adjust',
          preset_id: null,
          lines: [{ item_id: +first[1], new_item: null, qty: 2, raw: 'opened pack in fridge', expires_in_days: 3 }],
        }],
      };
    } else {
      result = { reply: 'Fridge matches your pantry.', events: [] };
    }
  } else if (hasImages) {
    const first = prompt.match(/^(\d+) \| [^|]+ \| (?:pc|slice|g|ml|level|portion) \|/m); // first catalog item, if any
    const lines = [{
      item_id: null,
      new_item: {
        name: 'Butter',
        emoji: '🧈',
        category: 'dairy',
        unit: 'g',
        step: 10,
        pack_size: 250,
        owner: /\bmy\b/i.test(user) ? 'mine' : 'shared',
        kcal_per_unit: 7.17,
        protein_per_unit: 0.008,
        fat_per_unit: 0.81,
        carbs_per_unit: 0.006,
        expires_in_days: 30,
      },
      qty: 250,
      raw: 'LURPAK SMØR 250G',
      price: 28.5,
      expires_in_days: 30,
    }];
    if (first) lines.push({ item_id: +first[1], new_item: null, qty: 1, raw: 'FIRST CATALOG ITEM', price: 29, expires_in_days: 14 });
    const total_cost = lines.reduce((sum, l) => sum + (l.price ?? 0), 0);
    result = { reply: `Found ${lines.length} things on the receipt.`, events: [{ kind: 'buy', preset_id: null, total_cost, lines }] };
  } else if (/\b(?:cooked|cook|batch|prepped)\b/i.test(user)) {
    const beef = prompt.match(/^(\d+) \| Minced beef \|/m);
    const pasta = prompt.match(/^(\d+) \| Fusilli \|/m);
    const ingredients = [];
    if (beef) ingredients.push({ item_id: +beef[1], qty: 500 });
    if (pasta) ingredients.push({ item_id: +pasta[1], qty: 400 });
    const existingMeal = prompt.match(/^(\d+) \| ([^|]+) \| (?:g|portion) \|[^\n]*\| cooked\b/m);
    result = {
      reply: 'Logged your cooked meal batch.',
      events: [],
      cook: [{
        meal_item_id: existingMeal ? +existingMeal[1] : null,
        name: existingMeal ? null : 'Chili',
        emoji: existingMeal ? null : '🍲',
        portions: 4,
        total_g: 1200,
        expires_in_days: 4,
        owner: /\bmy\b/i.test(user) ? 'mine' : 'shared',
        kcal_total: ingredients.length ? null : 1600,
        protein_total: ingredients.length ? null : 110,
        carbs_total: ingredients.length ? null : 150,
        ingredients,
      }],
    };
  } else if (cooked) {
    result = {
      reply: `Logged 1 portion of ${cooked[2].trim()}.`,
      events: [{
        kind: 'eat',
        preset_id: null,
        lines: [{ item_id: +cooked[1], new_item: null, qty: 1, unit: 'portion', raw: null }],
      }],
    };
  }
  out({ structured_output: result });
}
