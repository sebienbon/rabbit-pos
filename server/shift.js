// Bar till: service open / close with the cash count (owner decisions of 06/11/2026).
// Every payment belongs to the till that receives the money: bills paid at the bar stay in the bar's drawer.
// Only cash is counted per drawer; cards are checked for the whole day (both terminals = bar cards + reception cards).
// When the bar's cash is handed over, the POS writes the "BAR Cash-out" line of Entries Manual itself (outbox -> sync.js).
import { PosError, now, tx, logAction } from './db.js';
import { need } from './auth.js';
import { events } from './orders.js';
import { tillFor } from './stations.js';

const money = (v, what) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new PosError('bad_amount', `Invalid amount: ${what}`);
  return n;
};
const emit = () => events.emit('change', { type: 'shift' });

// Each till has its own drawer and its own service.
export function openShift(db, till) {
  const t = tillFor(db, till).id;
  return db.prepare("SELECT * FROM shifts WHERE closed_at IS NULL AND till = ? ORDER BY id DESC LIMIT 1").get(t) || null;
}
// Cash left in the drawer after the last service (counted - handed over): what the next opening should find.
function leftInDrawer(db, till) {
  const last = db.prepare('SELECT counted, cashout FROM shifts WHERE closed_at IS NOT NULL AND till = ? ORDER BY id DESC LIMIT 1').get(till);
  return last ? last.counted - last.cashout : 0;
}

// Totals of one service: paid bills by payment type, bills put on guests, expected cash in the drawer.
export function shiftSummary(db, shift) {
  if (!shift) return null;
  const pays = db.prepare(`SELECT payment, COUNT(*) n, SUM(total) total FROM tabs
    WHERE shift_id = ? AND status = 'paid' GROUP BY payment ORDER BY payment`).all(shift.id);
  const charged = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total), 0) total FROM tabs WHERE shift_id = ? AND status = 'charged'").get(shift.id);
  const cash = pays.find(p => p.payment === 'Cash')?.total || 0;
  return { ...shift, payments: pays, charged, cashSales: cash, expected: shift.float + cash };
}

export function startShift(db, user, { counted, comment, till }) {
  need(user, 'take_payment');
  const t = tillFor(db, till);
  const res = tx(db, () => {
    if (openShift(db, t.id)) throw new PosError('shift_open', `${t.name} is already open`);
    const float = money(counted, 'cash counted');
    const ref = leftInDrawer(db, t.id);
    const id = Number(db.prepare(`INSERT INTO shifts (opened_at, opened_by, float, open_diff, open_comment, till) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(now(), user.id, float, float - ref, String(comment || '').slice(0, 300), t.id).lastInsertRowid);
    logAction(db, user.id, 'shift_open', { id, float, diff: float - ref });
    return { id, float, expectedFloat: ref, diff: float - ref };
  });
  emit();
  return res;
}

// counted: cash in the drawer now; cashout: part of it handed to the reception / owner (written as BAR Cash-out).
export function endShift(db, settings, user, { counted, cashout, comment, till }) {
  need(user, 'take_payment');
  const t = tillFor(db, till);
  const res = tx(db, () => {
    const sh = shiftSummary(db, openShift(db, t.id));
    if (!sh) throw new PosError('no_shift', `${t.name} is not open`);
    const c = money(counted, 'cash counted'), out = money(cashout ?? 0, 'cash handed over');
    if (out > c) throw new PosError('bad_amount', 'You cannot hand over more cash than you counted');
    const diff = c - sh.expected, at = now(), note = String(comment || '').slice(0, 300);
    db.prepare(`UPDATE shifts SET closed_at = ?, closed_by = ?, counted = ?, cashout = ?, expected = ?, diff = ?, comment = ? WHERE id = ?`)
      .run(at, user.id, c, out, sh.expected, diff, note, sh.id);
    if (out > 0 && settings.sheet_sync) db.prepare('INSERT INTO outbox (type, payload, created_at) VALUES (?, ?, ?)').run('bar_cashout', JSON.stringify({
      shiftId: sh.id, at, amount: out,
      comment: `${t.name} service #${sh.id}: counted ${c}, expected ${sh.expected}, difference ${diff}${note ? ' · ' + note : ''}`.slice(0, 300),
    }), at);
    logAction(db, user.id, 'shift_close', { id: sh.id, counted: c, cashout: out, diff });
    return { ...shiftSummary(db, db.prepare('SELECT * FROM shifts WHERE id = ?').get(sh.id)), left: c - out };
  });
  emit();
  return res;
}

// One day (local time UTC+8) of the bar: payment totals, guest bills, services. For the card check of the day.
export function dayReport(db, day) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(d + 'T00:00:00+08:00')).toISOString(), to = new Date(Date.parse(d + 'T00:00:00+08:00') + 86400000).toISOString();
  const payments = db.prepare(`SELECT payment, COUNT(*) n, SUM(total) total FROM tabs WHERE status = 'paid' AND closed_at >= ? AND closed_at < ?
    GROUP BY payment ORDER BY payment`).all(from, to);
  const charged = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total), 0) total FROM tabs WHERE status = 'charged' AND closed_at >= ? AND closed_at < ?").get(from, to);
  const shifts = db.prepare('SELECT * FROM shifts WHERE opened_at < ? AND (closed_at IS NULL OR closed_at >= ?) ORDER BY id').all(to, from);
  return { day: d, payments, charged, cards: payments.filter(p => /card/i.test(p.payment)).reduce((a, p) => a + p.total, 0), shifts };
}
