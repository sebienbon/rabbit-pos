// Back office: options (owner), menu + photos + Loyverse import (owner, manager), staff and PINs (owner),
// printers (owner, manager), Google Sheet link (owner), QR codes.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp ' + Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
let token = store.get('token'), me = null;

async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(path, { method, headers: { Authorization: 'Bearer ' + token, ...(raw ? { 'Content-Type': raw.type || 'image/jpeg' } : { 'Content-Type': 'application/json' }) },
    body: raw || (body ? JSON.stringify(body) : undefined) }).catch(() => { throw new Error('No connection to the POS server'); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { token = null; store.set('token', null); showLogin(); throw new Error('Please log in'); }
  if (!r.ok) throw new Error(data.message || 'Error');
  return data;
}
let toastT;
function toast(msg, bad) { const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 3000); }
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Please log in') toast(e.message, true); } };

// ---------- sections ----------
const SECTIONS = [
  { id: 'options', name: 'Options', roles: ['owner'], draw: drawOptions },
  { id: 'menu', name: 'Menu & photos', roles: ['owner', 'manager'], draw: drawMenu },
  { id: 'import', name: 'Import from Loyverse', roles: ['owner', 'manager'], draw: drawImport },
  { id: 'staff', name: 'Staff & PINs', roles: ['owner'], draw: drawStaff },
  { id: 'printers', name: 'Printers', roles: ['owner', 'manager'], draw: drawPrinters },
  { id: 'sheet', name: 'Google Sheet', roles: ['owner'], draw: drawSheet },
  { id: 'qr', name: 'QR codes', roles: ['owner', 'manager'], draw: () => { location.href = '/qr.html'; } },
];
let section = location.hash.slice(1) || 'options';
function nav() {
  const mine = SECTIONS.filter(s => s.roles.includes(me.role));
  if (!mine.some(s => s.id === section)) section = mine[0]?.id;
  $('nav').innerHTML = mine.map(s => `<button data-s="${s.id}" ${s.id === section ? 'aria-current="page"' : ''}>${s.name}</button>`).join('');
}
$('nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.s); };
const go = run(async id => { section = id; history.replaceState(null, '', '#' + id); nav(); await SECTIONS.find(s => s.id === id).draw(); });
const head = (title, sub) => `<div class="head"><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const sw = (key, on, label) => `<button class="switch" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-key="${key}"><span></span></button>`;

// ---------- options ----------
let S = null;
const OPTS = [
  ['service_enabled', 'Service charge', 'Adds a percentage to bills.', 'service_rate'],
  ['tax_enabled', 'Tax (PB1)', 'Adds the restaurant tax to bills.', 'tax_rate'],
  ['validation_required', 'Waiter checks guest orders', 'A QR or tablet order on a room bill waits for a waiter to accept it.'],
  ['tables_enabled', 'Tables', 'Table numbers on orders and on the QR codes.'],
  ['qr_ordering', 'Guests order by QR code', 'Guests order from their phone.'],
  ['tablet_ordering', 'Self-service tablet', 'A tablet shows the menu in large format.'],
  ['external_guests', 'External guests', 'People not staying at the hostel can open a bill with their name.'],
  ['photos', 'Photos on the guest menu', 'Shows each product photo on phones and the tablet.'],
  ['sheet_sync', 'Google Sheet', 'Sends guest bills and the bar cash-out to the Reception sheet.'],
];
async function drawOptions() {
  S = await api('/api/settings');
  $('main').innerHTML = head('Options', 'Turn on only what you need. The screens adapt by themselves.') + `
    <div class="grid2">${OPTS.map(([k, t, d, rate]) => `<div class="card opt"><div class="txt"><b>${t}</b><small>${d}</small>
      ${rate && S[k] ? `<div class="row" style="margin-top: 6px"><label class="f">Rate %<input class="i small" type="number" min="0" max="50" step="0.5" data-rate="${rate}" value="${S[rate]}"></label></div>` : ''}</div>
      ${sw(k, S[k], t)}</div>`).join('')}</div>
    <div class="grid2">
      <div class="card"><b>Venue name</b><input class="i" id="venue" value="${esc(S.venue_name)}" maxlength="40"></div>
      <div class="card"><b>Payment types at the bar</b><small class="hint">Separated by commas. "Unpaid" is not one: use "Put on the guest bill".</small>
        <input class="i" id="pays" value="${esc(S.payments.join(', '))}"></div>
      <div class="card"><b>Cash drawer</b><small class="hint">Bar: the bar has its own drawer, opened and closed with a cash count.</small>
        <select class="i" id="till"><option value="bar" ${S.till === 'bar' ? 'selected' : ''}>Bar has its own drawer</option>
        <option value="reception" ${S.till === 'reception' ? 'selected' : ''}>One drawer with the reception (not finished)</option></select></div>
    </div>
    <div><button class="btn go" id="saveOpts">Save</button></div>`;
  $('main').onclick = run(async e => {
    const b = e.target.closest('[data-key]');
    if (b) { const k = b.dataset.key; S = await api('/api/settings', { method: 'PUT', body: { [k]: !S[k] } }); toast('Saved'); return drawOptions(); }
    if (e.target.id === 'saveOpts') {
      const body = { venue_name: $('venue').value.trim() || 'Rabbit Tree', till: $('till').value,
        payments: $('pays').value.split(',').map(x => x.trim()).filter(x => x && !/^unpaid$/i.test(x)).slice(0, 8) };
      if (!body.payments.length) throw new Error('Keep at least one payment type');
      document.querySelectorAll('[data-rate]').forEach(i => { body[i.dataset.rate] = Number(i.value); });
      S = await api('/api/settings', { method: 'PUT', body }); toast('Saved'); drawOptions();
    }
  });
}

// ---------- menu & photos ----------
let C = null, cat = 0;
const STATION = { bar: 'Bar', kitchen: 'Kitchen' };
const COLORS = ['orange', 'teal', 'sky', 'coral', 'violet', 'gray'];
async function drawMenu() {
  C = await api('/api/admin/catalog');
  if (!C.categories.some(c => c.id === cat)) cat = C.categories[0]?.id || 0;
  const c = C.categories.find(x => x.id === cat);
  const list = C.products.filter(p => p.categoryId === cat);
  $('main').innerHTML = head('Menu & photos', 'Prices, what goes to the bar or the kitchen, photos for the guest menu. Hidden items stay in old bills.') + `
    <nav class="cats" aria-label="Categories">${C.categories.map(x => `<button data-cat="${x.id}" aria-pressed="${x.id === cat}">${esc(x.name)}</button>`).join('')}
      <button class="add" data-newcat="1">+ Category</button></nav>
    ${c ? `<div class="card"><div class="row">
      <label class="f">Category name<input class="i" id="cName" value="${esc(c.name)}" maxlength="40"></label>
      <label class="f">Tickets print at<select class="i" id="cStation">${Object.entries(STATION).map(([k, v]) => `<option value="${k}" ${c.station === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">Colour<select class="i" id="cColor">${COLORS.map(k => `<option ${c.color === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <button class="btn ghost" data-savecat="1">Save category</button>
      ${c.products ? '' : '<button class="btn bad" data-delcat="1">Delete</button>'}</div></div>
    <div class="wrap"><table><thead><tr><th>Photo</th><th>Name</th><th>Price (Rp)</th><th>Prints at</th><th>On sale</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr class="${p.active ? '' : 'off'}" data-id="${p.id}">
        <td><label class="thumb" title="Change the photo">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : 'Add<br>photo'}<input type="file" accept="image/*" data-photo="${p.id}" aria-label="Photo of ${esc(p.name)}"></label>
          ${p.photo ? `<button class="btn" style="min-height: 28px; padding: 0 4px; font-size: 12px; color: var(--bad)" data-nophoto="${p.id}">remove</button>` : ''}</td>
        <td><input class="i" data-f="name" value="${esc(p.name)}" maxlength="60" aria-label="Name"></td>
        <td><input class="i money" data-f="price" inputmode="numeric" value="${p.price}" aria-label="Price"></td>
        <td><select class="i" data-f="station" aria-label="Prints at"><option value="">Like the category</option>${Object.entries(STATION).map(([k, v]) => `<option value="${k}" ${p.station === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td>${sw('active', p.active, 'On sale')}</td>
        <td><button class="btn ghost" data-saveprod="${p.id}">Save</button></td></tr>`).join('')}
      <tr data-id="0"><td></td><td><input class="i" data-f="name" placeholder="New item" maxlength="60" aria-label="New item name"></td>
        <td><input class="i money" data-f="price" inputmode="numeric" placeholder="0" aria-label="New item price"></td>
        <td><select class="i" data-f="station" aria-label="Prints at"><option value="">Like the category</option>${Object.entries(STATION).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></td>
        <td></td><td><button class="btn go" data-saveprod="0">Add</button></td></tr>
    </tbody></table></div>` : '<div class="card">Add a first category, or import your menu from Loyverse.</div>'}`;
  const rowBody = tr => ({ name: tr.querySelector('[data-f=name]').value, price: tr.querySelector('[data-f=price]').value,
    station: tr.querySelector('[data-f=station]').value || null, categoryId: cat,
    active: tr.querySelector('[data-key=active]') ? tr.querySelector('[data-key=active]').getAttribute('aria-checked') === 'true' : true });
  $('main').onclick = run(async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.cat) { cat = Number(d.cat); return drawMenu(); }
    if (d.newcat) { const r = await api('/api/admin/categories', { method: 'POST', body: { name: 'New category ' + (C.categories.length + 1), station: 'bar', color: 'gray' } }); cat = r.id; return drawMenu(); }
    if (d.savecat) { await api(`/api/admin/categories/${cat}`, { method: 'PUT', body: { name: $('cName').value, station: $('cStation').value, color: $('cColor').value } }); toast('Saved'); return drawMenu(); }
    if (d.delcat) { await api(`/api/admin/categories/${cat}`, { method: 'DELETE' }); cat = 0; return drawMenu(); }
    if (d.key === 'active') { const tr = b.closest('tr'); b.setAttribute('aria-checked', b.getAttribute('aria-checked') !== 'true'); await api(`/api/admin/products/${tr.dataset.id}`, { method: 'PUT', body: rowBody(tr) }); toast('Saved'); return drawMenu(); }
    if (d.saveprod !== undefined) {
      const tr = b.closest('tr'), id = Number(d.saveprod);
      await api(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PUT' : 'POST', body: rowBody(tr) });
      toast(id ? 'Saved' : 'Added'); return drawMenu();
    }
    if (d.nophoto) { await api(`/api/products/${d.nophoto}/photo`, { method: 'DELETE' }); return drawMenu(); }
  });
  $('main').onchange = run(async e => {
    const id = e.target.dataset.photo; if (!id || !e.target.files[0]) return;
    toast('Uploading the photo…');
    const blob = await shrink(e.target.files[0]);
    await api(`/api/products/${id}/photo`, { method: 'POST', raw: blob });
    toast('Photo saved'); drawMenu();
  });
}
// Photos are kept small (800 px, JPEG): fast on the wifi, light in GitHub.
async function shrink(file, max = 800) {
  const img = await createImageBitmap(file).catch(() => { throw new Error('This picture cannot be read: use a JPEG or PNG'); });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(b => res(b), 'image/jpeg', 0.82));
}

