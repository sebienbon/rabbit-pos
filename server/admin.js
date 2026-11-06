// Back office: menu (categories, products), import from Loyverse, staff and PINs, printers.
// Products are hidden, never deleted, so old bills keep their lines.
import { PosError, now, tx, logAction, getSettings, setSettings } from './db.js';
import { need, ROLES, createUser, setPin } from './auth.js';
import { Ticket, sendTcp } from './print.js';
import { events } from './orders.js';
import { prepIds, getStation } from './stations.js';

export const COLORS = ['orange', 'teal', 'sky', 'coral', 'violet', 'gray'];
const changed = type => events.emit('change', { type });
const text = (v, max, what) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new PosError('bad_input', `${what} is required`);
  return s.slice(0, max);
};
// Rupiah have no cents: "95.000", "95,000" and "Rp 95 000" all mean 95000.
const price = v => {
  const n = typeof v === 'number' ? Math.round(v) : Number(String(v).replace(/[^\d]/g, '') || NaN);
  if (!Number.isFinite(n) || n < 0 || n > 100e6) throw new PosError('bad_input', 'Invalid price');
  return n;
};
// A category or an item prints at a preparation station (Back office › Stations & printers).
const station = (db, v) => { if (v == null || v === '') return null; if (!prepIds(db).includes(v)) throw new PosError('bad_input', 'Unknown preparation station'); return v; };

// ---------- catalog ----------
export function adminCatalog(db) {
  const categories = db.prepare(`SELECT c.id, c.name, c.station, c.color, c.sort,
    (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS products FROM categories c ORDER BY c.sort, c.id`).all();
  const products = db.prepare(`SELECT id, category_id AS categoryId, name, price, photo, station, active, sort
    FROM products ORDER BY sort, id`).all();
  return { categories, products };
}

export function saveCategory(db, user, id, b) {
  need(user, 'manage_catalog');
  const name = text(b.name, 40, 'Name');
  const st = station(db, b.station) || prepIds(db)[0];
  const color = COLORS.includes(b.color) ? b.color : 'gray';
  const dup = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id || 0);
  if (dup) throw new PosError('exists', 'A category already has this name');
  if (id) {
    if (!db.prepare('UPDATE categories SET name = ?, station = ?, color = ? WHERE id = ?').run(name, st, color, id).changes)
      throw new PosError('not_found', 'Category not found', 404);
  } else {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 s FROM categories').get().s;
    id = Number(db.prepare('INSERT INTO categories (name, station, color, sort) VALUES (?, ?, ?, ?)').run(name, st, color, sort).lastInsertRowid);
  }
  logAction(db, user.id, 'category', { id, name });
  changed('catalog');
  return { id };
}

// Only an empty category can go (hide its products instead).
export function deleteCategory(db, user, id) {
  need(user, 'manage_catalog');
  if (db.prepare('SELECT 1 FROM products WHERE category_id = ?').get(id)) throw new PosError('not_empty', 'Move or hide its products first');
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  changed('catalog');
  return { ok: true };
}

