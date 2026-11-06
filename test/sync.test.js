// Link with Rabbit-System. The end-to-end tests run Rabbit-System's REAL server code (30.UI_api.gs, read from a
// checkout of github.com/sebienbon/Rabbit-System next to this folder, or RABBIT_SYSTEM_GS=path) in node:vm on an
// in-memory spreadsheet, behind a local HTTP server; they are skipped when that file is not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, getSettings, setSettings } from '../server/db.js';
import { createUser, login, userFromToken } from '../server/auth.js';
import * as O from '../server/orders.js';
import { seedDemo } from '../server/seed.js';
import * as T from '../server/shift.js';
import { pushOutbox, pullGuests, syncStatus, saleOp, tsOf, resetSyncState, callSheet } from '../server/sync.js';
import { rabbitSystem, loadGas } from './helpers/gas-fake.js';
import { readFileSync } from 'node:fs';

const GS = [process.env.RABBIT_SYSTEM_GS, '../../Rabbit-System/dev/server/30.UI_api.gs', '../../rabbit-system/dev/server/30.UI_api.gs']
  .filter(Boolean).map(p => p.startsWith('/') ? p : fileURLToPath(new URL(p, import.meta.url))).find(existsSync);
const real = { skip: GS ? false : 'Rabbit-System checkout not found (set RABBIT_SYSTEM_GS)' };

test('line ids: 17 digits in UTC+8, ids change after a refusal', () => {
  assert.equal(tsOf(Date.parse('2026-11-06T05:54:15.561Z')), '20261106135415561');
  const row = { id: 3, created_at: '2026-11-06T05:00:00.000Z', payload: JSON.stringify({ tabId: 9, at: '2026-11-06T05:00:00.000Z', guest: 'Hiro',
    lines: [{ product: 'Bintang', category: 'Beer', qty: 2, unit: 40000 }, { product: 'Service 5%', category: 'Service', qty: 1, unit: 4000 }] }) };
  const a = saleOp(row, {}), b = saleOp({ ...row, variant: 1 }, { sheet_category: 'F&B' });
  assert.equal(a.payload.payment, 'Unpaid'); assert.equal(a.payload.lines[0].category, 'Service'); assert.equal(a.payload.lines[0].object, 'Bar');
  assert.deepEqual(a.payload.lines.map(l => l.ts), ['20261106130000000', '20261106130000001']);
  assert.notEqual(a.id, b.id); assert.notEqual(a.payload.lines[0].ts, b.payload.lines[0].ts); assert.equal(b.payload.lines[0].category, 'F&B');
});

const H = n => [Array.from({ length: n }, (_, i) => 'col' + i)];
function sheetData() {
  const pay = ['', '', '', '', '', '', '', '', '', '', '', 'Service', 'Transport', 'Tour', 'Other', '', 'Payment type'];
  return {
    UI_Users: [['Username', 'Display name', 'Role', 'Author email', 'Set new password here', 'Password hash', 'Salt', 'Active'],
      ['bar-pos', 'Bar POS', 'manager', 'Bar POS', 'pw-123456', '', '', true]],
    UI_Log: H(10), UI_Shifts: H(13), Entries: H(20), 'Entries Manual': H(17), 'Cashouts&Cor': H(9), Settlements: H(10), Protect: H(5),
    'Data activities': [pay, ...['Cash', 'Card', 'Unpaid'].map(p => { const r = Array(17).fill(''); r[16] = p; return r; })],
    '24datafeed': [['', '', 'Guest'], ['', '', 'Hiro Tanaka'], ['', '', 'Jonas Keller']],
    'New guest': [['', '', '', '', '', 'Name'], ['', '', '', '', '', 'Maya Smith']],
  };
}

// Rabbit-System behind a local web server (down = no internet).
async function serve() {
  const rs = rabbitSystem(GS, sheetData());
  const st = { down: false, calls: [] };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const b = JSON.parse(body); st.calls.push(b.action);
      if (st.down) { res.writeHead(502, { 'Content-Type': 'text/html' }); return res.end('<html>Bad gateway</html>'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rs.doPost(b)));
    });
  }).listen(0);
  await new Promise(r => server.once('listening', r));
  const close = () => { server.closeAllConnections(); server.close(); };
  return { rs, st, close, url: `http://127.0.0.1:${server.address().port}/exec` };
}

