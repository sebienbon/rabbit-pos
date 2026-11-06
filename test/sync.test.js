// Google Sheet bridge: bridge/Code.gs runs here against a fake spreadsheet, behind a local HTTP server,
// and the POS worker (server/sync.js) talks to it like it would to Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { openDb, getSettings, setSettings } from '../server/db.js';
import { createUser, login, userFromToken } from '../server/auth.js';
import * as O from '../server/orders.js';
import { seedDemo } from '../server/seed.js';
import { pushOutbox, pullGuests, syncStatus } from '../server/sync.js';

// ---- a tiny fake of the Google services used by Code.gs ----
function fakeSheet(name, rows = []) {
  const sh = { name, rows: rows.map(r => [...r]), frozen: 0 };
  Object.assign(sh, {
    getName: () => name,
    getLastRow: () => sh.rows.length,
    getLastColumn: () => Math.max(0, ...sh.rows.map(r => r.length)),
    appendRow: r => sh.rows.push([...r]),
    setFrozenRows: n => { sh.frozen = n; },
    getRange: (row, col, nr = 1, nc = 1) => ({
      getValues: () => sh.rows.slice(row - 1, row - 1 + nr).map(r => Array.from({ length: nc }, (_, i) => r[col - 1 + i] ?? '')),
      getDisplayValues() { return this.getValues().map(r => r.map(v => v instanceof Date ? v.toISOString() : String(v))); },
      setValues: vals => vals.forEach((v, i) => { sh.rows[row - 1 + i] = [...v]; }),
    }),
  });
  return sh;
}
function bridge({ writeEntries = true } = {}) {
  const ENTRIES_HEADER = 'date,type,sub,obj,qty,unit,total,real,author,unitCost,cost,realCost,guest,pay,ts,past,comment,_,status,seller'.split(',');
  const tabs = {
    Entries: fakeSheet('Entries', [ENTRIES_HEADER, ['2026-11-05', 'Sale', 'Room', 'Dorm', 1, 150000]]),
    '24datafeed': fakeSheet('24datafeed', [['a', 'b', 'Guest name'], ['', '', 'Hiro Tanaka'], ['', '', ' Jonas  Keller '], ['', '', '']]),
    'New guest': fakeSheet('New guest', [['', '', '', '', '', 'Name'], ['', '', '', '', '', 'Maya Smith'], ['', '', '', '', '', 'hiro tanaka']]),
  };
  const ss = { getName: () => 'Reception - RABBIT TREE', getSheetByName: n => tabs[n] || null, insertSheet: n => (tabs[n] = fakeSheet(n)) };
  const props = { SHEET_ID: 'sheet1', SECRET: 's3cret', WRITE_ENTRIES: writeEntries ? 'yes' : '' };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'sheet1'); return ss; } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} }, JSON, Date, String, Math, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../bridge/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { tabs, props, post };
}

// Local web server in front of the fake script (down = no internet).
async function serve(b) {
  const st = { down: false, calls: 0 };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      st.calls++;
      if (st.down) { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>Bad gateway</html>'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b.post(JSON.parse(body))));
    });
  }).listen(0);
  await new Promise(r => server.once('listening', r));
  const stop = () => { server.closeAllConnections(); server.close(); };
  return { st, server: { close: stop }, url: `http://127.0.0.1:${server.address().port}/exec` };
}

function pos(url) {
  const db = openDb(':memory:');
  createUser(db, { name: 'Owner', role: 'owner', pin: '1234' });
  seedDemo(db);
  setSettings(db, { sheet_url: url, sheet_secret: 's3cret' });
  const c = userFromToken(db, login(db, '4444', 't').token);
  const pid = n => db.prepare('SELECT id FROM products WHERE name = ?').get(n).id;
  const gid = n => db.prepare('SELECT rowid AS id FROM guests WHERE name = ?').get(n).id;
  const sell = (who, items, close) => {
    const s = getSettings(db);
    const o = O.createOrder(db, s, { ...who, items: items.map(([n, qty]) => ({ productId: pid(n), qty })) }, c);
    O.closeTab(db, s, o.tabId, close, c);
    return o.tabId;
  };
  return { db, s: () => getSettings(db), sell, gid };
}

