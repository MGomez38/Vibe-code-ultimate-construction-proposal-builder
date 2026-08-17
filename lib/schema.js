/**
 * The database schema, shared by the live database and the test suite.
 * Kept separate from db.js so tests can build a throwaway in-memory copy
 * without touching (or seeding) the real data file.
 */
'use strict';

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One row per legal entity. Everything else hangs off these.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,          -- AS | DTS — also the document number prefix
  name TEXT NOT NULL,
  legal_name TEXT DEFAULT '',
  kind TEXT DEFAULT 'construction',   -- fabrication | construction
  tagline TEXT DEFAULT '',
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  website TEXT DEFAULT '',
  license_number TEXT DEFAULT '',
  accent TEXT DEFAULT '#f5a524',      -- brand colour so you always know which books you are in
  default_labor_rate REAL DEFAULT 65,
  target_margin_pct REAL DEFAULT 30,
  default_tax_pct REAL DEFAULT 0,
  default_retainage_pct REAL DEFAULT 0,
  payment_terms_days INTEGER DEFAULT 30,
  quote_terms TEXT DEFAULT '',
  payment_link_url TEXT DEFAULT '',
  payment_instructions TEXT DEFAULT '',
  mail_from TEXT DEFAULT '',
  cash_on_hand REAL DEFAULT 0,
  sister_client_id INTEGER,           -- the client record representing the other entity
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
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
  priced_on TEXT DEFAULT '',           -- when this price was last confirmed
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

CREATE TABLE IF NOT EXISTS change_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  co_number TEXT NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  client_id INTEGER REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  reason TEXT DEFAULT '',            -- client request | unforeseen condition | design change | other
  items TEXT DEFAULT '[]',
  labor_hours REAL DEFAULT 0,
  labor_rate REAL DEFAULT 65,
  markup_pct REAL DEFAULT 0,
  tax_pct REAL DEFAULT 0,
  schedule_days REAL DEFAULT 0,      -- calendar days added to the job
  status TEXT DEFAULT 'draft',       -- draft | sent | approved | declined
  public_token TEXT DEFAULT '',
  sent_at TEXT,
  responded_at TEXT,
  client_signature TEXT DEFAULT '',
  source_card_id INTEGER REFERENCES job_cards(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  client_id INTEGER REFERENCES clients(id),
  invoice_type TEXT DEFAULT 'progress',  -- deposit | progress | final
  description TEXT DEFAULT '',
  items TEXT DEFAULT '[]',
  tax_pct REAL DEFAULT 0,
  retainage_pct REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',       -- draft | sent | paid | void
  issue_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  terms_days INTEGER DEFAULT 30,
  sent_at TEXT,
  public_token TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount REAL NOT NULL,
  method TEXT DEFAULT 'check',       -- check | ach | card | cash | other
  reference TEXT DEFAULT '',
  received_on TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,         -- job_card | job | change_order | sub_document
  entity_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  original_name TEXT DEFAULT '',
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  caption TEXT DEFAULT '',
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subcontractors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trade TEXT DEFAULT '',
  contact TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  license_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sub_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_id INTEGER NOT NULL REFERENCES subcontractors(id),
  doc_type TEXT DEFAULT 'COI',       -- COI | W-9 | License | Contract | Other
  carrier TEXT DEFAULT '',
  policy_number TEXT DEFAULT '',
  issued_on TEXT DEFAULT '',
  expires_on TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- What the shop actually consumed, logged at the bench.
-- One row per line: a sheet of metal, a length of solder, a spool of wire.
CREATE TABLE IF NOT EXISTS material_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  work_order_id INTEGER REFERENCES work_orders(id),
  job_id INTEGER REFERENCES jobs(id),
  employee_id INTEGER REFERENCES employees(id),
  kind TEXT DEFAULT 'metal',         -- metal | solder | consumable | other
  material_id INTEGER REFERENCES materials(id),
  metal_type TEXT DEFAULT '',        -- Galvanized | Stainless 304 | Aluminum | CRS …
  gauge TEXT DEFAULT '',             -- 16 ga | .063 | 11 ga
  size TEXT DEFAULT '',              -- 4x10 sheet | 20ft stick | coil
  description TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  unit TEXT DEFAULT 'ea',            -- sheet | ea | lf | sqft | in (solder)
  unit_cost REAL DEFAULT 0,          -- snapshot, so later price changes do not rewrite history
  notes TEXT DEFAULT '',
  logged_at TEXT DEFAULT (datetime('now')),
  client_ref TEXT DEFAULT ''         -- offline de-duplication
);

