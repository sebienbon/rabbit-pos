// bridge/stock.gs (stock tabs of "Accounting Processor 2026"), run with journal.gs as one Apps Script project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadGas } from './helpers/gas-fake.js';

const src = f => readFileSync(new URL('../bridge/' + f, import.meta.url), 'utf8');
const code = src('journal.gs').replace("'PUT_THE_SHEET_ID_HERE'", "'s'").replace("'PUT_A_LONG_RANDOM_WORD_HERE'", "'k'") + '\n' + src('stock.gs');

test('stock tabs: setup, read, upsert by id; old tabs untouched; secret required', () => {
  const gs = loadGas(code, { Historic: [['Item Name', 'Unit']] }, 'pos.gs');
  const run = expr => JSON.parse(JSON.stringify(vm.runInContext(expr, gs.ctx)));
  const made = run('setupStock()');
  assert.equal(made.created.length, 12);
  assert.deepEqual(gs.tabs.Historic.rows, [['Item Name', 'Unit']]);
  assert.equal(run('setupStock()').created.length, 0, 'safe to run again');
  assert.equal(gs.tabs.Locations.rows.length, 6);

  assert.match(gs.doPost({ secret: 'x', action: 'stock_read' }).error, /bad secret/);
  let r = gs.doPost({ secret: 'k', action: 'stock_read', tabs: ['Locations', 'Ingredients'] });
  assert.equal(r.tabs.Locations[2].label, 'Kitchen');
  assert.equal(r.tabs.Ingredients.length, 105, 'the owner-reviewed ingredients are seeded');
  assert.equal(r.tabs.Ingredients.find(i => i.id === 'tomat').purchase_modes, 'A');

  r = gs.doPost({ secret: 'k', action: 'stock_upsert', tab: 'Products', rows: [
    { id: 'bimoli-5-ltr', name: 'Bimoli 5 ltr', ingredient_id: 'minyak-goreng', pack_count: 1, pack_qty: 5, pack_unit: 'L', last_price: 138000 },
    { id: 'kunci-mas-5l', name: 'Minyak Goreng Kunci Mas 5L', ingredient_id: 'minyak-goreng' }] });
  assert.deepEqual([r.added, r.updated], [2, 0]);
  gs.tabs.Products.rows[0].push('my column'); gs.tabs.Products.rows[1].push('kept');
  r = gs.doPost({ secret: 'k', action: 'stock_upsert', tab: 'Products', rows: [{ id: 'bimoli-5-ltr', last_price: 140000 }] });
  assert.deepEqual([r.added, r.updated], [0, 1]);
  const p = gs.doPost({ secret: 'k', action: 'stock_read', tabs: ['Products'] }).tabs.Products;
  assert.equal(p.length, 2);
  assert.equal(p[0].last_price, 140000);
  assert.equal(p[0].name, 'Bimoli 5 ltr');
  assert.equal(p[0]['my column'], 'kept', 'a column added by hand is kept');
  assert.match(gs.doPost({ secret: 'k', action: 'stock_upsert', tab: 'Historic', rows: [{ id: 'x' }] }).error, /unknown tab/);
  assert.match(gs.doPost({ secret: 'k', action: 'stock_upsert', tab: 'Products', rows: [{ name: 'no id' }] }).error, /without id/);
});