test('bridge script: secret, guests, guest bill to Entries, paid sale only in POS sales, no double write', () => {
  const b = bridge();
  assert.match(b.post({ secret: 'nope', action: 'ping' }).error, /bad secret/);
  assert.equal(b.post({ secret: 's3cret', action: 'ping' }).sheet, 'Reception - RABBIT TREE');
  assert.deepEqual(b.post({ secret: 's3cret', action: 'guests' }).guests, ['Hiro Tanaka', 'Jonas Keller', 'Maya Smith']);

  const sale = { at: '2026-11-06T05:00:00.000Z', tabId: 7, guest: 'Hiro Tanaka', kind: 'guest', pay: 'Unpaid', till: 'bar', author: 'Komang',
    lines: [{ product: 'Bintang', category: 'Beer & drinks', qty: 2, unit: 40000, total: 80000 }, { product: 'Burger', category: 'Food', qty: 1, unit: 85000, total: 85000 }] };
  assert.deepEqual(b.post({ secret: 's3cret', action: 'sale', id: 'x1', data: sale }), { ok: true, entries: 2 });
  assert.deepEqual(b.post({ secret: 's3cret', action: 'sale', id: 'x1', data: sale }), { ok: true, duplicate: true });
  const en = b.tabs.Entries.rows;
  assert.equal(en.length, 4);
  const row = Object.fromEntries(en[0].map((h, i) => [h, en[2][i]]));
  assert.equal(row.obj, 'Bintang'); assert.equal(row.qty, 2); assert.equal(row.total, 80000);
  assert.equal(row.guest, 'Hiro Tanaka'); assert.equal(row.pay, 'Unpaid'); assert.equal(row.comment, 'POS bill #7');
  assert.equal(en[2].length, 20);

  const paid = { ...sale, tabId: 8, guest: '', kind: 'walkin', pay: 'Cash', lines: sale.lines.slice(0, 1) };
  assert.deepEqual(b.post({ secret: 's3cret', action: 'sale', id: 'x2', data: paid }), { ok: true, entries: 0 });
  assert.equal(b.tabs.Entries.rows.length, 4, 'a sale paid at the bar does not touch Entries');
  assert.equal(b.tabs['POS sales'].rows.length, 1 + 2 + 1);

  const peek = b.post({ secret: 's3cret', action: 'peek' });
  assert.equal(peek.header[13], 'pay'); assert.equal(peek.preview[13], 'Unpaid'); assert.equal(peek.preview.length, peek.header.length);
});

test('bridge script: guest bills are refused (and wait) while Entries writing is off', () => {
  const b = bridge({ writeEntries: false });
  const d = { at: new Date().toISOString(), tabId: 1, guest: 'Maya Smith', pay: 'Unpaid', lines: [{ product: 'Mojito', category: 'Beer & drinks', qty: 1, unit: 85000, total: 85000 }] };
  assert.match(b.post({ secret: 's3cret', action: 'sale', id: 'y', data: d }).error, /WRITE_ENTRIES/);
  assert.equal(b.tabs.Entries.rows.length, 2);
  assert.equal(b.tabs['POS sales'], undefined);
});

test('POS worker: guest list in, sales out, waits when offline, sends later once', async () => {
  const b = bridge();
  const { st, server, url } = await serve(b);
  const p = pos(url);
  try {

  assert.equal(await pullGuests(p.db, p.s()), 3);
  assert.deepEqual(p.db.prepare('SELECT name FROM guests ORDER BY name').all().map(r => r.name), ['Hiro Tanaka', 'Jonas Keller', 'Maya Smith']);

  p.sell({ guestId: p.gid('Maya Smith') }, [['Mojito', 2]], { charge: true });
  st.down = true;
  p.sell({ walkin: true }, [['Espresso', 1]], { payment: 'Cash' });
  assert.equal(await pushOutbox(p.db, p.s()), 0);
  let y = syncStatus(p.db, p.s());
  assert.equal(y.waiting, 2); assert.match(y.error, /502/);
  const calls = st.calls;
  assert.equal(await pushOutbox(p.db, p.s()), 0); assert.equal(st.calls, calls, 'waits before trying again');

  st.down = false;
  assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 2);
  y = syncStatus(p.db, p.s()); assert.equal(y.waiting, 0); assert.equal(y.error, null);
  const maya = b.tabs.Entries.rows.filter(r => r[12] === 'Maya Smith');
  assert.equal(maya.length, 1); assert.equal(maya[0][6], 170000);
  assert.equal(b.tabs['POS sales'].rows.length, 3);

  // Sent again (answer lost): written once.
  p.db.exec('UPDATE outbox SET sent_at = NULL');
  assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 2);
  assert.equal(b.tabs['POS sales'].rows.length, 3);

  // An empty guest answer does not wipe the list.
  b.tabs['24datafeed'].rows.length = 1; b.tabs['New guest'].rows.length = 1;
  assert.equal(await pullGuests(p.db, p.s()), 0);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM guests').get().n, 3);
  } finally { server.close(); }
});

test('POS worker: a refused guest bill does not block the paid sales behind it', async () => {
  const b = bridge({ writeEntries: false });
  const { server, url } = await serve(b);
  const p = pos(url);
  try {
  await pullGuests(p.db, p.s());
  p.sell({ guestId: p.gid('Hiro Tanaka') }, [['Bintang', 1]], { charge: true });
  p.sell({ walkin: true }, [['Espresso', 1]], { payment: 'QRIS' });
  assert.equal(await pushOutbox(p.db, p.s()), 1);
  const y = syncStatus(p.db, p.s());
  assert.equal(y.waiting, 1); assert.match(y.error, /WRITE_ENTRIES/);
  b.props.WRITE_ENTRIES = 'yes';
  assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
  assert.equal(b.tabs.Entries.rows.at(-1)[12], 'Hiro Tanaka');
  } finally { server.close(); }
});
