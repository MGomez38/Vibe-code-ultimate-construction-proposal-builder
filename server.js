/**
 * DTS Command Center — zero-dependency Node.js server.
 * Serves the SPA from /public and a JSON REST API under /api.
 * Run: node server.js  (Node >= 22.5, uses built-in node:sqlite)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- utils
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const parseItems = s => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

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
  const cost = itemsCost(items) + labor * 0.6; // internal labor burden estimate vs billed rate
  return { materials: round2(materials), labor: round2(labor), subtotal: round2(subtotal), markup: round2(markup), tax: round2(tax), total: round2(total), est_cost: round2(cost) };
}

function woFinancials(wo) {
  const items = parseItems(wo.items);
  const materialCost = itemsCost(items);
  const materialPrice = itemsPrice(items);
  const laborCost = (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0) * 0.55; // internal cost portion of shop rate
  const totalCost = round2(materialCost + laborCost);
  const sold = Number(wo.sold_price) || round2(materialPrice + (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0));
  const profit = round2(sold - totalCost);
  const marginPct = sold > 0 ? round2(profit / sold * 100) : 0;
  return { material_cost: round2(materialCost), labor_cost: round2(laborCost), total_cost: totalCost, sold_price: round2(sold), profit, margin_pct: marginPct };
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
  for (const r of rows) {
    const m = /(\d+)$/.exec(r.n || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

// ---------------------------------------------------------------- generic CRUD config
const RESOURCES = {
  clients:  { table: 'clients',  fields: ['name', 'contact', 'phone', 'email', 'address', 'notes'] },
  employees:{ table: 'employees', fields: ['name', 'role', 'phone', 'email', 'hourly_rate', 'pin', 'active'] },
  materials:{ table: 'materials', fields: ['sku', 'name', 'category', 'unit', 'qty_on_hand', 'reorder_point', 'unit_cost', 'sell_price', 'location', 'vendor'] },
  quotes:   { table: 'quotes',   fields: ['quote_number', 'client_id', 'title', 'description', 'items', 'labor_hours', 'labor_rate', 'markup_pct', 'tax_pct', 'status', 'valid_until', 'notes'] },
  jobs:     { table: 'jobs',     fields: ['job_number', 'client_id', 'quote_id', 'title', 'description', 'address', 'status', 'sold_price', 'start_date', 'end_date', 'foreman_id', 'notes', 'completed_at'] },
  workorders:{ table: 'work_orders', fields: ['wo_number', 'job_id', 'client_id', 'title', 'description', 'wo_type', 'priority', 'status', 'assigned_to', 'due_date', 'items', 'labor_hours', 'labor_rate', 'sold_price', 'notes', 'completed_at'] },
  purchaseorders: { table: 'purchase_orders', fields: ['po_number', 'vendor', 'status', 'items', 'job_id', 'expected_date', 'notes'] },
  schedule: { table: 'schedule', fields: ['employee_id', 'job_id', 'date', 'shift', 'notes'] },
};

function sanitize(cfg, body) {
  const out = {};
  for (const f of cfg.fields) {
    if (body[f] !== undefined) {
      out[f] = (typeof body[f] === 'object' && body[f] !== null) ? JSON.stringify(body[f]) : body[f];
    }
  }
  return out;
}

function crudHandler(resource, method, id, body) {
  const cfg = RESOURCES[resource];
  if (!cfg) return null;
  const t = cfg.table;
  if (method === 'GET' && !id) return db.prepare(`SELECT * FROM ${t} ORDER BY id DESC`).all();
  if (method === 'GET' && id) return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id) || { error: 'Not found' };
  if (method === 'POST') {
    const data = sanitize(cfg, body);
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    const stmt = db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
    const info = stmt.run(...keys.map(k => data[k]));
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(info.lastInsertRowid);
  }
  if (method === 'PUT' && id) {
    const data = sanitize(cfg, body);
    const keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    db.prepare(`UPDATE ${t} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => data[k]), id);
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
  }
  if (method === 'DELETE' && id) {
    db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id);
    return { ok: true };
  }
  throw new Error('Unsupported');
}

// ---------------------------------------------------------------- API routes
async function handleApi(req, res, urlPath, query) {
  const method = req.method;
  const parts = urlPath.split('/').filter(Boolean); // ['api', resource, id?, action?]
  const resource = parts[1];
  const idOrAction = parts[2];
  const action = parts[3];
  const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};

  // ---- time clock ----
  if (resource === 'clock') {
    if (idOrAction === 'status' && method === 'GET') {
      const open = db.prepare(`
        SELECT t.*, e.name AS employee_name, j.job_number, j.title AS job_title
        FROM time_entries t
        JOIN employees e ON e.id = t.employee_id
        LEFT JOIN jobs j ON j.id = t.job_id
        WHERE t.clock_out IS NULL ORDER BY t.clock_in`).all();
      return json(res, 200, open);
    }
    if (idOrAction === 'in' && method === 'POST') {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND active = 1').get(body.employee_id);
      if (!emp) return json(res, 404, { error: 'Employee not found' });
      if (String(emp.pin) !== String(body.pin)) return json(res, 403, { error: 'Wrong PIN' });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(emp.id);
      if (open && !body.job_id) return json(res, 409, { error: `${emp.name} is already clocked in` });
      if (open && body.job_id) {
        // switching to a job: close the open entry, open a job entry
        db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      }
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

  // ---- timesheets ----
  if (resource === 'timesheets' && method === 'GET') {
    const from = query.get('from') || today();
    const to = query.get('to') || today();
    const rows = db.prepare(`
      SELECT t.*, e.name AS employee_name, e.hourly_rate, j.job_number, j.title AS job_title
      FROM time_entries t
      JOIN employees e ON e.id = t.employee_id
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE date(t.clock_in) BETWEEN ? AND ?
      ORDER BY t.clock_in DESC`).all(from, to);
    for (const r of rows) {
      r.hours = r.clock_out
        ? round2((new Date(r.clock_out.replace(' ', 'T') + 'Z') - new Date(r.clock_in.replace(' ', 'T') + 'Z')) / 3600e3)
        : null;
      r.labor_cost = r.hours !== null ? round2(r.hours * r.hourly_rate) : null;
      delete r.hourly_rate;
    }
    return json(res, 200, rows);
  }

  // ---- quotes: totals + convert ----
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
      const w = db.prepare(`INSERT INTO work_orders (wo_number, job_id, client_id, title, description, wo_type, status, items, labor_hours, labor_rate, sold_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(woNumber, jobId, q.client_id, q.title, q.description, 'Shop', 'open', q.items, q.labor_hours, q.labor_rate, totals.total);
      woId = w.lastInsertRowid;
    }
    db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`).run(now(), q.id);
    return json(res, 200, { ok: true, job_id: jobId, job_number: jobNumber, work_order_id: woId });
  }
  if (resource === 'quotes' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`
      SELECT q.*, c.name AS client_name FROM quotes q
      LEFT JOIN clients c ON c.id = q.client_id ORDER BY q.id DESC`).all();
    rows.forEach(r => { r.totals = quoteTotals(r); });
    return json(res, 200, rows);
  }

  // ---- jobs: enriched list & detail ----
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
    const job = db.prepare(`
      SELECT j.*, c.name AS client_name, e.name AS foreman_name FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN employees e ON e.id = j.foreman_id WHERE j.id = ?`).get(idOrAction);
    if (!job) return json(res, 404, { error: 'Not found' });
    job.financials = jobFinancials(job.id);
    job.materials = db.prepare(`SELECT jm.*, m.name AS material_name, m.unit FROM job_materials jm LEFT JOIN materials m ON m.id = jm.material_id WHERE jm.job_id = ?`).all(job.id);
    job.work_orders = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(job.id);
    job.work_orders.forEach(w => { w.financials = woFinancials(w); });
    job.time = db.prepare(`
      SELECT t.*, e.name AS employee_name FROM time_entries t JOIN employees e ON e.id = t.employee_id
      WHERE t.job_id = ? ORDER BY t.clock_in DESC LIMIT 50`).all(job.id);
    return json(res, 200, job);
  }
  if (resource === 'jobs' && idOrAction && action === 'materials' && method === 'POST') {
    // log material usage against a job; deducts inventory when linked to a material
    const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(idOrAction);
    if (!job) return json(res, 404, { error: 'Job not found' });
    let desc = body.description || '', cost = Number(body.unit_cost) || 0;
    if (body.material_id) {
      const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(body.material_id);
      if (m) {
        desc = desc || m.name;
        cost = cost || m.unit_cost;
        db.prepare('UPDATE materials SET qty_on_hand = MAX(0, qty_on_hand - ?) WHERE id = ?').run(Number(body.qty) || 0, m.id);
      }
    }
    db.prepare('INSERT INTO job_materials (job_id, material_id, description, qty, unit_cost) VALUES (?,?,?,?,?)')
      .run(idOrAction, body.material_id || null, desc, Number(body.qty) || 1, cost);
    return json(res, 200, { ok: true });
  }

  // ---- work orders: enriched ----
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

  // ---- purchase orders: receive into inventory ----
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
    return json(res, 200, { ok: true });
  }

  // ---- dashboard ----
  if (resource === 'dashboard' && method === 'GET') {
    const activeJobs = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status IN ('planned','in_progress','on_hold')`).get().n;
    const openWOs = db.prepare(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress')`).get().n;
    const rushWOs = db.prepare(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress') AND priority = 'rush'`).get().n;
    const onClock = db.prepare(`SELECT COUNT(*) n FROM time_entries WHERE clock_out IS NULL`).get().n;
    const pendingQuotes = db.prepare(`SELECT COUNT(*) n FROM quotes WHERE status IN ('draft','sent')`).get().n;
    const quoteValue = db.prepare(`SELECT * FROM quotes WHERE status IN ('draft','sent')`).all()
      .reduce((s, q) => s + quoteTotals(q).total, 0);
    const lowStock = db.prepare(`SELECT COUNT(*) n FROM materials WHERE qty_on_hand <= reorder_point`).get().n;
    const openPOs = db.prepare(`SELECT COUNT(*) n FROM purchase_orders WHERE status = 'ordered'`).get().n;

    // trailing-6-month completed revenue/profit (jobs + standalone work orders)
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }
    const series = months.map(m => ({ month: m, revenue: 0, profit: 0 }));
    for (const j of db.prepare(`SELECT * FROM jobs WHERE status = 'completed' AND completed_at IS NOT NULL`).all()) {
      const m = j.completed_at.slice(0, 7);
      const slot = series.find(s => s.month === m);
      if (slot) { const f = jobFinancials(j.id); slot.revenue += f.sold_price; slot.profit += f.profit; }
    }
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE job_id IS NULL AND completed_at IS NOT NULL`).all()) {
      const m = w.completed_at.slice(0, 7);
      const slot = series.find(s => s.month === m);
      if (slot) { const f = woFinancials(w); slot.revenue += f.sold_price; slot.profit += f.profit; }
    }
    series.forEach(s => { s.revenue = round2(s.revenue); s.profit = round2(s.profit); });

    const todaySchedule = db.prepare(`
      SELECT s.*, e.name AS employee_name, j.job_number, j.title AS job_title FROM schedule s
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.date = ? ORDER BY e.name`).all(today());

    const wip = db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status = 'in_progress'`).all();
    wip.forEach(r => { r.financials = jobFinancials(r.id); });

    return json(res, 200, {
      kpis: { activeJobs, openWOs, rushWOs, onClock, pendingQuotes, quoteValue: round2(quoteValue), lowStock, openPOs },
      series, todaySchedule, wip,
    });
  }

  // ---- archive & profit search ----
  if (resource === 'search' && method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    const like = `%${q}%`;
    const results = [];
    const wos = q
      ? db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id
          WHERE lower(w.title || ' ' || w.description || ' ' || w.wo_number || ' ' || w.items || ' ' || COALESCE(c.name,'')) LIKE ?
          ORDER BY w.id DESC`).all(like)
      : db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id ORDER BY w.id DESC`).all();
    for (const w of wos) {
      const f = woFinancials(w);
      results.push({
        type: 'work_order', id: w.id, number: w.wo_number, title: w.title, client: w.client_name,
        status: w.status, date: (w.completed_at || w.created_at || '').slice(0, 10),
        items: parseItems(w.items), sold_price: f.sold_price, total_cost: f.total_cost,
        profit: f.profit, margin_pct: f.margin_pct,
      });
    }
    const jobs = q
      ? db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
          WHERE lower(j.title || ' ' || j.description || ' ' || j.job_number || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY j.id DESC`).all(like)
      : db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id ORDER BY j.id DESC`).all();
    for (const j of jobs) {
      const f = jobFinancials(j.id);
      results.push({
        type: 'job', id: j.id, number: j.job_number, title: j.title, client: j.client_name,
        status: j.status, date: (j.completed_at || j.created_at || '').slice(0, 10),
        items: db.prepare('SELECT description AS desc, qty, unit_cost FROM job_materials WHERE job_id = ?').all(j.id),
        sold_price: f.sold_price, total_cost: f.total_cost, profit: f.profit, margin_pct: f.margin_pct,
      });
    }
    const quotes = q
      ? db.prepare(`SELECT qt.*, c.name AS client_name FROM quotes qt LEFT JOIN clients c ON c.id = qt.client_id
          WHERE lower(qt.title || ' ' || qt.description || ' ' || qt.quote_number || ' ' || qt.items || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY qt.id DESC`).all(like)
      : [];
    for (const qt of quotes) {
      const t = quoteTotals(qt);
      results.push({
        type: 'quote', id: qt.id, number: qt.quote_number, title: qt.title, client: qt.client_name,
        status: qt.status, date: (qt.created_at || '').slice(0, 10),
        items: parseItems(qt.items), sold_price: t.total, total_cost: t.est_cost,
        profit: round2(t.total - t.est_cost), margin_pct: t.total > 0 ? round2((t.total - t.est_cost) / t.total * 100) : 0,
      });
    }
    results.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return json(res, 200, results);
  }

  // ---- AI insights ----
  if (resource === 'insights' && method === 'GET') {
    const insights = [];
    const targetMargin = Number(db.prepare(`SELECT value FROM settings WHERE key='target_margin_pct'`).get()?.value || 30);

    // margin watch on active + completed jobs
    for (const j of db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status != 'planned'`).all()) {
      const f = jobFinancials(j.id);
      if (f.sold_price > 0 && f.margin_pct < targetMargin) {
        insights.push({
          kind: 'margin', severity: f.margin_pct < 10 ? 'high' : 'medium',
          title: `${j.job_number} ${j.title} is running a ${f.margin_pct}% margin`,
          detail: `Sold at $${f.sold_price.toLocaleString()} with $${f.total_cost.toLocaleString()} in costs so far (target ${targetMargin}%). ${j.status === 'completed' ? 'Use this as a pricing reference next time.' : 'Watch labor hours and change-order any added scope.'}`,
        });
      }
    }
    // reorder suggestions with usage-informed quantity
    for (const m of db.prepare(`SELECT * FROM materials WHERE qty_on_hand <= reorder_point`).all()) {
      const used = db.prepare(`SELECT COALESCE(SUM(qty),0) u FROM job_materials WHERE material_id = ? AND created_at >= datetime('now','-90 days')`).get(m.id).u;
      const suggested = Math.max(Math.ceil(m.reorder_point * 1.5 - m.qty_on_hand), Math.ceil(used / 3) || 0, 1);
      insights.push({
        kind: 'stock', severity: m.qty_on_hand <= m.reorder_point / 2 ? 'high' : 'medium',
        title: `${m.name} is low: ${m.qty_on_hand} ${m.unit} on hand (reorder at ${m.reorder_point})`,
        detail: `90-day usage: ${used} ${m.unit}. Suggested order: ${suggested} ${m.unit} from ${m.vendor || 'your usual vendor'} (~$${round2(suggested * m.unit_cost).toLocaleString()}).`,
      });
    }
    // overdue work orders
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE status IN ('open','in_progress') AND due_date != '' AND due_date < ?`).all(today())) {
      insights.push({
        kind: 'overdue', severity: 'high',
        title: `${w.wo_number} "${w.title}" is past due (${w.due_date})`,
        detail: `Priority ${w.priority}. Reassign shop time or call the customer with a new date before it becomes a complaint.`,
      });
    }
    // stale quotes
    for (const qt of db.prepare(`SELECT q.*, c.name AS client_name FROM quotes q LEFT JOIN clients c ON c.id = q.client_id WHERE q.status = 'sent' AND q.created_at < datetime('now','-5 days')`).all()) {
      insights.push({
        kind: 'quote', severity: 'medium',
        title: `Quote ${qt.quote_number} to ${qt.client_name || 'client'} has been out ${Math.floor((Date.now() - new Date(qt.created_at.replace(' ', 'T') + 'Z')) / 86400e3)} days`,
        detail: `"${qt.title}" — worth $${quoteTotals(qt).total.toLocaleString()}. Quotes followed up within a week close at roughly double the rate. Call ${qt.client_name || 'them'} today.`,
      });
    }
    // win rate + top client
    const all = db.prepare(`SELECT status FROM quotes`).all();
    const decided = all.filter(x => x.status === 'accepted' || x.status === 'declined');
    if (decided.length) {
      const rate = Math.round(decided.filter(x => x.status === 'accepted').length / decided.length * 100);
      insights.push({ kind: 'winrate', severity: 'info', title: `Quote win rate: ${rate}%`, detail: `${decided.filter(x => x.status === 'accepted').length} won of ${decided.length} decided. ${rate > 60 ? 'Strong close rate — you may have room to raise prices.' : rate < 30 ? 'Low close rate — review pricing or qualify leads harder.' : 'Healthy range.'}` });
    }
    const top = db.prepare(`
      SELECT c.name, SUM(j.sold_price) total FROM jobs j JOIN clients c ON c.id = j.client_id
      GROUP BY c.id ORDER BY total DESC LIMIT 1`).get();
    if (top) insights.push({ kind: 'client', severity: 'info', title: `Top client: ${top.name} ($${round2(top.total).toLocaleString()} in jobs)`, detail: 'Repeat clients cost nothing to win. Schedule a check-in and ask what is on their board for next quarter.' });

    const order = { high: 0, medium: 1, info: 2 };
    insights.sort((a, b) => order[a.severity] - order[b.severity]);
    return json(res, 200, insights);
  }

  if (resource === 'settings' && method === 'GET') {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return json(res, 200, Object.fromEntries(rows.map(r => [r.key, r.value])));
  }

  if (resource === 'numbers' && method === 'GET') {
    return json(res, 200, {
      quote: nextNumber('quotes', 'quote_number', 'Q'),
      job: nextNumber('jobs', 'job_number', 'J'),
      wo: nextNumber('work_orders', 'wo_number', 'WO'),
      po: nextNumber('purchase_orders', 'po_number', 'PO'),
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

// ---------------------------------------------------------------- static + server
function serveStatic(res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURIComponent(url.pathname);
  try {
    if (urlPath.startsWith('/api/')) return await handleApi(req, res, urlPath, url.searchParams);
    return serveStatic(res, urlPath);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  DTS Command Center running → http://localhost:${PORT}\n`);
});
