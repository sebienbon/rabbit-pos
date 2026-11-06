// Guest ordering. Phone: the QR code on the table (?key=…&table=…). Self-service tablet: ?key=…&mode=tablet.
// Guests pick who they are (in-house guest: on the room bill, paid at the reception; external guest: paid at the bar),
// choose from the menu and send the order. Talks only to /api/client/* (the key in the link).
const params = new URLSearchParams(location.search);
const KEY = params.get('key') || '', TABLE = (params.get('table') || '').slice(0, 20);
const TABLET = params.get('mode') === 'tablet';
const IDLE = 120000;          // tablet: back to the start after 2 min without a touch
const AFTER_ORDER = 20000;    // tablet: back to the start 20 s after an order

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rp = n => 'Rp ' + Math.round(n).toLocaleString('en-US').replace(/,/g, '.');
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

// ---------- words (English first; French and Indonesian for guests) ----------
const WORDS = {
  en: { who: 'Who is ordering?', table: 'Table', search: 'Your name', searchHint: 'Type at least 2 letters of your name',
    noGuest: 'No guest found. Check the spelling, or order as an external guest.', external: 'I am an external guest',
    extName: 'Your name', extGo: 'Continue', hello: 'Hello', change: 'Change', all: 'All', find: 'Search the menu',
    nothing: 'Nothing here', add: 'Add', see: 'See my order', mine: 'My order', empty: 'Your order is empty: tap + on a dish.',
    subtotal: 'Subtotal', service: 'Service', tax: 'Tax', total: 'Total', note: 'Note for the bar or kitchen (optional)',
    onBill: 'Added to your room bill, paid at the reception.', atBar: 'Please pay at the bar.', order: 'Order',
    sending: 'Sending…', sent: 'Thank you!', sentTxt: 'Your order is on its way to the bar and kitchen.',
    wait: 'Almost there', waitTxt: 'A waiter will confirm your order in a moment.', refused: 'Order not accepted',
    refusedTxt: 'Please ask at the bar.', more: 'Order something else', newGuest: 'Next guest', bad: 'This link does not work. Please ask the staff.',
    off: 'Ordering from here is turned off. Please order at the bar.', offline: 'No connection. Are you on the Rabbit Tree wifi?',
    chooseFirst: 'Who is ordering?', or: 'or', remove: 'Remove one', addOne: 'Add one', close: 'Close', room: 'Room' },
  fr: { who: 'Qui commande ?', table: 'Table', search: 'Votre nom', searchHint: 'Tapez au moins 2 lettres de votre nom',
    noGuest: 'Aucun client trouvé. Vérifiez l’orthographe, ou commandez comme client externe.', external: 'Je suis client externe',
    extName: 'Votre nom', extGo: 'Continuer', hello: 'Bonjour', change: 'Changer', all: 'Tout', find: 'Chercher dans le menu',
    nothing: 'Rien ici', add: 'Ajouter', see: 'Voir ma commande', mine: 'Ma commande', empty: 'Votre commande est vide : touchez + sur un plat.',
    subtotal: 'Sous-total', service: 'Service', tax: 'Taxe', total: 'Total', note: 'Note pour le bar ou la cuisine (facultatif)',
    onBill: 'Ajouté à votre note de chambre, réglée à la réception.', atBar: 'À régler au bar.', order: 'Commander',
    sending: 'Envoi…', sent: 'Merci !', sentTxt: 'Votre commande part au bar et en cuisine.',
    wait: 'Presque fini', waitTxt: 'Un serveur va confirmer votre commande.', refused: 'Commande non acceptée',
    refusedTxt: 'Merci de demander au bar.', more: 'Commander autre chose', newGuest: 'Client suivant', bad: 'Ce lien ne fonctionne pas. Demandez au personnel.',
    off: 'La commande ici est désactivée. Commandez au bar.', offline: 'Pas de connexion. Êtes-vous sur le wifi Rabbit Tree ?',
    chooseFirst: 'Qui commande ?', or: 'ou', remove: 'En retirer un', addOne: 'En ajouter un', close: 'Fermer', room: 'Chambre' },
  id: { who: 'Siapa yang memesan?', table: 'Meja', search: 'Nama Anda', searchHint: 'Ketik minimal 2 huruf nama Anda',
    noGuest: 'Tamu tidak ditemukan. Periksa ejaan, atau pesan sebagai tamu luar.', external: 'Saya tamu luar',
    extName: 'Nama Anda', extGo: 'Lanjut', hello: 'Halo', change: 'Ganti', all: 'Semua', find: 'Cari di menu',
    nothing: 'Tidak ada', add: 'Tambah', see: 'Lihat pesanan', mine: 'Pesanan saya', empty: 'Pesanan masih kosong: sentuh + pada menu.',
    subtotal: 'Subtotal', service: 'Layanan', tax: 'Pajak', total: 'Total', note: 'Catatan untuk bar atau dapur (opsional)',
    onBill: 'Ditambahkan ke tagihan kamar, dibayar di resepsionis.', atBar: 'Silakan bayar di bar.', order: 'Pesan',
    sending: 'Mengirim…', sent: 'Terima kasih!', sentTxt: 'Pesanan Anda sedang dikirim ke bar dan dapur.',
    wait: 'Sebentar lagi', waitTxt: 'Pelayan akan mengonfirmasi pesanan Anda.', refused: 'Pesanan tidak diterima',
    refusedTxt: 'Silakan tanya di bar.', more: 'Pesan lagi', newGuest: 'Tamu berikutnya', bad: 'Tautan ini tidak berfungsi. Silakan tanya staf.',
    off: 'Pemesanan di sini dimatikan. Silakan pesan di bar.', offline: 'Tidak ada koneksi. Apakah Anda di wifi Rabbit Tree?',
    chooseFirst: 'Siapa yang memesan?', or: 'atau', remove: 'Kurangi satu', addOne: 'Tambah satu', close: 'Tutup', room: 'Kamar' },
};
const guessLang = () => { const l = (navigator.language || 'en').slice(0, 2); return WORDS[l] ? l : 'en'; };
let lang = (!TABLET && store.get('lang')) || guessLang();
const t = k => WORDS[lang][k] ?? WORDS.en[k];

