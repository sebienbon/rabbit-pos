// Link with the Reception Google Sheet through Rabbit-System's own web app (30.UI_api.gs, UIAPI.handle):
//   login (POS user of the UI_Users tab) -> token kept 14 days, logged in again by itself when it expires
//   pull -> `guests` (24datafeed C + New guest F)  -> local `guests` table for the guest search
//   push -> op `sale` with payment 'Unpaid'           -> Entries + Entries Manual, so it shows in Guest bills
// Bills paid at the bar stay in the POS (the bar has its own cash; the desk records the bar cash-out).
// Selling never waits for this: when the internet is down, bills stay in the outbox and leave later.
import { now, setSettings } from './db.js';
import { replaceGuests } from './orders.js';

const TIMEOUT = 40000; // a push or pull of Rabbit-System can take ~20 s

// Wait longer after each failure: 30 s, 1 min, 2 min ... up to 30 min.
const retryDelay = tries => Math.min(30 * 2 ** Math.max(0, tries - 1), 1800) * 1000;

export function sheetReady(s) { return !!(s.sheet_sync && s.sheet_url && s.sheet_user && s.sheet_password); }

class SheetError extends Error {
  constructor(code, message, refused = true) { super(message || code); this.code = code; this.refused = refused; }
}

// Apps Script answers a POST with a redirect to the result; fetch follows it.
async function post(s, body) {
  let r, text;
  try {
    r = await fetch(s.sheet_url, {
      method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body),
    });
    text = await r.text();
  } catch (e) { throw new SheetError('offline', `No connection to the Sheet (${e.cause?.code || e.name})`, false); }
  let out;
  try { out = JSON.parse(text); } catch { throw new SheetError('offline', `Sheet answered ${r.status}`, false); }
  if (!out.ok) throw new SheetError(out.error || 'server_error', out.message || out.error, out.error !== 'server_error');
  return out;
}

const state = { token: null, guestsAt: null, guestsError: null, busy: false, offlineTries: 0, retryAt: 0 };

async function login(db, s) {
  const r = await post(s, { action: 'login', username: s.sheet_user, password: s.sheet_password, deviceId: s.sheet_device });
  state.token = r.token;
  if (db) setSettings(db, { sheet_token: r.token });
  return r;
}

// Call with the session; log in first or again when it expired.
export async function callSheet(db, s, action, data = {}) {
  if (!state.token) state.token = s.sheet_token || null;
  if (!state.token) await login(db, s);
  try {
    return await post(s, { action, token: state.token, ...data });
  } catch (e) {
    if (e.code !== 'no_session') throw e;
    await login(db, s);
    return post(s, { action, token: state.token, ...data });
  }
}

export async function pullGuests(db, s) {
  if (!sheetReady(s)) return null;
  try {
    const { guests } = await callSheet(db, s, 'pull');
    // An empty answer is more likely a problem than an empty hostel: keep the list we have.
    if (Array.isArray(guests) && guests.length) replaceGuests(db, guests);
    state.guestsAt = now(); state.guestsError = null;
    return guests.length;
  } catch (e) {
    state.guestsError = e.message;
    return null;
  }
}

// Line ids of Rabbit-System: 17 digits yyyyMMddHHmmssSSS in UTC+8, near the time of the sale.
export const tsOf = ms => new Date(ms + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 17);

// One closed POS bill -> one Rabbit-System `sale` op. `variant` changes the ids after a refusal.
export function saleOp(row, s) {
  const d = JSON.parse(row.payload), v = row.variant || 0, at = Date.parse(d.at);
  return {
    id: `POS-${row.id}-${Date.parse(row.created_at)}${v ? '-' + v : ''}`, type: 'sale', at: d.at,
    payload: {
      payment: 'Unpaid', saleId: `POS${d.tabId}`,
      lines: d.lines.map((l, i) => ({
        ts: tsOf(at + v * 211 + i), qty: l.qty, unit: l.unit, unitCost: 0, guest: d.guest, object: l.product,
        category: s.sheet_category || 'Bar', comment: `Bar POS bill #${d.tabId}${l.category ? ' · ' + l.category : ''}`,
      })),
    },
  };
}

export async function pushOutbox(db, s, { force = false } = {}) {
  if (!sheetReady(s) || state.busy) return 0;
  if (!force && Date.now() < state.retryAt) return 0;   // no connection last time: wait a bit
  state.busy = true;
  let sent = 0;
  const fail = (row, msg, bump) => db.prepare('UPDATE outbox SET tries = tries + 1, error = ?, last_try = ?, variant = variant + ? WHERE id = ?')
    .run(String(msg).slice(0, 300), now(), bump ? 1 : 0, row.id);
  try {
    const rows = db.prepare("SELECT * FROM outbox WHERE sent_at IS NULL AND type = 'sale' ORDER BY id LIMIT 20").all();
    for (const row of rows) {
      if (!force && row.tries && row.last_try && Date.now() - Date.parse(row.last_try) < retryDelay(row.tries)) continue;
      try {
        const res = await callSheet(db, s, 'push', { deviceId: s.sheet_device, ops: [saleOp(row, s)] });
        const r = (res.results || [])[0];
        if (!r) { // stopped before our op (Google busy): try again later
          fail(row, res.message || 'The Sheet was busy, sent again later');
          state.retryAt = Date.now() + retryDelay(++state.offlineTries);
          break;
        }
        if (r.status === 'applied' || r.status === 'duplicate') {
          db.prepare('UPDATE outbox SET sent_at = ?, error = ?, last_try = ? WHERE id = ?').run(now(), r.warning || null, now(), row.id);
          sent++; state.offlineTries = 0; state.retryAt = 0;
        } else {
          // Refused by Rabbit-System: shown on the till. A refused op id stays refused there, so the next try uses new ids.
          fail(row, `${r.message || r.error}`, true);
        }
      } catch (e) {
        fail(row, e.message);
        if (!e.refused) { // no connection: stop here and try again later
          state.retryAt = Date.now() + retryDelay(++state.offlineTries);
          break;
        }
      }
    }
  } finally { state.busy = false; }
  return sent;
}

export function syncStatus(db, s) {
  const w = db.prepare('SELECT COUNT(*) n, MAX(error) err FROM outbox WHERE sent_at IS NULL').get();
  const last = db.prepare('SELECT MAX(sent_at) at FROM outbox').get().at;
  return { on: sheetReady(s), waiting: w.n, error: w.err || state.guestsError, lastSent: last, guestsAt: state.guestsAt };
}

// Started by index.js: guest bills every 30 s; guest list every 30 min (a Rabbit-System pull reads a lot).
export function startSync(db, getSettings) {
  const push = () => pushOutbox(db, getSettings()).catch(e => console.error('sheet', e));
  const guests = () => pullGuests(db, getSettings()).then(n => n != null && console.log(`sheet: ${n} guests`)).catch(e => console.error('sheet', e));
  guests(); push();
  return [setInterval(push, 30000), setInterval(guests, 1800000)];
}

export function resetSyncState() { Object.assign(state, { token: null, guestsAt: null, guestsError: null, busy: false, offlineTries: 0, retryAt: 0 }); }