// ---------- Loyverse import ----------
let csvText = '';
function drawImport() {
  $('main').innerHTML = head('Import from Loyverse', 'In Loyverse Back Office: Items › Item list › Export. Then choose that file here.') + `
    <div class="card"><label class="f">Loyverse export (.csv)<input class="i" type="file" id="csv" accept=".csv,text/csv"></label>
      <small class="hint">New categories and items are added; an item with the same name gets the new price. Nothing is deleted.
      Categories with food words go to the kitchen printer: check them after the import in "Menu & photos".</small></div>
    <div id="plan"></div>`;
  $('csv').onchange = run(async () => {
    csvText = await $('csv').files[0].text();
    const p = await api('/api/admin/import', { method: 'POST', body: { csv: csvText } });
    const li = (l, f) => l.length ? `<ul class="preview">${l.slice(0, 200).map(f).join('')}</ul>` : '<div class="hint">none</div>';
    $('plan').innerHTML = `<div class="card"><h3>Before importing</h3>
      <div class="status ok">${p.add.length} new item(s), ${p.update.length} new price(s), ${p.newCategories.length} new categorie(s), ${p.same} unchanged</div>
      <b>New categories</b>${li(p.newCategories, c => `<li>${esc(c.name)} → ${STATION[c.station]}</li>`)}
      <b>New items</b>${li(p.add, i => `<li>${esc(i.name)} · ${esc(i.category)} · ${rp(i.price)}${i.active ? '' : ' (not on sale)'}</li>`)}
      <b>New prices</b>${li(p.update, i => `<li>${esc(i.name)}: ${rp(i.oldPrice)} → ${rp(i.price)}</li>`)}
      <div><button class="btn go" id="doImport" ${p.add.length || p.update.length || p.newCategories.length ? '' : 'disabled'}>Import now</button></div></div>`;
    $('doImport').onclick = run(async () => {
      const r = await api('/api/admin/import', { method: 'POST', body: { csv: csvText, apply: true } });
      toast(`Imported: ${r.add.length} items, ${r.update.length} prices`); section = 'menu'; go('menu');
    });
  });
}

