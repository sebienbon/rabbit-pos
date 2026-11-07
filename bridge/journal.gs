/**
 * Rabbit POS → "POS Bar" tab of the Reception Google Sheet.
 * A small Apps Script of its own (Rabbit-System is not touched): it only ADDS rows to the "POS Bar" tab,
 * one row per item of every bill closed at the POS (paid at the bar, or put on a guest's bill = "Unpaid").
 * This tab is a journal for reading: nothing in Entries, nothing in the reception totals.
 *
 * Setup (once): script.google.com › New project › paste this file › put the two values below ›
 * Deploy › New deployment › Web app (Execute as: Me, Who has access: Anyone) › copy the /exec address ›
 * on the POS PC: npm run config -- journal_url=<that address> journal_secret=<the SECRET below>
 * The same project also holds stock.gs (stock & purchasing tabs of "Accounting Processor 2026"): paste both files.
 */
var SHEET_ID = 'PUT_THE_SHEET_ID_HERE';   // docs.google.com/spreadsheets/d/<THIS PART>/edit
var SECRET = 'PUT_A_LONG_RANDOM_WORD_HERE'; // the same word goes in the POS (journal_secret); keep it out of GitHub

var TAB = 'POS Bar';
var HEADER = ['Date', 'Time', 'Bill', 'Who', 'Kind', 'Table', 'Item', 'Category', 'Bar / Kitchen', 'Qty', 'Unit price',
  'Total', 'Payment', 'Bar service', 'Staff', 'POS id'];
var TZ = 'Asia/Makassar';

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SECRET || SECRET.indexOf('PUT_') === 0 || req.secret !== SECRET) throw new Error('bad secret');
    if (req.action) out = stockAction_(req); // stock & purchasing (stock.gs, same project)
    else out = addBill_(SpreadsheetApp.openById(SHEET_ID), String(req.id || ''), req.bill);
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'Rabbit POS journal' })).setMimeType(ContentService.MimeType.JSON);
}

function addBill_(ss, id, b) {
  if (!/^POSJ-\d+-\d+$/.test(id) || !b || !b.lines || !b.lines.length) throw new Error('empty bill');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss.getSheetByName(TAB);
    if (!sh) {
      sh = ss.insertSheet(TAB);
      sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var last = sh.getLastRow(), idCol = HEADER.length;
    // Sent twice (answer lost on the way back): written once. Ids are at the end of the tab, look there first.
    if (last > 1) {
      var from = Math.max(2, last - 1999);
      var ids = sh.getRange(from, idCol, last - from + 1, 1).getValues();
      for (var i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === id) return { ok: true, duplicate: true };
    }
    var at = new Date(b.at);
    var day = Utilities.parseDate(Utilities.formatDate(at, TZ, 'yyyy-MM-dd'), TZ, 'yyyy-MM-dd');
    var time = Utilities.formatDate(at, TZ, 'HH:mm');
    var kind = { guest: 'Guest', external: 'External', walkin: 'Walk-in' }[b.kind] || String(b.kind || '');
    var rows = b.lines.map(function (l) {
      return [day, time, Number(b.tabId) || '', String(b.who || ''), kind, String(b.table || ''), String(l.product || ''),
        String(l.category || ''), String(l.stationName || (l.station === 'kitchen' ? 'Kitchen' : 'Bar')), Number(l.qty) || 0, Number(l.unit) || 0,
        Number(l.total) || 0, String(b.pay || ''), b.shiftId ? Number(b.shiftId) : '', String(b.author || ''), id];
    });
    var r = last + 1;
    sh.getRange(r, 1, rows.length, HEADER.length).setValues(rows);
    sh.getRange(r, 1, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sh.getRange(r, 11, rows.length, 2).setNumberFormat('#,##0');
    return { ok: true, rows: rows.length };
  } finally {
    lock.releaseLock();
  }
}
