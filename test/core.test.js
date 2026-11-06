import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb, getSettings, setSettings } from '../server/db.js';
import { createUser, login, userFromToken, can } from '../server/auth.js';
import * as O from '../server/orders.js';
import * as T from '../server/shift.js';
import * as stationsMod from '../server/stations.js';
import * as A from '../server/admin.js';
import { processPrintJobs, Ticket } from '../server/print.js';
import { seedDemo } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fresh() {
  const db = openDb(':memory:');
  createUser(db, { name: 'Owner', role: 'owner', pin: '1234' });
  seedDemo(db);
  const as = pin => userFromToken(db, login(db, pin, 'test-' + pin).token);
  const prod = name => db.prepare('SELECT id FROM products WHERE name = ?').get(name).id;
  const guest = name => db.prepare('SELECT rowid AS id FROM guests WHERE name = ?').get(name).id;
  return { db, as, prod, guest };
}

test('PIN login, wrong PIN, roles', () => {
  const { db, as } = fresh();
  assert.equal(as('1111').role, 'manager');
  assert.throws(() => login(db, '9999', 'x'), /Wrong PIN/);
  assert.throws(() => createUser(db, { name: 'Dup', role: 'waiter', pin: '2222' }), /already used/);
  assert.ok(can(as('2222'), 'sell'));
  assert.ok(!can(as('2222'), 'take_payment'));
  assert.ok(!can(as('3333'), 'sell'));
  assert.ok(can(as('3333'), 'take_payment'));
});

test('five wrong PINs lock the device for a while', () => {
  const { db } = fresh();
  for (let i = 0; i < 5; i++) assert.throws(() => login(db, '0000', 'lock'));
  assert.throws(() => login(db, '1234', 'lock'), /wait 30 seconds/);
  assert.ok(login(db, '1234', 'other').token);
});

test('service and tax only when the owner turns them on', () => {
  const { db, as, prod, guest } = fresh();
  const w = as('2222');
  const o = O.createOrder(db, getSettings(db), { guestId: guest('Martin Dupont'), items: [{ productId: prod('Bintang'), qty: 2 }, { productId: prod('Burger'), qty: 1 }] }, w);
  assert.equal(O.getTab(db, getSettings(db), o.tabId).total, 165000);
  setSettings(db, { service_enabled: true, service_rate: 5, tax_enabled: true, tax_rate: 10 });
  const t = O.getTab(db, getSettings(db), o.tabId);
  assert.deepEqual([t.subtotal, t.service, t.tax, t.total], [165000, 8250, 17325, 190575]);
  assert.throws(() => setSettings(db, { service_rate: 80 }), /0 to 50/);
  assert.throws(() => setSettings(db, { till: 'kitchen' }), /bar or reception/);
});

test('same guest = same open tab; tickets split bar / kitchen', () => {
  const { db, as, prod, guest } = fresh();
  const s = getSettings(db), w = as('2222');
  const a = O.createOrder(db, s, { guestId: guest('Martin Dupont'), items: [{ productId: prod('Bintang'), qty: 2 }, { productId: prod('Nasi goreng'), qty: 1, note: 'no chili' }] }, w);
  const b = O.createOrder(db, s, { guestId: guest('Martin Dupont'), items: [{ productId: prod('Espresso'), qty: 1 }] }, w);
  assert.equal(a.tabId, b.tabId);
  const jobs = db.prepare('SELECT station FROM print_jobs ORDER BY id').all().map(j => j.station);
  assert.deepEqual(jobs, ['bar', 'kitchen', 'bar']);
});

