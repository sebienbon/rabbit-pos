// Till screen: PIN, products, current bill, guests, open bills, client orders to validate.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp ' + Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
if (!store.get('device')) store.set('device', 'dev-' + Math.random().toString(36).slice(2, 8));

let token = store.get('token');
let S = null;                     // server state
let cat = 0, query = '';
let cur = { tabId: null, who: null, cart: [] }; // who: {guestId|externalName|walkin, label}
let es = null;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined }).catch(() => { throw new Error('No connection to the POS server'); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { logout(); throw new Error('Please log in again'); }
  if (!r.ok) throw new Error(data.message || 'Error');
  return data;
}
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg; t.role = 'status';
  document.body.append(t); setTimeout(() => t.remove(), 2600);
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
const can = perm => ({ sell: ['owner', 'manager', 'cashier', 'waiter'], pay: ['owner', 'manager', 'cashier', 'reception'],
  void: ['owner', 'manager'], validate: ['owner', 'manager', 'cashier', 'waiter'] })[perm].includes(S?.user.role);

// ---------- PIN ----------
let pin = '';
function showPin() {
  $('main').classList.add('hidden'); $('pin').classList.remove('hidden');
  $('clock').textContent = new Date().toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  pin = ''; drawDots();
}
function drawDots() { [...document.querySelectorAll('.dots span')].forEach((d, i) => d.classList.toggle('on', i < pin.length)); }
$('keys').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'].map(k =>
  `<button data-k="${k}" class="${k === 'C' ? 'clr' : k === 'OK' ? 'go' : ''}" aria-label="${k === 'C' ? 'Clear' : k === 'OK' ? 'Enter' : k}">${k}</button>`).join('');
$('keys').onclick = e => { const k = e.target.closest('button')?.dataset.k; if (k) key(k); };
document.addEventListener('keydown', e => {
  if ($('pin').classList.contains('hidden')) return;
  if (/^\d$/.test(e.key)) key(e.key); else if (e.key === 'Backspace') key('C'); else if (e.key === 'Enter') key('OK');
});
const key = run(async k => {
  $('pinErr').textContent = '';
  if (k === 'C') pin = pin.slice(0, -1);
  else if (k !== 'OK' && pin.length < 6) pin += k;
  drawDots();
  if (k === 'OK' || pin.length === 4) {
    if (pin.length < 4) return;
    try {
      const r = await api('/api/login', { method: 'POST', body: { pin, device: store.get('device') } });
      token = r.token; store.set('token', token); await start();
    } catch (e) { pin = ''; drawDots(); $('pinErr').textContent = e.message; }
  }
});
function logout() {
  if (token) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  token = null; store.set('token', null); es?.close(); es = null; cur = { tabId: null, who: null, cart: [] }; showPin();
}
$('meBtn').onclick = logout;

// ---------- state ----------
async function load() { S = await api('/api/state'); draw(); }
async function start() {
  await load();
  $('pin').classList.add('hidden'); $('main').classList.remove('hidden');
  es?.close();
  es = new EventSource('/api/events?token=' + token);
  let t; es.onmessage = () => { clearTimeout(t); t = setTimeout(() => load().catch(() => {}), 150); };
  es.onerror = () => net(false); es.onopen = () => { net(true); load().catch(() => {}); };
}
function net(on) { $('net').innerHTML = `<span class="dot${on ? '' : ' off'}"></span><span>${on ? 'Online' : 'Reconnecting…'}</span>`; }

