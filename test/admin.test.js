// Back office: menu, Loyverse import, staff and PINs, printers, owner options (secrets never sent back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getSettings, setSettings } from '../server/db.js';
import { createUser, login, userFromToken } from '../server/auth.js';
import * as A from '../server/admin.js';
import * as ST from '../server/stations.js';
import * as O from '../server/orders.js';
import { seedDemo } from '../server/seed.js';
import { createApp } from '../server/app.js';

function fresh() {
  const db = openDb(':memory:');
  createUser(db, { name: 'Owner', role: 'owner', pin: '1234' });
  seedDemo(db);
  const as = pin => userFromToken(db, login(db, pin, 't-' + pin).token);
  return { db, as };
}

test('menu: categories and products, hidden items leave the guest menu, food goes to the kitchen', () => {
  const { db, as } = fresh();
  const owner = as('1234'), waiter = as('2222');
  assert.throws(() => A.saveCategory(db, waiter, 0, { name: 'X' }), /cannot do this/);
  const { id: cid } = A.saveCategory(db, owner, 0, { name: 'Cocktails', station: 'bar', color: 'violet' });
  assert.throws(() => A.saveCategory(db, owner, 0, { name: 'cocktails' }), /already has this name/);
  const { id: pid } = A.saveProduct(db, owner, 0, { name: '  Pina   colada ', price: '95.000', categoryId: cid });
  let p = A.adminCatalog(db).products.find(x => x.id === pid);
  assert.equal(p.name, 'Pina colada'); assert.equal(p.price, 95000); assert.equal(p.active, 1);
  assert.throws(() => A.saveProduct(db, owner, pid, { name: 'Pina colada', price: -1, categoryId: cid }), /Invalid price/);
  A.saveProduct(db, owner, pid, { name: 'Pina colada', price: 90000, categoryId: cid, active: false });
  assert.ok(!O.catalog(db).products.some(x => x.id === pid), 'hidden from the till and the guests');
  assert.ok(A.adminCatalog(db).products.some(x => x.id === pid), 'still in the back office');
  assert.throws(() => A.deleteCategory(db, owner, cid), /Move or hide/);
  const { id: empty } = A.saveCategory(db, owner, 0, { name: 'Empty' });
  A.deleteCategory(db, owner, empty);
  assert.ok(!A.adminCatalog(db).categories.some(c => c.id === empty));
  A.reorder(db, owner, 'categories', [cid]);
  assert.equal(A.adminCatalog(db).categories[0].id, cid);
});

const LOYVERSE = `Handle,SKU,Name,Category,Description,Sold by weight,Option 1 name,Option 1 value,Option 2 name,Option 2 value,Cost,Barcode,Available for sale [Rabbit Tree],Price [Rabbit Tree]
bintang,10001,Bintang,Beer,,N,Size,Small,,,20000,,Y,40000
bintang,10002,,Beer,,N,Size,Large,,,30000,,Y,55000
nasi-goreng,10003,Nasi goreng,Food,"Fried rice, egg",N,,,,,15000,,Y,55000
mojito,10004,Mojito,Cocktails,,N,,,,,25000,,N,90000
espresso,10005,Espresso,Coffee,,N,,,,,5000,,Y,25000.00
gado,10007,Gado-gado,Main dishes,,N,,,,,10000,,Y,45000
open-price,10006,Tip,Other,,N,,,,,,,Y,
`;

test('Loyverse import: preview first, variants, new prices, food categories to the kitchen, nothing deleted', () => {
  const { db, as } = fresh();
  const owner = as('1234');
  const before = A.adminCatalog(db).products.length;
  const plan = A.importLoyverse(db, owner, LOYVERSE, false);
  assert.deepEqual(plan.add.map(i => [i.name, i.category, i.price, i.active]), [
    ['Bintang (Small)', 'Beer', 40000, true], ['Bintang (Large)', 'Beer', 55000, true], ['Gado-gado', 'Main dishes', 45000, true]]);
  assert.deepEqual(plan.update.map(i => [i.name, i.oldPrice, i.price]), [['Mojito', 85000, 90000]]);
  assert.equal(plan.same, 2); // Nasi goreng, Espresso: same name and price
  // Food and Cocktails: their items exist already (no new empty category); Main dishes is food.
  assert.deepEqual(plan.newCategories, [{ name: 'Beer', station: 'bar' }, { name: 'Main dishes', station: 'kitchen' }]);
  assert.equal(A.adminCatalog(db).products.length, before, 'preview changes nothing');
  A.importLoyverse(db, owner, LOYVERSE, true);
  const cat = A.adminCatalog(db);
  assert.equal(cat.products.length, before + 3);
  assert.equal(cat.products.find(p => p.name === 'Mojito').price, 90000);
  assert.equal(cat.categories.find(c => c.name === 'Main dishes').station, 'kitchen');
  assert.ok(!cat.categories.some(c => c.name === 'Cocktails'));
  assert.equal(A.importLoyverse(db, owner, LOYVERSE, false).add.length, 0, 'importing again adds nothing');
  assert.throws(() => A.importLoyverse(db, owner, 'a,b\n1,2', false), /not a Loyverse/);
  assert.deepEqual(A.parseCsv('a;b\n"x;1";"say ""hi"""\n'), [['a', 'b'], ['x;1', 'say "hi"']]);
});

