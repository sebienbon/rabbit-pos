// Waiter phone: open bills, guest orders to accept, new order for a guest / an external guest / a table,
// send to the bar and kitchen, put a guest's bill on the room, print the bill. No money here: the bar takes it.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp ' + Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const ago = iso => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60}`; };
let token = store.get('token'), S = null, es = null, online = true;
let view = { name: 'home' };   // home | tab {id} | new | add {tabId}
let cart = [], who = null, table = '', cat = 0;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined }).catch(() => { throw new Error('No connection to the POS'); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { logout(); throw new Error('Please log in'); }
  if (!r.ok) throw new Error(data.message || 'Error');
  return data;
}
function toast(msg, bad) {
  const d = document.createElement('div'); d.setAttribute('role', 'alert');
  d.style.cssText = `position: fixed; left: 50%; top: calc(14px + env(safe-area-inset-top)); transform: translateX(-50%); background: ${bad ? '#B3243C' : '#33305C'}; color: #fff; padding: 14px 20px; border-radius: 16px; font-weight: 800; z-index: 30; max-width: 90vw; text-align: center`;
  d.textContent = msg; document.body.append(d); setTimeout(() => d.remove(), 3000);
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Please log in') toast(e.message, true); } };
const icon = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#E06A1B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9B5DE5" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};
const tabLabel = t => t.table_no ? `Table ${t.table_no}` : t.kind === 'walkin' ? 'Walk-in' : t.name.split(' ')[0];
const tabSub = t => t.table_no ? (t.kind === 'walkin' ? ago(t.opened_at) : t.name.split(' ')[0]) : (t.kind === 'external' ? 'External' : ago(t.opened_at));

// ---------- login ----------
let pin = '';
function drawLogin() {
  $('app').innerHTML = `<section class="w"><header class="hero"><span class="mark"><img src="img/logo-mark-white.png" alt="Rabbit Tree"></span>
    <div class="grow"><h1>Waiter</h1><div class="sub">Type your PIN</div></div></header>
    <div class="body"><div class="pins" aria-label="${pin.length} digits typed">${[0, 1, 2, 3, 4, 5].slice(0, Math.max(4, pin.length)).map(i => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join('')}</div>
    <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-d="${n}">${n}</button>`).join('')}<button data-d="c" aria-label="Clear">C</button><button data-d="0">0</button><button data-d="ok" aria-label="Log in">OK</button></div></div></section>`;
}
const login = run(async () => {
  const r = await api('/api/login', { method: 'POST', body: { pin, device: 'waiter-phone' } });
  token = r.token; store.set('token', token); pin = ''; await start();
});
function logout() { token = null; store.set('token', null); es?.close(); S = null; pin = ''; drawLogin(); }

// ---------- data ----------
async function load() {
  S = await api('/api/state');
  draw();
}
function live() {
  es?.close();
  es = new EventSource('/api/events?token=' + token);
  es.onmessage = () => load().catch(() => {});
  es.onopen = () => { if (!online) { online = true; load().catch(() => {}); } };
  es.onerror = () => { online = false; drawOnline(); };
}
const drawOnline = () => { const o = document.querySelector('.online'); if (o) o.innerHTML = `<span class="dot ${online ? '' : 'off'}"></span>${online ? 'Online' : 'Offline'}`; };

// ---------- screens ----------
function draw() {
  if (!S) return;
  if (view.name === 'tab') return drawTab();
  if (view.name === 'new' || view.name === 'add') return drawPicker();
  drawHome();
}
function header(title, back) {
  return `<header class="hero">${back ? `<button class="back" data-home="1" aria-label="Back">${icon.back}</button>` : ''}
    <div class="grow"><div class="sub">${esc(S.user.name)} · ${esc(S.user.role)}</div><h1>${esc(title)}</h1></div>
    ${back ? '' : `<span class="online"></span><button class="pill" data-logout="1">Log out</button>`}</header>`;
}
function drawHome() {
  const pend = S.pending || [];
  const waitTabs = new Set(pend.map(o => o.tabId));
  const first = pend[0];
  $('app').innerHTML = `<section class="w">${header('Bills')}
    <div class="body">
      ${first ? `<div class="alert"><b style="display: flex; gap: 8px; align-items: center">${icon.bell}${pend.length} guest order${pend.length > 1 ? 's' : ''} to accept</b>
        <div class="items">${esc(first.tableNo ? 'Table ' + first.tableNo + ' · ' : '')}${esc(first.name)} · ${first.items.map(i => `${i.qty} × ${esc(i.name)}`).join(', ')}</div>
        <div class="two"><button class="btn refuse" data-reject="${first.id}">Refuse</button><button class="btn go" data-accept="${first.id}">Accept</button></div></div>` : ''}
      ${S.tabs.length ? `<div class="tabs">${S.tabs.map(t => `<button class="tab ${waitTabs.has(t.id) ? 'wait' : ''}" data-tab="${t.id}">
        <b>${esc(tabLabel(t))}</b><small>${esc(tabSub(t))} · ${rp(t.total)}</small></button>`).join('')}</div>`
        : '<div class="hint" style="text-align: center; padding: 30px 0">No open bill. Tap "New order".</div>'}
    </div>
    <div class="bottom">${S.user.role === 'waiter' || S.user.role === 'owner' || S.user.role === 'manager' || S.user.role === 'cashier'
      ? `<button class="btn new" data-new="1">${icon.plus}New order</button>` : ''}</div></section>`;
  drawOnline();
}
function drawTab() {
  const t = S.tabs.find(x => x.id === view.id);
  if (!t) { view = { name: 'home' }; return drawHome(); }
  const st = { sent: 'sent', pending: 'waiting', rejected: 'refused' };
  $('app').innerHTML = `<section class="w">${header(tabLabel(t), true)}
    <div class="body">
      <div class="hint">${esc(t.name)}${t.kind === 'guest' ? ' · hostel guest' : t.kind === 'external' ? ' · external guest' : ''} · open ${ago(t.opened_at)}</div>
      ${t.orders.map(o => `<div class="order"><div class="h"><span>${new Date(o.created_at).toTimeString().slice(0, 5)} · ${o.source === 'pos' ? 'staff' : o.source.toUpperCase()}</span>
        <span class="pill2 ${o.status}">${st[o.status] || o.status}</span></div>
        ${o.items.map(i => `<div class="l ${i.voided ? 'void' : ''}"><span>${i.qty} × ${esc(i.name)}${i.note ? ` <small class="hint">(${esc(i.note)})</small>` : ''}</span><span>${rp(i.qty * i.unit_price)}</span></div>`).join('')}</div>`).join('')}
      <div class="tot"><span>Total</span><span>${rp(t.total)}</span></div>
      ${t.kind === 'guest' ? '' : '<div class="paynote ext">Pays at the bar.</div>'}
    </div>
    <div class="bottom" style="flex-wrap: wrap">
      <button class="btn line" data-print="${t.id}">Print bill</button>
      ${t.kind === 'guest' ? `<button class="btn go" data-charge="${t.id}">On room bill</button>` : ''}
      <button class="btn new" data-add="${t.id}" style="flex-basis: 100%">${icon.plus}Add items</button></div></section>`;
}

// New order (who + items) or items for an open bill.
function drawPicker() {
  const adding = view.name === 'add';
  const t = adding && S.tabs.find(x => x.id === view.tabId);
  const cats = S.catalog.categories.filter(c => S.catalog.products.some(p => p.categoryId === c.id));
  if (!cats.some(c => c.id === cat)) cat = cats[0]?.id || 0;
  const n = cart.reduce((a, l) => a + l.qty, 0), total = cart.reduce((a, l) => a + l.qty * l.price, 0);
  $('app').innerHTML = `<section class="w">${header(adding ? `Add · ${tabLabel(t)}` : 'New order', true)}
    <div class="body">
      ${adding ? '' : `<div class="seg" role="group" aria-label="Who">
        ${['guest', 'external', 'walkin'].map(k => `<button data-who="${k}" aria-pressed="${who?.kind === k}">${{ guest: 'Hostel guest', external: 'External', walkin: 'Walk-in' }[k]}</button>`).join('')}</div>
        <div id="whoBox"></div>
        ${S.settings.tables_enabled ? `<label class="label" for="tbl">Table</label><div class="field"><input id="tbl" value="${esc(table)}" inputmode="text" maxlength="20" placeholder="e.g. 7"></div>` : ''}`}
      <nav class="cats" aria-label="Categories" style="padding: 0">${cats.map(c => `<button data-cat="${c.id}" aria-pressed="${c.id === cat}">${esc(c.name)}</button>`).join('')}</nav>
      <div class="pick">${S.catalog.products.filter(p => p.categoryId === cat).map(p => {
        const q = cart.find(l => l.id === p.id)?.qty || 0;
        return `<div class="prow"><span class="n">${esc(p.name)}<br><span class="p">${rp(p.price)}</span></span>
          <div class="step">${q ? `<button class="minus" data-dec="${p.id}" aria-label="One less ${esc(p.name)}">−</button><span>${q}</span>` : ''}
          <button class="plus" data-inc="${p.id}" aria-label="One more ${esc(p.name)}">+</button></div></div>`;
      }).join('')}</div>
    </div>
    <div class="bottom"><button class="btn go" data-send="1" ${n ? '' : 'disabled'}>Send${n ? ` · ${n} item${n > 1 ? 's' : ''} · ${rp(total)}` : ''}</button></div></section>`;
  if (!adding) drawWho();
  $('tbl')?.addEventListener('input', e => { table = e.target.value; });
}
function drawWho() {
  const box = $('whoBox'); if (!box) return;
  if (who?.kind === 'guest') {
    box.innerHTML = who.id ? `<button class="guest" data-who="guest"><b>${esc(who.name)}</b><span class="hint">change</span></button>`
      : `<div class="field">${icon.search}<input id="gq" placeholder="Guest name (2 letters)" autocomplete="off"></div><div id="gres" style="display: grid; gap: 8px"></div>`;
    const inp = $('gq');
    if (inp) {
      inp.focus();
      inp.oninput = run(async () => {
        const q = inp.value.trim();
        if (q.length < 2) { $('gres').innerHTML = ''; return; }
        const list = await api('/api/guests?q=' + encodeURIComponent(q));
        $('gres').innerHTML = list.length ? list.map(g => `<button class="guest" data-gid="${g.id}" data-gname="${esc(g.name)}"><b>${esc(g.name)}</b></button>`).join('') : '<div class="hint">No guest found</div>';
      });
    }
  } else if (who?.kind === 'external') {
    box.innerHTML = `<div class="field"><input id="ext" placeholder="Name of the external guest" value="${esc(who.name || '')}" maxlength="60"></div>`;
    $('ext').oninput = e => { who.name = e.target.value; };
  } else box.innerHTML = '';
}
function change(id, d) {
  const p = S.catalog.products.find(x => x.id === id), l = cart.find(x => x.id === id);
  if (l) l.qty = Math.max(0, Math.min(99, l.qty + d)); else if (d > 0) cart.push({ id, qty: 1, price: p.price });
  cart = cart.filter(x => x.qty > 0);
  const y = scrollY; drawPicker(); scrollTo(0, y);
}
const send = run(async btn => {
  btn.disabled = true;
  const items = cart.map(l => ({ productId: l.id, qty: l.qty }));
  let body;
  if (view.name === 'add') body = { tabId: view.tabId, items };
  else {
    if (!who) throw (btn.disabled = false, new Error('Choose who orders'));
    if (who.kind === 'guest' && !who.id) throw (btn.disabled = false, new Error('Choose the guest'));
    if (who.kind === 'external' && (who.name || '').trim().length < 2) throw (btn.disabled = false, new Error('Type the name'));
    body = { items, table: table || undefined, ...(who.kind === 'guest' ? { guestId: who.id } : who.kind === 'external' ? { externalName: who.name.trim() } : { walkin: true }) };
  }
  try {
    const r = await api('/api/orders', { method: 'POST', body });
    cart = []; who = null; table = '';
    toast(r.status === 'sent' ? 'Sent to the bar and kitchen' : 'Waiting for validation');
    view = { name: 'tab', id: r.tabId }; await load();
  } finally { btn.disabled = false; }
});

// ---------- clicks ----------
document.addEventListener('click', run(async e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.d !== undefined) {
    if (d.d === 'c') pin = ''; else if (d.d === 'ok') return pin.length >= 4 && login(); else if (pin.length < 6) pin += d.d;
    drawLogin(); if (pin.length === 6) login(); return;
  }
  if (d.logout) return logout();
  if (d.home) { view = { name: view.name === 'add' ? 'tab' : 'home', id: view.tabId }; cart = []; return draw(); }
  if (d.tab) { view = { name: 'tab', id: Number(d.tab) }; return draw(); }
  if (d.new) { view = { name: 'new' }; cart = []; who = null; table = ''; return draw(); }
  if (d.add) { view = { name: 'add', tabId: Number(d.add) }; cart = []; return draw(); }
  if (d.who) { who = { kind: d.who }; const y = scrollY; drawPicker(); scrollTo(0, y); return; }
  if (d.gid) { who = { kind: 'guest', id: Number(d.gid), name: d.gname }; return drawWho(); }
  if (d.cat) { cat = Number(d.cat); return drawPicker(); }
  if (d.inc) return change(Number(d.inc), 1);
  if (d.dec) return change(Number(d.dec), -1);
  if (d.send) return send(b);
  if (d.accept || d.reject) { await api(`/api/orders/${d.accept || d.reject}/${d.accept ? 'accept' : 'reject'}`, { method: 'POST' }); toast(d.accept ? 'Accepted: sent to the bar and kitchen' : 'Refused'); return load(); }
  if (d.print) { await api(`/api/tabs/${d.print}/print-bill`, { method: 'POST', body: { till: store.get('till') || undefined } }); return toast('Bill sent to the printer'); }
  if (d.charge) { await api(`/api/tabs/${d.charge}/charge`, { method: 'POST' }); toast('Put on the room bill'); view = { name: 'home' }; return load(); }
}));

async function start() {
  if (!token) return drawLogin();
  try { await load(); live(); } catch (e) { if (e.message !== 'Please log in') { $('app').innerHTML = `<section class="done"><h1>Rabbit POS</h1><p>${esc(e.message)}</p><button class="btn go" onclick="location.reload()">Try again</button></section>`; } }
}
start();