// ---------- drawing ----------
function draw() {
  const { catalog, user } = S;
  $('meBtn').textContent = `${user.name} · ${user.role}`;
  $('venue').textContent = S.settings.venue_name;
  $('tabsCount').textContent = S.tabs.length;
  $('cats').innerHTML = [{ id: 0, name: 'All' }, ...catalog.categories].map(c =>
    `<button data-c="${c.id}" class="${c.id === cat ? 'on' : ''}">${esc(c.name)}</button>`).join('');
  const color = id => catalog.categories.find(c => c.id === id)?.color || 'gray';
  const list = catalog.products.filter(p => (!cat || p.categoryId === cat) && p.name.toLowerCase().includes(query));
  $('grid').innerHTML = can('sell') ? list.map(p =>
    `<button class="tile c-${color(p.categoryId)}" data-p="${p.id}">${esc(p.name)}<small>${rp(p.price)}</small></button>`).join('')
    || '<div class="empty">No item</div>' : '<div class="empty">Your role takes payments: open a bill from “Open bills”.</div>';
  drawPending(); drawTicket(); drawSync();
}
// Google Sheet link: shown only when sales wait or something went wrong.
function drawSync() {
  const y = S.sync || {}, b = $('sheetBtn');
  b.classList.toggle('hidden', !y.on || (!y.waiting && !y.error));
  b.classList.toggle('warn', !!y.error);
  b.textContent = y.waiting ? `Sheet: ${y.waiting} waiting` : 'Sheet: problem';
  b.title = y.error ? `Google Sheet: ${y.error} (tap to try again)` : 'Google Sheet: tap to send now';
}
$('sheetBtn').onclick = run(async () => {
  const r = await api('/api/sync', { method: 'POST' });
  toast(r.waiting ? `Still ${r.waiting} waiting: ${r.error || 'try later'}` : 'Sent to the Google Sheet');
  await load();
});
$('cats').onclick = e => { const c = e.target.closest('button')?.dataset.c; if (c != null) { cat = +c; draw(); } };
$('search').oninput = e => { query = e.target.value.trim().toLowerCase(); draw(); };
$('grid').onclick = e => {
  const id = +e.target.closest('button')?.dataset.p; if (!id) return;
  const p = S.catalog.products.find(x => x.id === id);
  const line = cur.cart.find(l => l.productId === id && !l.note);
  if (line) line.qty++; else cur.cart.push({ productId: id, name: p.name, price: p.price, qty: 1 });
  drawTicket();
};

function curTab() { return cur.tabId ? S.tabs.find(t => t.id === cur.tabId) : null; }
function drawTicket() {
  const tab = curTab();
  if (cur.tabId && !tab) cur = { tabId: null, who: null, cart: cur.cart }; // closed elsewhere
  $('tHead').textContent = tab ? `Bill #${tab.id}` : 'New bill';
  const label = tab ? tab.name : cur.who?.label;
  $('whoTxt').textContent = label || 'Who is it for?';
  $('whoBtn').classList.toggle('set', !!label);
  $('whoBtn').disabled = !!tab;
  const sent = tab ? tab.orders.flatMap(o => o.items.map(i => ({ ...i, pending: o.status === 'pending' }))) : [];
  $('lines').innerHTML = sent.map(i => `
    <div class="line sent">
      <div class="q">${i.qty}</div>
      <div class="n">${esc(i.name)}${i.voided ? ' <s>(void)</s>' : ''}<small>${i.pending ? 'Waiting for validation' : esc(i.station)}${i.note ? ' · ' + esc(i.note) : ''}</small></div>
      <div class="p">${i.voided ? '' : rp(i.qty * i.unit_price)}</div>
      ${can('void') && !i.voided ? `<button class="mini" data-void="${i.id}" aria-label="Void ${esc(i.name)}">×</button>` : ''}
    </div>`).join('') + cur.cart.map((l, k) => `
    <div class="line">
      <button class="mini" data-dec="${k}" aria-label="One less">−</button>
      <div class="q">${l.qty}</div>
      <div class="n">${esc(l.name)}<small>Not sent yet</small></div>
      <div class="p">${rp(l.qty * l.price)}</div>
      <button class="mini" data-inc="${k}" aria-label="One more">+</button>
    </div>`).join('') || '<div class="empty">Tap items to add them</div>';
  const st = S.settings;
  const sub = (tab?.subtotal || 0) + cur.cart.reduce((s, l) => s + l.qty * l.price, 0);
  const service = st.service_enabled ? Math.round(sub * st.service_rate / 100) : 0;
  const tax = st.tax_enabled ? Math.round((sub + service) * st.tax_rate / 100) : 0;
  $('sSub').textContent = rp(sub); $('sService').textContent = rp(service); $('sTax').textContent = rp(tax);
  $('lService').textContent = `Service ${st.service_rate} %`; $('lTax').textContent = `Tax ${st.tax_rate} %`;
  $('rService').classList.toggle('hidden', !st.service_enabled); $('rTax').classList.toggle('hidden', !st.tax_enabled);
  $('sTotal').textContent = rp(sub + service + tax);
  $('sendBtn').disabled = !cur.cart.length || !can('sell');
  $('payBtn').disabled = !can('pay') || (!sub);
}
$('lines').onclick = run(async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.inc) cur.cart[b.dataset.inc].qty++;
  if (b.dataset.dec) { const l = cur.cart[b.dataset.dec]; if (--l.qty < 1) cur.cart.splice(b.dataset.dec, 1); }
  if (b.dataset.void && confirmBox) return confirmBox('Void this line?', 'It stays on the bill as void and in the log.', async () => {
    await api(`/api/items/${b.dataset.void}/void`, { method: 'POST' }); await load();
  });
  drawTicket();
});
$('newBtn').onclick = () => { cur = { tabId: null, who: null, cart: [] }; drawTicket(); };

