// Start: node --no-warnings server/index.js   (or start.bat on the reception PC)
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { openDb, getSettings, setSettings } from './db.js';
import { createUser } from './auth.js';
import { createApp } from './app.js';
import { processPrintJobs } from './print.js';
import { seedDemo } from './seed.js';
import { startSync, sheetReady } from './sync.js';

const PORT = Number(process.env.PORT || 8080);
const db = openDb(process.env.POS_DB || 'data/pos.db');

if (!getSettings(db).client_key) setSettings(db, { client_key: randomBytes(9).toString('base64url') });
if (!db.prepare('SELECT 1 FROM users').get()) {
  createUser(db, { name: 'Owner', role: 'owner', pin: process.env.OWNER_PIN || '1234' });
  console.log('First start: owner created with PIN', process.env.OWNER_PIN ? '(from OWNER_PIN)' : '1234 - change it!');
}
if (process.argv.includes('--demo')) seedDemo(db);

createApp(db).listen(PORT, () => {
  const ips = Object.values(networkInterfaces()).flat().filter(i => i?.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Rabbit POS running. On this PC: http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Tablets and phones on the wifi: http://${ip}:${PORT}`);
});

// Printers: try every 2 s.
setInterval(() => processPrintJobs(db, getSettings(db)).catch(e => console.error('print', e)), 2000);

// Google Sheet: sales out every 30 s, guest list in every 10 min (only when the bridge is set up).
startSync(db, () => getSettings(db));
if (!sheetReady(getSettings(db))) console.log('Google Sheet link not set up yet: see bridge/README.md');
