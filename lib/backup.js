/**
 * Backups and data export.
 *
 * Snapshots use SQLite's VACUUM INTO, which writes a consistent copy of a live
 * database without stopping writes — safer than copying the file while WAL
 * pages are in flight. Snapshots run on boot and then daily, oldest pruned.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const KEEP = 14;                       // roughly two weeks of daily snapshots
const INTERVAL_MS = 24 * 60 * 60e3;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function ensureDir() { fs.mkdirSync(BACKUP_DIR, { recursive: true }); }

/** Write a consistent snapshot and prune old ones. Returns its metadata. */
function snapshot(db, reason = 'scheduled') {
  ensureDir();
  const filename = `dts-${stamp()}-${reason}.db`;
  const target = path.join(BACKUP_DIR, filename);
  // VACUUM INTO refuses to overwrite, so a collision means one already exists
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  prune();
  const { size, mtime } = fs.statSync(target);
  return { filename, size, created_at: mtime.toISOString() };
}

function list() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const { size, mtime } = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, size, created_at: mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function prune() {
  const extra = list().slice(KEEP);
  for (const b of extra) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.filename)); } catch { /* already gone */ }
  }
  return extra.length;
}

/** True when the newest snapshot is older than a day. */
function isDue() {
  const newest = list()[0];
  return !newest || (Date.now() - new Date(newest.created_at).getTime()) > INTERVAL_MS;
}

/** Snapshot on boot if one is due, then keep checking every hour. */
function schedule(db, log = () => {}) {
  const run = () => {
    if (!isDue()) return;
    try { const b = snapshot(db, 'auto'); log(`backup written: ${b.filename} (${Math.round(b.size / 1024)} KB)`); }
    catch (e) { log(`backup failed: ${e.message}`); }
  };
  run();
  const timer = setInterval(run, 60 * 60e3);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------- export
const TABLES = [
  'settings', 'clients', 'employees', 'users', 'materials', 'quotes', 'jobs', 'job_materials',
  'work_orders', 'change_orders', 'invoices', 'payments', 'purchase_orders', 'schedule',
  'time_entries', 'job_cards', 'attachments', 'subcontractors', 'sub_documents', 'job_subs',
  'email_log', 'audit_log',
];
const REDACTED = { settings: ['smtp_pass', 'stripe_webhook_secret'], users: ['password_hash'] };

/** Everything in the database as one JSON document, secrets stripped. */
function exportJson(db) {
  const out = { exported_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    let rows;
    try { rows = db.prepare(`SELECT * FROM ${t}`).all(); } catch { continue; }
    if (t === 'settings') rows = rows.filter(r => !REDACTED.settings.includes(r.key));
    if (t === 'users') rows = rows.map(({ password_hash, ...rest }) => rest);
    out.tables[t] = rows;
  }
  out.row_counts = Object.fromEntries(Object.entries(out.tables).map(([t, r]) => [t, r.length]));
  return out;
}

const cell = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One table as CSV. */
function exportCsv(db, table) {
  if (!TABLES.includes(table)) throw new Error('Unknown table');
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) return '';
  let cols = Object.keys(rows[0]);
  if (table === 'users') cols = cols.filter(c => c !== 'password_hash');
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
}

module.exports = { snapshot, list, prune, isDue, schedule, exportJson, exportCsv, TABLES, BACKUP_DIR, KEEP };