// ---------- state ----------
let M = null;                 // menu: { flags, categories, products }
let who = TABLET ? null : JSON.parse(store.get('who') || 'null'); // {guestId, label} | {externalName, label}
let cart = [];                // [{ id, qty }]
let cat = 0, query = '', note = '';
let view = 'who';             // who | menu | done
let doneState = null, pollTimer = null, resetTimer = null, idleTimer = null;

async function api(path, { method = 'GET', body } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`/api/client/${path}${sep}key=${encodeURIComponent(KEY)}`, { method,
    headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => { throw new Error(t('offline')); });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || 'Error'), { status: r.status, code: data.error });
  return data;
}
const product = id => M.products.find(p => p.id === id);
const catOf = p => M.categories.find(c => c.id === p.categoryId) || {};
const count = () => cart.reduce((a, l) => a + l.qty, 0);
function sums() {
  const subtotal = cart.reduce((a, l) => a + l.qty * (product(l.id)?.price || 0), 0);
  const service = M.flags.service ? Math.round(subtotal * M.flags.service / 100) : 0;
  const tax = M.flags.tax ? Math.round((subtotal + service) * M.flags.tax / 100) : 0;
  return { subtotal, service, tax, total: subtotal + service + tax };
}
const initials = name => esc(name.split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase());
function photo(p, cls = '') {
  const c = 'c-' + (catOf(p).color || 'gray');
  return M.flags.photos && p.photo ? `<div class="${cls}"><img src="${esc(p.photo)}" alt="" loading="lazy"></div>`
    : `<div class="${cls} ${c}" aria-hidden="true"><span>${initials(p.name)}</span></div>`;
}
const icon = {
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9B5DE5" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  table: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 9h18M6 9v11M18 9v11M5 5h14"/></svg>',
  chev: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9B5DE5" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  globe: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  user: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  check: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  clock: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  x: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const langs = () => `<div class="langs" role="group" aria-label="Language">${['en', 'fr', 'id'].map(l =>
  `<button data-lang="${l}" aria-pressed="${l === lang}">${l.toUpperCase()}</button>`).join('')}</div>`;
const tableTxt = () => TABLE && M?.flags.tables ? `<div class="sub">${icon.table}${t('table')} ${esc(TABLE)}</div>` : '';

// ---------- who is ordering ----------
function whoHtml() {
  return `
    <label class="label" for="gq">${t('search')}</label>
    <div class="field">${icon.search}<input id="gq" autocomplete="off" autocapitalize="words" enterkeyhint="search" placeholder="${esc(t('searchHint'))}" aria-describedby="gres"></div>
    <div id="gres" style="display: grid; gap: 10px" aria-live="polite"></div>
    ${M.flags.external ? `<div class="or">${t('or')}</div>
    <div id="extBox" style="display: grid; gap: 10px">
      <button class="btn line" data-ext="1">${icon.globe}${t('external')}</button>
    </div>` : ''}`;
}
function drawWho() {
  view = 'who';
  $('app').innerHTML = `<section class="who">
    <header class="hero"><div class="grow">${tableTxt()}<h1>${t('who')}</h1></div><span class="mark"><img src="img/logo-mark-white.png" alt="Rabbit Tree"></span></header>
    <div class="body">${whoHtml()}</div>
    <footer class="foot">${langs()}</footer></section>`;
  bindWho();
}
let searchSeq = 0;
function bindWho() {
  const box = $('gres'), inp = $('gq');
  inp.oninput = async () => {
    const q = inp.value.trim(), seq = ++searchSeq;
    if (q.length < 2) { box.innerHTML = ''; return; }
    try {
      const list = await api('guests?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      box.innerHTML = list.length ? list.map((g, i) => `<button class="guest" data-gid="${g.id}" data-label="${esc(g.name)}" style="animation-delay: ${i * 60}ms">
        <span class="badge ${['c-violet', 'c-teal', 'c-orange', 'c-sky', 'c-coral'][i % 5]}">${g.room ? esc(g.room) : initials(g.name)}</span>
        <b>${esc(g.name)}${g.room ? `<small class="hint" style="display: block">${t('room')} ${esc(g.room)}</small>` : ''}</b>${icon.chev}</button>`).join('')
        : `<div class="hint">${t('noGuest')}</div>`;
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  if (!TABLET) inp.focus();
}
function pickGuest(b) {
  if (b.dataset.gid) choose({ guestId: Number(b.dataset.gid), label: b.dataset.label });
  else if (b.dataset.ext) {
    $('extBox').innerHTML = `<label class="label" for="ext">${t('extName')}</label>
      <div class="field"><input id="ext" autocomplete="name" autocapitalize="words" enterkeyhint="go"></div>
      <button class="btn go" data-extgo="1">${t('extGo')}</button>`;
    $('ext').focus();
    $('ext').onkeydown = e => { if (e.key === 'Enter') document.querySelector('[data-extgo]').click(); };
  } else if (b.dataset.extgo) {
    const name = $('ext').value.trim().replace(/\s+/g, ' ');
    if (name.length < 2) return $('ext').focus();
    choose({ externalName: name.slice(0, 60), label: name.slice(0, 60) });
  }
}
function choose(w) {
  who = w;
  if (!TABLET) store.set('who', JSON.stringify(w));
  closeModal();
  TABLET ? drawKiosk() : drawMenu();
}

// ---------- menu (phone) ----------
function visible() {
  const q = query.trim().toLowerCase();
  return M.products.filter(p => (!cat || p.categoryId === cat) && (!q || p.name.toLowerCase().includes(q)));
}
function cardsHtml() {
  const list = visible();
  if (!list.length) return `<div class="empty">${t('nothing')}</div>`;
  return list.map((p, i) => {
    const q = cart.find(l => l.id === p.id)?.qty;
    return `<article class="card" style="animation-delay: ${Math.min(i, 12) * 30}ms">
      ${photo(p, 'ph')}${q ? `<span class="qty-badge" aria-label="${q} in your order">${q}</span>` : ''}
      <div class="txt"><div class="name">${esc(p.name)}</div>
        <div class="row"><span class="price">${rp(p.price)}</span>
          <button class="add" data-add="${p.id}" aria-label="${esc(t('add'))} ${esc(p.name)}">${icon.plus}</button></div></div>
    </article>`;
  }).join('');
}
function catsHtml(cls = '') {
  return [{ id: 0, name: t('all') }, ...M.categories.filter(c => M.products.some(p => p.categoryId === c.id))]
    .map(c => `<button class="${cls}" data-cat="${c.id}" aria-pressed="${c.id === cat}">${esc(c.name)}</button>`).join('');
}
function drawMenu() {
  view = 'menu';
  const first = who.label.split(' ')[0];
  $('app').innerHTML = `<section class="menu">
    <header class="hero"><span class="mark"><img src="img/logo-mark-white.png" alt="Rabbit Tree"></span>
      <div class="grow"><h1 style="font-size: 24px">${t('hello')} ${esc(first)}</h1>${tableTxt()}</div>
      <button class="pill" data-who="1">${t('change')}</button></header>
    <nav class="cats" aria-label="Categories">${catsHtml()}</nav>
    <div class="field search">${icon.search}<input id="q" placeholder="${esc(t('find'))}" aria-label="${esc(t('find'))}" value="${esc(query)}" enterkeyhint="search"></div>
    <div class="grid" id="grid">${cardsHtml()}</div>
    <div class="cartbar" id="cartbar"></div></section>`;
  $('q').oninput = () => { query = $('q').value; $('grid').innerHTML = cardsHtml(); };
  drawCartBar();
}
function drawCartBar() {
  const n = count(), bar = $('cartbar');
  if (!bar) return;
  bar.classList.toggle('hidden', !n);
  bar.innerHTML = n ? `<button class="btn go" data-cart="1"><span class="n">${n}</span><span class="t">${t('see')}</span><span>${rp(sums().total)}</span></button>` : '';
}
function refreshMenu() {
  if (TABLET) return drawKioskParts();
  $('grid').innerHTML = cardsHtml(); drawCartBar();
  if ($('cartLines')) $('cartLines').innerHTML = cartHtml();
}

// ---------- cart ----------
function cartHtml() {
  if (!cart.length) return `<div class="hint" style="padding: 20px 0">${t('empty')}</div>`;
  const s = sums();
  return cart.map(l => { const p = product(l.id); return `<div class="line">${photo(p, 'th')}
      <div class="info"><b>${esc(p.name)}</b><small>${rp(p.price * l.qty)}</small></div>
      <div class="step"><button class="minus" data-dec="${p.id}" aria-label="${esc(t('remove'))}: ${esc(p.name)}">−</button><span>${l.qty}</span>
        <button class="plus" data-add="${p.id}" aria-label="${esc(t('addOne'))}: ${esc(p.name)}">+</button></div></div>`; }).join('')
    + `<div class="sums">${s.service || s.tax ? `<div class="r"><span>${t('subtotal')}</span><span>${rp(s.subtotal)}</span></div>` : ''}
      ${s.service ? `<div class="r"><span>${t('service')} ${M.flags.service}%</span><span>${rp(s.service)}</span></div>` : ''}
      ${s.tax ? `<div class="r"><span>${t('tax')} ${M.flags.tax}%</span><span>${rp(s.tax)}</span></div>` : ''}
      <div class="total"><span>${t('total')}</span><span>${rp(s.total)}</span></div></div>`;
}
const payNote = () => who?.guestId ? `<div class="paynote">${t('onBill')}</div>` : who ? `<div class="paynote ext">${t('atBar')}</div>` : '';
function openCart() {
  const v = document.createElement('div');
  v.className = 'veil'; v.id = 'veil';
  v.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cartTitle">
    <div class="head"><h2 id="cartTitle">${t('mine')}</h2><button class="x" data-closecart="1" aria-label="${esc(t('close'))}">${icon.x}</button></div>
    <div id="cartLines" class="cart">${cartHtml()}</div>
    <textarea class="note" id="note" rows="2" placeholder="${esc(t('note'))}" aria-label="${esc(t('note'))}" maxlength="200">${esc(note)}</textarea>
    ${payNote()}
    <button class="btn go" data-send="1">${t('order')} · ${rp(sums().total)}</button></div>`;
  document.body.append(v);
  $('note').oninput = () => { note = $('note').value; };
}
function closeCart() { $('veil')?.remove(); }
function change(id, d) {
  const l = cart.find(x => x.id === id);
  if (l) l.qty = Math.max(0, Math.min(99, l.qty + d)); else if (d > 0) cart.push({ id, qty: 1 });
  cart = cart.filter(x => x.qty > 0);
  refreshMenu();
  const send = document.querySelector('.sheet [data-send]');
  if (send) { send.textContent = `${t('order')} · ${rp(sums().total)}`; send.disabled = !cart.length; }
}

