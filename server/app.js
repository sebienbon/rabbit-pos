// HTTP API + static files + live updates (Server-Sent Events). No external packages.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PosError, getSettings, setSettings, logAction } from './db.js';
import { login, logout, userFromToken, need, can } from './auth.js';
import * as O from './orders.js';
import { printQueue, reprint } from './print.js';
import { syncStatus, pushOutbox, pullGuests } from './sync.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

// What a guest's phone or the self-service tablet may know about the options.
const clientFlags = s => ({ venue: s.venue_name, photos: s.photos, tables: s.tables_enabled, external: s.external_guests,
  qr: s.qr_ordering, tablet: s.tablet_ordering, validation: s.validation_required,
  service: s.service_enabled ? s.service_rate : 0, tax: s.tax_enabled ? s.tax_rate : 0 });
const staffSettings = s => { const { client_key, sheet_secret, ...rest } = s; return rest; };

export function createApp(db) {
  const routes = [];
  const route = (method, path, handler) => routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), handler });

  // ----- staff -----
  route('POST', '/api/login', ({ body, req }) => login(db, body.pin, String(body.device || req.socket.remoteAddress).slice(0, 60)));
  route('POST', '/api/logout', ({ token }) => (logout(db, token), { ok: true }));
  route('GET', '/api/me', ({ user }) => (need(user, 'view_tabs'), { user }));
  route('GET', '/api/state', ({ user, s }) => {
    need(user, 'view_tabs');
    return { user, settings: staffSettings(s), catalog: O.catalog(db), tabs: O.listTabs(db, s),
      pending: O.pendingOrders(db), print: can(user, 'printers') ? printQueue(db) : [], sync: syncStatus(db, s) };
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
  route('GET', '/api/settings', ({ user, s }) => (need(user, 'settings'), s));
  route('PUT', '/api/settings', ({ user, body }) => {
    need(user, 'settings');
    const out = setSettings(db, body);
    logAction(db, user.id, 'settings', body);
    O.events.emit('change', { type: 'settings' });
    return out;
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
    const { guestId, externalName, table, items, note } = body; // a client never picks an existing tab id
    return O.createOrder(db, s, { guestId, externalName, table, items, note }, null, source);
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
          p: r.re.exec(url.pathname).groups || {}, body: req.method === 'GET' ? {} : await readJson(req) };
        return send(res, 200, await r.handler(ctx));
      }
      return serveStatic(res, url.pathname);
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new PosError('too_big', 'Request too big', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new PosError('bad_json', 'Bad request')); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, path) {
  if (path === '/') path = '/pos.html';
  const file = normalize(join(PUBLIC, decodeURIComponent(path)));
  if (!file.startsWith(PUBLIC)) throw new PosError('not_found', 'Not found', 404);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { throw new PosError('not_found', 'Not found', 404); }
}
