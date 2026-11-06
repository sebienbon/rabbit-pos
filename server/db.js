// SQLite database (built into Node 22+, no install). One file: data/pos.db.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
  pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL, author TEXT, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, station TEXT NOT NULL DEFAULT 'bar', color TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  price INTEGER NOT NULL, photo TEXT, station TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS guests (name TEXT PRIMARY KEY, room TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tabs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, table_no TEXT,
  status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL, opened_by INTEGER,
  closed_at TEXT, closed_by INTEGER, payment TEXT, subtotal INTEGER, service INTEGER, tax INTEGER, total INTEGER);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, tab_id INTEGER NOT NULL REFERENCES tabs(id), source TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, created_by INTEGER, validated_by INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL,
  name TEXT NOT NULL, category TEXT NOT NULL, station TEXT NOT NULL, qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, note TEXT, voided INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS print_jobs (
  id INTEGER PRIMARY KEY, station TEXT NOT NULL, data BLOB NOT NULL, label TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', tries INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  sent_at TEXT, tries INTEGER NOT NULL DEFAULT 0, error TEXT, last_try TEXT);
CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, detail TEXT);
`;

// Owner options. Defaults follow the owner's choices of 06/11/2026.
export const DEFAULT_SETTINGS = {
  service_enabled: false, service_rate: 5,
  tax_enabled: false, tax_rate: 10,
  validation_required: false,     // client orders on a room tab wait for a waiter
  tables_enabled: false,
  qr_ordering: true, tablet_ordering: true, external_guests: true, photos: true,
  sheet_sync: true,
  sheet_url: '',                  // Apps Script web app address (bridge/Code.gs), ends with /exec
  sheet_secret: '',               // same value as SECRET in the script properties
  client_key: '',                 // secret in the QR link; set on first start
  till: 'bar',                    // 'bar' = its own cash drawer; 'reception' = counted in the reception shift
  payments: ['Cash', 'Card', 'QRIS'],
  printers: {},                   // { bar: {host, port}, kitchen: {...}, receipt: {...} }
  venue_name: 'Rabbit Tree',
};

export function openDb(file = 'data/pos.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after phase 1 (databases created before keep working).
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c);
  if (!has('outbox', 'last_try')) db.exec('ALTER TABLE outbox ADD COLUMN last_try TEXT');
  return db;
}

export const now = () => new Date().toISOString();

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[key] = JSON.parse(value); } catch { /* ignore a damaged value, keep the default */ }
  }
  return out;
}

export function setSettings(db, patch) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) throw new PosError('bad_setting', `Unknown option: ${k}`);
    if (typeof v !== typeof DEFAULT_SETTINGS[k] && !(Array.isArray(DEFAULT_SETTINGS[k]) && Array.isArray(v)))
      throw new PosError('bad_setting', `Wrong type for ${k}`);
    if (k === 'till' && !['bar', 'reception'].includes(v)) throw new PosError('bad_setting', 'till must be bar or reception');
    if (/_rate$/.test(k) && !(v >= 0 && v <= 50)) throw new PosError('bad_setting', 'Rate must be 0 to 50 %');
    up.run(k, JSON.stringify(v));
  }
  return getSettings(db);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function logAction(db, userId, action, detail) {
  db.prepare('INSERT INTO log (at, user_id, action, detail) VALUES (?, ?, ?, ?)').run(now(), userId ?? null, action, detail ? JSON.stringify(detail) : null);
}

export class PosError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