// ---------- send + follow ----------
let sending = false;
async function sendOrder(btn) {
  if (sending || !cart.length) return;
  if (!who) return TABLET ? openWhoModal() : drawWho();
  sending = true; btn.disabled = true; btn.textContent = t('sending');
  try {
    const r = await api('orders', { method: 'POST', body: { source: TABLET ? 'tablet' : 'qr', guestId: who.guestId, guestName: who.guestId ? who.label : undefined, externalName: who.externalName,
      table: TABLE || undefined, note: note.trim() || undefined, items: cart.map(l => ({ productId: l.id, qty: l.qty })) } });
    cart = []; note = ''; closeCart(); closeModal();
    showDone(r.status, r.id);
  } catch (e) {
    toast(e.code === 'disabled' ? t('off') : e.message);
    btn.disabled = false; btn.textContent = t('order');
    // The guest list changed since the guest chose: choose again, the order stays in the cart.
    if (e.code === 'guest_changed' || (e.status === 404 && who?.guestId)) { who = null; store.set('who', null); closeCart(); TABLET ? (drawKioskParts(), openWhoModal()) : drawWho(); }
  } finally { sending = false; }
}
function showDone(status, id) {
  view = 'done'; doneState = status;
  const s = { sent: ['', icon.check, 'sent', 'sentTxt'], pending: ['wait', icon.clock, 'wait', 'waitTxt'], rejected: ['no', icon.x, 'refused', 'refusedTxt'] }[status] || [];
  $('app').innerHTML = `<section class="done">
    <div class="big ${s[0]}">${s[1]}</div><h1>${t(s[2])}</h1><p>${t(s[3])}</p>
    ${status !== 'pending' ? `<p>${who?.guestId ? t('onBill') : t('atBar')}</p>` : ''}
    <button class="btn go" data-more="1">${TABLET ? t('newGuest') : t('more')}</button></section>`;
  clearTimeout(pollTimer);
  if (status === 'pending') pollTimer = setTimeout(async () => {
    try { const o = await api('orders/' + id); if (view === 'done') showDone(o.status, id); }
    catch { if (view === 'done') pollTimer = setTimeout(() => showDone('pending', id), 5000); }
  }, 5000);
  if (TABLET) { clearTimeout(resetTimer); resetTimer = setTimeout(resetKiosk, AFTER_ORDER); }
}
function toast(msg) {
  const d = document.createElement('div');
  d.setAttribute('role', 'alert');
  d.style.cssText = 'position: fixed; left: 50%; bottom: 120px; transform: translateX(-50%); background: #33305C; color: #fff; padding: 14px 20px; border-radius: 16px; font-weight: 800; z-index: 20; max-width: 90vw; text-align: center';
  d.textContent = msg; document.body.append(d); setTimeout(() => d.remove(), 3500);
}

