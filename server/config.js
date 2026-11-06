// Change options from the command line (until the owner options screen exists), and test the Google Sheet link.
//   npm run config                                   -> show the options
//   npm run config -- sheet_url=https://script.google.com/macros/s/.../exec sheet_secret=xxxx
//   npm run config -- check                          -> test the link: sheet name, guests, Entries preview
import { openDb, getSettings, setSettings, DEFAULT_SETTINGS } from './db.js';
import { callSheet, sheetReady } from './sync.js';

const db = openDb(process.env.POS_DB || 'data/pos.db');
const args = process.argv.slice(2);
const patch = {};
for (const a of args.filter(a => a.includes('='))) {
  const [k, ...rest] = a.split('='); const raw = rest.join('=');
  const def = DEFAULT_SETTINGS[k];
  patch[k] = typeof def === 'boolean' ? raw === 'true' : typeof def === 'number' ? Number(raw) : Array.isArray(def) ? raw.split(',') : raw;
}
if (Object.keys(patch).length) { setSettings(db, patch); console.log('Saved:', Object.keys(patch).join(', ')); }

const s = getSettings(db);
if (args.includes('check')) {
  if (!sheetReady(s)) { console.log('Set sheet_url and sheet_secret first.'); process.exit(1); }
  try {
    const p = await callSheet(s, 'ping');
    console.log(`OK, connected to "${p.sheet}". Entries writing: ${p.writeEntries ? 'ON' : 'OFF (guest bills wait in the POS)'}`);
    const g = await callSheet(s, 'guests');
    console.log(`${g.guests.length} guests, e.g. ${g.guests.slice(0, 5).join(', ')}`);
    const k = await callSheet(s, 'peek');
    console.log('\nEntries header :', k.header.join(' | '));
    for (const r of k.last) console.log('Last real row  :', r.join(' | '));
    console.log('POS would write:', k.preview.join(' | '));
  } catch (e) { console.log('Link problem:', e.message); process.exit(1); }
} else if (!Object.keys(patch).length) {
  const { client_key, sheet_secret, ...show } = s;
  console.log({ ...show, sheet_secret: sheet_secret ? '(set)' : '' });
}
