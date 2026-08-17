/**
 * Database layer — uses Node's built-in SQLite (node:sqlite), zero dependencies.
 * Creates schema on first run and seeds realistic demo data so every module
 * is populated out of the box. Data persists in data/dts.db.
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

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Crew',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  hourly_rate REAL DEFAULT 25,
  pin TEXT DEFAULT '0000',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT DEFAULT '',
  name TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  unit TEXT DEFAULT 'ea',
  qty_on_hand REAL DEFAULT 0,
  reorder_point REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  sell_price REAL DEFAULT 0,
  location TEXT DEFAULT '',
  vendor TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  items TEXT DEFAULT '[]',          -- JSON [{desc, qty, unit, unit_cost, unit_price, material_id?}]
  labor_hours REAL DEFAULT 0,
  labor_rate REAL DEFAULT 65,
  markup_pct REAL DEFAULT 0,
  tax_pct REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',      -- draft | sent | accepted | declined
  valid_until TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_number TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  quote_id INTEGER REFERENCES quotes(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  address TEXT DEFAULT '',
  status TEXT DEFAULT 'planned',    -- planned | in_progress | on_hold | completed
  sold_price REAL DEFAULT 0,
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  foreman_id INTEGER REFERENCES employees(id),
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS job_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  material_id INTEGER REFERENCES materials(id),
  description TEXT DEFAULT '',
  qty REAL DEFAULT 1,
  unit_cost REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_number TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  client_id INTEGER REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  wo_type TEXT DEFAULT 'Shop',      -- Shop | Field | Fabrication | Repair | Install
  priority TEXT DEFAULT 'normal',   -- low | normal | high | rush
  status TEXT DEFAULT 'open',       -- open | in_progress | completed | archived
  assigned_to INTEGER REFERENCES employees(id),
  due_date TEXT DEFAULT '',
  items TEXT DEFAULT '[]',          -- JSON [{desc, qty, unit_cost, unit_price}]
  labor_hours REAL DEFAULT 0,
  labor_rate REAL DEFAULT 65,
  sold_price REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL,
  vendor TEXT NOT NULL,
  status TEXT DEFAULT 'ordered',    -- draft | ordered | received | cancelled
  items TEXT DEFAULT '[]',          -- JSON [{material_id?, desc, qty, unit_cost}]
  job_id INTEGER REFERENCES jobs(id),
  expected_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  ordered_at TEXT DEFAULT (datetime('now')),
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  job_id INTEGER REFERENCES jobs(id),
  date TEXT NOT NULL,               -- YYYY-MM-DD
  shift TEXT DEFAULT 'Full day',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  job_id INTEGER REFERENCES jobs(id),
  entry_type TEXT DEFAULT 'shift',  -- shift | job
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'crew',   -- admin | crew
  employee_id INTEGER REFERENCES employees(id),
  active INTEGER DEFAULT 1,
  last_login TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  work_date TEXT NOT NULL,
  hours REAL DEFAULT 0,
  work_performed TEXT DEFAULT '',
  materials_used TEXT DEFAULT '',
  issues TEXT DEFAULT '',
  status TEXT DEFAULT 'submitted',     -- submitted | approved
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT DEFAULT '',
  kind TEXT DEFAULT 'quote',
  related_type TEXT DEFAULT '',
  related_id INTEGER,
  status TEXT DEFAULT 'sent',          -- sent | outbox | failed
  error TEXT DEFAULT '',
  preview_file TEXT DEFAULT '',
  sent_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------- column migrations
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('quotes', 'public_token', `TEXT DEFAULT ''`);
addColumn('quotes', 'sent_at', 'TEXT');
addColumn('quotes', 'responded_at', 'TEXT');
addColumn('quotes', 'client_signature', `TEXT DEFAULT ''`);

// ---------------------------------------------------------------- helpers
function iso(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }
function daysAgo(n, h = 8, m = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return iso(d);
}
function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- seed
const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'seeded'`).get();
if (!seeded) {
  const tx = () => {
    const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    const defaults = {
      company_name: 'Diverse Trade Services',
      company_address: '4820 Industrial Parkway, Fairview',
      company_phone: '(555) 100-0000',
      company_email: 'office@diversetradeservices.net',
      company_website: 'diversetradeservices.net',
      default_labor_rate: '65',
      target_margin_pct: '30',
      default_tax_pct: '7.25',
      quote_terms: 'Prices valid for 30 days from the date of this proposal. 40% deposit due at contract signing, balance due on completion. Work performed during standard business hours unless otherwise noted. Any change in scope will be quoted as a written change order before work proceeds.',
      app_base_url: 'http://localhost:3000',
      mail_from: 'Diverse Trade Services <office@diversetradeservices.net>',
      smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_secure: '0',
    };
    for (const [k, v] of Object.entries(defaults)) setSetting.run(k, v);

    const insClient = db.prepare(`INSERT INTO clients (name, contact, phone, email, address) VALUES (?,?,?,?,?)`);
    const clients = [
      ['Summit Property Group', 'Dana Reyes', '555-201-3348', 'dana@summitpg.com', '4120 Commerce Blvd, Suite 210'],
      ['Ironwood Builders', 'Marcus Cole', '555-887-1290', 'mcole@ironwoodbuild.com', '77 Foundry Row'],
      ['Lakeside HOA', 'Priya Natarajan', '555-443-9021', 'board@lakesidehoa.org', '900 Lakeside Dr'],
      ['Redline Logistics', 'Tom Brannigan', '555-310-4477', 'tbrannigan@redlinelog.com', '2 Distribution Way'],
      ['City of Fairview', 'Angela Whitfield', '555-772-6103', 'awhitfield@fairview.gov', '1 Civic Center Plaza'],
    ];
    clients.forEach(c => insClient.run(...c));

    const insEmp = db.prepare(`INSERT INTO employees (name, role, phone, hourly_rate, pin) VALUES (?,?,?,?,?)`);
    const employees = [
      ['Mike Gomez', 'Owner / PM', '555-100-0001', 55, '1111'],
      ['Carlos Vega', 'Foreman', '555-100-0002', 42, '2222'],
      ['Jess Tran', 'Lead Carpenter', '555-100-0003', 38, '3333'],
      ['Andre Willis', 'Electrician', '555-100-0004', 45, '4444'],
      ['Sam Ortiz', 'Shop Fabricator', '555-100-0005', 34, '5555'],
      ['Kayla Burke', 'Apprentice', '555-100-0006', 24, '6666'],
    ];
    employees.forEach(e => insEmp.run(...e));

    const insMat = db.prepare(`INSERT INTO materials (sku, name, category, unit, qty_on_hand, reorder_point, unit_cost, sell_price, location, vendor) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const materials = [
      ['LUM-2X4-8', '2x4 Stud 8ft SPF', 'Lumber', 'ea', 240, 100, 3.85, 6.5, 'Rack A1', 'Fairview Lumber Co'],
      ['LUM-2X6-10', '2x6 #2 Pine 10ft', 'Lumber', 'ea', 88, 60, 7.2, 11.75, 'Rack A2', 'Fairview Lumber Co'],
      ['PLY-CDX-34', 'CDX Plywood 3/4" 4x8', 'Sheet Goods', 'sheet', 34, 25, 42.5, 68, 'Rack B1', 'Fairview Lumber Co'],
      ['DRY-58-4X8', 'Drywall 5/8" 4x8', 'Sheet Goods', 'sheet', 52, 40, 13.9, 22, 'Rack B3', 'BuildRight Supply'],
      ['CON-80LB', 'Concrete Mix 80lb', 'Concrete', 'bag', 96, 50, 6.15, 9.5, 'Yard Bay 2', 'BuildRight Supply'],
      ['REB-4-20', 'Rebar #4 20ft', 'Concrete', 'ea', 140, 80, 8.9, 14, 'Yard Bay 3', 'SteelServ'],
      ['ELC-12-2-250', 'Romex 12/2 250ft Roll', 'Electrical', 'roll', 9, 6, 118, 172, 'Cage C1', 'Volt Supply'],
      ['ELC-BRK-20A', '20A Breaker', 'Electrical', 'ea', 31, 20, 11.4, 19.5, 'Cage C2', 'Volt Supply'],
      ['PLB-PEX-12', 'PEX 1/2" 100ft', 'Plumbing', 'roll', 12, 8, 38, 61, 'Cage D1', 'FlowMaster'],
      ['FST-SCR-3', 'Deck Screws 3" 5lb', 'Fasteners', 'box', 44, 30, 21, 33, 'Shelf E2', 'BuildRight Supply'],
      ['PNT-INT-5G', 'Interior Paint 5gal', 'Finishes', 'pail', 14, 10, 92, 145, 'Shelf F1', 'ColorPro'],
      ['STL-ANG-2', 'Steel Angle 2x2x1/4 20ft', 'Steel', 'ea', 26, 15, 31.5, 52, 'Steel Rack 1', 'SteelServ'],
      ['STL-TUB-2', 'Steel Tube 2x2x11ga 24ft', 'Steel', 'ea', 4, 12, 44.8, 74, 'Steel Rack 2', 'SteelServ'],
      ['INS-R13', 'Insulation R-13 Roll', 'Insulation', 'roll', 18, 15, 54, 84, 'Rack B4', 'BuildRight Supply'],
    ];
    materials.forEach(m => insMat.run(...m));

    const insQuote = db.prepare(`INSERT INTO quotes (quote_number, client_id, title, description, items, labor_hours, labor_rate, markup_pct, tax_pct, status, valid_until, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insQuote.run('Q-1041', 1, 'Warehouse Mezzanine Framing', 'Frame and deck 1,200 sqft storage mezzanine.',
      JSON.stringify([
        { desc: 'Steel Tube 2x2x11ga 24ft', qty: 22, unit: 'ea', unit_cost: 44.8, unit_price: 74 },
        { desc: 'CDX Plywood 3/4" 4x8', qty: 38, unit: 'sheet', unit_cost: 42.5, unit_price: 68 },
        { desc: 'Deck Screws 3" 5lb', qty: 6, unit: 'box', unit_cost: 21, unit_price: 33 },
      ]), 120, 65, 10, 7.25, 'sent', dateStr(21), daysAgo(6));
    insQuote.run('Q-1042', 3, 'Clubhouse Deck Rebuild', 'Demo and rebuild 640 sqft composite deck with new railing.',
      JSON.stringify([
        { desc: 'Composite Decking 16ft', qty: 58, unit: 'ea', unit_cost: 41, unit_price: 62 },
        { desc: '2x6 #2 Pine 10ft (framing)', qty: 40, unit: 'ea', unit_cost: 7.2, unit_price: 11.75 },
        { desc: 'Railing Kit 8ft', qty: 11, unit: 'kit', unit_cost: 96, unit_price: 149 },
      ]), 96, 65, 12, 7.25, 'accepted', dateStr(14), daysAgo(12));
    insQuote.run('Q-1043', 4, 'Dock Door Bollards', 'Supply and set 8 concrete-filled bollards at dock doors.',
      JSON.stringify([
        { desc: 'Bollard 6" Sch40 8ft', qty: 8, unit: 'ea', unit_cost: 88, unit_price: 140 },
        { desc: 'Concrete Mix 80lb', qty: 24, unit: 'bag', unit_cost: 6.15, unit_price: 9.5 },
      ]), 20, 65, 15, 7.25, 'draft', dateStr(30), daysAgo(2));

    const insJob = db.prepare(`INSERT INTO jobs (job_number, client_id, quote_id, title, description, address, status, sold_price, start_date, foreman_id, created_at, completed_at, end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Active jobs
    insJob.run('J-2308', 2, null, 'Ironwood Office Buildout', 'Interior buildout: framing, drywall, paint, electrical rough-in for 3,800 sqft office.', '77 Foundry Row', 'in_progress', 48500, dateStr(-9), 2, daysAgo(10), null, '');
    insJob.run('J-2309', 3, 2, 'Clubhouse Deck Rebuild', 'Demo and rebuild 640 sqft composite deck with new railing.', '900 Lakeside Dr', 'in_progress', 14980, dateStr(-3), 3, daysAgo(4), null, '');
    insJob.run('J-2310', 5, null, 'Fairview Park Pavilion Repairs', 'Structural post replacement and new roof sheathing on park pavilion.', '1 Civic Center Plaza', 'planned', 9200, dateStr(4), 2, daysAgo(3), null, '');
    // Completed historical jobs
    insJob.run('J-2301', 1, null, 'Suite 210 Tenant Improvement', 'Full TI: demising walls, ceiling grid, doors and hardware.', '4120 Commerce Blvd', 'completed', 62400, dateStr(-88), 2, daysAgo(90), daysAgo(61), dateStr(-61));
    insJob.run('J-2304', 4, null, 'Warehouse Guard Rail Install', 'Install 240ft of safety guard rail in distribution warehouse.', '2 Distribution Way', 'completed', 18750, dateStr(-55), 3, daysAgo(58), daysAgo(47), dateStr(-47));

    const insJobMat = db.prepare(`INSERT INTO job_materials (job_id, material_id, description, qty, unit_cost) VALUES (?,?,?,?,?)`);
    insJobMat.run(1, 1, '2x4 Stud 8ft SPF', 160, 3.85);
    insJobMat.run(1, 4, 'Drywall 5/8" 4x8', 110, 13.9);
    insJobMat.run(1, 7, 'Romex 12/2 250ft Roll', 3, 118);
    insJobMat.run(2, 2, '2x6 #2 Pine 10ft', 40, 7.2);
    insJobMat.run(2, 10, 'Deck Screws 3" 5lb', 4, 21);
    insJobMat.run(4, null, 'Metal studs, drywall, ceiling grid & finishes package', 1, 32400);
    insJobMat.run(4, null, 'Electrical & data subcontract', 1, 8900);
    insJobMat.run(5, null, 'Guard rail sections & hardware', 240, 41);

    const insWO = db.prepare(`INSERT INTO work_orders (wo_number, job_id, client_id, title, description, wo_type, priority, status, assigned_to, due_date, items, labor_hours, labor_rate, sold_price, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Open shop work orders
    insWO.run('WO-5121', 1, 2, 'Fab 12 window bucks', 'Fabricate 12 steel window bucks per drawing A-301 for Ironwood buildout.', 'Fabrication', 'high', 'in_progress', 5, dateStr(2),
      JSON.stringify([{ desc: 'Steel Angle 2x2x1/4 20ft', qty: 9, unit_cost: 31.5, unit_price: 52 }]), 26, 65, 2400, daysAgo(5), null);
    insWO.run('WO-5122', 2, 3, 'Railing panel welding', 'Weld 11 railing panels for clubhouse deck; powder-coat black.', 'Fabrication', 'normal', 'open', 5, dateStr(6),
      JSON.stringify([{ desc: 'Railing Kit 8ft components', qty: 11, unit_cost: 96, unit_price: 149 }]), 30, 65, 3900, daysAgo(2), null);
    insWO.run('WO-5123', null, 4, 'Forklift cage repair', 'Straighten and reinforce damaged pallet cage from Redline warehouse.', 'Repair', 'rush', 'open', 5, dateStr(1),
      JSON.stringify([{ desc: 'Steel Tube 2x2x11ga 24ft', qty: 2, unit_cost: 44.8, unit_price: 74 }]), 8, 65, 950, daysAgo(1), null);
    // Historical / archived work orders (the searchable profit history)
    insWO.run('WO-5098', 4, 1, 'Suite 210 door frames', 'Fabricate and hang 9 HM door frames with hardware.', 'Shop', 'normal', 'archived', 5, dateStr(-70),
      JSON.stringify([{ desc: 'HM Door Frame 3070', qty: 9, unit_cost: 148, unit_price: 245 }, { desc: 'Commercial Lockset', qty: 9, unit_cost: 86, unit_price: 139 }]), 34, 60, 5800, daysAgo(78), daysAgo(66));
    insWO.run('WO-5104', 5, 4, 'Guard rail post fab', 'Cut, drill and paint 62 guard rail posts.', 'Fabrication', 'normal', 'archived', 5, dateStr(-52),
      JSON.stringify([{ desc: 'Steel Tube 2x2x11ga 24ft', qty: 18, unit_cost: 42, unit_price: 71 }, { desc: 'Base Plate 6x6x3/8', qty: 62, unit_cost: 9.8, unit_price: 17 }]), 41, 60, 4950, daysAgo(60), daysAgo(50));
    insWO.run('WO-5110', null, 3, 'Pool gate rebuild', 'Rebuild corroded pool gate, new hinges and latch, powder-coat.', 'Repair', 'normal', 'archived', 5, dateStr(-33),
      JSON.stringify([{ desc: 'Aluminum Tube 1.5" 24ft', qty: 4, unit_cost: 39, unit_price: 66 }, { desc: 'Self-closing Hinge Set', qty: 1, unit_cost: 74, unit_price: 120 }]), 12, 60, 1450, daysAgo(40), daysAgo(33));
    insWO.run('WO-5115', null, 5, 'Park bench frames (x6)', 'Fabricate 6 steel park bench frames for Fairview Parks Dept.', 'Fabrication', 'low', 'archived', 5, dateStr(-20),
      JSON.stringify([{ desc: 'Steel Angle 2x2x1/4 20ft', qty: 12, unit_cost: 31.5, unit_price: 52 }, { desc: 'Powder Coat (per frame)', qty: 6, unit_cost: 35, unit_price: 60 }]), 28, 60, 3100, daysAgo(30), daysAgo(21));

    const insPO = db.prepare(`INSERT INTO purchase_orders (po_number, vendor, status, items, job_id, expected_date, ordered_at, received_at, notes) VALUES (?,?,?,?,?,?,?,?,?)`);
    insPO.run('PO-3021', 'SteelServ', 'ordered',
      JSON.stringify([{ material_id: 13, desc: 'Steel Tube 2x2x11ga 24ft', qty: 30, unit_cost: 44.8 }]),
      null, dateStr(3), daysAgo(2), null, 'Restock for WO-5121/5122 + shop stock.');
    insPO.run('PO-3022', 'Volt Supply', 'ordered',
      JSON.stringify([{ material_id: 7, desc: 'Romex 12/2 250ft Roll', qty: 8, unit_cost: 116 }, { material_id: 8, desc: '20A Breaker', qty: 20, unit_cost: 11.1 }]),
      1, dateStr(2), daysAgo(1), null, 'Ironwood electrical rough-in.');
    insPO.run('PO-3018', 'Fairview Lumber Co', 'received',
      JSON.stringify([{ material_id: 3, desc: 'CDX Plywood 3/4" 4x8', qty: 40, unit_cost: 41.9 }]),
      null, dateStr(-6), daysAgo(9), daysAgo(5), '');

    const insSched = db.prepare(`INSERT INTO schedule (employee_id, job_id, date, shift, notes) VALUES (?,?,?,?,?)`);
    // this week's crew assignments
    for (let d = 0; d < 5; d++) {
      insSched.run(2, 1, dateStr(d - new Date().getDay() + 1 + (d >= 5 ? 2 : 0)), 'Full day', '');
    }
    insSched.run(3, 2, dateStr(0), 'Full day', 'Deck framing');
    insSched.run(3, 2, dateStr(1), 'Full day', '');
    insSched.run(6, 2, dateStr(0), 'Full day', 'Helper');
    insSched.run(4, 1, dateStr(1), 'AM', 'Rough-in inspection prep');
    insSched.run(5, null, dateStr(0), 'Full day', 'Shop — WO-5121');
    insSched.run(5, null, dateStr(1), 'Full day', 'Shop — WO-5123 rush');

    const insTime = db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, clock_out, notes) VALUES (?,?,?,?,?,?)`);
    // historical hours on completed jobs (feeds profit numbers)
    const histEntries = [
      [2, 4, 62, 8, 8.5], [3, 4, 62, 8, 8], [6, 4, 62, 8, 8],
      [2, 4, 63, 8, 9], [3, 4, 63, 8, 8.5],
      [3, 5, 50, 8, 8], [6, 5, 50, 8, 7.5], [3, 5, 49, 8, 8],
    ];
    for (const [emp, job, ago, startH, hours] of histEntries) {
      const inT = daysAgo(ago, startH);
      const out = new Date(inT.replace(' ', 'T') + 'Z');
      out.setTime(out.getTime() + hours * 3600e3);
      insTime.run(emp, job, 'job', inT, iso(out), '');
    }
    // recent hours on active jobs
    const recentEntries = [
      [2, 1, 3, 7, 9], [3, 1, 3, 7, 8.5], [2, 1, 2, 7, 9], [4, 1, 2, 8, 6],
      [3, 2, 2, 7, 8], [6, 2, 2, 7, 8], [3, 2, 1, 7, 8.5], [6, 2, 1, 7, 8],
      [5, null, 1, 7, 8],
    ];
    for (const [emp, job, ago, startH, hours] of recentEntries) {
      const inT = daysAgo(ago, startH);
      const out = new Date(inT.replace(' ', 'T') + 'Z');
      out.setTime(out.getTime() + hours * 3600e3);
      insTime.run(emp, job, job ? 'job' : 'shift', inT, iso(out), '');
    }

    // user accounts — one admin (owner) plus a crew login per field employee
    const insUser = db.prepare(`INSERT INTO users (username, password_hash, role, employee_id) VALUES (?,?,?,?)`);
    const { hashPassword } = require('./auth');
    const accounts = [
      ['mike', 'admin123', 'admin', 1],
      ['carlos', 'crew123', 'crew', 2],
      ['jess', 'crew123', 'crew', 3],
      ['andre', 'crew123', 'crew', 4],
      ['sam', 'crew123', 'crew', 5],
      ['kayla', 'crew123', 'crew', 6],
    ];
    accounts.forEach(([u, p, r, e]) => insUser.run(u, hashPassword(p), r, e));

    // a couple of submitted field job cards awaiting office approval
    const insCard = db.prepare(`INSERT INTO job_cards (job_id, employee_id, work_date, hours, work_performed, materials_used, issues, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    insCard.run(1, 2, dateStr(-1), 9, 'Framed north and east demising walls, set door bucks for offices 3-6.', '48 studs, 2 boxes screws', '', 'submitted', daysAgo(1, 16));
    insCard.run(2, 3, dateStr(-1), 8.5, 'Demo of old deck complete, hauled debris. Started ledger and footings layout.', 'Dumpster pull #2', 'Two footings hit buried irrigation line — client notified, may need a change order.', 'submitted', daysAgo(1, 17));

    db.prepare(`INSERT INTO settings (key, value) VALUES ('seeded', '1')`).run();
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = db;
