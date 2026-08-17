/**
 * DTS Command Center — zero-dependency Node.js server.
 *
 * Serves three surfaces:
 *   /        Command Center  (admin only — full office console)
 *   /portal  Crew Portal     (any signed-in employee — mobile-first, no financials)
 *   /q/:tok  Public proposal (no login — the customer's view of an emailed quote)
 *
 * Run: node server.js   (Node >= 22.5, uses built-in node:sqlite)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { makeAuth, hashPassword } = require('./auth');
const { sendMail, OUTBOX } = require('./mailer');
const T = require('./templates');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const auth = makeAuth(db);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- utils
function json(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}
function html(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const parseItems = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const settings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));

function itemsCost(items) { return items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_cost) || 0), 0); }
function itemsPrice(items) { return items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0); }

function quoteTotals(q) {
  const items = parseItems(q.items);
  const materials = itemsPrice(items);
  const labor = (Number(q.labor_hours) || 0) * (Number(q.labor_rate) || 0);
  const subtotal = materials + labor;
  const markup = subtotal * (Number(q.markup_pct) || 0) / 100;
  const tax = (subtotal + markup) * (Number(q.tax_pct) || 0) / 100;
  const total = subtotal + markup + tax;
  const cost = itemsCost(items) + labor * 0.6; // internal labor burden vs billed rate
  return { materials: round2(materials), labor: round2(labor), subtotal: round2(subtotal), markup: round2(markup), tax: round2(tax), total: round2(total), est_cost: round2(cost) };
}

function woFinancials(wo) {
  const items = parseItems(wo.items);
  const materialCost = itemsCost(items);
  const materialPrice = itemsPrice(items);
  const laborCost = (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0) * 0.55;
  const totalCost = round2(materialCost + laborCost);
  const sold = Number(wo.sold_price) || round2(materialPrice + (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0));
  const profit = round2(sold - totalCost);
  return { material_cost: round2(materialCost), labor_cost: round2(laborCost), total_cost: totalCost, sold_price: round2(sold), profit, margin_pct: sold > 0 ? round2(profit / sold * 100) : 0 };
}

function jobFinancials(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const mats = db.prepare('SELECT * FROM job_materials WHERE job_id = ?').all(jobId);
  const materialCost = mats.reduce((s, m) => s + (m.qty || 0) * (m.unit_cost || 0), 0);
  const time = db.prepare(`
    SELECT t.*, e.hourly_rate FROM time_entries t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.job_id = ? AND t.clock_out IS NOT NULL`).all(jobId);
  let hours = 0, laborCost = 0;
  for (const t of time) {
    const h = (new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z')) / 3600e3;
    hours += h; laborCost += h * (t.hourly_rate || 0);
  }
  const woCost = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(jobId)
    .reduce((s, wo) => s + woFinancials(wo).total_cost, 0);
  const totalCost = round2(materialCost + laborCost + woCost);
  const sold = Number(job.sold_price) || 0;
  const profit = round2(sold - totalCost);
  return {
    material_cost: round2(materialCost), labor_hours: round2(hours), labor_cost: round2(laborCost),
    wo_cost: round2(woCost), total_cost: totalCost, sold_price: sold, profit,
    margin_pct: sold > 0 ? round2(profit / sold * 100) : 0,
  };
}

function nextNumber(table, column, prefix) {
  const rows = db.prepare(`SELECT ${column} AS n FROM ${table}`).all();
  let max = 0;
  for (const r of rows) { const m = /(\d+)$/.exec(r.n || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${max + 1}`;
}

function quoteContext(quote) {
  return {
    quote,
    client: quote.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(quote.client_id) : null,
    company: settings(),
    totals: quoteTotals(quote),
    items: parseItems(quote.items),
  };
}

// ---------------------------------------------------------------- generic CRUD config (admin only)
const RESOURCES = {
  clients:   { table: 'clients',   fields: ['name', 'contact', 'phone', 'email', 'address', 'notes'] },
  employees: { table: 'employees', fields: ['name', 'role', 'phone', 'email', 'hourly_rate', 'pin', 'active'] },
  materials: { table: 'materials', fields: ['sku', 'name', 'category', 'unit', 'qty_on_hand', 'reorder_point', 'unit_cost', 'sell_price', 'location', 'vendor'] },
  quotes:    { table: 'quotes',    fields: ['quote_number', 'client_id', 'title', 'description', 'items', 'labor_hours', 'labor_rate', 'markup_pct', 'tax_pct', 'status', 'valid_until', 'notes'] },
  jobs:      { table: 'jobs',      fields: ['job_number', 'client_id', 'quote_id', 'title', 'description', 'address', 'status', 'sold_price', 'start_date', 'end_date', 'foreman_id', 'notes', 'completed_at'] },
  workorders:{ table: 'work_orders', fields: ['wo_number', 'job_id', 'client_id', 'title', 'description', 'wo_type', 'priority', 'status', 'assigned_to', 'due_date', 'items', 'labor_hours', 'labor_rate', 'sold_price', 'notes', 'completed_at'] },
  purchaseorders: { table: 'purchase_orders', fields: ['po_number', 'vendor', 'status', 'items', 'job_id', 'expected_date', 'notes'] },
  schedule:  { table: 'schedule',  fields: ['employee_id', 'job_id', 'date', 'shift', 'notes'] },
  jobcards:  { table: 'job_cards', fields: ['job_id', 'employee_id', 'work_date', 'hours', 'work_performed', 'materials_used', 'issues', 'status'] },
};

function sanitize(cfg, body) {
  const out = {};
  for (const f of cfg.fields) {
    if (body[f] !== undefined) out[f] = (typeof body[f] === 'object' && body[f] !== null) ? JSON.stringify(body[f]) : body[f];
  }
  return out;
}

function crudHandler(resource, method, id, body) {
  const cfg = RESOURCES[resource];
  const t = cfg.table;
  if (method === 'GET' && !id) return db.prepare(`SELECT * FROM ${t} ORDER BY id DESC`).all();
  if (method === 'GET' && id) return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id) || { error: 'Not found' };
  if (method === 'POST') {
    const data = sanitize(cfg, body);
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    const info = db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => data[k]));
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(info.lastInsertRowid);
  }
  if (method === 'PUT' && id) {
    const data = sanitize(cfg, body);
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    db.prepare(`UPDATE ${t} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => data[k]), id);
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
  }
  if (method === 'DELETE' && id) { db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); return { ok: true }; }
  throw new Error('Unsupported');
}

// ---------------------------------------------------------------- public quote link
function publicQuoteRoutes(req, res, urlPath, body) {
  const [, , token, action] = urlPath.split('/'); // ['', 'q', token, action?]
  const quote = db.prepare(`SELECT * FROM quotes WHERE public_token = ? AND public_token != ''`).get(token);
  if (!quote) return html(res, 404, '<body style="font-family:system-ui;padding:60px;text-align:center"><h2>Proposal not found</h2><p>This link may have expired. Please contact us for a new copy.</p></body>');

  if (action === 'respond' && req.method === 'POST') {
    const decision = body.decision === 'accepted' ? 'accepted' : 'declined';
    db.prepare(`UPDATE quotes SET status = ?, responded_at = ?, client_signature = ?, updated_at = ? WHERE id = ?`)
      .run(decision, now(), String(body.signature || '').slice(0, 120), now(), quote.id);
    auth.audit(null, 'quote_' + decision, `${quote.quote_number} ${decision} by client${body.signature ? ` (${body.signature})` : ''}`);
    const fresh = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quote.id);
    return html(res, 200, T.quotePage(quoteContext(fresh), { token, responded: decision }));
  }
  return html(res, 200, T.quotePage(quoteContext(quote), { token }));
}

// ---------------------------------------------------------------- crew portal API
async function portalApi(req, res, parts, body, user) {
  const section = parts[2];
  const empId = user.employee_id;
  if (!empId) return json(res, 403, { error: 'This login is not linked to an employee record' });

  if (section === 'summary' && req.method === 'GET') {
    const open = db.prepare(`
      SELECT t.*, j.job_number, j.title AS job_title FROM time_entries t
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.employee_id = ? AND t.clock_out IS NULL`).get(empId);
    const todaysJobs = db.prepare(`
      SELECT s.*, j.job_number, j.title AS job_title, j.address FROM schedule s
      LEFT JOIN jobs j ON j.id = s.job_id WHERE s.employee_id = ? AND s.date = ?`).all(empId, today());
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    const entries = db.prepare(`
      SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NOT NULL AND date(clock_in) >= ?`)
      .all(empId, weekAgo.toISOString().slice(0, 10));
    const weekHours = round2(entries.reduce((s, t) =>
      s + (new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z')) / 3600e3, 0));
    const myWOs = db.prepare(`
      SELECT w.id, w.wo_number, w.title, w.description, w.wo_type, w.priority, w.status, w.due_date, j.job_number
      FROM work_orders w LEFT JOIN jobs j ON j.id = w.job_id
      WHERE w.assigned_to = ? AND w.status IN ('open','in_progress')
      ORDER BY CASE w.priority WHEN 'rush' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.due_date`).all(empId);
    return json(res, 200, {
      employee: { id: empId, name: user.employee_name, role: user.employee_role },
      open_entry: open || null, today: todaysJobs, week_hours: weekHours, work_orders: myWOs,
      jobs: db.prepare(`SELECT id, job_number, title, address FROM jobs WHERE status IN ('planned','in_progress') ORDER BY job_number`).all(),
    });
  }

  if (section === 'clock' && req.method === 'POST') {
    const dir = parts[3];
    const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(empId);
    if (dir === 'in') {
      if (open && !body.job_id) return json(res, 409, { error: 'You are already clocked in' });
      if (open) db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      db.prepare('INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, notes) VALUES (?,?,?,?,?)')
        .run(empId, body.job_id || null, body.job_id ? 'job' : 'shift', now(), body.notes || '');
      auth.audit(user, 'clock_in', body.job_id ? `job ${body.job_id}` : 'shift');
      return json(res, 200, { ok: true, message: body.job_id ? 'Clocked onto job' : 'Clocked in' });
    }
    if (dir === 'out') {
      if (!open) return json(res, 409, { error: 'You are not clocked in' });
      db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      auth.audit(user, 'clock_out', '');
      return json(res, 200, { ok: true, message: 'Clocked out — nice work' });
    }
  }

  if (section === 'schedule' && req.method === 'GET') {
    const from = new Date(); from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    const start = from.toISOString().slice(0, 10);
    const end = new Date(from); end.setDate(end.getDate() + 13);
    return json(res, 200, db.prepare(`
      SELECT s.*, j.job_number, j.title AS job_title, j.address FROM schedule s
      LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.employee_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date`).all(empId, start, end.toISOString().slice(0, 10)));
  }

  if (section === 'timesheet' && req.method === 'GET') {
    const from = new Date(); from.setDate(from.getDate() - 13);
    const rows = db.prepare(`
      SELECT t.*, j.job_number, j.title AS job_title FROM time_entries t
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.employee_id = ? AND date(t.clock_in) >= ? ORDER BY t.clock_in DESC`).all(empId, from.toISOString().slice(0, 10));
    rows.forEach(r => {
      r.hours = r.clock_out ? round2((new Date(r.clock_out.replace(' ', 'T') + 'Z') - new Date(r.clock_in.replace(' ', 'T') + 'Z')) / 3600e3) : null;
    });
    return json(res, 200, rows);
  }

  if (section === 'workorders' && req.method === 'PUT') {
    const wo = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(parts[3]);
    if (!wo || wo.assigned_to !== empId) return json(res, 403, { error: 'That work order is not assigned to you' });
    const status = ['open', 'in_progress', 'completed'].includes(body.status) ? body.status : null;
    if (!status) return json(res, 400, { error: 'Invalid status' });
    db.prepare('UPDATE work_orders SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, status === 'completed' ? now() : wo.completed_at, wo.id);
    auth.audit(user, 'wo_status', `${wo.wo_number} → ${status}`);
    return json(res, 200, { ok: true });
  }

  if (section === 'jobcards') {
    if (req.method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT c.*, j.job_number, j.title AS job_title FROM job_cards c
        LEFT JOIN jobs j ON j.id = c.job_id
        WHERE c.employee_id = ? ORDER BY c.id DESC LIMIT 30`).all(empId));
    }
    if (req.method === 'POST') {
      if (!body.work_performed) return json(res, 400, { error: 'Describe the work performed' });
      db.prepare(`INSERT INTO job_cards (job_id, employee_id, work_date, hours, work_performed, materials_used, issues)
        VALUES (?,?,?,?,?,?,?)`).run(body.job_id || null, empId, body.work_date || today(),
        Number(body.hours) || 0, body.work_performed, body.materials_used || '', body.issues || '');
      auth.audit(user, 'jobcard_submitted', body.work_performed.slice(0, 80));
      return json(res, 200, { ok: true, message: 'Job card submitted to the office' });
    }
  }

  // stock lookup — quantities and locations only, no costs or sell prices
  if (section === 'materials' && req.method === 'GET') {
    return json(res, 200, db.prepare('SELECT id, sku, name, category, unit, qty_on_hand, reorder_point, location FROM materials ORDER BY name').all());
  }

  return json(res, 404, { error: 'Unknown portal endpoint' });
}

// ---------------------------------------------------------------- admin API
async function adminApi(req, res, parts, body, query, user) {
  const method = req.method;
  const resource = parts[1];
  const idOrAction = parts[2];
  const action = parts[3];

  // ---- kiosk time clock (shared shop tablet — PIN protected) ----
  if (resource === 'clock') {
    if (idOrAction === 'status' && method === 'GET') {
      return json(res, 200, db.prepare(`
        SELECT t.*, e.name AS employee_name, j.job_number, j.title AS job_title
        FROM time_entries t JOIN employees e ON e.id = t.employee_id
        LEFT JOIN jobs j ON j.id = t.job_id
        WHERE t.clock_out IS NULL ORDER BY t.clock_in`).all());
    }
    if (idOrAction === 'in' && method === 'POST') {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(body.employee_id);
      if (!emp) return json(res, 404, { error: 'Employee not found' });
      if (String(emp.pin) !== String(body.pin)) return json(res, 403, { error: 'Wrong PIN' });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(emp.id);
      if (open && !body.job_id) return json(res, 409, { error: `${emp.name} is already clocked in` });
      if (open && body.job_id) db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      db.prepare('INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, notes) VALUES (?,?,?,?,?)')
        .run(emp.id, body.job_id || null, body.job_id ? 'job' : 'shift', now(), body.notes || '');
      return json(res, 200, { ok: true, message: body.job_id ? `${emp.name} clocked onto job` : `${emp.name} clocked in` });
    }
    if (idOrAction === 'out' && method === 'POST') {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(body.employee_id);
      if (!emp) return json(res, 404, { error: 'Employee not found' });
      if (String(emp.pin) !== String(body.pin)) return json(res, 403, { error: 'Wrong PIN' });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(emp.id);
      if (!open) return json(res, 409, { error: `${emp.name} is not clocked in` });
      db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      return json(res, 200, { ok: true, message: `${emp.name} clocked out` });
    }
  }

  if (resource === 'timesheets' && method === 'GET') {
    const from = query.get('from') || today(), to = query.get('to') || today();
    const rows = db.prepare(`
      SELECT t.*, e.name AS employee_name, e.hourly_rate, j.job_number, j.title AS job_title
      FROM time_entries t JOIN employees e ON e.id = t.employee_id
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE date(t.clock_in) BETWEEN ? AND ? ORDER BY t.clock_in DESC`).all(from, to);
    for (const r of rows) {
      r.hours = r.clock_out ? round2((new Date(r.clock_out.replace(' ', 'T') + 'Z') - new Date(r.clock_in.replace(' ', 'T') + 'Z')) / 3600e3) : null;
      r.labor_cost = r.hours !== null ? round2(r.hours * r.hourly_rate) : null;
      delete r.hourly_rate;
    }
    return json(res, 200, rows);
  }

  // ---- quotes ----
  if (resource === 'quotes' && idOrAction && action === 'convert' && method === 'POST') {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(idOrAction);
    if (!q) return json(res, 404, { error: 'Quote not found' });
    const totals = quoteTotals(q);
    const jobNumber = nextNumber('jobs', 'job_number', 'J');
    const info = db.prepare(`INSERT INTO jobs (job_number, client_id, quote_id, title, description, status, sold_price, start_date)
      VALUES (?,?,?,?,?,?,?,?)`).run(jobNumber, q.client_id, q.id, q.title, q.description, 'planned', totals.total, body.start_date || today());
    const jobId = info.lastInsertRowid;
    let woId = null;
    if (body.create_work_order) {
      const woNumber = nextNumber('work_orders', 'wo_number', 'WO');
      woId = db.prepare(`INSERT INTO work_orders (wo_number, job_id, client_id, title, description, wo_type, status, items, labor_hours, labor_rate, sold_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(woNumber, jobId, q.client_id, q.title, q.description, 'Shop', 'open', q.items, q.labor_hours, q.labor_rate, totals.total).lastInsertRowid;
    }
    db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`).run(now(), q.id);
    auth.audit(user, 'quote_converted', `${q.quote_number} → ${jobNumber}`);
    return json(res, 200, { ok: true, job_id: jobId, job_number: jobNumber, work_order_id: woId });
  }

  if (resource === 'quotes' && idOrAction && action === 'email' && method === 'POST') {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(idOrAction);
    if (!q) return json(res, 404, { error: 'Quote not found' });
    const client = q.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id) : null;
    const to = String(body.to || client?.email || '').trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(res, 400, { error: 'A valid recipient email address is required' });

    let token = q.public_token;
    if (!token) {
      token = crypto.randomBytes(18).toString('hex');
      db.prepare('UPDATE quotes SET public_token = ? WHERE id = ?').run(token, q.id);
      q.public_token = token;
    }
    const cfg = settings();
    const link = `${(cfg.app_base_url || '').replace(/\/$/, '')}/q/${token}`;
    const ctx = quoteContext(q);
    const subject = body.subject || `${cfg.company_name} — Proposal ${q.quote_number}: ${q.title}`;
    const message = body.message !== undefined ? body.message
      : `Hi${client?.contact ? ' ' + client.contact.split(' ')[0] : ''},\n\nThanks for the opportunity to quote this work. Our proposal is below — you can review and approve it online with the button at the bottom.\n\nHappy to walk through any line item.\n\n${cfg.company_name}\n${cfg.company_phone || ''}`;

    let result, status = 'sent', error = '';
    try {
      result = await sendMail(
        { host: cfg.smtp_host, port: cfg.smtp_port, user: cfg.smtp_user, pass: cfg.smtp_pass, secure: cfg.smtp_secure === '1', from: cfg.mail_from },
        { to, subject, replyTo: cfg.company_email, html: T.quoteEmail(ctx, { link, message }), text: T.quoteText(ctx, link) });
      status = result.status;
    } catch (e) { status = 'failed'; error = e.message; }

    db.prepare(`INSERT INTO email_log (to_email, subject, kind, related_type, related_id, status, error, preview_file, sent_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(to, subject, 'quote', 'quote', q.id, status, error, result?.file || '', user.id);

    if (status === 'failed') return json(res, 502, { error: `Email failed: ${error}`, link });
    if (q.status === 'draft') db.prepare(`UPDATE quotes SET status = 'sent' WHERE id = ?`).run(q.id);
    db.prepare('UPDATE quotes SET sent_at = ? WHERE id = ?').run(now(), q.id);
    auth.audit(user, 'quote_emailed', `${q.quote_number} → ${to} (${status})`);
    return json(res, 200, {
      ok: true, status, link, preview: result?.file ? `/outbox/${result.file}` : null,
      message: status === 'outbox'
        ? 'SMTP is not configured yet, so the email was saved to the outbox — open the preview to see exactly what the customer would receive.'
        : `Proposal emailed to ${to}`,
    });
  }

  if (resource === 'quotes' && idOrAction && action === 'link' && method === 'POST') {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(idOrAction);
    if (!q) return json(res, 404, { error: 'Quote not found' });
    let token = q.public_token;
    if (!token) {
      token = crypto.randomBytes(18).toString('hex');
      db.prepare('UPDATE quotes SET public_token = ? WHERE id = ?').run(token, q.id);
    }
    return json(res, 200, { link: `${(settings().app_base_url || '').replace(/\/$/, '')}/q/${token}` });
  }

  if (resource === 'quotes' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT q.*, c.name AS client_name, c.email AS client_email, c.contact AS client_contact FROM quotes q
      LEFT JOIN clients c ON c.id = q.client_id ORDER BY q.id DESC`).all();
    rows.forEach(r => { r.totals = quoteTotals(r); });
    return json(res, 200, rows);
  }

  // ---- jobs ----
  if (resource === 'jobs' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`
      SELECT j.*, c.name AS client_name, e.name AS foreman_name FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN employees e ON e.id = j.foreman_id
      ORDER BY CASE j.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END, j.id DESC`).all();
    rows.forEach(r => { r.financials = jobFinancials(r.id); });
    return json(res, 200, rows);
  }
  if (resource === 'jobs' && idOrAction && action === 'detail' && method === 'GET') {
    const job = db.prepare(`SELECT j.*, c.name AS client_name, e.name AS foreman_name FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN employees e ON e.id = j.foreman_id WHERE j.id = ?`).get(idOrAction);
    if (!job) return json(res, 404, { error: 'Not found' });
    job.financials = jobFinancials(job.id);
    job.materials = db.prepare(`SELECT jm.*, m.name AS material_name, m.unit FROM job_materials jm
      LEFT JOIN materials m ON m.id = jm.material_id WHERE jm.job_id = ?`).all(job.id);
    job.work_orders = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(job.id);
    job.work_orders.forEach(w => { w.financials = woFinancials(w); });
    job.time = db.prepare(`SELECT t.*, e.name AS employee_name FROM time_entries t
      JOIN employees e ON e.id = t.employee_id WHERE t.job_id = ? ORDER BY t.clock_in DESC LIMIT 50`).all(job.id);
    job.job_cards = db.prepare(`SELECT c.*, e.name AS employee_name FROM job_cards c
      JOIN employees e ON e.id = c.employee_id WHERE c.job_id = ? ORDER BY c.id DESC`).all(job.id);
    return json(res, 200, job);
  }
  if (resource === 'jobs' && idOrAction && action === 'materials' && method === 'POST') {
    if (!db.prepare('SELECT id FROM jobs WHERE id = ?').get(idOrAction)) return json(res, 404, { error: 'Job not found' });
    let desc = body.description || '', cost = Number(body.unit_cost) || 0;
    if (body.material_id) {
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(body.material_id);
      if (m) {
        desc = desc || m.name; cost = cost || m.unit_cost;
        db.prepare('UPDATE materials SET qty_on_hand = MAX(0, qty_on_hand - ?) WHERE id = ?').run(Number(body.qty) || 0, m.id);
      }
    }
    db.prepare('INSERT INTO job_materials (job_id, material_id, description, qty, unit_cost) VALUES (?,?,?,?,?)')
      .run(idOrAction, body.material_id || null, desc, Number(body.qty) || 1, cost);
    return json(res, 200, { ok: true });
  }

  // ---- work orders ----
  if (resource === 'workorders' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`
      SELECT w.*, c.name AS client_name, e.name AS assigned_name, j.job_number FROM work_orders w
      LEFT JOIN clients c ON c.id = w.client_id
      LEFT JOIN employees e ON e.id = w.assigned_to
      LEFT JOIN jobs j ON j.id = w.job_id
      ORDER BY CASE w.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
               CASE w.priority WHEN 'rush' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.id DESC`).all();
    rows.forEach(r => { r.financials = woFinancials(r); });
    return json(res, 200, rows);
  }

  // ---- job cards awaiting office review ----
  if (resource === 'jobcards' && method === 'GET' && !idOrAction) {
    return json(res, 200, db.prepare(`
      SELECT c.*, e.name AS employee_name, j.job_number, j.title AS job_title FROM job_cards c
      JOIN employees e ON e.id = c.employee_id
      LEFT JOIN jobs j ON j.id = c.job_id ORDER BY c.status = 'approved', c.id DESC`).all());
  }
  if (resource === 'jobcards' && idOrAction && action === 'approve' && method === 'POST') {
    db.prepare(`UPDATE job_cards SET status = 'approved' WHERE id = ?`).run(idOrAction);
    auth.audit(user, 'jobcard_approved', `card ${idOrAction}`);
    return json(res, 200, { ok: true });
  }

  // ---- purchasing ----
  if (resource === 'purchaseorders' && idOrAction && action === 'receive' && method === 'POST') {
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(idOrAction);
    if (!po) return json(res, 404, { error: 'PO not found' });
    if (po.status === 'received') return json(res, 409, { error: 'Already received' });
    for (const item of parseItems(po.items)) {
      if (item.material_id) {
        db.prepare('UPDATE materials SET qty_on_hand = qty_on_hand + ?, unit_cost = COALESCE(?, unit_cost) WHERE id = ?')
          .run(Number(item.qty) || 0, Number(item.unit_cost) || null, item.material_id);
      }
    }
    db.prepare(`UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ?`).run(now(), po.id);
    auth.audit(user, 'po_received', po.po_number);
    return json(res, 200, { ok: true });
  }

  // ---- dashboard ----
  if (resource === 'dashboard' && method === 'GET') {
    const one = sql => db.prepare(sql).get().n;
    const kpis = {
      activeJobs: one(`SELECT COUNT(*) n FROM jobs WHERE status IN ('planned','in_progress','on_hold')`),
      openWOs: one(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress')`),
      rushWOs: one(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress') AND priority = 'rush'`),
      onClock: one(`SELECT COUNT(*) n FROM time_entries WHERE clock_out IS NULL`),
      pendingQuotes: one(`SELECT COUNT(*) n FROM quotes WHERE status IN ('draft','sent')`),
      lowStock: one(`SELECT COUNT(*) n FROM materials WHERE qty_on_hand <= reorder_point`),
      openPOs: one(`SELECT COUNT(*) n FROM purchase_orders WHERE status = 'ordered'`),
      pendingCards: one(`SELECT COUNT(*) n FROM job_cards WHERE status = 'submitted'`),
      quoteValue: round2(db.prepare(`SELECT * FROM quotes WHERE status IN ('draft','sent')`).all().reduce((s, q) => s + quoteTotals(q).total, 0)),
    };
    const months = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); months.push(d.toISOString().slice(0, 7)); }
    const series = months.map(m => ({ month: m, revenue: 0, profit: 0 }));
    for (const j of db.prepare(`SELECT * FROM jobs WHERE status = 'completed' AND completed_at IS NOT NULL`).all()) {
      const slot = series.find(s => s.month === j.completed_at.slice(0, 7));
      if (slot) { const f = jobFinancials(j.id); slot.revenue += f.sold_price; slot.profit += f.profit; }
    }
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE job_id IS NULL AND completed_at IS NOT NULL`).all()) {
      const slot = series.find(s => s.month === w.completed_at.slice(0, 7));
      if (slot) { const f = woFinancials(w); slot.revenue += f.sold_price; slot.profit += f.profit; }
    }
    series.forEach(s => { s.revenue = round2(s.revenue); s.profit = round2(s.profit); });
    const todaySchedule = db.prepare(`
      SELECT s.*, e.name AS employee_name, j.job_number, j.title AS job_title FROM schedule s
      JOIN employees e ON e.id = s.employee_id LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.date = ? ORDER BY e.name`).all(today());
    const wip = db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status = 'in_progress'`).all();
    wip.forEach(r => { r.financials = jobFinancials(r.id); });
    return json(res, 200, { kpis, series, todaySchedule, wip });
  }

  // ---- reports ----
  if (resource === 'reports' && method === 'GET') {
    const byClient = db.prepare(`
      SELECT c.id, c.name, COUNT(j.id) jobs, COALESCE(SUM(j.sold_price),0) revenue
      FROM clients c LEFT JOIN jobs j ON j.client_id = c.id GROUP BY c.id ORDER BY revenue DESC`).all();
    byClient.forEach(c => {
      const jobs = db.prepare('SELECT id FROM jobs WHERE client_id = ?').all(c.id);
      c.profit = round2(jobs.reduce((s, j) => s + jobFinancials(j.id).profit, 0));
      c.margin_pct = c.revenue > 0 ? round2(c.profit / c.revenue * 100) : 0;
    });
    const jobs = db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id ORDER BY j.id DESC`).all()
      .map(j => ({ job_number: j.job_number, title: j.title, client: j.client_name, status: j.status, ...jobFinancials(j.id) }));
    const labor = db.prepare(`
      SELECT e.id, e.name, e.role, e.hourly_rate FROM employees e WHERE e.active = 1`).all().map(e => {
      const entries = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NOT NULL AND clock_in >= datetime('now','-30 days')`).all(e.id);
      const hours = entries.reduce((s, t) => s + (new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z')) / 3600e3, 0);
      const billable = entries.filter(t => t.job_id).reduce((s, t) => s + (new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z')) / 3600e3, 0);
      return { name: e.name, role: e.role, hours: round2(hours), billable_hours: round2(billable),
        utilization: hours > 0 ? round2(billable / hours * 100) : 0, cost: round2(hours * e.hourly_rate) };
    }).sort((a, b) => b.hours - a.hours);
    const topMaterials = db.prepare(`
      SELECT jm.description, COALESCE(m.name, jm.description) name, SUM(jm.qty) qty, SUM(jm.qty * jm.unit_cost) spend
      FROM job_materials jm LEFT JOIN materials m ON m.id = jm.material_id
      GROUP BY COALESCE(m.id, jm.description) ORDER BY spend DESC LIMIT 10`).all();
    const quotes = db.prepare('SELECT status FROM quotes').all();
    const decided = quotes.filter(q => q.status === 'accepted' || q.status === 'declined');
    return json(res, 200, {
      byClient, jobs, labor, topMaterials,
      winRate: decided.length ? round2(decided.filter(q => q.status === 'accepted').length / decided.length * 100) : null,
      quoteCounts: ['draft', 'sent', 'accepted', 'declined'].map(s => ({ status: s, n: quotes.filter(q => q.status === s).length })),
    });
  }

  // ---- archive & profit search ----
  if (resource === 'search' && method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    const like = `%${q}%`;
    const results = [];
    const wos = q
      ? db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id
          WHERE lower(w.title || ' ' || w.description || ' ' || w.wo_number || ' ' || w.items || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY w.id DESC`).all(like)
      : db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id ORDER BY w.id DESC`).all();
    for (const w of wos) {
      const f = woFinancials(w);
      results.push({ type: 'work_order', id: w.id, number: w.wo_number, title: w.title, client: w.client_name,
        status: w.status, date: (w.completed_at || w.created_at || '').slice(0, 10), items: parseItems(w.items), ...f });
    }
    const jobs = q
      ? db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
          WHERE lower(j.title || ' ' || j.description || ' ' || j.job_number || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY j.id DESC`).all(like)
      : db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id ORDER BY j.id DESC`).all();
    for (const j of jobs) {
      results.push({ type: 'job', id: j.id, number: j.job_number, title: j.title, client: j.client_name,
        status: j.status, date: (j.completed_at || j.created_at || '').slice(0, 10),
        items: db.prepare('SELECT description AS desc, qty, unit_cost FROM job_materials WHERE job_id = ?').all(j.id),
        ...jobFinancials(j.id) });
    }
    if (q) {
      for (const qt of db.prepare(`SELECT qt.*, c.name AS client_name FROM quotes qt LEFT JOIN clients c ON c.id = qt.client_id
          WHERE lower(qt.title || ' ' || qt.description || ' ' || qt.quote_number || ' ' || qt.items || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY qt.id DESC`).all(like)) {
        const t = quoteTotals(qt);
        results.push({ type: 'quote', id: qt.id, number: qt.quote_number, title: qt.title, client: qt.client_name,
          status: qt.status, date: (qt.created_at || '').slice(0, 10), items: parseItems(qt.items),
          sold_price: t.total, total_cost: t.est_cost, profit: round2(t.total - t.est_cost),
          margin_pct: t.total > 0 ? round2((t.total - t.est_cost) / t.total * 100) : 0 });
      }
    }
    results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return json(res, 200, results);
  }

  // ---- insights ----
  if (resource === 'insights' && method === 'GET') {
    const insights = [];
    const cfg = settings();
    const targetMargin = Number(cfg.target_margin_pct || 30);
    for (const j of db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status != 'planned'`).all()) {
      const f = jobFinancials(j.id);
      if (f.sold_price > 0 && f.margin_pct < targetMargin) {
        insights.push({ kind: 'margin', severity: f.margin_pct < 10 ? 'high' : 'medium',
          title: `${j.job_number} ${j.title} is running a ${f.margin_pct}% margin`,
          detail: `Sold at $${f.sold_price.toLocaleString()} with $${f.total_cost.toLocaleString()} in costs so far (target ${targetMargin}%). ${j.status === 'completed' ? 'Use this as a pricing reference next time.' : 'Watch labor hours and change-order any added scope.'}` });
      }
    }
    for (const m of db.prepare(`SELECT * FROM materials WHERE qty_on_hand <= reorder_point`).all()) {
      const used = db.prepare(`SELECT COALESCE(SUM(qty),0) u FROM job_materials WHERE material_id = ? AND created_at >= datetime('now','-90 days')`).get(m.id).u;
      const suggested = Math.max(Math.ceil(m.reorder_point * 1.5 - m.qty_on_hand), Math.ceil(used / 3) || 0, 1);
      insights.push({ kind: 'stock', severity: m.qty_on_hand <= m.reorder_point / 2 ? 'high' : 'medium',
        title: `${m.name} is low: ${m.qty_on_hand} ${m.unit} on hand (reorder at ${m.reorder_point})`,
        detail: `90-day usage: ${used} ${m.unit}. Suggested order: ${suggested} ${m.unit} from ${m.vendor || 'your usual vendor'} (~$${round2(suggested * m.unit_cost).toLocaleString()}).` });
    }
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE status IN ('open','in_progress') AND due_date != '' AND due_date < ?`).all(today())) {
      insights.push({ kind: 'overdue', severity: 'high', title: `${w.wo_number} "${w.title}" is past due (${w.due_date})`,
        detail: `Priority ${w.priority}. Reassign shop time or call the customer with a new date before it becomes a complaint.` });
    }
    for (const qt of db.prepare(`SELECT q.*, c.name AS client_name FROM quotes q LEFT JOIN clients c ON c.id = q.client_id WHERE q.status = 'sent' AND q.created_at < datetime('now','-5 days')`).all()) {
      insights.push({ kind: 'quote', severity: 'medium',
        title: `Quote ${qt.quote_number} to ${qt.client_name || 'client'} has been out ${Math.floor((Date.now() - new Date(qt.created_at.replace(' ', 'T') + 'Z')) / 86400e3)} days`,
        detail: `"${qt.title}" — worth $${quoteTotals(qt).total.toLocaleString()}. Quotes followed up within a week close at roughly double the rate. Call ${qt.client_name || 'them'} today.` });
    }
    const pending = db.prepare(`SELECT COUNT(*) n FROM job_cards WHERE status = 'submitted'`).get().n;
    if (pending) insights.push({ kind: 'cards', severity: 'medium', title: `${pending} field job card${pending > 1 ? 's' : ''} waiting on office review`,
      detail: 'Crew reports sitting unreviewed are hours and materials not yet costed to the job. Approve them to keep job profit accurate.' });
    const all = db.prepare(`SELECT status FROM quotes`).all();
    const decided = all.filter(x => x.status === 'accepted' || x.status === 'declined');
    if (decided.length) {
      const won = decided.filter(x => x.status === 'accepted').length;
      const rate = Math.round(won / decided.length * 100);
      insights.push({ kind: 'winrate', severity: 'info', title: `Quote win rate: ${rate}%`,
        detail: `${won} won of ${decided.length} decided. ${rate > 60 ? 'Strong close rate — you may have room to raise prices.' : rate < 30 ? 'Low close rate — review pricing or qualify leads harder.' : 'Healthy range.'}` });
    }
    const top = db.prepare(`SELECT c.name, SUM(j.sold_price) total FROM jobs j JOIN clients c ON c.id = j.client_id GROUP BY c.id ORDER BY total DESC LIMIT 1`).get();
    if (top) insights.push({ kind: 'client', severity: 'info', title: `Top client: ${top.name} ($${round2(top.total).toLocaleString()} in jobs)`,
      detail: 'Repeat clients cost nothing to win. Schedule a check-in and ask what is on their board for next quarter.' });
    if (!cfg.smtp_host) insights.push({ kind: 'setup', severity: 'info', title: 'Email delivery is not configured yet',
      detail: 'Quotes currently save to the outbox for preview instead of sending. Add your SMTP details in Settings to email proposals straight to customers.' });
    const order = { high: 0, medium: 1, info: 2 };
    insights.sort((a, b) => order[a.severity] - order[b.severity]);
    return json(res, 200, insights);
  }

  // ---- settings ----
  if (resource === 'settings') {
    if (method === 'GET') {
      const s = settings();
      if (s.smtp_pass) s.smtp_pass = '••••••••';    // never echo the stored password
      return json(res, 200, s);
    }
    if (method === 'PUT') {
      const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      for (const [k, v] of Object.entries(body)) {
        if (k === 'seeded') continue;
        if (k === 'smtp_pass' && /^•+$/.test(String(v))) continue; // unchanged masked value
        stmt.run(k, String(v));
      }
      auth.audit(user, 'settings_updated', Object.keys(body).join(', '));
      return json(res, 200, { ok: true });
    }
  }

  // ---- users ----
  if (resource === 'users') {
    if (method === 'GET') {
      return json(res, 200, db.prepare(`SELECT u.id, u.username, u.role, u.employee_id, u.active, u.last_login, e.name AS employee_name
        FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.role, u.username`).all());
    }
    if (method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase();
      if (!username || !body.password) return json(res, 400, { error: 'Username and password are required' });
      if (String(body.password).length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return json(res, 409, { error: 'That username is taken' });
      db.prepare('INSERT INTO users (username, password_hash, role, employee_id) VALUES (?,?,?,?)')
        .run(username, hashPassword(body.password), body.role === 'admin' ? 'admin' : 'crew', body.employee_id || null);
      auth.audit(user, 'user_created', username);
      return json(res, 200, { ok: true });
    }
    if (method === 'PUT' && idOrAction) {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(idOrAction);
      if (!target) return json(res, 404, { error: 'User not found' });
      const admins = db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1`).get().n;
      const demoting = (body.role && body.role !== 'admin') || body.active === 0;
      if (target.role === 'admin' && admins <= 1 && demoting) return json(res, 409, { error: 'This is the last active admin — promote someone else first' });
      if (body.password) {
        if (String(body.password).length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), target.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id); // force re-login everywhere
      }
      if (body.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role === 'admin' ? 'admin' : 'crew', target.id);
      if (body.employee_id !== undefined) db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(body.employee_id || null, target.id);
      if (body.active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(Number(body.active) ? 1 : 0, target.id);
      auth.audit(user, 'user_updated', target.username);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE' && idOrAction) {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(idOrAction);
      if (!target) return json(res, 404, { error: 'User not found' });
      if (target.id === user.id) return json(res, 409, { error: 'You cannot delete your own account' });
      const admins = db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1`).get().n;
      if (target.role === 'admin' && admins <= 1) return json(res, 409, { error: 'This is the last active admin' });
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      auth.audit(user, 'user_deleted', target.username);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'emails' && method === 'GET') {
    return json(res, 200, db.prepare(`SELECT l.*, u.username AS sent_by_name FROM email_log l
      LEFT JOIN users u ON u.id = l.sent_by ORDER BY l.id DESC LIMIT 100`).all());
  }
  if (resource === 'audit' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
  }
  if (resource === 'numbers' && method === 'GET') {
    return json(res, 200, {
      quote: nextNumber('quotes', 'quote_number', 'Q'), job: nextNumber('jobs', 'job_number', 'J'),
      wo: nextNumber('work_orders', 'wo_number', 'WO'), po: nextNumber('purchase_orders', 'po_number', 'PO'),
    });
  }

  // ---- generic CRUD fallback ----
  if (RESOURCES[resource]) {
    const result = crudHandler(resource, method, /^\d+$/.test(idOrAction || '') ? idOrAction : null, body);
    if (result && result.error) return json(res, 404, result);
    return json(res, 200, result);
  }
  return json(res, 404, { error: 'Unknown endpoint' });
}

// ---------------------------------------------------------------- static files
function serveStatic(res, urlPath, fallback) {
  let filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, fallback);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const ASSET = /^\/(css|js|img)\//;

// ---------------------------------------------------------------- request handler
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURIComponent(url.pathname);
  const method = req.method;

  try {
    const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};

    // --- public: customer proposal links ---
    if (urlPath === '/q' || urlPath.startsWith('/q/')) return publicQuoteRoutes(req, res, urlPath, body);

    // --- public: static assets and the login page ---
    if (ASSET.test(urlPath) || urlPath === '/favicon.ico') return serveStatic(res, urlPath, 'index.html');

    // --- auth endpoints ---
    if (urlPath === '/api/auth/login' && method === 'POST') {
      const result = auth.login(body.username, body.password);
      if (!result) { auth.audit(null, 'login_failed', String(body.username || '').slice(0, 40)); return json(res, 401, { error: 'Incorrect username or password' }); }
      const { user, session } = result;
      auth.audit(user, 'login', user.role);
      return json(res, 200, { ok: true, role: user.role, home: user.role === 'admin' ? '/' : '/portal' },
        { 'Set-Cookie': auth.sessionCookie(session.token, session.expires) });
    }
    if (urlPath === '/api/auth/logout' && method === 'POST') {
      auth.logout(req);
      return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }

    const user = auth.currentUser(req);

    if (urlPath === '/api/auth/me' && method === 'GET') {
      if (!user) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, {
        id: user.id, username: user.username, role: user.role,
        employee_id: user.employee_id, name: user.employee_name || user.username, employee_role: user.employee_role,
        company: settings().company_name,
      });
    }
    if (urlPath === '/api/auth/password' && method === 'POST') {
      if (!user) return json(res, 401, { error: 'Not signed in' });
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!require('./auth').verifyPassword(body.current, row.password_hash)) return json(res, 403, { error: 'Current password is incorrect' });
      if (String(body.next || '').length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), user.id);
      auth.audit(user, 'password_changed', '');
      return json(res, 200, { ok: true, message: 'Password updated' });
    }

    // --- login page ---
    if (urlPath === '/login' || urlPath === '/login.html') {
      if (user) return redirect(res, user.role === 'admin' ? '/' : '/portal');
      return serveStatic(res, '/login.html', 'login.html');
    }

    // --- everything past here needs a session ---
    if (!user) {
      if (urlPath.startsWith('/api/')) return json(res, 401, { error: 'Session expired — please sign in again' });
      return redirect(res, '/login');
    }

    // --- crew portal ---
    if (urlPath === '/portal' || urlPath === '/portal.html') return serveStatic(res, '/portal.html', 'portal.html');
    if (urlPath.startsWith('/api/portal/')) return await portalApi(req, res, urlPath.split('/').filter(Boolean), body, user);

    // --- admin-only from here ---
    const isAdmin = user.role === 'admin';
    if (urlPath.startsWith('/api/')) {
      if (!isAdmin) return json(res, 403, { error: 'Admin access required' });
      return await adminApi(req, res, urlPath.split('/').filter(Boolean), body, url.searchParams, user);
    }
    if (urlPath.startsWith('/outbox/')) {
      if (!isAdmin) { res.writeHead(403); return res.end(); }
      const file = path.join(OUTBOX, path.basename(urlPath));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Preview not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!isAdmin) return redirect(res, '/portal');
    return serveStatic(res, urlPath === '/' ? '/index.html' : urlPath, 'index.html');
  } catch (err) {
    console.error(err);
    if (urlPath.startsWith('/api/')) return json(res, 500, { error: err.message || 'Server error' });
    return html(res, 500, '<body style="font-family:system-ui;padding:40px">Server error</body>');
  }
});

server.listen(PORT, () => {
  console.log(`\n  DTS Command Center → http://localhost:${PORT}`);
  console.log(`  Office console: /   ·  Crew portal: /portal  ·  Sign in: /login\n`);
});
