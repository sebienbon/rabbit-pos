/**
 * Rabbit POS ⇄ Reception Google Sheet bridge.
 * A standalone Apps Script (not inside Rabbit-System): it opens the Sheet by id and answers the POS server.
 * Setup: see bridge/README.md. Script properties needed: SHEET_ID, SECRET. Optional: WRITE_ENTRIES = yes.
 *
 * Actions (POST body = JSON text, always with "secret"):
 *   ping    -> { ok, sheet }                       check the link
 *   guests  -> { ok, guests: [names] }             24datafeed col C + New guest col F
 *   sale    -> { ok, entries, duplicate? }          one closed POS tab (see POS server/orders.js closeTab)
 *   peek    -> { ok, header, last, preview }        Entries header + last rows next to what the POS would write
 */

var CFG = {
  ENTRIES: 'Entries',
  GUEST_SOURCES: [['24datafeed', 3], ['New guest', 6]], // [tab, column number] — same as Rabbit-System readGuests_
  POS_SALES: 'POS sales',   // every POS sale, paid or not (the bar till's own record)
  POS_LOG: 'POS sync',      // ids already written, so a sale sent twice is written once
  // Entries columns, in order (Rabbit-System 30.UI_api.gs): what the POS writes for one line of a guest bill.
  // !! Check with the "peek" action (or previewEntries() below) before setting WRITE_ENTRIES = yes.
  ENTRY_TYPE: 'Sale',
  SELLER: 'Bar POS',
};

function entryRow_(d, line) {
  var at = new Date(d.at);
  return [
    at,                       // date
    CFG.ENTRY_TYPE,           // type
    line.category,            // sub
    line.product,             // obj
    line.qty,                 // qty
    line.unit,                // unit
    line.total,               // total
    line.total,               // real
    d.author || 'POS',        // author
    '', '', '',               // unitCost, cost, realCost
    d.guest,                  // guest
    d.pay,                    // pay  ('Unpaid' -> shows in Guest bills)
    new Date(),               // ts
    '',                       // past
    'POS bill #' + d.tabId,   // comment
    '',                       // _
    '',                       // status
    CFG.SELLER,               // seller
  ];
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('SECRET');
    if (!secret || req.secret !== secret) throw new Error('bad secret');
    var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    var writeEntries = String(props.getProperty('WRITE_ENTRIES') || '').toLowerCase() === 'yes';
    if (req.action === 'ping') out = { ok: true, sheet: ss.getName(), writeEntries: writeEntries };
    else if (req.action === 'guests') out = { ok: true, guests: readGuests_(ss) };
    else if (req.action === 'sale') out = writeSale_(ss, req.id, req.data, writeEntries);
    else if (req.action === 'peek') out = peek_(ss);
    else throw new Error('unknown action');
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'Rabbit POS bridge' })).setMimeType(ContentService.MimeType.JSON);
}

function readGuests_(ss) {
  var seen = {}, out = [];
  CFG.GUEST_SOURCES.forEach(function (src) {
    var sh = ss.getSheetByName(src[0]);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, src[1], sh.getLastRow() - 1, 1).getDisplayValues().forEach(function (r) {
      var name = String(r[0] || '').replace(/\s+/g, ' ').trim();
      if (name && !seen[name.toLowerCase()]) { seen[name.toLowerCase()] = 1; out.push(name); }
    });
  });
  return out;
}

function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
  return sh;
}

function writeSale_(ss, id, d, writeEntries) {
  if (!id || !d || !d.lines || !d.lines.length) throw new Error('empty sale');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var log = sheet_(ss, CFG.POS_LOG, ['id', 'written', 'tab', 'entries']);
    var ids = log.getLastRow() > 1 ? log.getRange(2, 1, log.getLastRow() - 1, 1).getValues() : [];
    for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(id)) return { ok: true, duplicate: true };

    var charged = d.pay === 'Unpaid';
    // A bill put on the guest must reach Guest bills: until Entries writing is switched on, refuse it so it waits in the POS.
    if (charged && !writeEntries) throw new Error('Entries writing is off (WRITE_ENTRIES)');

    var sales = sheet_(ss, CFG.POS_SALES, ['date', 'bill', 'guest', 'kind', 'product', 'category', 'qty', 'unit', 'total', 'pay', 'till', 'author']);
    var at = new Date(d.at);
    var rows = d.lines.map(function (l) { return [at, d.tabId, d.guest, d.kind, l.product, l.category, l.qty, l.unit, l.total, d.pay, d.till, d.author]; });
    sales.getRange(sales.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    var n = 0;
    if (charged) {
      var en = ss.getSheetByName(CFG.ENTRIES);
      if (!en) throw new Error('no Entries tab');
      var er = d.lines.map(function (l) { return entryRow_(d, l); });
      en.getRange(en.getLastRow() + 1, 1, er.length, er[0].length).setValues(er);
      n = er.length;
    }
    log.appendRow([id, new Date(), d.tabId, n]);
    return { ok: true, entries: n };
  } finally {
    lock.releaseLock();
  }
}

function peek_(ss) {
  var en = ss.getSheetByName(CFG.ENTRIES);
  if (!en) throw new Error('no Entries tab');
  var cols = en.getLastColumn(), last = en.getLastRow();
  var header = en.getRange(1, 1, 1, cols).getDisplayValues()[0];
  var from = Math.max(2, last - 2);
  var rows = last >= 2 ? en.getRange(from, 1, last - from + 1, cols).getDisplayValues() : [];
  var sample = { at: new Date().toISOString(), tabId: 0, guest: 'Test Guest', kind: 'guest', pay: 'Unpaid', till: 'bar', author: 'POS',
    lines: [{ product: 'Bintang', category: 'Beer & drinks', qty: 2, unit: 40000, total: 80000 }] };
  return { ok: true, header: header, last: rows, preview: entryRow_(sample, sample.lines[0]).map(String) };
}

// Run this from the editor (Run ▸ previewEntries) and read the log: the Entries header, the last real rows,
// and the row the POS would write. They must line up before WRITE_ENTRIES = yes.
function previewEntries() {
  var props = PropertiesService.getScriptProperties();
  var p = peek_(SpreadsheetApp.openById(props.getProperty('SHEET_ID')));
  Logger.log('HEADER  ' + JSON.stringify(p.header));
  p.last.forEach(function (r) { Logger.log('SHEET   ' + JSON.stringify(r)); });
  Logger.log('POS     ' + JSON.stringify(p.preview));
}
