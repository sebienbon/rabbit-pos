import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb, getSettings, setSettings } from '../server/db.js';
import { createUser, login, userFromToken, can } from '../server/auth.js';
import * as O from '../server/orders.js';
import { processPrintJobs, Ticket } from '../server/print.js';
import { seedDemo } from '../server/seed.js';
import { createApp } from '../server/app.js';

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
  const o1 = O.createOrder(db, getSettings(db), { guestId: guest('Hiro Tanaka'), items: item }, null, 'qr');
  assert.equal(o1.status, 'sent');
  setSettings(db, { validation_required: true });
  const s = getSettings(db);
  const o2 = O.createOrder(db, s, { guestId: guest('Hiro Tanaka'), items: item }, null, 'tablet');
  assert.equal(o2.status, 'pending');
  assert.equal(O.pendingOrders(db).length, 1);
  const before = db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n;
  assert.throws(() => O.closeTab(db, s, o2.tabId, { charge: true }, as('3333')), /waits for validation/);
  O.decideOrder(db, s, o2.id, true, as('2222'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n, before + 1);
  assert.throws(() => O.decideOrder(db, s, o2.id, true, as('2222')), /already handled/);
  setSettings(db, { qr_ordering: false });
  assert.throws(() => O.createOrder(db, getSettings(db), { guestId: guest('Hiro Tanaka'), items: item }, null, 'qr'), /turned off/);
});

test('charge to the guest sends Unpaid lines for Guest bills; walk-in must pay', () => {
  const { db, as, prod, guest } = fresh();
  setSettings(db, { service_enabled: true });
  const s = getSettings(db), c = as('4444');
  const o = O.createOrder(db, s, { guestId: guest('Jonas Keller'), items: [{ productId: prod('Burger'), qty: 2 }] }, c);
  O.closeTab(db, s, o.tabId, { charge: true }, c);
  const out = JSON.parse(db.prepare('SELECT payload FROM outbox').get().payload);
  assert.equal(out.pay, 'Unpaid'); assert.equal(out.guest, 'Jonas Keller'); assert.equal(out.till, 'bar');
  assert.deepEqual(out.lines.map(l => [l.product, l.total]), [['Burger', 170000], ['Service 5%', 8500]]);
  assert.throws(() => O.closeTab(db, s, o.tabId, { payment: 'Cash' }, c), /already closed/);

  const w = O.createOrder(db, s, { walkin: true, items: [{ productId: prod('Espresso'), qty: 1 }] }, c);
  assert.throws(() => O.closeTab(db, s, w.tabId, { charge: true }, c), /must be paid now/);
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

  setSettings(db, { printers: { kitchen: { host: '127.0.0.1', port: 1 } } }); // nothing listens on port 1
  await processPrintJobs(db, getSettings(db));
  const j = db.prepare('SELECT status, tries, error FROM print_jobs').get();
  assert.equal(j.status, 'waiting'); assert.equal(j.tries, 1); assert.ok(j.error);

  setSettings(db, { printers: { kitchen: { host: '127.0.0.1', port } } });
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
  const o = await call('/api/client/orders?key=k3y', { method: 'POST', body: JSON.stringify({ guestId: g.id, items: [{ productId: pid, qty: 1 }], tabId: 999 }) });
  assert.equal(o.status, 200); assert.equal(o.body.status, 'sent');
  server.close();
});