test('client order waits for a waiter only when validation is on', () => {
  const { db, as, prod, guest } = fresh();
  const item = [{ productId: prod('Mojito'), qty: 1 }];
  const o1 = O.createOrder(db, getSettings(db), { guestId: guest('Hiro Tanaka'), guestName: 'Hiro T.', items: item }, null, 'qr');
  assert.equal(o1.status, 'sent');
  setSettings(db, { validation_required: true });
  const s = getSettings(db);
  const o2 = O.createOrder(db, s, { guestId: guest('Hiro Tanaka'), guestName: 'Hiro T.', items: item }, null, 'tablet');
  assert.equal(o2.status, 'pending');
  assert.equal(O.pendingOrders(db).length, 1);
  const before = db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n;
  assert.throws(() => O.closeTab(db, s, o2.tabId, { charge: true }, as('3333')), /waits for validation/);
  O.decideOrder(db, s, o2.id, true, as('2222'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n, before + 1);
  assert.throws(() => O.decideOrder(db, s, o2.id, true, as('2222')), /already handled/);
  setSettings(db, { qr_ordering: false });
  assert.throws(() => O.createOrder(db, getSettings(db), { guestId: guest('Hiro Tanaka'), guestName: 'Hiro T.', items: item }, null, 'qr'), /turned off/);
});

test('charge to the guest sends Unpaid lines for Guest bills; walk-in must pay', () => {
  const { db, as, prod, guest } = fresh();
  setSettings(db, { service_enabled: true });
  const s = getSettings(db), c = as('4444');
  const o = O.createOrder(db, s, { guestId: guest('Jonas Keller'), items: [{ productId: prod('Burger'), qty: 2 }] }, c);
  O.closeTab(db, s, o.tabId, { charge: true }, c);
  const out = JSON.parse(db.prepare('SELECT payload FROM outbox').get().payload);
  assert.equal(out.pay, 'Unpaid'); assert.equal(out.guest, 'Jonas Keller'); assert.equal(out.till, 'receipt');
  assert.deepEqual(out.lines.map(l => [l.product, l.total]), [['Burger', 170000], ['Service 5%', 8500]]);
  assert.throws(() => O.closeTab(db, s, o.tabId, { payment: 'Cash' }, c), /already closed/);

  const w = O.createOrder(db, s, { walkin: true, items: [{ productId: prod('Espresso'), qty: 1 }] }, c);
  assert.throws(() => O.closeTab(db, s, w.tabId, { charge: true }, c), /must be paid now/);
  assert.throws(() => O.closeTab(db, s, w.tabId, { payment: 'Cash' }, c), /Open Bar till first/);
  T.startShift(db, c, { counted: 0 });
  assert.throws(() => O.closeTab(db, s, w.tabId, { payment: 'Gold' }, c), /Unknown payment/);
  assert.throws(() => O.closeTab(db, s, w.tabId, { payment: 'Cash' }, as('2222')), /cannot do this/);
  O.closeTab(db, s, w.tabId, { payment: 'Cash' }, c);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM print_jobs WHERE station = 'receipt'").get().n, 1);
});

test('voiding needs a manager and leaves the total', () => {
  const { db, as, prod, guest } = fresh();
  const s = getSettings(db);
  const o = O.createOrder(db, s, { guestId: guest('Mariana Silva'), items: [{ productId: prod('Bintang'), qty: 1 }, { productId: prod('Mojito'), qty: 1 }] }, as('2222'));
  const line = db.prepare("SELECT id FROM order_items WHERE name = 'Mojito'").get().id;
  assert.throws(() => O.voidItem(db, line, as('2222')), /cannot do this/);
  O.voidItem(db, line, as('1111'));
  assert.equal(O.getTab(db, s, o.tabId).total, 40000);
});

test('clients see masked names only after 2 letters', () => {
  const { db } = fresh();
  assert.deepEqual(O.searchGuests(db, 'M', { client: true }), []);
  assert.deepEqual(O.searchGuests(db, 'mar', { client: true }).map(g => g.name), ['Mariana S.', 'Martin D.']);
  assert.equal(O.searchGuests(db, '12')[0].name, 'Martin Dupont');
});

test('tickets reach a network printer, and wait while it is off', async () => {
  const { db, as, prod, guest } = fresh();
  const got = [];
  const printer = net.createServer(s => { const c = []; s.on('data', d => c.push(d)); s.on('end', () => got.push(Buffer.concat(c))); });
  await new Promise(r => printer.listen(0, '127.0.0.1', r));
  const port = printer.address().port;
  O.createOrder(db, getSettings(db), { guestId: guest('Martin Dupont'), items: [{ productId: prod('Nasi goreng'), qty: 1, note: 'Pédas' }] }, as('2222'));

  db.prepare("UPDATE stations SET host = '127.0.0.1', port = 1 WHERE id = 'kitchen'").run(); // nothing listens on port 1
  await processPrintJobs(db, getSettings(db));
  const j = db.prepare('SELECT status, tries, error FROM print_jobs').get();
  assert.equal(j.status, 'waiting'); assert.equal(j.tries, 1); assert.ok(j.error);

  db.prepare("UPDATE stations SET host = '127.0.0.1', port = ? WHERE id = 'kitchen'").run(port);
  assert.equal(await processPrintJobs(db, getSettings(db)), 1);
  await new Promise(r => setTimeout(r, 50));
  const text = got[0].toString('latin1');
  assert.match(text, /KITCHEN/); assert.match(text, /1 x Nasi goreng/); assert.match(text, /> Pedas/);
  printer.close();
});

test('receipt layout fits the paper width', () => {
  const t = new Ticket(32).pair('2 x A very long product name indeed', 'Rp 170.000');
  const line = t.bytes().toString('latin1').split('\n')[0].slice(2);
  assert.equal(line.length, 32);
});

test('HTTP: staff token and the client ordering key', async () => {
  const { db } = fresh();
  const server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } }).then(async r => ({ status: r.status, body: await r.json() }));
  setSettings(db, { client_key: 'k3y' });

  assert.equal((await call('/api/state')).status, 401);
  const { body: { token } } = await call('/api/login', { method: 'POST', body: JSON.stringify({ pin: '2222' }) });
  const st = await call('/api/state', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(st.status, 200); assert.equal(st.body.settings.client_key, undefined);
  assert.equal((await call('/api/settings', { headers: { Authorization: 'Bearer ' + token } })).status, 403);

  assert.equal((await call('/api/client/menu?key=nope')).status, 403);
  const menu = await call('/api/client/menu?key=k3y');
  assert.ok(menu.body.products.length > 5); assert.equal(menu.body.flags.service, 0);
  const [g] = (await call('/api/client/guests?key=k3y&q=hiro')).body;
  const pid = menu.body.products[0].id;
  assert.equal(g.name, 'Hiro T.');
  const order = extra => call('/api/client/orders?key=k3y', { method: 'POST', body: JSON.stringify({ guestId: g.id, guestName: g.name, items: [{ productId: pid, qty: 1 }], ...extra }) });
  const o = await order({ tabId: 999 });
  assert.equal(o.status, 200); assert.equal(o.body.status, 'sent');
  assert.equal((await call(`/api/client/orders/${o.body.id}?key=k3y`)).body.status, 'sent');
  assert.equal((await call(`/api/client/orders/${o.body.id}?key=nope`)).status, 403);
  // The phone shows a name: if the list changed and that id is now someone else, the guest must choose again.
  assert.equal((await order({ guestName: 'Martin D.' })).status, 409);

  // Guest list refreshed from the Sheet: ids of guests still there do not change.
  const ids = () => Object.fromEntries(db.prepare('SELECT rowid AS id, name FROM guests').all().map(r => [r.name, r.id]));
  const before = ids();
  O.replaceGuests(db, ['Newcomer Smith', 'Hiro Tanaka', 'Jonas Keller']);
  const after = ids();
  assert.equal(after['Hiro Tanaka'], before['Hiro Tanaka']); assert.equal(after['Jonas Keller'], before['Jonas Keller']);
  assert.equal(after['Martin Dupont'], undefined); assert.ok(after['Newcomer Smith']);
  assert.equal((await order({})).status, 200);

  // Staff page for the QR codes: owner/manager only.
  assert.equal((await call('/api/staff/order-links', { headers: { Authorization: 'Bearer ' + token } })).status, 403);
  const own = (await call('/api/login', { method: 'POST', body: JSON.stringify({ pin: '1234' }) })).body.token;
  const links = await call('/api/staff/order-links', { headers: { Authorization: 'Bearer ' + own } });
  assert.equal(links.body.key, 'k3y'); assert.ok(Array.isArray(links.body.bases));
  server.closeAllConnections(); server.close();
});