// ---------- staff ----------
const ROLES = { owner: 'Owner (everything)', manager: 'Manager (menu, printers, voids)', cashier: 'Cashier (sells, takes money)',
  waiter: 'Waiter (sells, no money)', reception: 'Reception (takes money, bills)' };
async function drawStaff() {
  const users = await api('/api/admin/users');
  const roleSel = r => `<select class="i" data-f="role" aria-label="Role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${r === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
  $('main').innerHTML = head('Staff & PINs', 'Each person has their own PIN (4 to 6 digits): the PIN says who sold, voided or counted the cash.') + `
    <div class="wrap"><table><thead><tr><th>Name</th><th>Role</th><th>New PIN</th><th>Active</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr class="${u.active ? '' : 'off'}" data-id="${u.id}"><td><input class="i" data-f="name" value="${esc(u.name)}" maxlength="40" aria-label="Name"></td>
      <td>${roleSel(u.role)}</td><td><input class="i small" data-f="pin" inputmode="numeric" maxlength="6" placeholder="keep" aria-label="New PIN for ${esc(u.name)}" autocomplete="off"></td>
      <td>${sw('active', u.active, 'Active')}</td><td><button class="btn ghost" data-save="${u.id}">Save</button></td></tr>`).join('')}
    <tr data-id="0"><td><input class="i" data-f="name" placeholder="New person" maxlength="40" aria-label="New person name"></td><td>${roleSel('waiter')}</td>
      <td><input class="i small" data-f="pin" inputmode="numeric" maxlength="6" placeholder="PIN" aria-label="PIN of the new person" autocomplete="off"></td><td></td>
      <td><button class="btn go" data-save="0">Add</button></td></tr></tbody></table></div>`;
  const body = tr => ({ name: tr.querySelector('[data-f=name]').value, role: tr.querySelector('[data-f=role]').value,
    pin: tr.querySelector('[data-f=pin]').value.trim() || undefined,
    active: tr.querySelector('[data-key=active]') ? tr.querySelector('[data-key=active]').getAttribute('aria-checked') === 'true' : true });
  $('main').onclick = run(async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.key === 'active') { b.setAttribute('aria-checked', b.getAttribute('aria-checked') !== 'true'); return; }
    if (b.dataset.save !== undefined) {
      const id = Number(b.dataset.save), tr = b.closest('tr');
      await api(id ? `/api/admin/users/${id}` : '/api/admin/users', { method: id ? 'PUT' : 'POST', body: body(tr) });
      toast(id ? 'Saved' : 'Added'); drawStaff();
    }
  });
}

