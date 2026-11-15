# Siri Shortcuts: plan and how it works

## The problem
Until now there was one Shortcut recipe (`POST /api/shortcut {text}`) that matched a preset name and otherwise fell back to the AI.
In practice it only ever did "breakfast". Two jobs, two shortcuts:

| Shortcut | Say | Does | Request |
|---|---|---|---|
| **MyFood AI** | "Hey Siri, MyFood AI" | Dictate anything, the AI turns it into events (eat/buy/cook) and logs them | `POST /api/shortcut {"mode":"ai","text":"..."}` |
| **Log meal** | "Hey Siri, Log meal" | Pick a preset or cooked meal from a list, logged instantly (no AI, no wait) | `GET /api/shortcut/meals`, then `POST /api/shortcut {"mode":"log","meal":"Lunch"}` |

## Server (done)
- `mode: "ai"` always asks the AI, even when the text equals a preset name.
- `mode: "log"` logs a **preset** (all its lines) or a **cooked meal** (`portions`, default 1; 1 portion = `portion_g` grams, or one portion unit).
  Names match loosely: exact, starts with, contains, or "my lunch please" containing "lunch". Presets win over cooked meals.
  `meal` left out = the preset whose usual hour is closest to now, so "Log meal" at 19:00 picks Dinner without asking.
- `GET /api/shortcut/meals` returns `{ meals: [...names], suggested }` for Choose from List. It works with the same token.
- A token with the `shortcut` scope can call only those routes (plus `/api/health`). It cannot read the pantry.
- The old call (`text` or `preset` without `mode`) behaves as before, so existing Shortcuts keep working.

## App (done)
Me tab, Siri Shortcut card: create a token, then **Copy setup text** for each shortcut. The text is a plain description
(URL, method, headers, JSON body, each step), made for Shortcuts' AI builder ("describe your shortcut"; Siri/Apple Intelligence can
build a shortcut from text) and equally usable as a by-hand checklist. If you just created the token, it is already inside the text;
otherwise it says `<PASTE YOUR TOKEN HERE>`.

## Set it up (2 minutes)
1. Me tab, Siri Shortcut: name a token (e.g. "iPhone"), **Create**. Keep the page open, the token shows once.
2. Tap **Copy setup text** under *MyFood AI*. Shortcuts app, **+**, describe/paste the text. Check the result looks like the steps, **Done**.
3. Repeat for *Log meal*.
4. Say "Hey Siri, MyFood AI" or "Hey Siri, Log meal". The shortcut's name is the phrase.

## Not done / limits
- Shortcut files (`.shortcut`) cannot be shipped signed from here, hence the text route.
- The AI call is synchronous (can take up to the AI timeout, 180 s). Shortcuts waits for it; `async` is accepted but unused.
- Choose from List needs a tap; dictating a name into Ask for Input instead also works (loose matching).