test('bar service: opening count, cash expected, difference, BAR Cash-out sent, cards of the day', () => {
  const { db, as, prod, guest } = fresh();
  const s = getSettings(db), c = as('4444');
  const sell = (who, items, close) => { const o = O.createOrder(db, s, { ...who, items: items.map(([n, q]) => ({ productId: prod(n), qty: q })) }, c); return O.closeTab(db, s, o.tabId, close, c); };

  assert.throws(() => T.startShift(db, as('2222'), { counted: 0 }), /cannot do this/);
  const o1 = T.startShift(db, c, { counted: 200000 });
  assert.equal(o1.diff, 200000, 'first service: nothing was left before');
  assert.throws(() => T.startShift(db, c, { counted: 0 }), /already open/);

  sell({ walkin: true }, [['Bintang', 2]], { payment: 'Cash' });          // 80 000 cash
  sell({ walkin: true }, [['Mojito', 1]], { payment: 'Card' });           // 85 000 card
  sell({ guestId: guest('Hiro Tanaka') }, [['Burger', 1]], { charge: true }); // guest bill: not in the drawer
  let sh = T.shiftSummary(db, T.openShift(db));
  assert.equal(sh.cashSales, 80000); assert.equal(sh.expected, 280000); assert.equal(sh.charged.total, 85000);
  assert.deepEqual(sh.payments.map(p => [p.payment, p.total]), [['Card', 85000], ['Cash', 80000]]);

  assert.throws(() => T.endShift(db, s, c, { counted: 270000, cashout: 300000 }), /more cash than you counted/);
  const end = T.endShift(db, s, c, { counted: 270000, cashout: 170000, comment: 'short 10k' });
  assert.equal(end.diff, -10000); assert.equal(end.left, 100000);
  const out = db.prepare("SELECT payload FROM outbox WHERE type = 'bar_cashout'").get();
  assert.equal(JSON.parse(out.payload).amount, 170000);
  assert.match(JSON.parse(out.payload).comment, /counted 270000, expected 280000, difference -10000 · short 10k/);
  assert.equal(T.openShift(db), null);
  assert.throws(() => sell({ walkin: true }, [['Espresso', 1]], { payment: 'Cash' }), /Open Bar till first/);
  sell({ guestId: guest('Hiro Tanaka') }, [['Espresso', 1]], { charge: true }); // a guest bill needs no open bar

  const o2 = T.startShift(db, c, { counted: 95000 });
  assert.equal(o2.expectedFloat, 100000); assert.equal(o2.diff, -5000);
  T.endShift(db, s, c, { counted: 95000, cashout: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE type = 'bar_cashout'").get().n, 1, 'nothing handed over: no cash-out line');

  const day = T.dayReport(db);
  assert.equal(day.cards, 85000); assert.equal(day.charged.total, 85000 + 25000); assert.equal(day.shifts.length, 2);
});

test('HTTP: product photos kept on this PC, devices keep app files and photos', async () => {
  const { db, prod } = fresh();
  const dir = mkdtempSync(join(tmpdir(), 'pos-'));
  const server = createApp(db, { photosDir: join(dir, 'photos') }).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = async pin => (await (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ pin }) })).json()).token;
    const owner = await login('1234'), waiter = await login('2222');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(40, 7)]);
    const up = (tok, body, id = prod('Mojito')) => fetch(`${base}/api/products/${id}/photo`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'image/png' }, body });
    assert.equal((await up(waiter, png)).status, 403);
    assert.equal((await up(owner, Buffer.from('not a picture at all'))).status, 400);
    assert.equal((await up(owner, Buffer.alloc(3e6 + 10, 1))).status, 413);
    const r = await up(owner, png); const { photo } = await r.json();
    assert.match(photo, /^\/photos\/p\d+-[0-9a-f]{10}\.png$/);
    assert.ok(existsSync(join(dir, 'photos', photo.split('/').pop())));
    const img = await fetch(base + photo);
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
    assert.equal((await fetch(base + '/photos/../pos.db')).status, 404);

    // A new picture replaces the old file.
    const png2 = Buffer.concat([png, Buffer.from('v2')]);
    const second = (await (await up(owner, png2)).json()).photo;
    assert.notEqual(second, photo); assert.ok(!existsSync(join(dir, 'photos', photo.split('/').pop())));
    assert.equal(O.catalog(db).products.find(p => p.name === 'Mojito').photo, second);

    // App files: asked again with their ETag, the server answers 304 (nothing downloaded).
    const js = await fetch(base + '/pos.js');
    assert.equal(js.headers.get('cache-control'), 'no-cache');
    assert.equal((await fetch(base + '/pos.js', { headers: { 'If-None-Match': js.headers.get('etag') } })).status, 304);
    assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
  } finally { server.closeAllConnections(); server.close(); }
});

