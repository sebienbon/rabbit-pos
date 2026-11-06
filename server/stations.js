// Stations: where tickets print. Two kinds:
//  - 'prep': a preparation point (Bar, Kitchen, Pizza, Beach bar…). A category or a product chooses its station;
//            a mixed order is split, each station gets only its own lines. `copy_all`: also gets every order (pass).
//  - 'till': a cash point (Bar till, Beach till…) with its own receipt printer, cash drawer and bar service.
//            Each device chooses its till; the receipt prints there.
// `sheet_object`: the object written in Rabbit-System's Entries for a guest bill line made here (Bar / Restaurant).
import { PosError, getSettings, logAction, tx } from './db.js';
import { need } from './auth.js';

export const KINDS = ['prep', 'till'];

// First start (and databases from before stations existed): Bar, Kitchen, Bar till, with the old printer settings.
export function ensureStations(db) {
  if (db.prepare('SELECT 1 FROM stations LIMIT 1').get()) return;
  const old = getSettings(db).printers || {};
  const ins = db.prepare('INSERT INTO stations (id, name, kind, host, port, width, sheet_object, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  [['bar', 'Bar', 'prep', 'Bar'], ['kitchen', 'Kitchen', 'prep', 'Restaurant'], ['receipt', 'Bar till', 'till', null]].forEach(([id, name, kind, obj], i) =>
    ins.run(id, name, kind, old[id]?.host || null, old[id]?.port || 9100, old[id]?.width || 48, obj, i));
}

export const listStations = (db, { all = false } = {}) =>
  db.prepare(`SELECT * FROM stations ${all ? '' : 'WHERE active = 1'} ORDER BY sort, rowid`).all();
export const getStation = (db, id) => db.prepare('SELECT * FROM stations WHERE id = ?').get(id) || null;
export const prepIds = db => listStations(db).filter(s => s.kind === 'prep').map(s => s.id);

// The till a device works at (default: the first till).
export function tillFor(db, id) {
  const t = id && db.prepare("SELECT * FROM stations WHERE id = ? AND kind = 'till' AND active = 1").get(String(id));
  if (t) return t;
  const first = db.prepare("SELECT * FROM stations WHERE kind = 'till' AND active = 1 ORDER BY sort, rowid LIMIT 1").get();
  if (!first) throw new PosError('no_till', 'Add a till in the back office (Stations & printers)');
  return first;
}

// What the screens may know (no printer address for staff).
export const publicStations = db => listStations(db).map(({ id, name, kind, copy_all }) => ({ id, name, kind, copyAll: !!copy_all }));

const HOST = /^(\d{1,3}\.){3}\d{1,3}$|^[a-z0-9][a-z0-9.-]{0,62}$/i;
// Back office: add or change a station. The id is made from the first name and never changes (old tickets keep it).
export function saveStation(db, user, id, b) {
  need(user, 'printers');
  return tx(db, () => saveStation_(db, user, id, b));
}
function saveStation_(db, user, id, b) {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!name) throw new PosError('bad_input', 'Name the station');
  const kind = id ? getStation(db, id)?.kind : b.kind;
  if (!KINDS.includes(kind)) throw new PosError('bad_input', 'Kind: preparation or till');
  const host = String(b.host || '').trim();
  if (host && !HOST.test(host)) throw new PosError('bad_input', `${name}: write the printer address like 192.168.1.50`);
  const port = Number(b.port || 9100), width = Number(b.width || 48);
  if (!(port > 0 && port < 65536)) throw new PosError('bad_input', `${name}: wrong port`);
  if (![32, 42, 48].includes(width)) throw new PosError('bad_input', `${name}: paper 58 mm (32) or 80 mm (48)`);
  const obj = kind === 'prep' ? (String(b.sheetObject || '').trim().slice(0, 40) || 'Bar') : null;
  const active = b.active === false ? 0 : 1;
  if (id) {
    if (!getStation(db, id)) throw new PosError('not_found', 'Station not found', 404);
    if (!active) {
      const used = db.prepare('SELECT (SELECT COUNT(*) FROM categories WHERE station = ?) + (SELECT COUNT(*) FROM products WHERE station = ?) n').get(id, id).n;
      if (used) throw new PosError('in_use', `${name} is used by ${used} categor(ies)/item(s): move them first`);
      if (kind === 'till' && db.prepare("SELECT 1 FROM shifts WHERE till = ? AND closed_at IS NULL").get(id)) throw new PosError('in_use', 'Close the service of this till first');
    }
    db.prepare('UPDATE stations SET name = ?, host = ?, port = ?, width = ?, copy_all = ?, sheet_object = ?, active = ? WHERE id = ?')
      .run(name, host || null, port, width, b.copyAll ? 1 : 0, obj, active, id);
  } else {
    const base = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'station';
    id = base; for (let n = 2; getStation(db, id); n++) id = `${base}-${n}`;
    const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 s FROM stations').get().s;
    db.prepare('INSERT INTO stations (id, name, kind, host, port, width, copy_all, sheet_object, active, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, name, kind, host || null, port, width, b.copyAll ? 1 : 0, obj, sort);
  }
  if (kind === 'till' && !db.prepare("SELECT 1 FROM stations WHERE kind = 'till' AND active = 1").get()) throw new PosError('last_till', 'Keep at least one till');
  logAction(db, user.id, 'station', { id, name, kind, host, active });
  return { id };
}
