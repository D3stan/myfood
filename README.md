<h1 align="center">MyFood</h1>

<p align="center">
  A shared pantry that an AI keeps up to date.<br>
  Tell it what you bought, cooked or ate, and the stock follows.
</p>

<p align="center">
  <img src="docs/media/demo.gif" alt="MyFood demo: a message, a voice note and a receipt photo each update the pantry" width="300">
</p>

---

> **Personal project.** MyFood runs on my homelab for two people sharing a kitchen.
> It is not production-ready, has no support or stability guarantees, and its
> defaults assume a small, trusted setup.

## The idea

Keeping a pantry list accurate is tedious, so nobody does it. MyFood moves that work
to an AI: you describe what happened in plain words, and the model turns it into
stock changes.

- **Text** — "had breakfast", "made 4 portions of bolognese with the minced beef".
- **Voice** — the same sentences, dictated through Siri Shortcuts.
- **Photo** — a receipt or a screenshot of an order, Danish included.

Every change is an event you can review, edit or undo, so the AI never has the last word.

## Bring your own assistant

The whole pantry is exposed as an MCP server, so Claude, ChatGPT, Gemini, Cursor or
any other MCP client can read and change it directly: log a meal, plan a shopping
trip, check what is about to run out. Each member gets their own token, and every
tool acts as that member.

## What it tracks

| | |
|---|---|
| **Stock** | Items counted in the unit you eat them in: eggs by piece, cheese by slice, pasta by weight. |
| **Cooking** | Batches cooked from ingredients, eaten later by the portion. |
| **Nutrition** | kcal, protein and fat per item; a meal's totals are summed from its ingredients. |
| **Spending** | Shared expenses and a weekly settle-up between members. |
| **Deals** | Offers from local store catalogs, matched to what you usually buy. |
| **Barcodes** | Scan a product to find or create the item. |

## Under the hood

TypeScript run directly by Node, Hono, SQLite (`node:sqlite`), a vanilla TypeScript
PWA built with Vite, and Vitest. The AI backend is pluggable: a local CLI agent or any
OpenAI-compatible API, always constrained to return JSON against a schema.

## Running it

See [RUNNING.md](RUNNING.md) for local development, AI configuration, deployment,
MCP clients, the guest view and Siri Shortcuts.