test('waiter phone and reception: waiter puts a guest on the room bill but takes no money; bill printed before paying', async () => {
  const { db, as, prod, guest } = fresh();
  const s = getSettings(db), w = as('2222'), rec = as('3333');
  const o = O.createOrder(db, s, { guestId: guest('Hiro Tanaka'), items: [{ productId: prod('Bintang'), qty: 2 }] }, w);
  const e = O.createOrder(db, s, { externalName: 'Lucas', items: [{ productId: prod('Mojito'), qty: 1 }] }, w);
  assert.throws(() => O.closeTab(db, s, e.tabId, { payment: 'Cash' }, w), /cannot do this/, 'a waiter takes no money');
  assert.throws(() => O.closeTab(db, s, e.tabId, { charge: true }, w), /external guest pays at the bar/);
  O.printBill(db, s, o.tabId, rec);
  const job = db.prepare("SELECT label, data FROM print_jobs WHERE label LIKE '%not paid%'").get();
  assert.match(job.label, new RegExp(`Bill #${o.tabId}`)); assert.match(Buffer.from(job.data).toString('latin1'), /NOT PAID YET/);
  assert.equal(O.getTab(db, s, o.tabId).status, 'open', 'printing the bill closes nothing');
  O.closeTab(db, s, o.tabId, { charge: true }, w);
  assert.equal(O.getTab(db, s, o.tabId).payment, 'Unpaid');
  const recent = O.chargedSince(db, s, new Date(Date.now() - 3600000).toISOString());
  assert.deepEqual(recent.map(t => t.id), [o.tabId]);
  assert.throws(() => O.printBill(db, s, o.tabId, rec), /already closed/);
});

