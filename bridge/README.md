# Google Sheet bridge (Rabbit POS ⇄ "Reception - RABBIT TREE")

A small Apps Script of its own (Rabbit-System is not changed). The POS server calls it to:
- read the guests in house (`24datafeed` col C + `New guest` col F) for the guest search;
- send every closed bill: all go to a new tab **POS sales**; bills put on a guest (*Unpaid*) also go to **Entries**,
  so they show in Rabbit-System's Guest bills and are paid at reception.
- It also creates a tab **POS sync** (ids already written: a bill sent twice is written once).

## Set up (10 minutes, once)
1. Go to <https://script.google.com> → **New project**, name it `Rabbit POS bridge`.
2. Replace the code with `bridge/Code.gs`, save.
3. ⚙ **Project settings** → **Script properties** → add:
   - `SHEET_ID` = the id in the Sheet address (`docs.google.com/spreadsheets/d/`**THIS_PART**`/edit`)
   - `SECRET` = a long random word (e.g. 30 letters and digits)
   - (leave `WRITE_ENTRIES` out for now)
4. **Deploy** → **New deployment** → type **Web app**; Execute as: **Me**; Who has access: **Anyone** → Deploy,
   allow access, copy the address ending in `/exec`.
5. On the reception PC, in the POS folder:
   `npm run config -- sheet_url=https://script.google.com/macros/s/…/exec sheet_secret=THE_SAME_SECRET`
   then `npm run config -- check`. It shows the sheet name, guests, and the **Entries** header, the last real rows
   and the row the POS would write.
6. When that preview lines up with the real rows (type, sub, seller…: adjust `CFG` / `entryRow_` at the top of the
   script if needed), add the property `WRITE_ENTRIES` = `yes`. Until then, guest bills wait safely in the POS
   (the till shows "Sheet: … waiting") and nothing is written to Entries.
7. Restart the POS (`start.bat`).

After changing the script: **Deploy → Manage deployments → Edit → Version: New version** (the address stays the same).

## Notes
- Paid bills (bar till) only go to **POS sales**, not Entries, so the reception cash count is not mixed with the bar.
  With `till: 'reception'` this is still to decide (see CLAUDE.md).
- No internet: sales wait in `data/pos.db` (outbox) and leave in order when it is back. The chip "Sheet" on the till
  sends them right away when tapped.