// ---------- send / pay ----------
async function send() {
  if (!cur.cart.length) return cur.tabId;
  if (!cur.tabId && !cur.who) { await pickWho(); if (!cur.who) return null; }
  const body = { items: cur.cart.map(l => ({ productId: l.productId, qty: l.qty, note: l.note })) };
  if (cur.tabId) body.tabId = cur.tabId;
  else Object.assign(body, { guestId: cur.who.guestId, externalName: cur.who.externalName, walkin: cur.who.walkin });
  const r = await api('/api/orders', { method: 'POST', body });
  cur = { tabId: r.tabId, who: null, cart: [] };
  toast('Sent to bar / kitchen');
  await load();
  return r.tabId;
}
$('sendBtn').onclick = run(send);
$('payBtn').onclick = run(async () => {
  if (!cur.tabId && !cur.who && cur.cart.length) cur.who = { walkin: true, label: 'Walk-in' };
  const id = await send(); if (!id) return;
  const tab = curTab();
  open(`<h2>Pay ${rp(tab.total)}</h2>
    <div style="color: var(--ink-soft); font-weight: 700">${esc(tab.name)}</div>
    ${S.settings.payments.map(p => `<button class="opt" data-pay="${esc(p)}">${esc(p)}</button>`).join('')}
    ${tab.kind !== 'walkin' ? `<button class="opt" data-charge="1" style="background: var(--ok-bg); color: var(--ok); border: 0">
      Put on the guest bill<small>Paid at the reception</small></button>` : ''}
    <button class="btn line2" data-close="1">Cancel</button>`, run(async b => {
    if (b.dataset.pay) await api(`/api/tabs/${id}/pay`, { method: 'POST', body: { payment: b.dataset.pay } });
    else if (b.dataset.charge) await api(`/api/tabs/${id}/charge`, { method: 'POST' });
    else return close();
    close(); toast(b.dataset.charge ? 'Added to the guest bill' : 'Paid');
    cur = { tabId: null, who: null, cart: [] }; await load();
  }));
});

