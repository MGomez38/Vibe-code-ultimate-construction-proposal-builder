/**
 * Database layer — uses Node's built-in SQLite (node:sqlite), zero dependencies.
 * Creates the schema on first run and seeds a realistic two-entity group so
 * every module is populated out of the box. Data persists in data/dts.db.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dts.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

require('./lib/schema').create(db);

if (!db.prepare(`SELECT value FROM settings WHERE key = 'seeded'`).get()) {
  db.exec('BEGIN');
  try { require('./lib/seed')(db); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = db;