test('staff: PINs are personal, a disabled person is logged out, one owner always stays', () => {
  const { db, as } = fresh();
  const owner = as('1234');
  assert.throws(() => A.listUsers(db, as('1111')), /cannot do this/, 'manager cannot manage staff');
  assert.throws(() => A.saveUser(db, owner, 0, { name: 'Made', role: 'waiter', pin: '2222' }), /already used/);
  const { id } = A.saveUser(db, owner, 0, { name: 'Made', role: 'waiter', pin: '5555' });
  const t = login(db, '5555', 'phone').token;
  A.saveUser(db, owner, id, { name: 'Made', role: 'cashier', pin: '5656' });
  assert.equal(userFromToken(db, t).role, 'cashier');
  assert.throws(() => login(db, '5555', 'x'), /Wrong PIN/); login(db, '5656', 'x');
  A.saveUser(db, owner, id, { name: 'Made', role: 'cashier', active: false });
  assert.equal(userFromToken(db, t), null, 'logged out at once');
  assert.throws(() => A.saveUser(db, owner, owner.id, { name: 'Owner', role: 'manager' }), /at least one active owner/);
  assert.equal(A.listUsers(db, owner).find(u => u.id === owner.id).role, 'owner');
});

test('printers: test ticket sent to the station printer', async () => {
  const { db, as } = fresh();
  const mgr = as('1111');
  ST.saveStation(db, mgr, 'bar', { name: 'Bar', host: '192.168.1.50', port: 9100, width: 48, sheetObject: 'Bar' });
  const sent = [];
  await A.testPrinter(db, mgr, 'bar', async (p, data) => sent.push([p.host, data.toString('latin1')]));
  assert.equal(sent[0][0], '192.168.1.50'); assert.match(sent[0][1], /Test: Bar/);
  await assert.rejects(A.testPrinter(db, mgr, 'kitchen'), /Save the printer address/);
  await assert.rejects(A.testPrinter(db, mgr, 'bar', async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }), /No answer from 192.168.1.50:9100 \(ECONNREFUSED\)/);
});

test('HTTP: owner options never show passwords; an empty password keeps the old one', async () => {
  const { db } = fresh();
  setSettings(db, { sheet_password: 'old-pass', journal_secret: 'j', sheet_token: 'tok', client_key: 'k' });
  const server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tok = (await (await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ pin: '1234' }) })).json()).token;
    const call = (path, opts = {}) => fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());
    const s = await call('/api/settings');
    assert.equal(JSON.stringify(s).includes('old-pass'), false); assert.equal(JSON.stringify(s).includes('"tok"'), false);
    assert.deepEqual(s.secrets, { sheet_password: true, sheet_token: true, journal_secret: true, client_key: true });
    await call('/api/settings', { method: 'PUT', body: JSON.stringify({ sheet_password: '', service_enabled: true, client_key: 'hack' }) });
    const after = getSettings(db);
    assert.equal(after.sheet_password, 'old-pass'); assert.equal(after.client_key, 'k'); assert.equal(after.service_enabled, true);
    await call('/api/settings', { method: 'PUT', body: JSON.stringify({ sheet_password: 'new-pass' }) });
    assert.equal(getSettings(db).sheet_password, 'new-pass'); assert.equal(getSettings(db).sheet_token, '', 'new password: log in again');
    const imp = await call('/api/admin/import', { method: 'POST', body: JSON.stringify({ csv: LOYVERSE }) });
    assert.equal(imp.add.length, 3);
  } finally { server.closeAllConnections(); server.close(); }
});
