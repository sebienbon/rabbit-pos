// Thermal printers (ESC/POS, the language of cheap 58/80 mm printers) over the network, port 9100.
// Each order line goes to its station (bar / kitchen); the receipt goes to 'receipt'.
import net from 'node:net';
import { now } from './db.js';

const ESC = 0x1b, GS = 0x1d;
// Cheap printers only know plain ASCII: "Café crème" prints as "Cafe creme".
const ascii = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');

export class Ticket {
  constructor(width = 48) { this.width = width; this.parts = [Buffer.from([ESC, 0x40])]; }
  raw(...bytes) { this.parts.push(Buffer.from(bytes)); return this; }
  text(s = '') { this.parts.push(Buffer.from(ascii(s) + '\n', 'ascii')); return this; }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  big(on) { return this.raw(GS, 0x21, on ? 0x11 : 0); }
  align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
  line() { return this.text('-'.repeat(this.width)); }
  pair(left, right) {
    left = ascii(left); right = ascii(right);
    const room = this.width - right.length - 1;
    return this.text(left.slice(0, room).padEnd(room) + ' ' + right);
  }
  drawer() { return this.raw(ESC, 0x70, 0, 25, 250); }
  cut() { return this.text('').text('').text('').raw(GS, 0x56, 66, 0); }
  bytes() { return Buffer.concat(this.parts); }
}

const rp = n => 'Rp ' + Number(n).toLocaleString('en-US').replace(/,/g, '.');
const hhmm = iso => new Date(iso).toTimeString().slice(0, 5);
const STATION_TITLE = { bar: 'BAR', kitchen: 'KITCHEN' };

function widthFor(settings, station) { return settings.printers?.[station]?.width || 48; }

function addJob(db, station, ticket, label) {
  db.prepare('INSERT INTO print_jobs (station, data, label, created_at) VALUES (?, ?, ?, ?)').run(station, ticket.bytes(), label, now());
}

export function queueOrderTickets(db, settings, orderId) {
  const o = db.prepare(`SELECT o.*, t.name, t.table_no FROM orders o JOIN tabs t ON t.id = o.tab_id WHERE o.id = ?`).get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND voided = 0').all(orderId);
  const stations = [...new Set(items.map(i => i.station))];
  for (const st of stations) {
    const t = new Ticket(widthFor(settings, st));
    t.align('center').big(true).bold(true).text(STATION_TITLE[st] || st.toUpperCase()).big(false).bold(false)
      .text(`Order #${orderId}  ${hhmm(o.created_at)}`).align('left').line()
      .bold(true).text(o.name).bold(false);
    if (o.table_no) t.text(`Table ${o.table_no}`);
    if (o.source !== 'pos') t.text(`Ordered by guest (${o.source})`);
    t.line();
    for (const i of items.filter(i => i.station === st)) {
      t.big(true).text(`${i.qty} x ${i.name}`).big(false);
      if (i.note) t.text(`   > ${i.note}`);
    }
    if (o.note) t.line().text(`Note: ${o.note}`);
    t.cut();
    addJob(db, st, t, `Order #${orderId} ${st}`);
  }
}

export function queueReceipt(db, settings, tabId) {
  const tab = db.prepare('SELECT * FROM tabs WHERE id = ?').get(tabId);
  const items = db.prepare(`SELECT i.name, i.qty, i.unit_price FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.tab_id = ? AND o.status = 'sent' AND i.voided = 0 ORDER BY i.id`).all(tabId);
  const t = new Ticket(widthFor(settings, 'receipt'));
  t.align('center').big(true).bold(true).text(settings.venue_name).big(false).bold(false)
    .text(new Date(tab.closed_at).toLocaleString('en-GB')).text(`Bill #${tabId}`).align('left').line();
  if (tab.kind !== 'walkin') t.text(tab.name);
  for (const i of items) t.pair(`${i.qty} x ${i.name}`, rp(i.qty * i.unit_price));
  t.line().pair('Subtotal', rp(tab.subtotal));
  if (tab.service) t.pair(`Service ${settings.service_rate}%`, rp(tab.service));
  if (tab.tax) t.pair(`Tax ${settings.tax_rate}%`, rp(tab.tax));
  t.bold(true).big(true).pair('TOTAL', rp(tab.total)).big(false).bold(false).pair('Paid', tab.payment)
    .text('').align('center').text('Thank you!');
  if (tab.payment === 'Cash') t.drawer();
  t.cut();
  addJob(db, 'receipt', t, `Bill #${tabId}`);
}

export function sendTcp({ host, port = 9100 }, data, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const fail = e => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => fail(new Error('Printer not answering')));
    sock.on('error', fail);
    sock.on('connect', () => sock.end(data, resolve));
  });
}

// Sends what waits. A printer that is off keeps its tickets; they print when it comes back.
let busy = false;
export async function processPrintJobs(db, settings, send = sendTcp) {
  if (busy) return 0;
  busy = true;
  let done = 0;
  try {
    const jobs = db.prepare("SELECT * FROM print_jobs WHERE status = 'waiting' ORDER BY id LIMIT 20").all();
    for (const j of jobs) {
      const printer = settings.printers?.[j.station];
      if (!printer?.host) {
        db.prepare('UPDATE print_jobs SET error = ? WHERE id = ?').run(`No printer set for ${j.station}`, j.id);
        continue;
      }
      try {
        await send(printer, Buffer.from(j.data));
        db.prepare("UPDATE print_jobs SET status = 'printed', error = NULL WHERE id = ?").run(j.id);
        done++;
      } catch (e) {
        const tries = j.tries + 1;
        db.prepare('UPDATE print_jobs SET tries = ?, error = ?, status = ? WHERE id = ?')
          .run(tries, String(e.message).slice(0, 200), tries >= 20 ? 'failed' : 'waiting', j.id);
      }
    }
  } finally { busy = false; }
  return done;
}

export function printQueue(db) {
  return db.prepare(`SELECT id, station, label, status, tries, error, created_at AS createdAt FROM print_jobs
    WHERE status != 'printed' OR created_at > ? ORDER BY id DESC LIMIT 50`).all(new Date(Date.now() - 3600e3).toISOString());
}

export function reprint(db, jobId) {
  db.prepare("UPDATE print_jobs SET status = 'waiting', tries = 0, error = NULL WHERE id = ?").run(jobId);
}