function pos(url) {
  resetSyncState();
  const db = openDb(':memory:');
  createUser(db, { name: 'Owner', role: 'owner', pin: '1234' });
  seedDemo(db);
  setSettings(db, { sheet_url: url, sheet_user: 'bar-pos', sheet_password: 'pw-123456' });
  const c = userFromToken(db, login(db, '4444', 't').token);
  T.startShift(db, c, { counted: 0 });
  const pid = n => db.prepare('SELECT id FROM products WHERE name = ?').get(n).id;
  const gid = n => db.prepare('SELECT rowid AS id FROM guests WHERE name = ?').get(n).id;
  const sell = (who, items, close) => {
    const s = getSettings(db);
    const o = O.createOrder(db, s, { ...who, items: items.map(([n, qty]) => ({ productId: pid(n), qty })) }, c);
    O.closeTab(db, s, o.tabId, close, c);
    return o.tabId;
  };
  return { db, s: () => getSettings(db), sell, gid, user: c };
}
const unpaid = rs => rs.tabs.Entries.rows.slice(1).filter(r => r[13] === 'Unpaid');

test('Rabbit-System: guests in, guest bill out as Unpaid lines, paid bills stay in the POS', real, async () => {
  const { rs, close, url } = await serve();
  try {
    const p = pos(url);
    assert.equal(await pullGuests(p.db, p.s()), 3);
    assert.deepEqual(p.db.prepare('SELECT name FROM guests ORDER BY name').all().map(r => r.name), ['Hiro Tanaka', 'Jonas Keller', 'Maya Smith']);
    assert.ok(p.s().sheet_token, 'session kept');

    p.sell({ guestId: p.gid('Maya Smith') }, [['Mojito', 2], ['Burger', 1]], { charge: true });
    p.sell({ walkin: true }, [['Espresso', 1]], { payment: 'Cash' });
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 1, 'a bill paid at the bar is not sent');
    assert.equal(await pushOutbox(p.db, p.s()), 1);

    const rows = unpaid(rs);
    // Owner's rule: sub-category Service, object "Bar" (drinks) or "Restaurant" (kitchen), the item in the comment.
    assert.deepEqual(rows.map(r => [r[1], r[2], r[3], r[4], r[6], r[12], r[19]]),
      [['Income', 'Service', 'Bar', 2, 170000, 'Maya Smith', ''], ['Income', 'Service', 'Restaurant', 1, 85000, 'Maya Smith', '']]);
    assert.match(rows[0][16], /^Mojito · Bar POS bill #\d+$/); assert.match(rows[1][16], /^Burger · /);
    assert.equal(rs.tabs['Entries Manual'].rows.length, 3);
    assert.deepEqual(syncStatus(p.db, p.s()).waiting, 0);

    // End of the bar service: the cash handed over becomes the "BAR Cash-out" row of Entries Manual.
    T.endShift(p.db, p.s(), p.user, { counted: 40000, cashout: 25000 });
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
    const bar = rs.tabs['Entries Manual'].rows.filter(r => r[1] === 'BAR Cash-out');
    assert.equal(bar.length, 1); assert.equal(bar[0][7], 25000); assert.equal(bar[0][13], 'Extern cash'); assert.equal(bar[0][14], 'Bar POS');
    assert.match(bar[0][15], /counted 40000, expected 25000, difference 15000/);
    const pulled = await callSheet(p.db, p.s(), 'pull');
    assert.equal(pulled.bar.length, 1); assert.equal(pulled.bar[0].amount, 25000);
    assert.equal(rs.tabs.Entries.rows.filter(r => r[1] === 'BAR Cash-out').length, 0, 'never in Entries');
  } finally { close(); }
});

test('Rabbit-System: offline, then sent once; expired session; a line id already used gets new ids', real, async () => {
  const { rs, st, close, url } = await serve();
  try {
    const p = pos(url);
    await pullGuests(p.db, p.s());
    st.down = true;
    p.sell({ guestId: p.gid('Hiro Tanaka') }, [['Bintang', 3]], { charge: true });
    assert.equal(await pushOutbox(p.db, p.s()), 0);
    assert.match(syncStatus(p.db, p.s()).error, /No connection|502/);
    const n = st.calls.length;
    assert.equal(await pushOutbox(p.db, p.s()), 0); assert.equal(st.calls.length, n, 'waits before trying again');

    st.down = false;
    for (const k of Object.keys(rs.props)) if (k.startsWith('UIS_')) delete rs.props[k]; // session expired on the server
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
    assert.ok(st.calls.slice(n).includes('login'), 'logged in again by itself');
    assert.equal(unpaid(rs).length, 1);

    // Answer lost, sent again: written once.
    p.db.exec('UPDATE outbox SET sent_at = NULL');
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
    assert.equal(unpaid(rs).length, 1);

    // The reception already has a line with the id the POS would use: refused, then sent with new ids.
    const id = p.sell({ guestId: p.gid('Jonas Keller') }, [['Pisang goreng', 1]], { charge: true });
    const row = p.db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL').get();
    const ts = saleOp(row, p.s()).payload.lines[0].ts;
    const clash = Array(17).fill(''); clash[0] = new Date(); clash[1] = 'Income'; clash[3] = 'Room'; clash[12] = 'Someone'; clash[13] = 'Cash'; clash[14] = ts;
    rs.tabs.Entries.rows.push(clash);
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 0);
    assert.match(syncStatus(p.db, p.s()).error, /already has a different line/);
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
    const j = unpaid(rs).filter(r => r[12] === 'Jonas Keller');
    assert.equal(j.length, 1); assert.notEqual(j[0][14], ts); assert.match(j[0][16], new RegExp(`#${id}\\b`));
  } finally { close(); }
});