// ---------- who ----------
function pickWho() {
  return new Promise(resolve => {
    open(`<h2>Who is it for?</h2>
      <input id="gq" placeholder="Room number or guest name" aria-label="Room number or guest name" autocomplete="off">
      <div id="gres"></div>
      ${S.settings.external_guests ? `<div class="split"><input id="ext" placeholder="External guest: name" aria-label="External guest name"><button class="btn pick" style="flex: 0 0 120px" data-ext="1">Add</button></div>` : ''}
      <button class="opt" data-walkin="1">Walk-in<small>Pays now</small></button>
      <button class="btn line2" data-close="1">Cancel</button>`, b => {
      if (b.dataset.g) cur.who = { guestId: +b.dataset.g, label: b.dataset.label };
      else if (b.dataset.ext) { const n = $('ext').value.trim(); if (n.length < 2) return toast('Enter a name', true); cur.who = { externalName: n, label: n + ' (external)' }; }
      else if (b.dataset.walkin) cur.who = { walkin: true, label: 'Walk-in' };
      close(); drawTicket(); resolve();
    }, resolve);
    const search = run(async () => {
      const list = await api('/api/guests?q=' + encodeURIComponent($('gq').value));
      $('gres').innerHTML = list.slice(0, 8).map(g => `<button class="opt" data-g="${g.id}" data-label="${esc(g.name)}">${esc(g.name)}<small>${g.room ? 'Room ' + esc(g.room) : ''}</small></button>`).join('')
        || '<div class="empty" style="padding: 12px">No guest found</div>';
    });
    $('gq').oninput = search; search(); $('gq').focus();
  });
}
$('whoBtn').onclick = run(pickWho);

// ---------- open bills / pending ----------
$('tabsBtn').onclick = () => open(`<h2>Open bills</h2>
  ${S.tabs.map(t => `<button class="opt" data-tab="${t.id}">${esc(t.name)}${t.table_no ? ' · T' + esc(t.table_no) : ''}<small>${rp(t.total)}</small></button>`).join('') || '<div class="empty">No open bill</div>'}
  <button class="btn line2" data-close="1">Close</button>`, b => {
  if (b.dataset.tab) { cur = { tabId: +b.dataset.tab, who: null, cart: [] }; drawTicket(); }
  close();
});
function drawPending() {
  $('pendingBox').innerHTML = can('validate') && S.pending.length ? `<div style="padding: 12px 16px 0; display: grid; gap: 8px">${S.pending.map(o => `
    <div class="pending"><b>Guest order to check · ${esc(o.name)}${o.tableNo ? ' · Table ' + esc(o.tableNo) : ''}</b>
      <div>${o.items.map(i => `${i.qty} × ${esc(i.name)}`).join(', ')}</div>
      <div class="split" style="display: flex; gap: 8px"><button class="btn line2" style="height: 48px" data-rej="${o.id}">Refuse</button><button class="btn go" style="height: 48px" data-acc="${o.id}">Accept</button></div>
    </div>`).join('')}</div>` : '';
}
$('pendingBox').onclick = run(async e => {
  const b = e.target.closest('button'); if (!b) return;
  await api(`/api/orders/${b.dataset.acc || b.dataset.rej}/${b.dataset.acc ? 'accept' : 'reject'}`, { method: 'POST' });
  await load();
});

// ---------- dialog ----------
let onPick = null, onCancel = null;
function open(html, pick, cancel) { $('sheet').innerHTML = html; onPick = pick; onCancel = cancel; $('veil').classList.remove('hidden'); }
function close() { $('veil').classList.add('hidden'); onPick = onCancel = null; }
$('veil').onclick = e => {
  if (e.target === $('veil')) { onCancel?.(); return close(); }
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.close) { onCancel?.(); return close(); }
  onPick?.(b);
};
function confirmBox(title, text, yes) {
  open(`<h2>${esc(title)}</h2><div>${esc(text)}</div><div class="split"><button class="btn line2" data-close="1">No</button><button class="btn pick" data-yes="1">Yes</button></div>`,
    run(async () => { close(); await yes(); }));
}

// ---------- go ----------
token ? start().catch(() => showPin()) : showPin();