// ---------- printers ----------
async function drawPrinters() {
  const st = await api('/api/state');
  const P = st.settings.printers || {};
  const row = (k, label) => `<div class="card"><b>${label}</b><div class="row">
    <label class="f">Address on the wifi<input class="i" data-p="${k}" data-f="host" value="${esc(P[k]?.host || '')}" placeholder="192.168.1.50"></label>
    <label class="f" style="flex: 0 0 90px">Port<input class="i" data-p="${k}" data-f="port" value="${P[k]?.port || 9100}" inputmode="numeric"></label>
    <label class="f" style="flex: 0 0 150px">Paper<select class="i" data-p="${k}" data-f="width"><option value="48" ${(P[k]?.width || 48) === 48 ? 'selected' : ''}>80 mm</option>
      <option value="32" ${P[k]?.width === 32 ? 'selected' : ''}>58 mm</option></select></label>
    <button class="btn ghost" data-test="${k}">Print a test</button></div></div>`;
  const waiting = (st.print || []).filter(j => j.status !== 'done');
  $('main').innerHTML = head('Printers', 'Network (LAN) receipt printers. The address is printed on the self-test page of the printer (hold FEED while switching it on).') +
    row('bar', 'Bar tickets') + row('kitchen', 'Kitchen tickets') + row('receipt', 'Receipts (and cash drawer)') +
    `<div><button class="btn go" id="savePr">Save</button></div>
    <div class="card"><b>Waiting to print</b>${waiting.length ? waiting.map(j => `<div class="status warn">${esc(j.station)} · ${esc(j.label || '')} · ${esc(j.error || 'waiting')}</div>`).join('') : '<div class="hint">Nothing waiting.</div>'}</div>`;
  const collect = () => { const o = {}; document.querySelectorAll('[data-p]').forEach(i => { (o[i.dataset.p] ||= {})[i.dataset.f] = i.dataset.f === 'host' ? i.value.trim() : Number(i.value); }); return o; };
  $('main').onclick = run(async e => {
    if (e.target.id === 'savePr') { await api('/api/admin/printers', { method: 'PUT', body: collect() }); toast('Saved'); return drawPrinters(); }
    const t = e.target.closest('[data-test]');
    if (t) { await api('/api/admin/printers', { method: 'PUT', body: collect() }); await api('/api/admin/printers/test', { method: 'POST', body: { station: t.dataset.test } }); toast('Test sent: check the printer'); }
  });
}