test('Rabbit-System: wrong password is shown on the till and nothing is lost', real, async () => {
  const { rs, close, url } = await serve();
  try {
    const p = pos(url);
    setSettings(p.db, { sheet_password: 'nope' });
    p.sell({ guestId: p.gid('Hiro Tanaka') }, [['Bintang', 1]], { charge: true });
    assert.equal(await pushOutbox(p.db, p.s()), 0);
    assert.match(syncStatus(p.db, p.s()).error, /Wrong username or password/);
    setSettings(p.db, { sheet_password: 'pw-123456' });
    assert.equal(await pushOutbox(p.db, p.s(), { force: true }), 1);
    assert.equal(unpaid(rs).length, 1);
  } finally { close(); }
});

test('"POS Bar" tab: every bill, one row per item, written once; Entries untouched', async () => {
  const code = readFileSync(new URL('../bridge/journal.gs', import.meta.url), 'utf8')
    .replace("'PUT_THE_SHEET_ID_HERE'", "'sheet1'").replace("'PUT_A_LONG_RANDOM_WORD_HERE'", "'j-secret'");
  const gs = loadGas(code, { Entries: [['h']] }, 'journal.gs');
  assert.match(loadGas(readFileSync(new URL('../bridge/journal.gs', import.meta.url), 'utf8'), {}).doPost({ secret: 'PUT_A_LONG_RANDOM_WORD_HERE' }).error, /bad secret/, 'the template refuses everything');
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(gs.doPost(JSON.parse(b)))); }); }).listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    resetSyncState();
    const db = openDb(':memory:');
    createUser(db, { name: 'Owner', role: 'owner', pin: '1234' });
    seedDemo(db);
    setSettings(db, { journal_url: `http://127.0.0.1:${server.address().port}/exec`, journal_secret: 'j-secret' }); // no Rabbit-System link here
    const c = userFromToken(db, login(db, '4444', 't').token);
    T.startShift(db, c, { counted: 0 });
    const pid = n => db.prepare('SELECT id FROM products WHERE name = ?').get(n).id;
    const gid = n => db.prepare('SELECT rowid AS id FROM guests WHERE name = ?').get(n).id;
    const sell = (who, items, close) => { const s = getSettings(db); const o = O.createOrder(db, s, { ...who, items: items.map(([n, q]) => ({ productId: pid(n), qty: q })) }, c); O.closeTab(db, s, o.tabId, close, c); };
    sell({ walkin: true }, [['Bintang', 2], ['Nasi goreng', 1]], { payment: 'Cash' });
    sell({ guestId: gid('Hiro Tanaka') }, [['Mojito', 1]], { charge: true });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE type = 'sale'").get().n, 1, 'the guest bill also waits for Rabbit-System');
    assert.equal(await pushOutbox(db, getSettings(db)), 2);
    const rows = gs.tabs['POS Bar'].rows;
    assert.equal(rows[0][0], 'Date'); assert.equal(rows.length, 4);
    assert.deepEqual(rows.slice(1).map(r => [r[4], r[6], r[8], r[9], r[11], r[12], r[14]]), [
      ['Walk-in', 'Bintang', 'Bar', 2, 80000, 'Cash', 'Komang'], ['Walk-in', 'Nasi goreng', 'Kitchen', 1, 55000, 'Cash', 'Komang'],
      ['Guest', 'Mojito', 'Bar', 1, 85000, 'Unpaid', 'Komang']]);
    assert.equal(rows[3][3], 'Hiro Tanaka'); assert.ok(rows[1][0] instanceof Date);
    // Sent again (answer lost): written once.
    db.exec("UPDATE outbox SET sent_at = NULL WHERE type = 'journal'");
    assert.equal(await pushOutbox(db, getSettings(db), { force: true }), 2);
    assert.equal(gs.tabs['POS Bar'].rows.length, 4);
    assert.equal(gs.tabs.Entries.rows.length, 1, 'Entries untouched');
    assert.equal(syncStatus(db, getSettings(db)).waiting, 1, 'only the guest bill waits (no Rabbit-System link set)');
  } finally { server.closeAllConnections(); server.close(); }
});