export function saveProduct(db, user, id, b) {
  need(user, 'manage_catalog');
  const name = text(b.name, 60, 'Name');
  const p = price(b.price);
  const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(Number(b.categoryId));
  if (!cat) throw new PosError('bad_input', 'Choose a category');
  const st = station(db, b.station);
  const active = b.active === false ? 0 : 1;
  if (id) {
    if (!db.prepare('UPDATE products SET name = ?, price = ?, category_id = ?, station = ?, active = ? WHERE id = ?')
      .run(name, p, cat.id, st, active, id).changes) throw new PosError('not_found', 'Product not found', 404);
  } else {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 s FROM products WHERE category_id = ?').get(cat.id).s;
    id = Number(db.prepare('INSERT INTO products (category_id, name, price, station, active, sort) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cat.id, name, p, st, active, sort).lastInsertRowid);
  }
  logAction(db, user.id, 'product', { id, name, price: p, active });
  changed('catalog');
  return { id };
}

// Order inside a list: ids in the wanted order.
export function reorder(db, user, kind, ids) {
  need(user, 'manage_catalog');
  if (!Array.isArray(ids) || ids.length > 1000) throw new PosError('bad_input', 'Bad order');
  const table = kind === 'categories' ? 'categories' : 'products';
  const first = ids.map(Number);
  // The ids given come first, in that order; the others keep their order after them.
  const rest = db.prepare(`SELECT id FROM ${table} ORDER BY sort, id`).all().map(r => r.id).filter(id => !first.includes(id));
  const up = db.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`);
  tx(db, () => [...first, ...rest].forEach((id, i) => up.run(i, id)));
  changed('catalog');
  return { ok: true };
}

// ---------- Loyverse import ----------
// Loyverse › Items › Export gives a CSV: Handle, SKU, Name, Category, …, Option 1 value…, Cost, …,
// "Available for sale [Store]", "Price [Store]" (older exports: "Default price"). Variants repeat the Handle.
export function parseCsv(textIn) {
  const s = String(textIn || '').replace(/^﻿/, '');
  const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}

const KITCHEN = /food|meal|makan|plat|dish|kitchen|breakfast|lunch|dinner|snack|dessert|burger|pizza|pasta|noodle|nasi|mie|salad|sandwich|toast|soup|cake/i;

export function loyverseItems(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new PosError('bad_csv', 'The file is empty');
  const head = rows[0].map(h => String(h).trim());
  const col = re => head.findIndex(h => re.test(h));
  const iName = col(/^name$/i), iCat = col(/^category$/i), iHandle = col(/^handle$/i);
  const iPrice = [col(/^price \[/i), col(/^default price$/i), col(/^price$/i)].find(i => i >= 0);
  const iAvail = col(/^available for sale/i);
  const iOpts = head.map((h, i) => /^option \d+ value$/i.test(h) ? i : -1).filter(i => i >= 0);
  if (iName < 0 || iPrice === undefined) throw new PosError('bad_csv', 'This is not a Loyverse items export (no Name / Price column)');
  const items = []; const names = {};
  for (const r of rows.slice(1)) {
    const handle = iHandle >= 0 ? r[iHandle] : '';
    let name = String(r[iName] || '').trim();
    if (!name && handle) name = names[handle] || '';                 // a variant line of the item above
    if (name && handle) names[handle] = name;
    const opts = iOpts.map(i => String(r[i] || '').trim()).filter(Boolean);
    if (opts.length) name = `${name} (${opts.join(', ')})`;
    // Loyverse writes 40000 or 40000.00; a typed "40.000" means forty thousand.
    const raw = String(r[iPrice] || '').trim();
    const p = /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : Number(raw.replace(/[^\d]/g, ''));
    if (!name || !Number.isFinite(p) || String(r[iPrice] || '').trim() === '') continue;
    const cat = String(r[iCat] || '').trim() || 'Other';
    const avail = iAvail < 0 || !/^n/i.test(String(r[iAvail] || 'Y').trim());
    items.push({ name: name.slice(0, 60), category: cat.slice(0, 40), price: Math.round(p), active: avail });
  }
  if (!items.length) throw new PosError('bad_csv', 'No item with a price found in this file');
  return items;
}

// Preview (apply = false) or import: new categories and products are added, same names get the new price.
export function importLoyverse(db, user, csv, apply) {
  need(user, 'manage_catalog');
  const items = loyverseItems(csv);
  const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map(c => [c.name.toLowerCase(), c.id]));
  const prods = new Map(db.prepare('SELECT id, name, price FROM products').all().map(p => [p.name.toLowerCase(), p]));
  const plan = { newCategories: [], add: [], update: [], same: 0 };
  const preps = prepIds(db), barId = preps.includes('bar') ? 'bar' : preps[0], kitchenId = preps.includes('kitchen') ? 'kitchen' : barId;
  const seen = new Set();
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    const old = prods.get(key);
    // A category is created only for the new items that need it (an existing item keeps its category).
    if (!old && !cats.has(it.category.toLowerCase()) && !plan.newCategories.some(c => c.name.toLowerCase() === it.category.toLowerCase()))
      plan.newCategories.push({ name: it.category, station: KITCHEN.test(it.category) || KITCHEN.test(it.name) ? kitchenId : barId });
    if (!old) plan.add.push(it);
    else if (old.price !== it.price) plan.update.push({ ...it, id: old.id, oldPrice: old.price });
    else plan.same++;
  }
  if (!apply) return plan;
  tx(db, () => {
    let sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 s FROM categories').get().s;
    const colors = ['orange', 'teal', 'sky', 'coral', 'violet'];
    for (const c of plan.newCategories)
      cats.set(c.name.toLowerCase(), Number(db.prepare('INSERT INTO categories (name, station, color, sort) VALUES (?, ?, ?, ?)')
        .run(c.name, c.station, colors[sort % colors.length], sort++).lastInsertRowid));
    const ins = db.prepare('INSERT INTO products (category_id, name, price, active, sort) VALUES (?, ?, ?, ?, ?)');
    plan.add.forEach((it, i) => ins.run(cats.get(it.category.toLowerCase()), it.name, it.price, it.active ? 1 : 0, 1000 + i));
    const up = db.prepare('UPDATE products SET price = ? WHERE id = ?');
    plan.update.forEach(it => up.run(it.price, it.id));
  });
  logAction(db, user.id, 'import', { added: plan.add.length, updated: plan.update.length, categories: plan.newCategories.length });
  changed('catalog');
  return { ...plan, done: true };
}

// ---------- staff ----------
export function listUsers(db, user) {
  need(user, 'manage_users');
  return db.prepare('SELECT id, name, role, active, author FROM users ORDER BY active DESC, name').all();
}

export function saveUser(db, user, id, b) {
  need(user, 'manage_users');
  const name = text(b.name, 40, 'Name');
  if (!ROLES.includes(b.role)) throw new PosError('bad_input', 'Choose a role');
  const active = b.active === false ? 0 : 1;
  return tx(db, () => {
    if (!id) {
      if (!b.pin) throw new PosError('bad_pin', 'Choose a PIN (4 to 6 digits)');
      id = createUser(db, { name, role: b.role, pin: String(b.pin) });
    } else {
      if (!db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, b.role, active, id).changes)
        throw new PosError('not_found', 'Not found', 404);
      if (b.pin) setPin(db, id, String(b.pin));
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);  // logged out at once
    }
    if (!db.prepare("SELECT 1 FROM users WHERE role = 'owner' AND active = 1").get())
      throw new PosError('last_owner', 'Keep at least one active owner');
    logAction(db, user.id, 'user', { id, name, role: b.role, active, pin: b.pin ? 'changed' : undefined });
    return { id };
  });
}

// ---------- printers (stations: server/stations.js) ----------
export async function testPrinter(db, user, st, send = sendTcp) {
  need(user, 'printers');
  const p = getStation(db, st);
  if (!p?.host) throw new PosError('no_printer', 'Save the printer address first');
  const t = new Ticket(p.width || 48).align('center').bold(true).big(true).text('RABBIT POS').big(false).bold(false)
    .text(`Test: ${p.name}`).text(new Date().toLocaleString('en-GB')).text('If you can read this, it works.').cut();
  try { await send(p, t.bytes()); } catch (e) { throw new PosError('printer_off', `No answer from ${p.host}:${p.port} (${e.code || e.message})`); }
  return { ok: true };
}

export { now };