// ---------- tablet (self-service) ----------
function drawKiosk() {
  view = 'menu';
  $('app').innerHTML = `<section class="kiosk">
    <nav class="side" aria-label="Categories"><div class="logo"><img src="img/logo-mark-white.png" alt="Rabbit Tree"></div>
      <div id="kcats" style="display: contents"></div><div class="grow"></div>${langs()}</nav>
    <div class="mid"><div class="top"><h1 id="ktitle"></h1>
      <div class="field">${icon.search}<input id="q" placeholder="${esc(t('find'))}" aria-label="${esc(t('find'))}" value="${esc(query)}"></div></div>
      <div class="grid" id="grid"></div></div>
    <aside class="panel" aria-label="${esc(t('mine'))}">
      <div class="ph1"><h2>${t('mine')}</h2><button class="whoBtn" id="kwho" data-who="1"></button></div>
      <div class="lines" id="cartLines"></div>
      <div class="ph2" id="kfoot"></div></aside></section>`;
  $('q').oninput = () => { query = $('q').value; $('grid').innerHTML = cardsHtml(); };
  drawKioskParts();
}
function drawKioskParts() {
  if (!$('kcats')) return;
  $('kcats').innerHTML = catsHtml('cat');
  $('ktitle').textContent = cat ? M.categories.find(c => c.id === cat)?.name : t('all');
  $('grid').innerHTML = cardsHtml();
  $('kwho').className = 'whoBtn' + (who ? '' : ' none');
  $('kwho').innerHTML = `${icon.user}<span>${who ? esc(who.label) : t('chooseFirst')}</span><b style="font-size: 13px">${who ? t('change') : ''}</b>`;
  $('cartLines').innerHTML = cartHtml();
  $('kfoot').innerHTML = `${payNote()}
    <textarea class="note" id="note" rows="1" placeholder="${esc(t('note'))}" aria-label="${esc(t('note'))}" maxlength="200">${esc(note)}</textarea>
    <button class="btn go" data-send="1" ${cart.length ? '' : 'disabled'}>${t('order')}${cart.length ? ' · ' + rp(sums().total) : ''}</button>`;
  $('note').oninput = () => { note = $('note').value; };
}
function openWhoModal() {
  closeModal();
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'modal';
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-labelledby="wt">
    <div style="display: flex; justify-content: space-between; align-items: center"><h2 id="wt" style="font-size: 28px">${t('who')}</h2>
    <button class="x" data-closemodal="1" aria-label="${esc(t('close'))}">${icon.x}</button></div>${whoHtml()}</div>`;
  document.querySelector('.kiosk').append(m);
  bindWho(); $('gq').focus();
}
function closeModal() { $('modal')?.remove(); }
function resetKiosk() {
  clearTimeout(resetTimer); clearTimeout(pollTimer);
  who = null; cart = []; note = ''; cat = 0; query = ''; lang = guessLang();
  drawKiosk();
}
function touched() {
  if (!TABLET) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (who || cart.length || view === 'done') resetKiosk(); }, IDLE);
}

// ---------- clicks ----------
document.addEventListener('click', e => {
  touched();
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.lang) { lang = d.lang; if (!TABLET) store.set('lang', lang); return redraw(); }
  if (d.gid || d.ext || d.extgo) return pickGuest(b);
  if (d.cat !== undefined) { cat = Number(d.cat); return TABLET ? drawKioskParts() : drawMenu(); }
  if (d.add) return change(Number(d.add), 1);
  if (d.dec) return change(Number(d.dec), -1);
  if (d.cart) return openCart();
  if (d.closecart) return closeCart();
  if (d.closemodal) return closeModal();
  if (d.send) return sendOrder(b);
  if (d.who) { if (TABLET) return openWhoModal(); who = null; store.set('who', null); return drawWho(); }
  if (d.more) { clearTimeout(pollTimer); return TABLET ? resetKiosk() : drawMenu(); }
});
document.addEventListener('keydown', e => {
  touched();
  if (e.key === 'Escape') { closeCart(); closeModal(); }
});
document.addEventListener('click', e => { if (e.target.id === 'veil') closeCart(); if (e.target.id === 'modal') closeModal(); });
function redraw() {
  document.documentElement.lang = lang;
  if (view === 'done') return showDone(doneState);
  if (TABLET) { const m = !!$('modal'); drawKiosk(); if (m) openWhoModal(); return; }
  if (view === 'menu' && who) { const open = !!$('veil'); drawMenu(); if (open) openCart(); } else drawWho();
}

// ---------- start ----------
async function start() {
  document.documentElement.lang = lang;
  if (TABLET) document.body.classList.add('tablet');
  try {
    M = await api('menu');
  } catch (e) {
    $('app').innerHTML = `<section class="done"><h1>Rabbit Tree</h1><p>${esc(e.status === 403 ? t('bad') : e.message)}</p>
      <button class="btn go" onclick="location.reload()">↻</button></section>`;
    return;
  }
  if ((TABLET && !M.flags.tablet) || (!TABLET && !M.flags.qr)) {
    $('app').innerHTML = `<section class="done"><h1>Rabbit Tree</h1><p>${t('off')}</p></section>`;
    return;
  }
  if (TABLET) { drawKiosk(); touched(); } else who ? drawMenu() : drawWho();
  // Menu changes (prices, items out of stock) arrive without reloading.
  setInterval(async () => {
    try {
      const m = await api('menu');
      if (JSON.stringify(m) === JSON.stringify(M)) return;
      M = m; cart = cart.filter(l => product(l.id));
      if (view === 'menu') refreshMenu();
    } catch {}
  }, 60000);
}
start();