// ---------- Google Sheet ----------
async function drawSheet() {
  const [s, st] = await Promise.all([api('/api/settings'), api('/api/state')]);
  const y = st.sync || {};
  const status = !s.sheet_url ? '<div class="status warn">Not set up yet.</div>'
    : y.error ? `<div class="status bad">Problem: ${esc(y.error)}</div>`
    : `<div class="status ok">Working${y.waiting ? ` · ${y.waiting} waiting` : ''}${y.lastSent ? ` · last sent ${new Date(y.lastSent).toLocaleString('en-GB')}` : ''}</div>`;
  $('main').innerHTML = head('Google Sheet', 'Guest bills and the bar cash-out go to Rabbit-System; every bill goes to the "POS Bar" tab.') + status + `
    <div class="card"><b>Rabbit-System (guest bills, BAR Cash-out, guest names)</b>
      <label class="f">Rabbit-System web app address<input class="i" id="url" value="${esc(s.sheet_url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <div class="row"><label class="f">POS account (UI_Users tab)<input class="i" id="user" value="${esc(s.sheet_user)}"></label>
      <label class="f">Its password<input class="i" id="pw" type="password" autocomplete="new-password" placeholder="${s.secrets.sheet_password ? 'set (type to change)' : 'not set'}"></label></div></div>
    <div class="card"><b>"POS Bar" tab (journal of every bill)</b>
      <label class="f">Address of the POS Bar script<input class="i" id="jurl" value="${esc(s.journal_url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
      <label class="f">Its secret<input class="i" id="jsec" type="password" autocomplete="new-password" placeholder="${s.secrets.journal_secret ? 'set (type to change)' : 'not set'}"></label></div>
    <div class="card"><b>Lines of guest bills in Entries</b><div class="row">
      <label class="f">Sub-category<input class="i" id="cat" value="${esc(s.sheet_category)}"></label>
      <label class="f">Object for drinks<input class="i" id="obar" value="${esc(s.sheet_object_bar)}"></label>
      <label class="f">Object for food<input class="i" id="okit" value="${esc(s.sheet_object_kitchen)}"></label></div></div>
    <div class="row"><button class="btn go" id="saveSh">Save</button><button class="btn line" id="syncNow">Send now and refresh guests</button></div>`;
  $('main').onclick = run(async e => {
    if (e.target.id === 'saveSh') {
      await api('/api/settings', { method: 'PUT', body: { sheet_url: $('url').value.trim(), sheet_user: $('user').value.trim(), sheet_password: $('pw').value,
        journal_url: $('jurl').value.trim(), journal_secret: $('jsec').value, sheet_category: $('cat').value.trim() || 'Service',
        sheet_object_bar: $('obar').value.trim() || 'Bar', sheet_object_kitchen: $('okit').value.trim() || 'Restaurant' } });
      toast('Saved'); return drawSheet();
    }
    if (e.target.id === 'syncNow') { const r = await api('/api/sync', { method: 'POST' }); toast(r.error ? 'Problem: ' + r.error : `Sent ${r.sent} · ${r.guests ?? '?'} guests`, !!r.error); drawSheet(); }
  });
}

// ---------- login ----------
function showLogin() {
  $('nav').innerHTML = ''; $('me').textContent = '';
  $('main').innerHTML = `<form class="card login" id="lf"><h2>Back office</h2><div class="sub">Owner or manager PIN</div>
    <input class="i" id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN" autofocus>
    <button class="btn go">Log in</button></form>`;
  $('lf').onsubmit = run(async e => {
    e.preventDefault();
    const r = await api('/api/login', { method: 'POST', body: { pin: $('pin').value, device: store.get('device') || 'backoffice' } });
    token = r.token; store.set('token', token); start();
  });
}
const start = run(async () => {
  if (!token) return showLogin();
  me = (await api('/api/me')).user;
  if (!['owner', 'manager'].includes(me.role)) { $('main').innerHTML = '<div class="card login">The back office is for the owner and managers. <a href="/">Back to the till</a></div>'; return; }
  $('me').textContent = `${me.name} · ${me.role}`;
  nav(); await go(section);
});
start();
