// Change options from the command line (until the owner options screen exists), and test the Google Sheet link.
//   npm run config                                   -> show the options
//   npm run config -- sheet_user=bar-pos sheet_password=xxxx sheet_url=https://script.google.com/macros/s/.../exec
//   npm run config -- check                          -> log in to Rabbit-System, read the guests, show a sample bill
import { openDb, getSettings, setSettings, DEFAULT_SETTINGS } from './db.js';
import { callSheet, sheetReady, saleOp } from './sync.js';

const db = openDb(process.env.POS_DB || 'data/pos.db');
const args = process.argv.slice(2);
const patch = {};
for (const a of args.filter(a => a.includes('='))) {
  const [k, ...rest] = a.split('='); const raw = rest.join('=');
  const def = DEFAULT_SETTINGS[k];
  patch[k] = typeof def === 'boolean' ? raw === 'true' : typeof def === 'number' ? Number(raw) : Array.isArray(def) ? raw.split(',') : raw;
}
if (patch.sheet_user || patch.sheet_password || patch.sheet_url) patch.sheet_token = '';
if (Object.keys(patch).length) { setSettings(db, patch); console.log('Saved:', Object.keys(patch).join(', ')); }

const s = getSettings(db);
if (args.includes('check')) {
  if (!sheetReady(s)) { console.log('Set sheet_url, sheet_user and sheet_password first.'); process.exit(1); }
  try {
    const p = await callSheet(db, s, 'pull');
    console.log(`OK, logged in to Rabbit-System as ${p.me.name} (${p.me.role}).`);
    console.log(`${p.guests.length} guests, e.g. ${p.guests.slice(0, 5).join(', ')}`);
    console.log(`Payment types: ${p.payments.join(', ')}`);
    const sample = saleOp({ id: 0, created_at: new Date().toISOString(), payload: JSON.stringify({ tabId: 0, at: new Date().toISOString(), guest: p.guests[0] || 'Guest',
      lines: [{ product: 'Bintang', category: 'Beer & drinks', qty: 2, unit: 40000, total: 80000 }] }) }, s);
    console.log('A guest bill is sent like this (not sent now):', JSON.stringify(sample.payload, null, 1));
  } catch (e) { console.log('Link problem:', e.message); process.exit(1); }
} else if (!Object.keys(patch).length) {
  const { client_key, sheet_password, sheet_token, ...show } = s;
  console.log({ ...show, sheet_password: sheet_password ? '(set)' : '' });
}
