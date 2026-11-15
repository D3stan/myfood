# MyFood

A small shared pantry for the kitchen: fractional slices, one-tap breakfast, editable stock, and a natural-language helper. The current prototype runs locally with a SQLite database and a clearly labeled demo assistant; it does not deploy anything by itself.

## Run it locally

Requirements: Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open the Vite URL printed in the terminal (usually `http://localhost:5173`). The demo starts with Puddu selected. To switch household member, use the PIN login on the Me tab: `1234` for Puddu or `2468` for Roomie. Data persists in `data/myfood.db`; delete that file to restore the sample pantry.

The default assistant understands common English and Danish notes such as “ate 2 eggs”, “købte 1 pack bacon”, and “made breakfast”. This predictable demo parser keeps the prototype useful without an AI login; the eventual `agy` integration and receipt-photo review are not connected yet.

To use a separate local API port, set both `PORT` and `API_PORT` to the same value. To point the database elsewhere, set `MYFOOD_DB`.

`npm run build` checks the TypeScript and builds the installable web shell. The service worker caches the UI; inventory writes still go through the local server.

