# Rabbit POS — context for Claude (read this, not the old chat history)

Bar & restaurant POS of **Rabbit Tree** (hostel, Indonesia). Owner: Sébastien. UI language: **English**.
Separate from **Rabbit-System** (github.com/sebienbon/Rabbit-System = reception PWA on Google Apps Script + the
"Reception - RABBIT TREE" Google Sheet). Do NOT modify or load Rabbit-System to work here: the only link is the Sheet.

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
- `sync.js` Sheet worker (guests in every 10 min, outbox out every 30 s, offline back-off) · `config.js` CLI options + `check`
- `bridge/Code.gs` standalone Apps Script web app (ping, guests, sale, peek) + `bridge/README.md` setup
- `public/pos.*` till screen (PIN + sell + bills + guest-order validation + "Sheet" chip when sales wait)
- `test/core.test.js`, `test/sync.test.js` (runs Code.gs in node:vm on a fake Sheet) — `npm test` must stay green.
  Try the UI: `npm run demo` → http://localhost:8080

## Status / next steps
1. ✅ Phase 1: server, roles, options, orders, tabs, printing queue, till screen, 11 tests.
2. ✅ Sheet bridge (code + 4 tests). Every sale → tab `POS sales`; Unpaid (guest bill) → also `Entries`
   (columns: date,type,sub,obj,qty,unit,total,real,author,unitCost,cost,realCost,guest,pay,ts,past,comment,_,status,seller).
   Entries writing is OFF until script property `WRITE_ENTRIES=yes` (guest bills wait in the outbox meanwhile).
   TO CONFIRM with the owner after deploy (`npm run config -- check` shows the preview): values of type ('Sale'),
   sub (POS category), real, seller ('Bar POS'), status. `till: 'reception'` mapping to the reception shift still open.
3. Guest ordering pages (QR phone + self-service tablet) using `/api/client/*` (key in the link), photos upload.
4. Owner options screen, catalog import from the Loyverse CSV export, users/PIN management, printer setup screen.
5. Waiter phone screen, reception view of open bills, bar till shift open/close + cash count.
6. Windows install: Node + `start.bat` at boot, daily backup of `data/pos.db`.