test('stations: more preparation points and tills; mixed orders split; a pass gets a copy; each till its drawer and receipts', () => {
  const { db, as, prod, guest } = fresh();
  const s = getSettings(db), owner = as('1234'), c = as('4444');
  const ST = stationsMod;
  assert.deepEqual(ST.listStations(db).map(x => [x.id, x.kind]), [['bar', 'prep'], ['kitchen', 'prep'], ['receipt', 'till']]);
  assert.throws(() => ST.saveStation(db, as('2222'), null, { name: 'X', kind: 'prep' }), /cannot do this/);
  const { id: pizza } = ST.saveStation(db, owner, null, { name: 'Pizza oven', kind: 'prep', host: '192.168.1.60', sheetObject: 'Restaurant' });
  const { id: pass } = ST.saveStation(db, owner, null, { name: 'Pass', kind: 'prep', copyAll: true });
  const { id: beach } = ST.saveStation(db, owner, null, { name: 'Beach till', kind: 'till', host: '192.168.1.70' });
  assert.deepEqual([pizza, pass, beach], ['pizza-oven', 'pass', 'beach-till']);
  assert.throws(() => ST.saveStation(db, owner, null, { name: 'Bad', kind: 'prep', host: 'no way!' }), /192.168/);
  // Pizza category -> pizza oven
  const cat = A.saveCategory(db, owner, 0, { name: 'Pizza', station: pizza }).id;
  const mar = A.saveProduct(db, owner, 0, { name: 'Margherita', price: 90000, categoryId: cat }).id;
  assert.throws(() => A.saveCategory(db, owner, 0, { name: 'X', station: 'nowhere' }), /Unknown preparation station/);
  db.exec('DELETE FROM print_jobs');
  const o = O.createOrder(db, s, { walkin: true, items: [{ productId: prod('Bintang'), qty: 1 }, { productId: mar, qty: 2 }, { productId: prod('Burger'), qty: 1 }] }, c);
  const jobs = db.prepare('SELECT station, label, data FROM print_jobs ORDER BY id').all();
  assert.deepEqual(jobs.map(j => j.station), ['bar', pizza, 'kitchen', pass]);
  const txt = st => Buffer.from(jobs.find(j => j.station === st).data).toString('latin1');
  assert.match(txt(pizza), /PIZZA OVEN/); assert.match(txt(pizza), /2 x Margherita/); assert.doesNotMatch(txt(pizza), /Bintang/);
  assert.match(txt(pass), /PASS - ALL/); assert.match(txt(pass), /1 x Bintang/); assert.match(txt(pass), /2 x Margherita/);
  // Two tills: each its own service; the receipt prints at the till that took the money.
  T.startShift(db, c, { counted: 100000, till: beach });
  assert.throws(() => O.closeTab(db, s, o.tabId, { payment: 'Cash' }, c), /Open Bar till first/);
  O.closeTab(db, s, o.tabId, { payment: 'Cash', till: beach }, c);
  const rec = db.prepare("SELECT station FROM print_jobs WHERE label = ?").get(`Bill #${o.tabId}`);
  assert.equal(rec.station, beach);
  assert.equal(T.shiftSummary(db, T.openShift(db, beach)).cashSales, 40000 + 180000 + 85000);
  assert.equal(T.openShift(db, 'receipt'), null);
  assert.equal(db.prepare('SELECT till FROM tabs WHERE id = ?').get(o.tabId).till, beach);
  // A guest bill keeps the object of the station that made it (Entries: Pizza oven -> Restaurant).
  const g = O.createOrder(db, s, { guestId: guest('Hiro Tanaka'), items: [{ productId: mar, qty: 1 }, { productId: prod('Mojito'), qty: 1 }] }, c);
  O.closeTab(db, s, g.tabId, { charge: true }, c);
  const lines = JSON.parse(db.prepare("SELECT payload FROM outbox WHERE type = 'sale' ORDER BY id DESC").get().payload).lines;
  assert.deepEqual(lines.map(l => [l.product, l.object, l.stationName]), [['Margherita', 'Restaurant', 'Pizza oven'], ['Mojito', 'Bar', 'Bar']]);
  // A station in use cannot be switched off; the last till stays.
  assert.throws(() => ST.saveStation(db, owner, pizza, { name: 'Pizza oven', active: false }), /used by 1/);
  assert.throws(() => ST.saveStation(db, owner, beach, { name: 'Beach till', active: false }), /Close the service/);
  T.endShift(db, s, c, { counted: 405000, cashout: 0, till: beach });
  ST.saveStation(db, owner, beach, { name: 'Beach till', active: false });
  assert.throws(() => ST.saveStation(db, owner, 'receipt', { name: 'Bar till', active: false }), /at least one till/);
});
