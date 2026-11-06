# Rabbit POS — context for Claude (read this, not the old chat history)

Bar & restaurant POS of **Rabbit Tree** (hostel, Indonesia). Owner: Sébastien. UI language: **English**.
Separate from **Rabbit-System** (github.com/sebienbon/Rabbit-System = reception PWA on Google Apps Script + the
"Reception - RABBIT TREE" Google Sheet). Do NOT modify Rabbit-System: the POS talks to its existing web app API
(dev/server/30.UI_api.gs: login / pull / push) as the user `bar-pos` of the UI_Users tab.

## Decisions (owner, Nov 2026)
- Runs on the **reception PC** (Windows, little RAM) as a local Node server; tablets/phones use it over the wifi.
  Everything always goes through it (no fallback switching). Google Sheet gets data in the background.
- Node ≥ 22.13, **zero npm dependencies** (node:sqlite, node:http, SSE for live updates, node:net for printers).
- Roles (PIN 4–6 digits): owner, manager, cashier, waiter, reception. Permissions in `server/auth.js`.
- Owner options (`server/db.js` DEFAULT_SETTINGS): service charge OFF by default, tax (PB1) off, waiter validation of
  guest orders OFF (built, optional), tables OFF (built, optional), QR + self-service tablet ordering ON, external guests ON,
  photos ON, `till`: 'bar' (own cash drawer) with option 'reception' (unified) — owner needs a separate till later.
- Guest bills: "Put on the guest bill" closes the tab as **Unpaid** with the guest name → outbox → Sheet `Entries`
  so it shows in Rabbit-System's Guest bills and is paid at reception (existing flow, no Rabbit-System change).
- Guests list = names from Sheet tabs `24datafeed` (col C) and `New guest` (col F), like Rabbit-System `readGuests_`.
- Printers: cheap ESC/POS **LAN** printers, port 9100; stations `bar`, `kitchen`, `receipt` (category decides the station).
- Brand: palette, Baloo 2 + Nunito fonts and logos copied from Rabbit-System (`public/`).
- Mockups (Claude Design canvas "Maquettes POS"): till, PIN, QR guest search, waiter phone, reception, guest menu
  phone + tablet with photos, owner options.

## Layout
- `server/db.js` schema + settings · `auth.js` PIN/roles · `orders.js` tabs, orders, totals, close (pay / charge)
- `print.js` ESC/POS tickets + queue + TCP send · `app.js` HTTP API + SSE · `index.js` start · `seed.js` demo data
- `sync.js` link with Rabbit-System (login, `pull` guests every 30 min, `push` op `sale` every 30 s, offline back-off,
  re-login, new line ids after a `ts_collision`) · `config.js` CLI options + `check`
- `bridge/journal.gs` small separate Apps Script (SHEET_ID + SECRET written in it, never commit the filled copy): appends
  every closed POS bill to the Sheet tab **"POS Bar"** (one row per item, paid or Unpaid; journal only, not in Entries).
  POS side: outbox type `journal` → `journal_url` / `journal_secret`, independent of the Rabbit-System link.
  Deployed 06/11 in the owner's Apps Script project "POS" (Execute as Me, access Anyone), tested live: tab created.
  Redeploy with Manage deployments › Edit › New version (keeps the address).
- `shift.js` bar service: open (cash count, gap vs what was left) / close (counted, handed over = BAR Cash-out, difference),
  day report (cards of the bar). Bar till: taking money needs an open service; a guest bill does not.
- Photos: kept **in git** in `photos/` (owner's choice, 06/11): `POST /api/products/:id/photo` (raw JPEG/PNG/WebP ≤ 3 MB)
  → `photos/p<id>-<hash>.<ext>`, served by the PC at /photos/ (immutable). Keep them ~800 px, < 300 KB.
  Devices: ETag/304 on app files; service worker `public/sw.js` + manifest only where allowed (localhost/https, not http://192.168…).
- `public/menu.*` guest ordering, one page: phone from the QR (`/menu.html?key=…&table=…`) and self-service tablet
  (`&mode=tablet`, resets 20 s after an order / 2 min idle). EN/FR/ID. Guest = room bill; external = pays at the bar.
  Phone sends the masked name it showed (`guestName`): server refuses (409) if that id is now someone else.
  Guest ids stay stable across Sheet refreshes (`replaceGuests` upserts). Order status: `GET /api/client/orders/:id`.
- `public/qr.html` printable QR codes (owner/manager token from the till; `GET /api/staff/order-links`),
  `public/vendor/qrcode.mjs` (qrcode-generator 2.0.4, MIT, vendored).
- `public/pos.*` till screen (PIN + sell + bills + guest-order validation + "Sheet" chip when sales wait)
- `test/core.test.js`, `test/sync.test.js` — `npm test` must stay green. sync tests run Rabbit-System's REAL
  30.UI_api.gs in node:vm (`test/helpers/gas-fake.js`); set RABBIT_SYSTEM_GS=path/to/30.UI_api.gs, else 3 are skipped.
  Try the UI: `npm run demo` → http://localhost:8080

## Set-aside sub-tasks
`BACKLOG.md` (in French, for the owner): every sub-task met on the way and left for later goes there (where, why, what to do),
and is ticked when done. Read it before calling the project finished.

## Status / next steps
1. ✅ Phase 1: server, roles, options, orders, tabs, printing queue, till screen, 11 tests.
2. ✅ Sheet link via Rabbit-System's API (checked live 06/11: login ok, 143 guests). Only bills put on a guest go:
   op `sale`, payment Unpaid, one line per item → Entries + Entries Manual (type Income, sub **Service**, object **Bar**
   for drinks / **Restaurant** for the kitchen station, item in the comment — owner 06/11; author 'Bar POS' without @ =
   no commission), shown in Guest bills. Paid bills stay in the POS (bar cash).
   Account `bar-pos` (role **manager**, needed by Rabbit-System's `bar_cashout`) in UI_Users; password only in the POS settings (`npm run config`), never in git.
   `till: 'reception'` mapping to the reception shift still open.
2b. ✅ Bar/reception money rules (doc "Rabbit POS — décisions caisse bar / réception"): every payment belongs to the till that
   receives it; bar cash counted per service; handed-over cash → op `bar_cashout` (Entries Manual "BAR Cash-out", never Entries);
   cards checked per day for both terminals. Card settlement fix on the Rabbit-System side: BACKLOG.md #1.
3. ✅ Guest ordering pages (QR phone + self-service tablet) + printable QR codes. Photo upload screen → phase 4.
4. Owner options screen, catalog import from the Loyverse CSV export, users/PIN management, printer setup screen.
5. Waiter phone screen, reception view of open bills, bar till shift open/close + cash count.
6. Windows install: Node + `start.bat` at boot, daily backup of `data/pos.db`.
