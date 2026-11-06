// HTTP API + static files + live updates (Server-Sent Events). No external packages.
import http from 'node:http';
import { readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, normalize, extname, basename } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PosError, getSettings, setSettings, logAction } from './db.js';
import { login, logout, userFromToken, need, can } from './auth.js';
import * as O from './orders.js';
import { printQueue, reprint } from './print.js';
import { syncStatus, pushOutbox, pullGuests } from './sync.js';
import * as T from './shift.js';
import * as A from './admin.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

// What a guest's phone or the self-service tablet may know about the options.
const clientFlags = s => ({ venue: s.venue_name, photos: s.photos, tables: s.tables_enabled, external: s.external_guests,
  qr: s.qr_ordering, tablet: s.tablet_ordering, validation: s.validation_required,
  service: s.service_enabled ? s.service_rate : 0, tax: s.tax_enabled ? s.tax_rate : 0 });
const staffSettings = s => { const { client_key, sheet_password, sheet_token, journal_secret, ...rest } = s; return rest; };

// Product photos live in the app's `photos/` folder, kept in git (owner's choice): served from this PC, so the menu
// loads fast on the wifi and works without internet.
const PHOTOS_DIR = fileURLToPath(new URL('../photos/', import.meta.url));
export function createApp(db, { photosDir = PHOTOS_DIR, port = 8080 } = {}) {
  const PHOTOS = photosDir;
  const routes = [];
  const route = (method, path, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), handler, ...opts });

  // ----- staff -----
  route('POST', '/api/login', ({ body, req }) => login(db, body.pin, String(body.device || req.socket.remoteAddress).slice(0, 60)));
  route('POST', '/api/logout', ({ token }) => (logout(db, token), { ok: true }));
  route('GET', '/api/me', ({ user }) => (need(user, 'view_tabs'), { user }));
  route('GET', '/api/state', ({ user, s }) => {
    need(user, 'view_tabs');
    return { user, settings: staffSettings(s), catalog: O.catalog(db), tabs: O.listTabs(db, s),
      pending: O.pendingOrders(db), print: can(user, 'printers') ? printQueue(db) : [], sync: syncStatus(db, s),
      shift: s.till === 'bar' ? T.shiftSummary(db, T.openShift(db)) : null };
  });
  // Send waiting sales and refresh the guest list now (button on the till, or after the internet comes back).
  route('POST', '/api/sync', async ({ user, s }) => {
    need(user, 'view_tabs');
    const sent = await pushOutbox(db, s, { force: true });
    const guests = await pullGuests(db, s);
    O.events.emit('change', { type: 'sync' });
    return { sent, guests, ...syncStatus(db, s) };
  });
  route('GET', '/api/guests', ({ user, query }) => (need(user, 'view_tabs'), O.searchGuests(db, query.get('q'))));
  route('POST', '/api/orders', ({ user, s, body }) => O.createOrder(db, s, body, user, 'pos'));
  route('POST', '/api/orders/:id/accept', ({ user, s, p }) => O.decideOrder(db, s, +p.id, true, user));
  route('POST', '/api/orders/:id/reject', ({ user, s, p }) => O.decideOrder(db, s, +p.id, false, user));
  route('POST', '/api/items/:id/void', ({ user, p }) => (O.voidItem(db, +p.id, user), { ok: true }));
  route('GET', '/api/tabs/:id', ({ user, s, p }) => (need(user, 'view_tabs'), O.getTab(db, s, +p.id)));
  route('POST', '/api/tabs/:id/pay', ({ user, s, p, body }) => O.closeTab(db, s, +p.id, { payment: body.payment }, user));
  route('POST', '/api/tabs/:id/charge', ({ user, s, p }) => O.closeTab(db, s, +p.id, { charge: true }, user));
  route('POST', '/api/tabs/:id/print-bill', ({ user, s, p }) => O.printBill(db, s, +p.id, user));
  // Reception: bills put on guests since the start of yesterday (local time).
  route('GET', '/api/tabs-charged', ({ user, s }) => {
    need(user, 'view_tabs');
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    return O.chargedSince(db, s, new Date(Date.parse(day + 'T00:00:00+08:00') - 86400000).toISOString());
  });
  // Bar service: open with the cash count, close with the count and the cash handed over (BAR Cash-out).
  route('POST', '/api/shift/open', ({ user, body }) => T.startShift(db, user, body));
  route('POST', '/api/shift/close', async ({ user, s, body }) => {
    const r = T.endShift(db, s, user, body);
    pushOutbox(db, s, { force: true }).catch(() => {}); // the BAR Cash-out leaves now if the internet is there
    return r;
  });
  route('GET', '/api/report/day', ({ user, query }) => (need(user, 'take_payment'), T.dayReport(db, query.get('day'))));
  // Photo of a product: the image itself is the request body (JPEG, PNG or WebP, up to 3 MB; the back office shrinks it first).
  route('POST', '/api/products/:id/photo', async ({ user, p, body }) => {
    need(user, 'manage_catalog');
    const prod = db.prepare('SELECT id, photo FROM products WHERE id = ?').get(+p.id);
    if (!prod) throw new PosError('not_found', 'Unknown product', 404);
    const ext = imageType(body);
    if (!ext) throw new PosError('bad_image', 'Send a JPEG, PNG or WebP picture');
    await mkdir(PHOTOS, { recursive: true });
    const name = `p${prod.id}-${createHash('sha1').update(body).digest('hex').slice(0, 10)}.${ext}`;
    await writeFile(join(PHOTOS, name), body);
    const url = '/photos/' + name;
    db.prepare('UPDATE products SET photo = ? WHERE id = ?').run(url, prod.id);
    if (prod.photo && prod.photo !== url) await unlink(join(PHOTOS, basename(prod.photo))).catch(() => {});
    logAction(db, user.id, 'photo', { product: prod.id });
    O.events.emit('change', { type: 'catalog' });
    return { photo: url };
  }, { raw: 3e6 });
  route('DELETE', '/api/products/:id/photo', async ({ user, p }) => {
    need(user, 'manage_catalog');
    const prod = db.prepare('SELECT id, photo FROM products WHERE id = ?').get(+p.id);
    if (!prod) throw new PosError('not_found', 'Unknown product', 404);
    db.prepare('UPDATE products SET photo = NULL WHERE id = ?').run(prod.id);
    if (prod.photo) await unlink(join(PHOTOS, basename(prod.photo))).catch(() => {});
    O.events.emit('change', { type: 'catalog' });
    return { photo: null };
  });
  // ----- back office (public/admin.html) -----
  route('GET', '/api/admin/catalog', ({ user }) => (need(user, 'manage_catalog'), A.adminCatalog(db)));
  route('POST', '/api/admin/categories', ({ user, body }) => A.saveCategory(db, user, 0, body));
  route('PUT', '/api/admin/categories/:id', ({ user, p, body }) => A.saveCategory(db, user, +p.id, body));
  route('DELETE', '/api/admin/categories/:id', ({ user, p }) => A.deleteCategory(db, user, +p.id));
  route('POST', '/api/admin/products', ({ user, body }) => A.saveProduct(db, user, 0, body));
  route('PUT', '/api/admin/products/:id', ({ user, p, body }) => A.saveProduct(db, user, +p.id, body));
  route('POST', '/api/admin/order', ({ user, body }) => A.reorder(db, user, body.kind, body.ids));
  route('POST', '/api/admin/import', ({ user, body }) => A.importLoyverse(db, user, body.csv, !!body.apply), { jsonMax: 8e6 });
  route('GET', '/api/admin/users', ({ user }) => A.listUsers(db, user));
  route('POST', '/api/admin/users', ({ user, body }) => A.saveUser(db, user, 0, body));
  route('PUT', '/api/admin/users/:id', ({ user, p, body }) => A.saveUser(db, user, +p.id, body));
  route('PUT', '/api/admin/printers', ({ user, body }) => A.savePrinters(db, user, body));
  route('POST', '/api/admin/printers/test', ({ user, body }) => A.testPrinter(db, user, String(body.station)));
  // Owner options. Passwords and keys never leave the PC: the screen only learns whether they are set.
  const SECRET_KEYS = ['sheet_password', 'sheet_token', 'journal_secret', 'client_key'];
  const ownerSettings = s => ({ ...staffSettings(s), secrets: Object.fromEntries(SECRET_KEYS.map(k => [k, !!s[k]])) });
  route('GET', '/api/settings', ({ user, s }) => (need(user, 'settings'), ownerSettings(s)));
  route('PUT', '/api/settings', ({ user, body }) => {
    need(user, 'settings');
    const patch = { ...body };
    delete patch.secrets; delete patch.sheet_token; delete patch.client_key; delete patch.printers; // printers: own screen
    for (const k of ['sheet_password', 'journal_secret']) if (!patch[k]) delete patch[k];          // empty = keep the old one
    if ('sheet_url' in patch || 'sheet_user' in patch || 'sheet_password' in patch) patch.sheet_token = '';
    const out = setSettings(db, patch);
    logAction(db, user.id, 'settings', Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, SECRET_KEYS.includes(k) ? '(changed)' : v])));
    O.events.emit('change', { type: 'settings' });
    return ownerSettings(out);
  });
  route('GET', '/api/print', ({ user }) => (need(user, 'printers'), printQueue(db)));
  route('POST', '/api/print/:id/retry', ({ user, p }) => (need(user, 'printers'), reprint(db, +p.id), { ok: true }));

  // ----- guests ordering (QR link or self-service tablet): the link carries the venue key -----
  const clientOk = (s, query) => {
    if (!s.client_key || query.get('key') !== s.client_key) throw new PosError('forbidden', 'This ordering link is not valid', 403);
  };
  route('GET', '/api/client/menu', ({ s, query }) => (clientOk(s, query), { flags: clientFlags(s), ...O.catalog(db) }));
  route('GET', '/api/client/guests', ({ s, query }) => (clientOk(s, query), O.searchGuests(db, query.get('q'), { client: true })));
  route('POST', '/api/client/orders', ({ s, query, body }) => {
    clientOk(s, query);
    const source = body.source === 'tablet' ? 'tablet' : 'qr';
    const { guestId, guestName, externalName, table, items, note } = body; // a client never picks an existing tab id
    return O.createOrder(db, s, { guestId, guestName, externalName, table, items, note }, null, source);
  });
  // The guest's phone follows its own order (waiting for a waiter / sent / refused). Only the status, nothing else.
  route('GET', '/api/client/orders/:id', ({ s, query, p }) => {
    clientOk(s, query);
    const o = db.prepare('SELECT id, status FROM orders WHERE id = ? AND source IN (?, ?)').get(+p.id, 'qr', 'tablet');
    if (!o) throw new PosError('not_found', 'Order not found', 404);
    return o;
  });
  // Staff: the ordering links to put in the QR codes (the phones must be on the hostel wifi to reach this PC).
  route('GET', '/api/staff/order-links', ({ user, s }) => {
    need(user, 'manage_catalog');
    const ips = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
    return { key: s.client_key, tables: s.tables_enabled, bases: ips.map(ip => `http://${ip}:${port}`) };
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname === '/api/events') return events(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
        if (!r) throw new PosError('not_found', 'Unknown address', 404);
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const ctx = { req, token, user: userFromToken(db, token), s: getSettings(db), query: url.searchParams,
          p: r.re.exec(url.pathname).groups || {}, body: req.method === 'GET' ? {} : r.raw ? await readBody(req, r.raw) : await readJson(req, r.jsonMax) };
        return send(res, 200, await r.handler(ctx));
      }
      if (url.pathname.startsWith('/photos/')) return await servePhoto(req, res, PHOTOS, url.pathname);
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      if (!(e instanceof PosError)) console.error(e);
      send(res, e.status || 500, { error: e.code || 'server_error', message: e instanceof PosError ? e.message : 'Server error' });
    }
  });

  function events(req, res, url) {
    if (!userFromToken(db, url.searchParams.get('token'))) return send(res, 401, { error: 'login' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const on = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    O.events.on('change', on);
    req.on('close', () => { clearInterval(ping); O.events.off('change', on); });
  }
  return server;
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data ?? {}));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    // Too big: read to the end anyway (so the device gets a clear answer), keep nothing; cut off only far above the limit.
    req.on('data', c => { size += c.length; if (size <= max) chunks.push(c); else if (size > max * 5) req.destroy(); });
    req.on('end', () => size > max ? reject(new PosError('too_big', 'Picture too big (3 MB max)', 413)) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function imageType(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readJson(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > max) { reject(new PosError('too_big', 'Request too big', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new PosError('bad_json', 'Bad request')); }
    });
    req.on('error', reject);
  });
}

// App files: the phone or tablet keeps them and only asks "changed?" (answer 304 when not): fast on the wifi.
async function serveStatic(req, res, path) {
  if (path === '/') path = '/pos.html';
  const file = normalize(join(PUBLIC, decodeURIComponent(path)));
  if (!file.startsWith(PUBLIC)) throw new PosError('not_found', 'Not found', 404);
  await sendFile(req, res, file, path.startsWith('/fonts/') || path.startsWith('/img/') ? 'public, max-age=604800' : 'no-cache');
}
// A photo's name changes with its content, so a device can keep it for good.
async function servePhoto(req, res, dir, path) {
  const name = basename(decodeURIComponent(path));
  if (!/^p\d+-[0-9a-f]{10}\.(jpg|png|webp)$/.test(name)) throw new PosError('not_found', 'Not found', 404);
  await sendFile(req, res, join(dir, name), 'public, max-age=31536000, immutable');
}
async function sendFile(req, res, file, cache) {
  let st;
  try { st = await stat(file); } catch { throw new PosError('not_found', 'Not found', 404); }
  if (!st.isFile()) throw new PosError('not_found', 'Not found', 404);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const head = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': cache, ETag: etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
  res.writeHead(200, head);
  res.end(await readFile(file));
}
