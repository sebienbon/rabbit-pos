// Just enough of Google Apps Script (SpreadsheetApp, Utilities, PropertiesService, LockService...) to run
// Rabbit-System's 30.UI_api.gs in node:vm against an in-memory spreadsheet, for the POS link tests.
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const OFFSETS = { 'Asia/Singapore': 8, 'Asia/Makassar': 8, 'Asia/Jakarta': 7, UTC: 0 };
const pad = (n, w = 2) => String(n).padStart(w, '0');
function formatDate(d, tz, pattern) {
  const t = new Date(d.getTime() + (OFFSETS[tz] ?? 8) * 3600000);
  const map = { yyyy: t.getUTCFullYear(), MM: pad(t.getUTCMonth() + 1), dd: pad(t.getUTCDate()), HH: pad(t.getUTCHours()),
    mm: pad(t.getUTCMinutes()), ss: pad(t.getUTCSeconds()), SSS: pad(t.getUTCMilliseconds(), 3) };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, k => map[k]);
}
function parseDate(str, tz, pattern) {
  const keys = pattern.match(/yyyy|MM|dd|HH|mm|ss|SSS/g);
  const re = new RegExp('^' + pattern.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, k => `(\\d{${k.length}})`) + '$');
  const m = String(str).match(re); if (!m) return null;
  const v = { yyyy: 1970, MM: 1, dd: 1, HH: 0, mm: 0, ss: 0, SSS: 0 }; keys.forEach((k, i) => { v[k] = +m[i + 1]; });
  return new Date(Date.UTC(v.yyyy, v.MM - 1, v.dd, v.HH, v.mm, v.ss, v.SSS) - (OFFSETS[tz] ?? 8) * 3600000);
}

export function fakeSheet(name, rows = []) {
  const sh = { rows: rows.map(r => [...r]) };
  const cell = (r, c) => { const v = (sh.rows[r] || [])[c]; return v === undefined || v === null ? '' : v; };
  const range = (row, col, nr = 1, nc = 1) => {
    const rg = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(row - 1 + i, col - 1 + j))),
      getValue: () => cell(row - 1, col - 1),
      getDisplayValues: () => rg.getValues().map(r => r.map(v => v instanceof Date ? formatDate(v, 'Asia/Makassar', 'dd/MM/yyyy') : String(v))),
      getDisplayValue: () => rg.getDisplayValues()[0][0],
      getFormulas: () => rg.getValues().map(r => r.map(() => '')),
      setValues: vals => { vals.forEach((v, i) => { const r = sh.rows[row - 1 + i] = sh.rows[row - 1 + i] || []; v.forEach((x, j) => { r[col - 1 + j] = x; }); }); return rg; },
      setValue: v => rg.setValues([[v]]),
      setNumberFormat: () => rg, setFontWeight: () => rg, insertCheckboxes: () => rg, copyTo: () => rg, clearContents: () => rg,
    };
    return rg;
  };
  Object.assign(sh, {
    getName: () => name,
    getLastRow: () => { for (let i = sh.rows.length - 1; i >= 0; i--) if ((sh.rows[i] || []).some(v => v !== '' && v != null)) return i + 1; return 0; },
    getLastColumn: () => Math.max(0, ...sh.rows.map(r => (r || []).length)),
    getMaxRows: () => Math.max(1000, sh.rows.length),
    insertRowsAfter: () => sh, deleteRow: n => { sh.rows.splice(n - 1, 1); },
    appendRow: r => { sh.rows[sh.getLastRow()] = [...r]; },
    setFrozenRows: () => sh, getRange: range,
  });
  return sh;
}

// Loads the real script; returns doPost(body) -> parsed JSON answer, plus the sheets and properties.
export function rabbitSystem(file, sheets) { return loadGas(readFileSync(file, 'utf8'), sheets, basenameOf(file)); }
const basenameOf = f => String(f).split('/').pop();
export function loadGas(code, sheets, filename = 'script.gs') {
  const tabs = {};
  for (const [n, rows] of Object.entries(sheets)) tabs[n] = fakeSheet(n, rows);
  const ss = { getName: () => 'Reception - RABBIT TREE', getSpreadsheetTimeZone: () => 'Asia/Makassar',
    getSheetByName: n => tabs[n] || null, insertSheet: n => (tabs[n] = fakeSheet(n)) };
  const props = {};
  const P = { getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; },
    getProperties: () => ({ ...props }) };
  const ctx = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {}, CopyPasteType: { PASTE_FORMAT: 'f' } },
    PropertiesService: { getScriptProperties: () => P },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    Utilities: { formatDate, parseDate, getUuid: () => randomUUID(), sleep() {},
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...createHash('sha256').update(String(s), 'utf8').digest()].map(b => (b << 24) >> 24) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    MailApp: { sendEmail() {} }, ScriptApp: { getProjectTriggers: () => [] },
    Logger: { log() {} }, console: { error() {}, log() {} },
  });
  vm.runInContext(code, ctx, { filename });
  const doPost = body => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { tabs, props, doPost, ctx };
}
