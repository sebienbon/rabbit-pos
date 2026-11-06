// Business rules: catalog, guests, tabs (notes), orders, payment.
// Money is in whole rupiah (integers).
import { EventEmitter } from 'node:events';
import { PosError, now, tx, logAction } from './db.js';
import { need } from './auth.js';
import { queueOrderTickets, queueReceipt } from './print.js';

export const events = new EventEmitter();
events.setMaxListeners(100);
const emit = (type, data) => events.emit('change', { type, ...data });

// ---------- catalog ----------
export function catalog(db, { includeInactive = false } = {}) {
  const categories = db.prepare('SELECT id, name, station, color FROM categories ORDER BY sort, id').all();
  const products = db.prepare(`SELECT id, category_id AS categoryId, name, price, photo, station, active
    FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
  return { categories, products };
}

// ---------- guests (copied from the sheet: 24datafeed and New guest) ----------
export function replaceGuests(db, list) {
  tx(db, () => {
    db.exec('DELETE FROM guests');
    const ins = db.prepare('INSERT OR IGNORE INTO guests (name, room, updated_at) VALUES (?, ?, ?)');
    for (const g of list) {
      const name = String(typeof g === 'string' ? g : g.name || '').trim();
      if (name) ins.run(name, typeof g === 'object' ? g.room || null : null, now());
    }
  });
}

// Clients only see first name + initial, and only after typing 2 letters.
const mask = name => {
  const [first, ...rest] = name.split(/\s+/);
  return rest.length ? `${first} ${rest.map(w => w[0].toUpperCase() + '.').join(' ')}` : first;
};
export function searchGuests(db, q, { client = false } = {}) {
  q = String(q || '').trim();
  if (client && q.length < 2) return [];
  const rows = db.prepare(`SELECT rowid AS id, name, room FROM guests
    WHERE name LIKE ? OR room = ? ORDER BY name LIMIT ?`).all(`%${q}%`, q, client ? 5 : 30);
  return rows.map(r => ({ id: r.id, name: client ? mask(r.name) : r.name, room: r.room }));
}

// ---------- totals ----------
export function totals(settings, items) {
  const subtotal = items.filter(i => !i.voided).reduce((s, i) => s + i.qty * i.unit_price, 0);
  const service = settings.service_enabled ? Math.round(subtotal * settings.service_rate / 100) : 0;
  const tax = settings.tax_enabled ? Math.round((subtotal + service) * settings.tax_rate / 100) : 0;
  return { subtotal, service, tax, total: subtotal + service + tax };
}

// ---------- tabs ----------
function findOpenTab(db, kind, name) {
  return db.prepare("SELECT * FROM tabs WHERE status = 'open' AND kind = ? AND name = ?").get(kind, name);
}

function resolveTab(db, settings, { tabId, guestId, externalName, walkin, table }, user, source) {
  if (tabId) {
    const t = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId);
    if (!t) throw new PosError('not_found', 'Tab not found', 404);
    if (t.status !== 'open') throw new PosError('closed', 'This tab is already closed');
    return t;
  }
  let kind, name;
  if (guestId) {
    const g = db.prepare('SELECT rowid AS id, name FROM guests WHERE rowid = ?').get(guestId);
    if (!g) throw new PosError('not_found', 'Guest not found', 404);
    kind = 'guest'; name = g.name;
  } else if (externalName) {
    if (!settings.external_guests) throw new PosError('disabled', 'External guests are turned off');
    name = String(externalName).trim().slice(0, 60);
    if (name.length < 2) throw new PosError('bad_name', 'Please enter a name');
    kind = 'external';
  } else if (walkin && source === 'pos') {
    kind = 'walkin'; name = `Walk-in ${new Date().toTimeString().slice(0, 5)}`;
  } else {
    throw new PosError('who', 'Choose a guest, an external name, or a walk-in sale');
  }
  const existing = kind !== 'walkin' && findOpenTab(db, kind, name);
  if (existing) return existing;
  const r = db.prepare('INSERT INTO tabs (kind, name, table_no, opened_at, opened_by) VALUES (?, ?, ?, ?, ?)')
    .run(kind, name, settings.tables_enabled && table ? String(table).slice(0, 20) : null, now(), user?.id ?? null);
  return db.prepare('SELECT * FROM tabs WHERE id = ?').get(Number(r.lastInsertRowid));
}

export function getTab(db, settings, id) {
  const tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(id);
  if (!tab) throw new PosError('not_found', 'Tab not found', 404);
  const orders = db.prepare('SELECT * FROM orders WHERE tab_id = ? ORDER BY id').all(id);
  const items = db.prepare(`SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.tab_id = ? AND o.status != 'rejected' ORDER BY i.id`).all(id);
  for (const o of orders) o.items = items.filter(i => i.order_id === o.id);
  const sums = tab.status === 'open' ? totals(settings, items)
    : { subtotal: tab.subtotal, service: tab.service, tax: tab.tax, total: tab.total };
  return { ...tab, orders, ...sums };
}

export function listTabs(db, settings, status = 'open') {
  return db.prepare('SELECT id FROM tabs WHERE status = ? ORDER BY opened_at DESC LIMIT 200').all(status)
    .map(t => getTab(db, settings, t.id));
}

// ---------- orders ----------
const CLIENT_SOURCES = ['qr', 'tablet'];

export function createOrder(db, settings, input, user, source = 'pos') {
  if (source === 'pos') need(user, 'sell');
  else if (!CLIENT_SOURCES.includes(source)) throw new PosError('bad_source', 'Unknown order source');
  if (source === 'qr' && !settings.qr_ordering) throw new PosError('disabled', 'QR ordering is turned off');
  if (source === 'tablet' && !settings.tablet_ordering) throw new PosError('disabled', 'Tablet ordering is turned off');
  const lines = Array.isArray(input.items) ? input.items : [];
  if (!lines.length || lines.length > 50) throw new PosError('empty', 'The order is empty');

  const order = tx(db, () => {
    const tab = resolveTab(db, settings, input, user, source);
    const pending = CLIENT_SOURCES.includes(source) && settings.validation_required && tab.kind === 'guest';
    const r = db.prepare('INSERT INTO orders (tab_id, source, status, created_at, created_by, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tab.id, source, pending ? 'pending' : 'sent', now(), user?.id ?? null, input.note ? String(input.note).slice(0, 200) : null);
    const orderId = Number(r.lastInsertRowid);
    const getP = db.prepare(`SELECT p.*, c.name AS cat, COALESCE(p.station, c.station) AS st
      FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.active = 1`);
    const ins = db.prepare(`INSERT INTO order_items (order_id, product_id, name, category, station, qty, unit_price, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of lines) {
      const p = getP.get(Number(l.productId));
      if (!p) throw new PosError('not_found', 'A product is no longer available', 404);
      const qty = Number(l.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new PosError('bad_qty', 'Quantity must be 1 to 99');
      ins.run(orderId, p.id, p.name, p.cat, p.st, qty, p.price, l.note ? String(l.note).slice(0, 120) : null);
    }
    if (!pending) queueOrderTickets(db, settings, orderId);
    logAction(db, user?.id, 'order', { orderId, tab: tab.id, source });
    return { id: orderId, tabId: tab.id, status: pending ? 'pending' : 'sent' };
  });
  emit('order', order);
  return order;
}

