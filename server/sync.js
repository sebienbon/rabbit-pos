// Link with the Reception Google Sheet, through the small Apps Script web app in bridge/Code.gs.
//  - pullGuests: names of the guests in house  -> local `guests` table (used by the guest search)
//  - pushOutbox: closed tabs waiting in `outbox` -> the Sheet (Unpaid ones show in Rabbit-System's Guest bills)
// Selling never waits for this: when the internet is down, rows stay in the outbox and leave later.
import { now } from './db.js';
import { replaceGuests } from './orders.js';

const TIMEOUT = 20000;

// Wait longer after each failure: 30 s, 1 min, 2 min ... up to 30 min.
const retryDelay = tries => Math.min(30 * 2 ** Math.max(0, tries - 1), 1800) * 1000;

export function sheetReady(s) { return !!(s.sheet_sync && s.sheet_url && s.sheet_secret); }

// Apps Script answers a POST with a redirect to the result; fetch follows it.
export async function callSheet(s, action, data = {}) {
  const ctrl = AbortSignal.timeout(TIMEOUT);
  const r = await fetch(s.sheet_url, {
    method: 'POST', redirect: 'follow', signal: ctrl,
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain: no CORS preflight, Apps Script reads e.postData
    body: JSON.stringify({ secret: s.sheet_secret, action, ...data }),
  });
  const text = await r.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`Sheet answered ${r.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
  if (!r.ok || !out.ok) throw Object.assign(new Error(out.error || `Sheet answered ${r.status}`), { refused: true });
  return out;
}

const state = { guestsAt: null, guestsError: null, busy: false, offlineTries: 0, retryAt: 0 };

export async function pullGuests(db, s) {
  if (!sheetReady(s)) return null;
  try {
    const { guests } = await callSheet(s, 'guests');
    // An empty answer is more likely a problem than an empty hostel: keep the list we have.
    if (Array.isArray(guests) && guests.length) replaceGuests(db, guests);
    state.guestsAt = now(); state.guestsError = null;
    return guests.length;
  } catch (e) {
    state.guestsError = e.message;
    return null;
  }
}

export async function pushOutbox(db, s, { force = false } = {}) {
  if (!sheetReady(s) || state.busy) return 0;
  if (!force && Date.now() < state.retryAt) return 0;   // no connection last time: wait a bit
  state.busy = true;
  let sent = 0;
  try {
    const rows = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20').all();
    for (const row of rows) {
      if (!force && row.tries && row.last_try && Date.now() - Date.parse(row.last_try) < retryDelay(row.tries)) continue;
      try {
        // `id` lets the script ignore a sale it already wrote (answer lost on the way back, then sent again).
        const res = await callSheet(s, row.type, { id: `pos-${row.id}-${row.created_at}`, data: JSON.parse(row.payload) });
        db.prepare('UPDATE outbox SET sent_at = ?, error = NULL, last_try = ? WHERE id = ?').run(now(), now(), row.id);
        sent++; state.offlineTries = 0; state.retryAt = 0;
        if (res.duplicate) console.log(`sheet: outbox #${row.id} was already there`);
      } catch (e) {
        db.prepare('UPDATE outbox SET tries = tries + 1, error = ?, last_try = ? WHERE id = ?').run(String(e.message).slice(0, 300), now(), row.id);
        if (!e.refused) { // no connection: stop here and try again later; a refused sale does not block the others
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

// Started by index.js: sales every 30 s, guests every 10 min.
export function startSync(db, getSettings) {
  const push = () => pushOutbox(db, getSettings()).catch(e => console.error('sheet', e));
  const guests = () => pullGuests(db, getSettings()).then(n => n != null && console.log(`sheet: ${n} guests`)).catch(e => console.error('sheet', e));
  guests(); push();
  return [setInterval(push, 30000), setInterval(guests, 600000)];
}