-- Drops: what is left of a sheet after the shop cuts it. Real material on a
-- real rack, tracked so it gets used instead of quietly becoming scrap.
CREATE TABLE IF NOT EXISTS remnants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  material_id INTEGER REFERENCES materials(id),   -- the stock it was cut from
  tag TEXT DEFAULT '',                            -- what gets written on the piece
  metal_type TEXT DEFAULT '',
  gauge TEXT DEFAULT '',
  width_in REAL NOT NULL,
  length_in REAL NOT NULL,
  area_sqft REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0,                       -- carried value per sqft
  location TEXT DEFAULT '',
  status TEXT DEFAULT 'available',                -- available | used | scrapped
  source_usage_id INTEGER REFERENCES material_usage(id),
  used_usage_id INTEGER REFERENCES material_usage(id),
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT DEFAULT (datetime('now')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS job_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  sub_id INTEGER NOT NULL REFERENCES subcontractors(id),
  scope TEXT DEFAULT '',
  contract_amount REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

/** Add columns to existing databases so old data files upgrade cleanly. */
function migrate(db) {
  const addColumn = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  // a price is only as good as its date — imported books carry one
  addColumn('materials', 'priced_on', `TEXT DEFAULT ''`);
  addColumn('quotes', 'public_token', `TEXT DEFAULT ''`);
  addColumn('quotes', 'sent_at', 'TEXT');
  addColumn('quotes', 'responded_at', 'TEXT');
  addColumn('quotes', 'client_signature', `TEXT DEFAULT ''`);
  // prevailing-wage / certified payroll support
  addColumn('employees', 'classification', `TEXT DEFAULT ''`);
  addColumn('employees', 'fringe_rate', 'REAL DEFAULT 0');
  addColumn('jobs', 'prevailing_wage', 'INTEGER DEFAULT 0');
  addColumn('jobs', 'est_labor_hours', 'REAL DEFAULT 0');
  // offline sync de-duplication
  addColumn('time_entries', 'client_ref', `TEXT DEFAULT ''`);
  addColumn('job_cards', 'client_ref', `TEXT DEFAULT ''`);
  // document versioning — what the customer was actually sent, frozen
  for (const t of ['quotes', 'change_orders']) {
    addColumn(t, 'sent_snapshot', 'TEXT');
    addColumn(t, 'revision', 'INTEGER DEFAULT 1');
    addColumn(t, 'approved_revision', 'INTEGER');
  }
  // online payments
  addColumn('payments', 'external_id', `TEXT DEFAULT ''`);

  // ---- multi-entity: every primary record belongs to one company ----
  for (const t of ['clients', 'employees', 'materials', 'quotes', 'jobs', 'work_orders',
                   'invoices', 'purchase_orders', 'subcontractors', 'change_orders']) {
    addColumn(t, 'company_id', 'INTEGER REFERENCES companies(id)');
  }
  // a user pinned to one entity sees only that one; NULL sees the whole group
  addColumn('users', 'company_id', 'INTEGER REFERENCES companies(id)');
  // clients that are actually the sister entity, so intercompany billing is obvious
  addColumn('clients', 'is_internal', 'INTEGER DEFAULT 0');
  // work raised by one entity against the other's job
  addColumn('work_orders', 'origin_job_id', 'INTEGER REFERENCES jobs(id)');
  addColumn('work_orders', 'origin_company_id', 'INTEGER REFERENCES companies(id)');
  addColumn('work_orders', 'billed_invoice_id', 'INTEGER REFERENCES invoices(id)');
  addColumn('invoices', 'intercompany', 'INTEGER DEFAULT 0');
  // sheet goods carry their nominal size so drops can be worked out
  addColumn('materials', 'sheet_width_in', 'REAL DEFAULT 0');
  addColumn('materials', 'sheet_length_in', 'REAL DEFAULT 0');
  addColumn('materials', 'min_usable_in', 'REAL DEFAULT 6');
  // usage lines record the cut that produced a drop
  addColumn('material_usage', 'cut_width_in', 'REAL DEFAULT 0');
  addColumn('material_usage', 'cut_length_in', 'REAL DEFAULT 0');
  addColumn('material_usage', 'remnant_id', 'INTEGER REFERENCES remnants(id)');
}

/** Create every table on a fresh connection. */
function create(db) { db.exec(DDL); migrate(db); }

module.exports = { DDL, create, migrate };