export function pendingOrders(db) {
  return db.prepare(`SELECT o.id, o.tab_id AS tabId, o.source, o.created_at AS createdAt, t.name, t.table_no AS tableNo
    FROM orders o JOIN tabs t ON t.id = o.tab_id WHERE o.status = 'pending' ORDER BY o.id`).all()
    .map(o => ({ ...o, items: db.prepare('SELECT name, qty, note FROM order_items WHERE order_id = ?').all(o.id) }));
}

export function decideOrder(db, settings, orderId, accept, user) {
  need(user, 'validate');
  const res = tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!o) throw new PosError('not_found', 'Order not found', 404);
    if (o.status !== 'pending') throw new PosError('done', 'This order was already handled');
    db.prepare('UPDATE orders SET status = ?, validated_by = ? WHERE id = ?').run(accept ? 'sent' : 'rejected', user.id, orderId);
    if (accept) queueOrderTickets(db, settings, orderId);
    logAction(db, user.id, accept ? 'validate' : 'reject', { orderId });
    return { id: orderId, tabId: o.tab_id, status: accept ? 'sent' : 'rejected' };
  });
  emit('order', res);
  return res;
}

export function voidItem(db, itemId, user) {
  need(user, 'void_item');
  const it = db.prepare(`SELECT i.*, t.status AS tabStatus, t.id AS tabId FROM order_items i
    JOIN orders o ON o.id = i.order_id JOIN tabs t ON t.id = o.tab_id WHERE i.id = ?`).get(itemId);
  if (!it) throw new PosError('not_found', 'Line not found', 404);
  if (it.tabStatus !== 'open') throw new PosError('closed', 'The tab is closed');
  db.prepare('UPDATE order_items SET voided = 1 WHERE id = ?').run(itemId);
  logAction(db, user.id, 'void', { itemId, name: it.name, qty: it.qty });
  emit('tab', { tabId: it.tabId });
}

