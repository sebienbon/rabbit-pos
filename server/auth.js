// PIN login and role permissions.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { PosError, now, logAction } from './db.js';

export const ROLES = ['owner', 'manager', 'cashier', 'waiter', 'reception'];

// What each role may do. 'client' is a guest ordering from the QR link or the self-service tablet.
const PERMS = {
  sell:       ['owner', 'manager', 'cashier', 'waiter'],
  take_payment: ['owner', 'manager', 'cashier', 'reception'],
  validate:   ['owner', 'manager', 'cashier', 'waiter'],
  void_item:  ['owner', 'manager'],
  view_tabs:  ['owner', 'manager', 'cashier', 'waiter', 'reception'],
  manage_catalog: ['owner', 'manager'],
  manage_users:   ['owner'],
  settings:   ['owner'],
  printers:   ['owner', 'manager'],
};

export function can(user, perm) {
  return !!user && (PERMS[perm] || []).includes(user.role);
}
export function need(user, perm) {
  if (!user) throw new PosError('login', 'Please log in with your PIN', 401);
  if (!can(user, perm)) throw new PosError('forbidden', 'Your role cannot do this', 403);
}

const hash = (pin, salt) => scryptSync(String(pin), salt, 32).toString('hex');

function checkPinFormat(pin) {
  if (!/^\d{4,6}$/.test(String(pin))) throw new PosError('bad_pin', 'The PIN must be 4 to 6 digits');
}

export function createUser(db, { name, role, pin, author }) {
  if (!name || !String(name).trim()) throw new PosError('bad_user', 'Name required');
  if (!ROLES.includes(role)) throw new PosError('bad_user', `Unknown role: ${role}`);
  checkPinFormat(pin);
  if (findByPin(db, pin)) throw new PosError('pin_taken', 'This PIN is already used by someone else');
  const salt = randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users (name, role, pin_hash, pin_salt, author) VALUES (?, ?, ?, ?, ?)')
    .run(String(name).trim(), role, hash(pin, salt), salt, author || null);
  return Number(r.lastInsertRowid);
}

// New PIN for a staff member (each PIN belongs to one person: the PIN alone says who logs in).
export function setPin(db, userId, pin) {
  checkPinFormat(pin);
  const other = findByPin(db, pin);
  if (other && other.id !== userId) throw new PosError('pin_taken', 'This PIN is already used by someone else');
  const salt = randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(hash(pin, salt), salt, userId);
}

function findByPin(db, pin) {
  for (const u of db.prepare('SELECT * FROM users WHERE active = 1').all()) {
    const a = Buffer.from(hash(pin, u.pin_salt), 'hex');
    if (timingSafeEqual(a, Buffer.from(u.pin_hash, 'hex'))) return u;
  }
  return null;
}

// Wrong PINs slow a device down: 5 mistakes, then 30 s wait.
const attempts = new Map();
export function login(db, pin, device = 'unknown') {
  const a = attempts.get(device) || { n: 0, until: 0 };
  if (Date.now() < a.until) throw new PosError('wait', 'Too many wrong PINs, wait 30 seconds', 429);
  const u = /^\d{4,6}$/.test(String(pin)) ? findByPin(db, pin) : null;
  if (!u) {
    a.n += 1; if (a.n >= 5) { a.n = 0; a.until = Date.now() + 30000; }
    attempts.set(device, a);
    throw new PosError('bad_pin', 'Wrong PIN', 401);
  }
  attempts.delete(device);
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, device, created_at) VALUES (?, ?, ?, ?)').run(token, u.id, device, now());
  logAction(db, u.id, 'login', { device });
  return { token, user: publicUser(u) };
}

export function logout(db, token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }

export function userFromToken(db, token) {
  if (!token) return null;
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1').get(token);
  return u ? publicUser(u) : null;
}

export const publicUser = u => ({ id: u.id, name: u.name, role: u.role, author: u.author || u.name });
