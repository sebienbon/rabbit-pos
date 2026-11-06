// Reception: the bar's open bills (who drank and ate what), print a bill, put a hostel guest's bill on the room
// (it then shows in Rabbit-System's Guest bills, where the reception takes the money as usual).
// Money is never taken here for the bar: an external guest pays at the bar (owner's rule, 06/11).
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp ' + Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const dt = iso => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${d.toTimeString().slice(0, 5)}`; };
let token = store.get('token'), S = null, charged = [], sel = null, q = '', es = null;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined }).catch(() => { throw new Error('No connection to the POS'); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { token = null; store.set('token', null); drawLogin(); throw new Error('Please log in'); }
  if (!r.ok) throw new Error(data.message || 'Error');
  return data;
}
let tt;
function toast(msg, bad) { const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); clearTimeout(tt); tt = setTimeout(() => t.classList.add('hidden'), 3000); }
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== 'Please log in') toast(e.message, true); } };
const PAL = [['#E8DCFB', '#5B2A9E'], ['#D3F6F1', '#0B6B61'], ['#DCEFFF', '#0B4F80'], ['#FFE8D6', '#8A3B00'], ['#FFE0E5', '#9B1C33']];
const initials = n => esc(n.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase());
const where = (o, t) => o.source === 'qr' ? `QR${t.table_no ? ' · T' + t.table_no : ''}` : o.source === 'tablet' ? 'Tablet' : t.table_no ? `Table ${t.table_no}` : 'Staff';
const drink = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12l-1.5 17a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2z"/><path d="M6.5 9h11"/></svg>';
const food = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 13h16a8 8 0 0 1-16 0z"/><path d="M9 9c0-2 2-2 2-4M14 9c0-2 2-2 2-4"/></svg>';

async function load() {
  [S, charged] = await Promise.all([api('/api/state'), api('/api/tabs-charged')]);
  $('me').textContent = `${S.user.name} · ${S.user.role}`;
  const y = S.sync || {};
  $('sync').textContent = !y.on ? 'Google Sheet not linked' : y.error ? 'Google Sheet: problem' : y.waiting ? `Google Sheet: ${y.waiting} waiting` : 'Google Sheet up to date';
  draw();
}
function noteBtn(t, i) {
  const [bg, ink] = PAL[i % PAL.length], n = t.orders.reduce((a, o) => a + o.items.filter(x => !x.voided).length, 0);
  const info = t.status === 'open' ? `${t.kind === 'external' ? 'External · ' : t.kind === 'walkin' ? 'Walk-in · ' : ''}${n} item${n > 1 ? 's' : ''} · since ${dt(t.opened_at)}`
    : `On the room bill · ${dt(t.closed_at)}`;
  return `<button class="note" data-id="${t.id}" aria-current="${sel === t.id}"><span class="badge" style="background: ${bg}; color: ${ink}">${t.table_no ? 'T' + esc(t.table_no) : initials(t.name)}</span>
    <span class="t"><b>${esc(t.name)}</b><small>${info}</small></span><span class="sum">${rp(t.total)}</span></button>`;
}
function draw() {
  const f = t => !q || t.name.toLowerCase().includes(q) || String(t.table_no || '') === q;
  const open = S.tabs.filter(f), done = charged.filter(f);
  const all = [...S.tabs, ...charged];
  if (!all.some(t => t.id === sel)) sel = open[0]?.id ?? null;
  const t = all.find(x => x.id === sel);
  $('app').innerHTML = `<aside class="list">
      <label class="search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9B5DE5" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="q" placeholder="Name or table" value="${esc(q)}" aria-label="Search a bill"></label>
      <div class="sect">Open at the bar (${open.length})</div>
      ${open.map(noteBtn).join('') || '<div class="hint">No open bill.</div>'}
      <div class="sect">Put on room bills, today and yesterday (${done.length})</div>
      ${done.map(noteBtn).join('') || '<div class="hint">None yet.</div>'}
    </aside>
    <section class="detail">${t ? detail(t) : '<div class="empty">Choose a bill on the left.</div>'}</section>`;
  const inp = $('q'); inp.oninput = () => { q = inp.value.trim().toLowerCase(); const p = inp.selectionStart; draw(); $('q').focus(); $('q').setSelectionRange(p, p); };
}
function detail(t) {
  const lines = t.orders.filter(o => o.status !== 'rejected').flatMap(o => o.items.map(i => ({ o, i })));
  const sub = [t.service ? `Subtotal ${rp(t.subtotal)} · Service ${S.settings.service_rate}% ${rp(t.service)}` : '', t.tax ? `Tax ${rp(t.tax)}` : ''].filter(Boolean).join(' · ');
  const pending = t.orders.some(o => o.status === 'pending');
  return `<div class="head"><h2>${esc(t.name)}${t.table_no ? ' · Table ' + esc(t.table_no) : ''}</h2>
      <div class="sub">${t.kind === 'guest' ? 'Hostel guest' : t.kind === 'external' ? 'External guest' : 'Walk-in'} · opened ${dt(t.opened_at)}
      ${t.status === 'charged' ? ` · <b>on the room bill since ${dt(t.closed_at)}: pay it in Rabbit-System's Guest bills</b>` : ''}</div></div>
    <div class="lines">${lines.map(({ o, i }) => `<div class="line ${i.voided ? 'void' : ''}"><span class="d">${dt(o.created_at)}</span><span class="w">${esc(where(o, t))}${o.status === 'pending' ? ' · waiting' : ''}</span>
      <span class="ic ${i.station}">${i.station === 'kitchen' ? food : drink}</span><span class="n">${i.qty} × ${esc(i.name)}</span><span class="p">${rp(i.qty * i.unit_price)}</span></div>`).join('')}</div>
    <div class="foot"><div class="tt">${sub ? `<div class="sub">${sub}</div>` : ''}<div class="big">${rp(t.total)}</div></div>
      ${t.status === 'open' ? `<button class="btn line xl" data-print="${t.id}">Print the bill</button>
        ${t.kind === 'guest' ? `<button class="btn go xl" data-charge="${t.id}" ${pending ? 'disabled title="An order still waits for a waiter"' : ''}>Put on the room bill</button>`
          : '<div class="status warn">An external guest pays at the bar.</div>'}` : ''}</div>`;
}
document.addEventListener('click', run(async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.id) { sel = Number(b.dataset.id); return draw(); }
  if (b.dataset.print) { await api(`/api/tabs/${b.dataset.print}/print-bill`, { method: 'POST', body: { till: store.get('till') || undefined } }); return toast('Bill sent to the printer'); }
  if (b.dataset.charge) { await api(`/api/tabs/${b.dataset.charge}/charge`, { method: 'POST' }); toast('On the room bill: it reaches Rabbit-System in a few seconds'); return load(); }
}));

function drawLogin() {
  $('me').textContent = ''; $('sync').textContent = '';
  $('app').innerHTML = `<form class="card login" id="lf"><h2>Reception</h2><div class="sub">Your PIN</div>
    <input class="i" id="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN" autofocus><button class="btn go">Log in</button></form>`;
  $('lf').onsubmit = run(async e => { e.preventDefault(); const r = await api('/api/login', { method: 'POST', body: { pin: $('pin').value, device: 'reception' } }); token = r.token; store.set('token', token); start(); });
}
const start = run(async () => {
  if (!token) return drawLogin();
  await load();
  es?.close(); es = new EventSource('/api/events?token=' + token);
  es.onmessage = () => load().catch(() => {});
});
start();