// ---------- closing a tab ----------
// Paid here (bar till), or charged to the guest: the lines go to the sheet as "Unpaid"
// and the guest settles at the reception, in Rabbit-System's Guest bills.
export function closeTab(db, settings, tabId, { payment, charge = false }, user) {
  need(user, 'take_payment');
  const res = tx(db, () => {
    const tab = getTab(db, settings, tabId);
    if (tab.status !== 'open') throw new PosError('closed', 'This tab is already closed');
    if (db.prepare("SELECT 1 FROM orders WHERE tab_id = ? AND status = 'pending'").get(tabId))
      throw new PosError('pending', 'An order of this tab still waits for validation');
    if (tab.total <= 0) throw new PosError('empty', 'Nothing to pay on this tab');
    let pay;
    if (charge) {
      if (tab.kind === 'walkin') throw new PosError('no_guest', 'A walk-in sale must be paid now');
      pay = 'Unpaid';
    } else {
      if (!settings.payments.includes(payment)) throw new PosError('bad_payment', 'Unknown payment type');
      pay = payment;
    }
    const at = now();
    db.prepare(`UPDATE tabs SET status = ?, closed_at = ?, closed_by = ?, payment = ?, subtotal = ?, service = ?, tax = ?, total = ?
      WHERE id = ?`).run(charge ? 'charged' : 'paid', at, user.id, pay, tab.subtotal, tab.service, tab.tax, tab.total, tabId);
    const lines = [];
    for (const o of tab.orders) for (const i of o.items) if (!i.voided)
      lines.push({ product: i.name, category: i.category, qty: i.qty, unit: i.unit_price, total: i.qty * i.unit_price });
    if (tab.service) lines.push({ product: `Service ${settings.service_rate}%`, category: 'Service', qty: 1, unit: tab.service, total: tab.service });
    if (tab.tax) lines.push({ product: `Tax ${settings.tax_rate}%`, category: 'Tax', qty: 1, unit: tab.tax, total: tab.tax });
    // Only a bill put on the guest goes to the Sheet (Guest bills); a bill paid here stays in the bar's own till.
    if (settings.sheet_sync && charge) db.prepare('INSERT INTO outbox (type, payload, created_at) VALUES (?, ?, ?)').run('sale', JSON.stringify({
      tabId, at, guest: tab.kind === 'walkin' ? '' : tab.name, kind: tab.kind, pay, till: settings.till, author: user.author, lines,
    }), at);
    if (!charge) queueReceipt(db, settings, tabId);
    logAction(db, user.id, charge ? 'charge' : 'pay', { tabId, total: tab.total, pay });
    return { id: tabId, status: charge ? 'charged' : 'paid', total: tab.total };
  });
  emit('tab', { tabId });
  return res;
}
