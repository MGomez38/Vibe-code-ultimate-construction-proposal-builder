/**
 * DTS Command Center — zero-dependency Node.js server.
 *
 * Surfaces:
 *   /          Command Center  (admin — full office console)
 *   /portal    Crew Portal     (signed-in employee — mobile, offline-capable, no financials)
 *   /q/:tok    Public proposal      (customer approves a quote)
 *   /co/:tok   Public change order  (customer approves added scope)
 *   /inv/:tok  Public invoice       (customer views what they owe)
 *
 * Run: node server.js   (Node >= 22.5, uses built-in node:sqlite)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const { makeAuth, hashPassword, verifyPassword } = require('./auth');
const { sendMail, OUTBOX } = require('./mailer');
const { readUpload, storeFile, removeFile, UPLOAD_DIR } = require('./lib/uploads');
const backup = require('./lib/backup');
const T = require('./templates');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const auth = makeAuth(db);
const F = require('./lib/finance')(db);
const { docTotals, invoiceTotals, woFinancials, jobFinancials, changeOrderValue, round2, parseItems } = F;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
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
function text(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
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
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const settings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
const token = () => crypto.randomBytes(18).toString('hex');
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

function nextNumber(table, column, prefix) {
  const rows = db.prepare(`SELECT ${column} AS n FROM ${table}`).all();
  let max = 0;
  for (const r of rows) { const m = /(\d+)$/.exec(r.n || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${max + 1}`;
}
function paidOn(invoiceId) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(invoiceId).s;
}
function attachmentsFor(entityType, entityId) {
  return db.prepare('SELECT id, filename, original_name, mime, size, caption, created_at FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY id').all(entityType, entityId);
}

// ---------------------------------------------------------------- document versioning
/**
 * What the customer was actually sent, frozen at send time.
 * Editing a quote afterwards must not change the document they are reading —
 * or the signature they leave against it. Re-sending cuts a new revision.
 */
const SNAPSHOT_FIELDS = ['title', 'description', 'reason', 'labor_hours', 'labor_rate',
  'markup_pct', 'tax_pct', 'schedule_days', 'valid_until'];

function snapshotOf(doc) {
  const snap = { revision: Number(doc.revision) || 1, frozen_at: now(), items: parseItems(doc.items) };
  for (const f of SNAPSHOT_FIELDS) if (doc[f] !== undefined) snap[f] = doc[f];
  return JSON.stringify(snap);
}

/** True when the live record no longer matches what was sent. */
function hasDrift(doc) {
  if (!doc.sent_snapshot) return false;
  try {
    const sent = JSON.parse(doc.sent_snapshot);
    if (JSON.stringify(sent.items) !== JSON.stringify(parseItems(doc.items))) return true;
    return SNAPSHOT_FIELDS.some(f => doc[f] !== undefined && String(sent[f] ?? '') !== String(doc[f] ?? ''));
  } catch { return false; }
}

/** The document as the customer sees it: the frozen copy when one exists. */
function frozenView(doc) {
  if (!doc.sent_snapshot) return doc;
  try { return { ...doc, ...JSON.parse(doc.sent_snapshot) }; } catch { return doc; }
}

/** Freeze a document for sending, cutting a new revision if it changed since last time. */
function freezeForSend(table, doc) {
  if (doc.sent_snapshot && hasDrift(doc)) doc.revision = (Number(doc.revision) || 1) + 1;
  doc.sent_snapshot = snapshotOf(doc);
  db.prepare(`UPDATE ${table} SET sent_snapshot = ?, revision = ? WHERE id = ?`)
    .run(doc.sent_snapshot, doc.revision || 1, doc.id);
  return doc;
}

function quoteContext(q, { asSent = false } = {}) {
  const view = asSent ? frozenView(q) : q;
  return {
    quote: view, client: q.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id) : null,
    company: settings(), totals: docTotals(view), items: parseItems(view.items),
  };
}
function coContext(co, { asSent = false } = {}) {
  const view = asSent ? frozenView(co) : co;
  return {
    co: view, job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(co.job_id),
    client: co.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(co.client_id) : null,
    company: settings(), totals: docTotals(view), items: parseItems(view.items),
  };
}
function invContext(inv) {
  const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_on').all(inv.id);
  return {
    inv, job: inv.job_id ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(inv.job_id) : null,
    client: inv.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id) : null,
    company: settings(), totals: invoiceTotals(inv, paidOn(inv.id)), items: parseItems(inv.items), payments,
  };
}

/** Shared "email a customer document" pipeline used by quotes, COs and invoices. */
async function deliver({ to, subject, html: body, text: plain, kind, relatedType, relatedId, user }) {
  const cfg = settings();
  let result, status = 'sent', error = '';
  try {
    result = await sendMail(
      { host: cfg.smtp_host, port: cfg.smtp_port, user: cfg.smtp_user, pass: cfg.smtp_pass, secure: cfg.smtp_secure === '1', from: cfg.mail_from },
      { to, subject, replyTo: cfg.company_email, html: body, text: plain });
    status = result.status;
  } catch (e) { status = 'failed'; error = e.message; }
  db.prepare(`INSERT INTO email_log (to_email, subject, kind, related_type, related_id, status, error, preview_file, sent_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(to, subject, kind, relatedType, relatedId, status, error, result?.file || '', user?.id || null);
  return { status, error, preview: result?.file ? `/outbox/${result.file}` : null };
}
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());

// ---------------------------------------------------------------- generic CRUD (admin)
const RESOURCES = {
  clients:   { table: 'clients',   fields: ['name', 'contact', 'phone', 'email', 'address', 'notes'] },
  employees: { table: 'employees', fields: ['name', 'role', 'phone', 'email', 'hourly_rate', 'pin', 'active', 'classification', 'fringe_rate'] },
  materials: { table: 'materials', fields: ['sku', 'name', 'category', 'unit', 'qty_on_hand', 'reorder_point', 'unit_cost', 'sell_price', 'location', 'vendor'] },
  quotes:    { table: 'quotes',    fields: ['quote_number', 'client_id', 'title', 'description', 'items', 'labor_hours', 'labor_rate', 'markup_pct', 'tax_pct', 'status', 'valid_until', 'notes'] },
  jobs:      { table: 'jobs',      fields: ['job_number', 'client_id', 'quote_id', 'title', 'description', 'address', 'status', 'sold_price', 'start_date', 'end_date', 'foreman_id', 'notes', 'completed_at', 'prevailing_wage', 'est_labor_hours'] },
  workorders:{ table: 'work_orders', fields: ['wo_number', 'job_id', 'client_id', 'title', 'description', 'wo_type', 'priority', 'status', 'assigned_to', 'due_date', 'items', 'labor_hours', 'labor_rate', 'sold_price', 'notes', 'completed_at'] },
  purchaseorders: { table: 'purchase_orders', fields: ['po_number', 'vendor', 'status', 'items', 'job_id', 'expected_date', 'notes'] },
  schedule:  { table: 'schedule',  fields: ['employee_id', 'job_id', 'date', 'shift', 'notes'] },
  jobcards:  { table: 'job_cards', fields: ['job_id', 'employee_id', 'work_date', 'hours', 'work_performed', 'materials_used', 'issues', 'status'] },
  changeorders: { table: 'change_orders', fields: ['co_number', 'job_id', 'client_id', 'title', 'description', 'reason', 'items', 'labor_hours', 'labor_rate', 'markup_pct', 'tax_pct', 'schedule_days', 'status', 'source_card_id'] },
  invoices:  { table: 'invoices',  fields: ['invoice_number', 'job_id', 'client_id', 'invoice_type', 'description', 'items', 'tax_pct', 'retainage_pct', 'status', 'issue_date', 'due_date', 'terms_days', 'notes'] },
  payments:  { table: 'payments',  fields: ['invoice_id', 'amount', 'method', 'reference', 'received_on', 'notes'] },
  subcontractors: { table: 'subcontractors', fields: ['name', 'trade', 'contact', 'phone', 'email', 'license_number', 'notes', 'active'] },
  subdocuments: { table: 'sub_documents', fields: ['sub_id', 'doc_type', 'carrier', 'policy_number', 'issued_on', 'expires_on', 'notes'] },
  jobsubs:   { table: 'job_subs',  fields: ['job_id', 'sub_id', 'scope', 'contract_amount'] },
};

function sanitize(cfg, body) {
  const out = {};
  for (const f of cfg.fields) {
    if (body[f] !== undefined) out[f] = (typeof body[f] === 'object' && body[f] !== null) ? JSON.stringify(body[f]) : body[f];
  }
  return out;
}
function crudHandler(resource, method, id, body) {
  const cfg = RESOURCES[resource], t = cfg.table;
  if (method === 'GET' && !id) return db.prepare(`SELECT * FROM ${t} ORDER BY id DESC`).all();
  if (method === 'GET' && id) return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id) || { error: 'Not found' };
  if (method === 'POST') {
    const data = sanitize(cfg, body), keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    const info = db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => data[k]));
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(info.lastInsertRowid);
  }
  if (method === 'PUT' && id) {
    const data = sanitize(cfg, body), keys = Object.keys(data);
    if (!keys.length) throw new Error('No valid fields');
    db.prepare(`UPDATE ${t} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => data[k]), id);
    return db.prepare(`SELECT * FROM ${t} WHERE id = ?`).get(id);
  }
  if (method === 'DELETE' && id) { db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id); return { ok: true }; }
  throw new Error('Unsupported');
}

// ---------------------------------------------------------------- public customer routes
function publicRoutes(req, res, urlPath, body) {
  const [, kind, tok, action] = urlPath.split('/');

  if (kind === 'q') {
    const q = db.prepare(`SELECT * FROM quotes WHERE public_token = ? AND public_token != ''`).get(tok);
    if (!q) return notFoundDoc(res, 'Proposal');
    if (action === 'respond' && req.method === 'POST') {
      const decision = body.decision === 'accepted' ? 'accepted' : 'declined';
      // record which revision they actually signed, not whatever the office edited since
      db.prepare(`UPDATE quotes SET status = ?, responded_at = ?, client_signature = ?, approved_revision = ?, updated_at = ? WHERE id = ?`)
        .run(decision, now(), String(body.signature || '').slice(0, 120), frozenView(q).revision || 1, now(), q.id);
      auth.audit(null, 'quote_' + decision, `${q.quote_number} rev ${frozenView(q).revision || 1} by client${body.signature ? ` (${body.signature})` : ''}`);
      const fresh = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
      return html(res, 200, T.quotePage(quoteContext(fresh, { asSent: true }), { token: tok, responded: decision }));
    }
    return html(res, 200, T.quotePage(quoteContext(q, { asSent: true }), { token: tok }));
  }

  if (kind === 'co') {
    const co = db.prepare(`SELECT * FROM change_orders WHERE public_token = ? AND public_token != ''`).get(tok);
    if (!co) return notFoundDoc(res, 'Change order');
    if (action === 'respond' && req.method === 'POST') {
      const decision = body.decision === 'approved' ? 'approved' : 'declined';
      db.prepare(`UPDATE change_orders SET status = ?, responded_at = ?, client_signature = ?, approved_revision = ? WHERE id = ?`)
        .run(decision, now(), String(body.signature || '').slice(0, 120), frozenView(co).revision || 1, co.id);
      // an approved change order extends the schedule as well as the contract
      if (decision === 'approved' && Number(co.schedule_days)) {
        const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(co.job_id);
        if (job && job.end_date) db.prepare('UPDATE jobs SET end_date = ? WHERE id = ?').run(addDays(job.end_date, Number(co.schedule_days)), job.id);
      }
      auth.audit(null, 'change_order_' + decision, `${co.co_number} by client${body.signature ? ` (${body.signature})` : ''}`);
      const freshCo = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(co.id);
      return html(res, 200, T.changeOrderPage(coContext(freshCo, { asSent: true }), { token: tok, responded: decision }));
    }
    return html(res, 200, T.changeOrderPage(coContext(co, { asSent: true }), { token: tok }));
  }

  if (kind === 'inv') {
    const inv = db.prepare(`SELECT * FROM invoices WHERE public_token = ? AND public_token != ''`).get(tok);
    if (!inv) return notFoundDoc(res, 'Invoice');
    return html(res, 200, T.invoicePage(invContext(inv)));
  }
  return notFoundDoc(res, 'Document');
}
function notFoundDoc(res, what) {
  return html(res, 404, `<body style="font-family:system-ui;padding:60px;text-align:center"><h2>${what} not found</h2><p>This link may have expired. Please contact us for a new copy.</p></body>`);
}

// ---------------------------------------------------------------- payment webhook
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

/**
 * Verify a Stripe webhook signature.
 * Header looks like: t=1699999999,v1=<hex hmac>[,v1=<older hex>]
 * The signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint secret.
 */
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!secret) return { ok: false, error: 'No webhook secret configured' };
  const parts = Object.create(null);
  const v1 = [];
  for (const piece of String(header || '').split(',')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const k = piece.slice(0, i).trim(), v = piece.slice(i + 1).trim();
    if (k === 'v1') v1.push(v); else parts[k] = v;
  }
  if (!parts.t || !v1.length) return { ok: false, error: 'Malformed signature header' };
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > toleranceSec) return { ok: false, error: 'Signature timestamp outside tolerance' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`, 'utf8').digest();
  const match = v1.some(sig => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, error: 'Signature mismatch' };
}

/** Record a payment sent by the processor, matched to an invoice and de-duplicated. */
function applyWebhookPayment({ externalId, amount, reference, invoiceNumber, invoiceId, method = 'card' }) {
  if (!(amount > 0)) return { skipped: 'no amount' };
  if (externalId && db.prepare('SELECT id FROM payments WHERE external_id = ?').get(externalId)) return { skipped: 'already recorded' };
  const inv = invoiceId ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId)
    : invoiceNumber ? db.prepare('SELECT * FROM invoices WHERE invoice_number = ?').get(invoiceNumber) : null;
  if (!inv) return { skipped: `no invoice matched (${invoiceNumber || invoiceId || 'none supplied'})` };
  db.prepare('INSERT INTO payments (invoice_id, amount, method, reference, received_on, notes, external_id) VALUES (?,?,?,?,?,?,?)')
    .run(inv.id, round2(amount), method, reference || '', today(), 'Recorded automatically from payment processor', externalId || '');
  const t = invoiceTotals(inv, paidOn(inv.id));
  if (t.balance <= 0.005) db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).run(inv.id);
  else if (inv.status === 'draft') db.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).run(inv.id);
  auth.audit(null, 'payment_webhook', `${T.money(amount)} on ${inv.invoice_number} (${externalId || 'no id'})`);
  return { ok: true, invoice: inv.invoice_number, balance: t.balance };
}

async function stripeWebhook(req, res) {
  const raw = await readRaw(req);
  const cfg = settings();
  const check = verifyStripeSignature(raw, req.headers['stripe-signature'], cfg.stripe_webhook_secret);
  if (!check.ok) {
    auth.audit(null, 'payment_webhook_rejected', check.error);
    return json(res, 400, { error: check.error });
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

  const obj = event?.data?.object || {};
  const meta = obj.metadata || {};
  // Stripe reports money in the smallest currency unit
  const amount = (obj.amount_received ?? obj.amount_total ?? obj.amount_paid ?? obj.amount ?? 0) / 100;
  let result = { skipped: `unhandled event ${event?.type}` };
  if (['checkout.session.completed', 'payment_intent.succeeded', 'charge.succeeded'].includes(event?.type)) {
    result = applyWebhookPayment({
      externalId: obj.id, amount,
      reference: obj.payment_intent || obj.id || '',
      invoiceNumber: meta.invoice_number || obj.client_reference_id || null,
      invoiceId: meta.invoice_id ? Number(meta.invoice_id) : null,
    });
  }
  return json(res, 200, { received: true, ...result });
}

// ---------------------------------------------------------------- crew portal API
async function portalApi(req, res, parts, body, user, url) {
  const section = parts[2];
  const empId = user.employee_id;
  if (!empId) return json(res, 403, { error: 'This login is not linked to an employee record' });

  const openEntry = () => db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(empId);

  /** Clock actions are shared by the live buttons and the offline sync queue. */
  function clockIn({ job_id, at, client_ref, notes }) {
    if (client_ref && db.prepare('SELECT id FROM time_entries WHERE client_ref = ?').get(client_ref)) return { ok: true, deduped: true };
    const stamp = safeStamp(at);
    const open = openEntry();
    if (open && !job_id) return { error: 'You are already clocked in' };
    if (open) db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(stamp, open.id);
    db.prepare('INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, notes, client_ref) VALUES (?,?,?,?,?,?)')
      .run(empId, job_id || null, job_id ? 'job' : 'shift', stamp, notes || '', client_ref || '');
    return { ok: true, message: job_id ? 'Clocked onto job' : 'Clocked in' };
  }
  function clockOut({ at }) {
    const open = openEntry();
    if (!open) return { error: 'You are not clocked in' };
    db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(safeStamp(at), open.id);
    return { ok: true, message: 'Clocked out — nice work' };
  }
  function saveCard(b) {
    if (b.client_ref && db.prepare('SELECT id FROM job_cards WHERE client_ref = ?').get(b.client_ref)) return { ok: true, deduped: true };
    if (!b.work_performed) return { error: 'Describe the work performed' };
    const info = db.prepare(`INSERT INTO job_cards (job_id, employee_id, work_date, hours, work_performed, materials_used, issues, client_ref)
      VALUES (?,?,?,?,?,?,?,?)`).run(b.job_id || null, empId, b.work_date || today(), Number(b.hours) || 0,
      b.work_performed, b.materials_used || '', b.issues || '', b.client_ref || '');
    return { ok: true, id: info.lastInsertRowid, message: 'Job card submitted to the office' };
  }

  if (section === 'summary' && req.method === 'GET') {
    const open = db.prepare(`
      SELECT t.*, j.job_number, j.title AS job_title FROM time_entries t
      LEFT JOIN jobs j ON j.id = t.job_id WHERE t.employee_id = ? AND t.clock_out IS NULL`).get(empId);
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    const weekHours = round2(db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NOT NULL AND date(clock_in) >= ?`)
      .all(empId, weekAgo.toISOString().slice(0, 10)).reduce((s, t) => s + F.hoursOf(t), 0));
    return json(res, 200, {
      employee: { id: empId, name: user.employee_name, role: user.employee_role },
      open_entry: open || null,
      today: db.prepare(`SELECT s.*, j.job_number, j.title AS job_title, j.address FROM schedule s
        LEFT JOIN jobs j ON j.id = s.job_id WHERE s.employee_id = ? AND s.date = ?`).all(empId, today()),
      week_hours: weekHours,
      work_orders: db.prepare(`SELECT w.id, w.wo_number, w.title, w.description, w.wo_type, w.priority, w.status, w.due_date, j.job_number
        FROM work_orders w LEFT JOIN jobs j ON j.id = w.job_id
        WHERE w.assigned_to = ? AND w.status IN ('open','in_progress')
        ORDER BY CASE w.priority WHEN 'rush' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.due_date`).all(empId),
      jobs: db.prepare(`SELECT id, job_number, title, address FROM jobs WHERE status IN ('planned','in_progress') ORDER BY job_number`).all(),
    });
  }

  if (section === 'clock' && req.method === 'POST') {
    const r = parts[3] === 'in' ? clockIn(body) : parts[3] === 'out' ? clockOut(body) : { error: 'Unknown action' };
    if (r.error) return json(res, 409, r);
    auth.audit(user, 'clock_' + parts[3], body.job_id ? `job ${body.job_id}` : '');
    return json(res, 200, r);
  }

  /** Offline queue drain — each item carries the timestamp it happened at. */
  if (section === 'sync' && req.method === 'POST') {
    const results = [];
    for (const op of (Array.isArray(body.queue) ? body.queue : []).slice(0, 100)) {
      try {
        let r;
        if (op.type === 'clock_in') r = clockIn({ ...op.payload, at: op.at, client_ref: op.client_ref });
        else if (op.type === 'clock_out') r = clockOut({ at: op.at });
        else if (op.type === 'job_card') r = saveCard({ ...op.payload, client_ref: op.client_ref });
        else r = { error: 'Unknown operation' };
        results.push({ client_ref: op.client_ref, ...r });
      } catch (e) { results.push({ client_ref: op.client_ref, error: e.message }); }
    }
    if (results.length) auth.audit(user, 'offline_sync', `${results.filter(r => r.ok).length}/${results.length} accepted`);
    return json(res, 200, { results });
  }

  if (section === 'schedule' && req.method === 'GET') {
    const from = new Date(); from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    const start = from.toISOString().slice(0, 10);
    const end = new Date(from); end.setDate(end.getDate() + 13);
    return json(res, 200, db.prepare(`SELECT s.*, j.job_number, j.title AS job_title, j.address FROM schedule s
      LEFT JOIN jobs j ON j.id = s.job_id WHERE s.employee_id = ? AND s.date BETWEEN ? AND ? ORDER BY s.date`)
      .all(empId, start, end.toISOString().slice(0, 10)));
  }

  if (section === 'timesheet' && req.method === 'GET') {
    const from = new Date(); from.setDate(from.getDate() - 13);
    const rows = db.prepare(`SELECT t.*, j.job_number, j.title AS job_title FROM time_entries t
      LEFT JOIN jobs j ON j.id = t.job_id WHERE t.employee_id = ? AND date(t.clock_in) >= ? ORDER BY t.clock_in DESC`)
      .all(empId, from.toISOString().slice(0, 10));
    rows.forEach(r => { r.hours = r.clock_out ? round2(F.hoursOf(r)) : null; });
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
      const cards = db.prepare(`SELECT c.*, j.job_number, j.title AS job_title FROM job_cards c
        LEFT JOIN jobs j ON j.id = c.job_id WHERE c.employee_id = ? ORDER BY c.id DESC LIMIT 30`).all(empId);
      cards.forEach(c => { c.photos = attachmentsFor('job_card', c.id); });
      return json(res, 200, cards);
    }
    if (req.method === 'POST') {
      const r = saveCard(body);
      if (r.error) return json(res, 400, r);
      auth.audit(user, 'jobcard_submitted', String(body.work_performed || '').slice(0, 80));
      return json(res, 200, r);
    }
  }

  // photo upload from the field — only onto the crew member's own job cards
  if (section === 'attachments' && req.method === 'POST') {
    const entityId = Number(url.searchParams.get('entity_id'));
    const card = db.prepare('SELECT * FROM job_cards WHERE id = ?').get(entityId);
    if (!card || card.employee_id !== empId) return json(res, 403, { error: 'You can only add photos to your own job cards' });
    const { fields, files } = await readUpload(req);
    const saved = [];
    for (const file of files) {
      const meta = storeFile(file);
      const info = db.prepare(`INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime, size, caption, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?)`).run('job_card', entityId, meta.filename, meta.original_name, meta.mime, meta.size, fields.caption || '', user.id);
      saved.push({ id: info.lastInsertRowid, ...meta });
    }
    return json(res, 200, { ok: true, saved, message: `${saved.length} photo${saved.length === 1 ? '' : 's'} attached` });
  }

  if (section === 'materials' && req.method === 'GET') {
    return json(res, 200, db.prepare('SELECT id, sku, name, category, unit, qty_on_hand, reorder_point, location FROM materials ORDER BY name').all());
  }

  return json(res, 404, { error: 'Unknown portal endpoint' });
}

/** Accept a client-supplied timestamp only if it is sane; otherwise use server time. */
function safeStamp(at) {
  if (!at) return now();
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return now();
  if (t > Date.now() + 5 * 60e3 || t < Date.now() - 7 * 864e5) return now();
  return new Date(t).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------- estimating intelligence
/** Every historical priced line item, from quotes, work orders and change orders. */
function historicalItems() {
  const out = [];
  const push = (src, number, date, status, items) => {
    for (const i of parseItems(items)) {
      if (!i.desc) continue;
      out.push({ source: src, number, date: (date || '').slice(0, 10), status, desc: i.desc,
        qty: Number(i.qty) || 0, unit: i.unit || '', unit_cost: Number(i.unit_cost) || 0, unit_price: Number(i.unit_price) || 0 });
    }
  };
  for (const q of db.prepare('SELECT * FROM quotes').all()) push('quote', q.quote_number, q.created_at, q.status, q.items);
  for (const w of db.prepare('SELECT * FROM work_orders').all()) push('work_order', w.wo_number, w.completed_at || w.created_at, w.status, w.items);
  for (const c of db.prepare('SELECT * FROM change_orders').all()) push('change_order', c.co_number, c.created_at, c.status, c.items);
  return out;
}

/**
 * How far off our labor estimates run, measured against clocked hours.
 * Only completed jobs count — an in-progress job has hours still to come and
 * would drag the average toward "we always overestimate", which is backwards.
 */
function laborAccuracy() {
  const jobs = db.prepare(`SELECT * FROM jobs WHERE est_labor_hours > 0 AND status = 'completed'`).all();
  const samples = [];
  for (const j of jobs) {
    const f = jobFinancials(j.id);
    if (f.labor_hours > 0) samples.push({ job_number: j.job_number, title: j.title, status: j.status,
      estimated: j.est_labor_hours, actual: f.labor_hours, variance_pct: round2((f.labor_hours - j.est_labor_hours) / j.est_labor_hours * 100) });
  }
  if (!samples.length) return { samples: [], factor: 1, avg_variance_pct: null };
  const avg = samples.reduce((s, x) => s + x.variance_pct, 0) / samples.length;
  return { samples, factor: round2(1 + avg / 100), avg_variance_pct: round2(avg) };
}

function estimatorSearch(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const groups = new Map();
  for (const i of historicalItems()) {
    if (!i.desc.toLowerCase().includes(needle)) continue;
    const key = i.desc.toLowerCase();
    if (!groups.has(key)) groups.set(key, { desc: i.desc, unit: i.unit, uses: [], sources: [] });
    const g = groups.get(key);
    g.uses.push(i);
    g.sources.push(`${i.number}`);
  }
  // materials on hand are quotable too
  for (const m of db.prepare('SELECT * FROM materials WHERE lower(name) LIKE ?').all(`%${needle}%`)) {
    const key = m.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { desc: m.name, unit: m.unit, uses: [], sources: [], in_stock: m.qty_on_hand, current_cost: m.unit_cost, current_price: m.sell_price });
    else Object.assign(groups.get(key), { in_stock: m.qty_on_hand, current_cost: m.unit_cost, current_price: m.sell_price });
  }
  const results = [];
  for (const g of groups.values()) {
    const priced = g.uses.filter(u => u.unit_price > 0);
    const costed = g.uses.filter(u => u.unit_cost > 0);
    const avg = a => a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : 0;
    const last = g.uses.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
    results.push({
      desc: g.desc, unit: g.unit || 'ea', times_quoted: g.uses.length,
      avg_price: avg(priced.map(u => u.unit_price)), min_price: priced.length ? Math.min(...priced.map(u => u.unit_price)) : 0,
      max_price: priced.length ? Math.max(...priced.map(u => u.unit_price)) : 0,
      avg_cost: avg(costed.map(u => u.unit_cost)),
      last_price: last ? last.unit_price : 0, last_used: last ? last.date : '', last_on: last ? last.number : '',
      in_stock: g.in_stock ?? null, current_cost: g.current_cost ?? null, current_price: g.current_price ?? null,
    });
  }
  return results.sort((a, b) => b.times_quoted - a.times_quoted).slice(0, 12);
}

/** Score a draft quote against everything the company has actually done. */
function benchmark(draft) {
  const totals = docTotals(draft);
  const cfg = settings();
  const target = Number(cfg.target_margin_pct || 30);
  const accuracy = laborAccuracy();
  const warnings = [];

  if (totals.total > 0 && totals.est_margin_pct < target) {
    warnings.push({ level: totals.est_margin_pct < target / 2 ? 'high' : 'medium',
      title: `Estimated margin is ${totals.est_margin_pct}% — below your ${target}% target`,
      detail: `At ${T.money(totals.total)} you are projecting ${T.money(totals.est_profit)} of profit. To hit ${target}% you would need to price this around ${T.money(round2(totals.est_cost / (1 - target / 100)))}.` });
  }
  if (accuracy.avg_variance_pct !== null && accuracy.avg_variance_pct > 5 && Number(draft.labor_hours) > 0) {
    const realistic = round2(Number(draft.labor_hours) * accuracy.factor);
    warnings.push({ level: accuracy.avg_variance_pct > 20 ? 'high' : 'medium',
      title: `Your labor estimates run ${accuracy.avg_variance_pct}% over on average`,
      detail: `You have ${draft.labor_hours} hours here. On past jobs that would land closer to ${realistic} hours — roughly ${T.money(round2((realistic - Number(draft.labor_hours)) * (Number(draft.labor_rate) || 0)))} of labor you have not billed for.` });
  }
  // compare against past jobs with similar titles
  const words = String(draft.title || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const similar = [];
  if (words.length) {
    for (const j of db.prepare(`SELECT * FROM jobs WHERE status = 'completed'`).all()) {
      const hay = `${j.title} ${j.description}`.toLowerCase();
      const hits = words.filter(w => hay.includes(w)).length;
      if (hits) { const f = jobFinancials(j.id); similar.push({ job_number: j.job_number, title: j.title, score: hits, sold: f.sold_price, cost: f.total_cost, margin_pct: f.margin_pct, hours: f.labor_hours }); }
    }
    similar.sort((a, b) => b.score - a.score);
  }
  if (similar.length) {
    const avgMargin = round2(similar.reduce((s, x) => s + x.margin_pct, 0) / similar.length);
    if (avgMargin < target) warnings.push({ level: 'medium', title: `Similar past work averaged a ${avgMargin}% margin`,
      detail: `${similar.slice(0, 3).map(s => `${s.job_number} (${s.margin_pct}%)`).join(', ')}. This type of job has historically underperformed your target — price accordingly.` });
  }
  return { totals, target_margin_pct: target, labor_accuracy: accuracy, similar_jobs: similar.slice(0, 5), warnings };
}

// ---------------------------------------------------------------- capacity planning
function capacity(weeks = 4) {
  const shiftHours = s => (s === 'AM' || s === 'PM') ? 4 : 8;
  const crew = db.prepare('SELECT * FROM employees WHERE active = 1').all();
  const start = new Date(); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const from = new Date(start); from.setDate(from.getDate() + w * 7);
    const to = new Date(from); to.setDate(to.getDate() + 6);
    const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT s.*, e.name AS employee_name, j.job_number FROM schedule s
      JOIN employees e ON e.id = s.employee_id LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.date BETWEEN ? AND ?`).all(f, t);
    const committed = rows.reduce((s, r) => s + shiftHours(r.shift), 0);
    const available = crew.length * 8 * 5;
    // double-bookings: same person, same day, more than one full-day assignment
    const seen = new Map(), conflicts = [];
    for (const r of rows) {
      const key = `${r.employee_id}|${r.date}`;
      const prev = seen.get(key);
      if (prev) {
        const total = shiftHours(prev.shift) + shiftHours(r.shift);
        if (total > 8) conflicts.push({ employee: r.employee_name, date: r.date, jobs: [prev.job_number || 'Shop', r.job_number || 'Shop'], hours: total });
      } else seen.set(key, r);
    }
    out.push({ week_start: f, week_end: t, committed_hours: committed, available_hours: available,
      utilization_pct: available ? round2(committed / available * 100) : 0, crew_count: crew.length,
      overcommitted: committed > available, conflicts });
  }
  return out;
}

// ---------------------------------------------------------------- cash flow forecast
/**
 * Project cash in and out, week by week, from commitments already in the system:
 * unpaid invoices by due date, scheduled crew hours, and purchase orders in transit.
 * Anything already overdue lands in week one — that money is needed now.
 */
function cashflow(weeks = 13) {
  const cfg = settings();
  const shiftHours = s => (s === 'AM' || s === 'PM') ? 4 : 8;
  const start = new Date(); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weekStarts = [...Array(weeks)].map((_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i * 7); return d.toISOString().slice(0, 10);
  });
  const bucketFor = date => {
    if (!date) return null;
    if (date < weekStarts[0]) return 0;                       // overdue / already committed
    for (let i = weeks - 1; i >= 0; i--) if (date >= weekStarts[i]) return i;
    return null;
  };

  const rows = weekStarts.map(w => ({ week_start: w, inflow: 0, outflow: 0, inflows: [], outflows: [] }));
  const addIn = (i, amount, label) => { if (i !== null && rows[i]) { rows[i].inflow = round2(rows[i].inflow + amount); rows[i].inflows.push({ label, amount: round2(amount) }); } };
  const addOut = (i, amount, label) => { if (i !== null && rows[i]) { rows[i].outflow = round2(rows[i].outflow + amount); rows[i].outflows.push({ label, amount: round2(amount) }); } };

  // in: unpaid invoices, by due date
  for (const inv of db.prepare(`SELECT i.*, c.name AS client_name FROM invoices i
      LEFT JOIN clients c ON c.id = i.client_id WHERE i.status NOT IN ('void','paid')`).all()) {
    const t = invoiceTotals(inv, paidOn(inv.id));
    if (t.balance <= 0.005) continue;
    const due = inv.due_date || inv.issue_date || today();
    addIn(bucketFor(due), t.balance, `${inv.invoice_number}${inv.client_name ? ' · ' + inv.client_name : ''}${due < today() ? ' (overdue)' : ''}`);
  }

  // out: payroll from the schedule, at each employee's rate
  const sched = db.prepare(`SELECT s.date, s.shift, e.hourly_rate, e.name FROM schedule s
    JOIN employees e ON e.id = s.employee_id WHERE s.date >= ?`).all(weekStarts[0]);
  const payrollByWeek = {};
  for (const s of sched) {
    const i = bucketFor(s.date);
    if (i === null) continue;
    payrollByWeek[i] = (payrollByWeek[i] || 0) + shiftHours(s.shift) * (s.hourly_rate || 0);
  }
  for (const [i, amount] of Object.entries(payrollByWeek)) addOut(Number(i), amount, 'Payroll (scheduled crew)');

  // out: purchase orders in transit, by expected date
  for (const po of db.prepare(`SELECT * FROM purchase_orders WHERE status = 'ordered'`).all()) {
    const total = parseItems(po.items).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_cost) || 0), 0);
    if (total <= 0) continue;
    addOut(bucketFor(po.expected_date || today()), total, `${po.po_number} · ${po.vendor}`);
  }

  let balance = Number(cfg.cash_on_hand) || 0;
  const opening = balance;
  for (const r of rows) {
    r.net = round2(r.inflow - r.outflow);
    balance = round2(balance + r.net);
    r.balance = balance;
    r.short = balance < 0;
  }
  const firstShort = rows.find(r => r.short);
  return {
    weeks: rows, opening_balance: opening, closing_balance: balance,
    total_in: round2(rows.reduce((s, r) => s + r.inflow, 0)),
    total_out: round2(rows.reduce((s, r) => s + r.outflow, 0)),
    first_shortfall: firstShort ? firstShort.week_start : null,
    unbilled: round2(db.prepare(`SELECT id FROM jobs WHERE status IN ('planned','in_progress','on_hold')`).all()
      .reduce((s, j) => { const f = jobFinancials(j.id); return s + Math.max(0, f.sold_price - f.invoicing.billed); }, 0)),
  };
}

// ---------------------------------------------------------------- payroll
function payrollPeriod(from, to) {
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY name').all();
  return employees.map(e => {
    const entries = db.prepare(`SELECT t.*, j.job_number, j.title AS job_title, j.prevailing_wage FROM time_entries t
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.employee_id = ? AND t.clock_out IS NOT NULL AND date(t.clock_in) BETWEEN ? AND ?
      ORDER BY t.clock_in`).all(e.id, from, to);
    const byDay = {}, byJob = {};
    let total = 0;
    for (const t of entries) {
      const h = round2(F.hoursOf(t));
      const day = t.clock_in.slice(0, 10);
      byDay[day] = round2((byDay[day] || 0) + h);
      const key = t.job_number || 'Shop / general';
      byJob[key] = round2((byJob[key] || 0) + h);
      total += h;
    }
    total = round2(total);
    // overtime past 40 hours in each Mon–Sun week within the period
    let otHours = 0;
    const weeks = {};
    for (const [day, h] of Object.entries(byDay)) {
      const d = new Date(day + 'T12:00:00Z');
      d.setDate(d.getDate() - ((d.getUTCDay() + 6) % 7));
      const wk = d.toISOString().slice(0, 10);
      weeks[wk] = (weeks[wk] || 0) + h;
    }
    for (const h of Object.values(weeks)) if (h > 40) otHours += h - 40;
    otHours = round2(otHours);
    const regular = round2(total - otHours);
    const gross = round2(regular * e.hourly_rate + otHours * e.hourly_rate * 1.5);
    return {
      id: e.id, name: e.name, role: e.role, classification: e.classification || e.role,
      rate: e.hourly_rate, fringe_rate: e.fringe_rate || 0,
      total_hours: total, regular_hours: regular, ot_hours: otHours, gross_pay: gross,
      by_day: byDay, by_job: byJob,
    };
  }).filter(r => r.total_hours > 0);
}

/** WH-347 style rows: one line per employee per job for the payroll week. */
function certifiedPayroll(jobId, weekEnding) {
  const job = db.prepare('SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.id = ?').get(jobId);
  if (!job) return null;
  const end = weekEnding || today();
  const start = addDays(end, -6);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const rows = db.prepare(`SELECT t.*, e.name, e.classification, e.role, e.hourly_rate, e.fringe_rate FROM time_entries t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.job_id = ? AND t.clock_out IS NOT NULL AND date(t.clock_in) BETWEEN ? AND ?`).all(jobId, start, end);
  const byEmp = new Map();
  for (const t of rows) {
    if (!byEmp.has(t.employee_id)) {
      byEmp.set(t.employee_id, { name: t.name, classification: t.classification || t.role, rate: t.hourly_rate,
        fringe_rate: t.fringe_rate || 0, days: Object.fromEntries(days.map(d => [d, 0])), total: 0 });
    }
    const e = byEmp.get(t.employee_id);
    const day = t.clock_in.slice(0, 10);
    const h = round2(F.hoursOf(t));
    if (e.days[day] !== undefined) e.days[day] = round2(e.days[day] + h);
    e.total = round2(e.total + h);
  }
  const employees = [...byEmp.values()].map(e => {
    const ot = Math.max(0, round2(e.total - 40));
    const reg = round2(e.total - ot);
    return { ...e, regular_hours: reg, ot_hours: ot,
      gross_pay: round2(reg * e.rate + ot * e.rate * 1.5),
      fringe_total: round2(e.total * e.fringe_rate),
      total_package: round2(reg * e.rate + ot * e.rate * 1.5 + e.total * e.fringe_rate) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { job, week_start: start, week_ending: end, days, employees,
    totals: { hours: round2(employees.reduce((s, e) => s + e.total, 0)), gross: round2(employees.reduce((s, e) => s + e.gross_pay, 0)) } };
}

// ---------------------------------------------------------------- admin API
async function adminApi(req, res, parts, body, query, user, url) {
  const method = req.method;
  const resource = parts[1];
  const idOrAction = parts[2];
  const action = parts[3];

  // ---- kiosk time clock ----
  if (resource === 'clock') {
    if (idOrAction === 'status' && method === 'GET') {
      return json(res, 200, db.prepare(`SELECT t.*, e.name AS employee_name, j.job_number, j.title AS job_title
        FROM time_entries t JOIN employees e ON e.id = t.employee_id
        LEFT JOIN jobs j ON j.id = t.job_id WHERE t.clock_out IS NULL ORDER BY t.clock_in`).all());
    }
    if ((idOrAction === 'in' || idOrAction === 'out') && method === 'POST') {
      const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(body.employee_id);
      if (!emp || (idOrAction === 'in' && !emp.active)) return json(res, 404, { error: 'Employee not found' });
      if (String(emp.pin) !== String(body.pin)) return json(res, 403, { error: 'Wrong PIN' });
      const open = db.prepare('SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL').get(emp.id);
      if (idOrAction === 'in') {
        if (open && !body.job_id) return json(res, 409, { error: `${emp.name} is already clocked in` });
        if (open) db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
        db.prepare('INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, notes) VALUES (?,?,?,?,?)')
          .run(emp.id, body.job_id || null, body.job_id ? 'job' : 'shift', now(), body.notes || '');
        return json(res, 200, { ok: true, message: body.job_id ? `${emp.name} clocked onto job` : `${emp.name} clocked in` });
      }
      if (!open) return json(res, 409, { error: `${emp.name} is not clocked in` });
      db.prepare('UPDATE time_entries SET clock_out = ? WHERE id = ?').run(now(), open.id);
      return json(res, 200, { ok: true, message: `${emp.name} clocked out` });
    }
  }

  if (resource === 'timesheets' && method === 'GET') {
    const from = query.get('from') || today(), to = query.get('to') || today();
    const rows = db.prepare(`SELECT t.*, e.name AS employee_name, e.hourly_rate, j.job_number, j.title AS job_title
      FROM time_entries t JOIN employees e ON e.id = t.employee_id
      LEFT JOIN jobs j ON j.id = t.job_id WHERE date(t.clock_in) BETWEEN ? AND ? ORDER BY t.clock_in DESC`).all(from, to);
    for (const r of rows) {
      r.hours = r.clock_out ? round2(F.hoursOf(r)) : null;
      r.labor_cost = r.hours !== null ? round2(r.hours * r.hourly_rate) : null;
      delete r.hourly_rate;
    }
    return json(res, 200, rows);
  }

  // ---- quotes ----
  if (resource === 'quotes' && idOrAction === 'estimator' && method === 'GET') {
    return json(res, 200, { matches: estimatorSearch(query.get('q')), accuracy: laborAccuracy() });
  }
  if (resource === 'quotes' && idOrAction === 'benchmark' && method === 'POST') {
    return json(res, 200, benchmark(body));
  }
  if (resource === 'quotes' && idOrAction && action === 'convert' && method === 'POST') {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(idOrAction);
    if (!q) return json(res, 404, { error: 'Quote not found' });
    const totals = docTotals(q);
    const jobNumber = nextNumber('jobs', 'job_number', 'J');
    const jobId = db.prepare(`INSERT INTO jobs (job_number, client_id, quote_id, title, description, status, sold_price, start_date, est_labor_hours)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(jobNumber, q.client_id, q.id, q.title, q.description, 'planned', totals.total, body.start_date || today(), q.labor_hours).lastInsertRowid;
    let woId = null;
    if (body.create_work_order) {
      const woNumber = nextNumber('work_orders', 'wo_number', 'WO');
      woId = db.prepare(`INSERT INTO work_orders (wo_number, job_id, client_id, title, description, wo_type, status, items, labor_hours, labor_rate, sold_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(woNumber, jobId, q.client_id, q.title, q.description, 'Shop', 'open', q.items, q.labor_hours, q.labor_rate, totals.total).lastInsertRowid;
    }
    let invId = null;
    if (body.deposit_pct > 0) {
      const invNumber = nextNumber('invoices', 'invoice_number', 'INV');
      const amount = round2(totals.total * Number(body.deposit_pct) / 100);
      invId = db.prepare(`INSERT INTO invoices (invoice_number, job_id, client_id, invoice_type, description, items, status, issue_date, due_date, terms_days)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(invNumber, jobId, q.client_id, 'deposit', `Contract deposit — ${body.deposit_pct}% at signing`,
        JSON.stringify([{ desc: `Deposit, ${body.deposit_pct}% of contract`, qty: 1, unit: 'ls', unit_price: amount }]), 'draft', today(), today(), 0).lastInsertRowid;
    }
    db.prepare(`UPDATE quotes SET status = 'accepted', updated_at = ? WHERE id = ?`).run(now(), q.id);
    auth.audit(user, 'quote_converted', `${q.quote_number} → ${jobNumber}`);
    return json(res, 200, { ok: true, job_id: jobId, job_number: jobNumber, work_order_id: woId, invoice_id: invId });
  }
  if (resource === 'quotes' && idOrAction && (action === 'email' || action === 'link') && method === 'POST') {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(idOrAction);
    if (!q) return json(res, 404, { error: 'Quote not found' });
    if (!q.public_token) { q.public_token = token(); db.prepare('UPDATE quotes SET public_token = ? WHERE id = ?').run(q.public_token, q.id); }
    const link = `${(settings().app_base_url || '').replace(/\/$/, '')}/q/${q.public_token}`;
    if (action === 'link') return json(res, 200, { link });

    const client = q.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(q.client_id) : null;
    const to = String(body.to || client?.email || '').trim();
    if (!validEmail(to)) return json(res, 400, { error: 'A valid recipient email address is required' });
    const cfg = settings();
    freezeForSend('quotes', q);
    const ctx = quoteContext(q, { asSent: true });
    const subject = body.subject || `${cfg.company_name} — Proposal ${q.quote_number}: ${q.title}`;
    const message = body.message !== undefined ? body.message
      : `Hi${client?.contact ? ' ' + client.contact.split(' ')[0] : ''},\n\nThanks for the opportunity to quote this work. Our proposal is below.\n\n${cfg.company_name}`;
    const r = await deliver({ to, subject, html: T.quoteEmail(ctx, { link, message }), text: T.quoteText(ctx, link),
      kind: 'quote', relatedType: 'quote', relatedId: q.id, user });
    if (r.status === 'failed') return json(res, 502, { error: `Email failed: ${r.error}`, link });
    if (q.status === 'draft') db.prepare(`UPDATE quotes SET status = 'sent' WHERE id = ?`).run(q.id);
    db.prepare('UPDATE quotes SET sent_at = ? WHERE id = ?').run(now(), q.id);
    auth.audit(user, 'quote_emailed', `${q.quote_number} → ${to} (${r.status})`);
    return json(res, 200, { ok: true, status: r.status, link, preview: r.preview,
      message: r.status === 'outbox' ? 'SMTP is not configured yet, so the email was saved to the outbox — open the preview to see what the customer would receive.' : `Proposal emailed to ${to}` });
  }
  if (resource === 'quotes' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT q.*, c.name AS client_name, c.email AS client_email, c.contact AS client_contact
      FROM quotes q LEFT JOIN clients c ON c.id = q.client_id ORDER BY q.id DESC`).all();
    rows.forEach(r => { r.totals = docTotals(r); r.has_drift = hasDrift(r); });
    return json(res, 200, rows);
  }

  // ---- change orders ----
  if (resource === 'changeorders' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT co.*, j.job_number, j.title AS job_title, c.name AS client_name, c.email AS client_email, c.contact AS client_contact
      FROM change_orders co LEFT JOIN jobs j ON j.id = co.job_id LEFT JOIN clients c ON c.id = co.client_id ORDER BY co.id DESC`).all();
    rows.forEach(r => { r.totals = docTotals(r); r.has_drift = hasDrift(r); });
    return json(res, 200, rows);
  }
  if (resource === 'changeorders' && idOrAction && (action === 'email' || action === 'link') && method === 'POST') {
    const co = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(idOrAction);
    if (!co) return json(res, 404, { error: 'Change order not found' });
    if (!co.public_token) { co.public_token = token(); db.prepare('UPDATE change_orders SET public_token = ? WHERE id = ?').run(co.public_token, co.id); }
    const link = `${(settings().app_base_url || '').replace(/\/$/, '')}/co/${co.public_token}`;
    if (action === 'link') return json(res, 200, { link });

    const client = co.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(co.client_id) : null;
    const to = String(body.to || client?.email || '').trim();
    if (!validEmail(to)) return json(res, 400, { error: 'A valid recipient email address is required' });
    const cfg = settings();
    freezeForSend('change_orders', co);
    const ctx = coContext(co, { asSent: true });
    const subject = body.subject || `${cfg.company_name} — Change Order ${co.co_number}: ${co.title}`;
    const message = body.message !== undefined ? body.message
      : `Hi${client?.contact ? ' ' + client.contact.split(' ')[0] : ''},\n\nWe ran into work outside the original scope and need your approval before proceeding. Details are below.\n\n${cfg.company_name}`;
    const r = await deliver({ to, subject, html: T.changeOrderEmail(ctx, { link, message }), text: T.docText('Change Order', ctx, link),
      kind: 'change_order', relatedType: 'change_order', relatedId: co.id, user });
    if (r.status === 'failed') return json(res, 502, { error: `Email failed: ${r.error}`, link });
    db.prepare(`UPDATE change_orders SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = ? WHERE id = ?`).run(now(), co.id);
    auth.audit(user, 'change_order_emailed', `${co.co_number} → ${to} (${r.status})`);
    return json(res, 200, { ok: true, status: r.status, link, preview: r.preview,
      message: r.status === 'outbox' ? 'SMTP is not configured — a preview was saved to the outbox.' : `Change order sent to ${to}` });
  }

  // ---- invoices ----
  if (resource === 'invoices' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT i.*, j.job_number, j.title AS job_title, c.name AS client_name, c.email AS client_email, c.contact AS client_contact
      FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id LEFT JOIN clients c ON c.id = i.client_id ORDER BY i.id DESC`).all();
    rows.forEach(r => {
      r.totals = invoiceTotals(r, paidOn(r.id));
      r.days_overdue = (r.due_date && r.totals.balance > 0 && r.due_date < today())
        ? Math.floor((new Date(today()) - new Date(r.due_date)) / 864e5) : 0;
    });
    return json(res, 200, rows);
  }
  if (resource === 'invoices' && idOrAction === 'aging' && method === 'GET') {
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    const open = [];
    for (const inv of db.prepare(`SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.status NOT IN ('void','draft')`).all()) {
      const t = invoiceTotals(inv, paidOn(inv.id));
      if (t.balance <= 0.005) continue;
      const days = inv.due_date && inv.due_date < today() ? Math.floor((new Date(today()) - new Date(inv.due_date)) / 864e5) : 0;
      const key = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus';
      buckets[key] = round2(buckets[key] + t.balance);
      open.push({ id: inv.id, invoice_number: inv.invoice_number, client: inv.client_name, due_date: inv.due_date,
        days_overdue: days, balance: t.balance, total: t.total, bucket: key });
    }
    open.sort((a, b) => b.days_overdue - a.days_overdue || b.balance - a.balance);
    const retained = round2(db.prepare(`SELECT * FROM invoices WHERE status != 'void'`).all()
      .reduce((s, i) => s + invoiceTotals(i, 0).retainage, 0));
    return json(res, 200, { buckets, open, total_outstanding: round2(Object.values(buckets).reduce((a, b) => a + b, 0)), retainage_held: retained });
  }
  if (resource === 'invoices' && idOrAction && action === 'generate' && method === 'POST') {
    // build a progress bill straight from the job's contract value and % complete
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(idOrAction);
    if (!job) return json(res, 404, { error: 'Job not found' });
    const fin = jobFinancials(job.id);
    const pct = Math.max(0, Math.min(100, Number(body.percent_complete) || 0));
    const cfg = settings();
    const gross = round2(fin.sold_price * pct / 100);
    const already = fin.invoicing.billed;
    const thisBill = round2(Math.max(0, gross - already));
    if (thisBill <= 0) return json(res, 409, { error: `Already billed ${T.money(already)} of ${T.money(fin.sold_price)} — nothing new to bill at ${pct}%` });
    const invNumber = nextNumber('invoices', 'invoice_number', 'INV');
    const termsDays = Number(body.terms_days ?? cfg.payment_terms_days ?? 30);
    const id = db.prepare(`INSERT INTO invoices (invoice_number, job_id, client_id, invoice_type, description, items, tax_pct, retainage_pct, status, issue_date, due_date, terms_days)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(invNumber, job.id, job.client_id, body.invoice_type || 'progress',
      body.description || `Progress billing — ${pct}% complete`,
      JSON.stringify([{ desc: `Work completed to date (${pct}% of contract), less previous billings`, qty: 1, unit: 'ls', unit_price: thisBill }]),
      Number(body.tax_pct) || 0, body.retainage_pct !== undefined ? Number(body.retainage_pct) : Number(cfg.default_retainage_pct || 0),
      'draft', today(), addDays(today(), termsDays), termsDays).lastInsertRowid;
    auth.audit(user, 'invoice_generated', `${invNumber} for ${job.job_number} at ${pct}%`);
    return json(res, 200, { ok: true, id, invoice_number: invNumber, amount: thisBill });
  }
  if (resource === 'invoices' && idOrAction && (action === 'email' || action === 'link') && method === 'POST') {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(idOrAction);
    if (!inv) return json(res, 404, { error: 'Invoice not found' });
    if (!inv.public_token) { inv.public_token = token(); db.prepare('UPDATE invoices SET public_token = ? WHERE id = ?').run(inv.public_token, inv.id); }
    const link = `${(settings().app_base_url || '').replace(/\/$/, '')}/inv/${inv.public_token}`;
    if (action === 'link') return json(res, 200, { link });

    const client = inv.client_id ? db.prepare('SELECT * FROM clients WHERE id = ?').get(inv.client_id) : null;
    const to = String(body.to || client?.email || '').trim();
    if (!validEmail(to)) return json(res, 400, { error: 'A valid recipient email address is required' });
    const cfg = settings();
    const ctx = invContext(inv);
    const subject = body.subject || `${cfg.company_name} — Invoice ${inv.invoice_number}`;
    const message = body.message !== undefined ? body.message
      : `Hi${client?.contact ? ' ' + client.contact.split(' ')[0] : ''},\n\nInvoice ${inv.invoice_number} is attached below, due ${inv.due_date || 'on receipt'}. Thank you for your business.\n\n${cfg.company_name}`;
    const r = await deliver({ to, subject, html: T.invoiceEmail(ctx, { link, message }), text: T.docText('Invoice', ctx, link),
      kind: 'invoice', relatedType: 'invoice', relatedId: inv.id, user });
    if (r.status === 'failed') return json(res, 502, { error: `Email failed: ${r.error}`, link });
    db.prepare(`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = ? WHERE id = ?`).run(now(), inv.id);
    auth.audit(user, 'invoice_emailed', `${inv.invoice_number} → ${to} (${r.status})`);
    return json(res, 200, { ok: true, status: r.status, link, preview: r.preview,
      message: r.status === 'outbox' ? 'SMTP is not configured — a preview was saved to the outbox.' : `Invoice emailed to ${to}` });
  }
  if (resource === 'invoices' && idOrAction && action === 'payments' && method === 'POST') {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(idOrAction);
    if (!inv) return json(res, 404, { error: 'Invoice not found' });
    const amount = round2(body.amount);
    if (!(amount > 0)) return json(res, 400, { error: 'Payment amount must be greater than zero' });
    db.prepare('INSERT INTO payments (invoice_id, amount, method, reference, received_on, notes) VALUES (?,?,?,?,?,?)')
      .run(inv.id, amount, body.method || 'check', body.reference || '', body.received_on || today(), body.notes || '');
    const t = invoiceTotals(inv, paidOn(inv.id));
    // A draft that has been paid was clearly issued — promote it, or the balance
    // would sit outside AR aging (which ignores drafts) and go untracked.
    if (t.balance <= 0.005) db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).run(inv.id);
    else if (inv.status === 'draft') db.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).run(inv.id);
    auth.audit(user, 'payment_recorded', `${T.money(amount)} on ${inv.invoice_number}`);
    return json(res, 200, { ok: true, balance: t.balance, paid_in_full: t.balance <= 0.005 });
  }
  if (resource === 'payments' && method === 'DELETE' && idOrAction) {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(idOrAction);
    if (!p) return json(res, 404, { error: 'Payment not found' });
    db.prepare('DELETE FROM payments WHERE id = ?').run(p.id);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(p.invoice_id);
    if (inv && inv.status === 'paid') db.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).run(inv.id);
    auth.audit(user, 'payment_deleted', `${T.money(p.amount)} from invoice ${p.invoice_id}`);
    return json(res, 200, { ok: true });
  }

  // ---- jobs ----
  if (resource === 'jobs' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT j.*, c.name AS client_name, e.name AS foreman_name FROM jobs j
      LEFT JOIN clients c ON c.id = j.client_id LEFT JOIN employees e ON e.id = j.foreman_id
      ORDER BY CASE j.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'on_hold' THEN 2 ELSE 3 END, j.id DESC`).all();
    rows.forEach(r => { r.financials = jobFinancials(r.id); });
    return json(res, 200, rows);
  }
  if (resource === 'jobs' && idOrAction && action === 'detail' && method === 'GET') {
    const job = db.prepare(`SELECT j.*, c.name AS client_name, c.email AS client_email, c.contact AS client_contact, e.name AS foreman_name
      FROM jobs j LEFT JOIN clients c ON c.id = j.client_id LEFT JOIN employees e ON e.id = j.foreman_id WHERE j.id = ?`).get(idOrAction);
    if (!job) return json(res, 404, { error: 'Not found' });
    job.financials = jobFinancials(job.id);
    job.materials = db.prepare(`SELECT jm.*, m.name AS material_name, m.unit FROM job_materials jm
      LEFT JOIN materials m ON m.id = jm.material_id WHERE jm.job_id = ?`).all(job.id);
    job.work_orders = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(job.id);
    job.work_orders.forEach(w => { w.financials = woFinancials(w); });
    job.time = db.prepare(`SELECT t.*, e.name AS employee_name FROM time_entries t JOIN employees e ON e.id = t.employee_id
      WHERE t.job_id = ? ORDER BY t.clock_in DESC LIMIT 50`).all(job.id);
    job.job_cards = db.prepare(`SELECT c.*, e.name AS employee_name FROM job_cards c JOIN employees e ON e.id = c.employee_id
      WHERE c.job_id = ? ORDER BY c.id DESC`).all(job.id);
    job.job_cards.forEach(c => { c.photos = attachmentsFor('job_card', c.id); });
    job.change_orders = db.prepare('SELECT * FROM change_orders WHERE job_id = ? ORDER BY id').all(job.id);
    job.change_orders.forEach(c => { c.totals = docTotals(c); });
    job.invoices = db.prepare(`SELECT * FROM invoices WHERE job_id = ? ORDER BY id`).all(job.id);
    job.invoices.forEach(i => { i.totals = invoiceTotals(i, paidOn(i.id)); });
    job.subs = db.prepare(`SELECT js.*, s.name, s.trade, s.phone FROM job_subs js JOIN subcontractors s ON s.id = js.sub_id WHERE js.job_id = ?`).all(job.id);
    job.subs.forEach(s => { s.documents = db.prepare('SELECT * FROM sub_documents WHERE sub_id = ?').all(s.sub_id); });
    job.photos = attachmentsFor('job', job.id);
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
    const rows = db.prepare(`SELECT w.*, c.name AS client_name, e.name AS assigned_name, j.job_number FROM work_orders w
      LEFT JOIN clients c ON c.id = w.client_id LEFT JOIN employees e ON e.id = w.assigned_to LEFT JOIN jobs j ON j.id = w.job_id
      ORDER BY CASE w.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
               CASE w.priority WHEN 'rush' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, w.id DESC`).all();
    rows.forEach(r => { r.financials = woFinancials(r); });
    return json(res, 200, rows);
  }

  // ---- job cards ----
  if (resource === 'jobcards' && method === 'GET' && !idOrAction) {
    const rows = db.prepare(`SELECT c.*, e.name AS employee_name, j.job_number, j.title AS job_title, j.client_id FROM job_cards c
      JOIN employees e ON e.id = c.employee_id LEFT JOIN jobs j ON j.id = c.job_id ORDER BY c.status = 'approved', c.id DESC`).all();
    rows.forEach(c => { c.photos = attachmentsFor('job_card', c.id); });
    return json(res, 200, rows);
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

  // ---- attachments ----
  if (resource === 'attachments') {
    if (method === 'GET') return json(res, 200, attachmentsFor(query.get('entity_type'), Number(query.get('entity_id'))));
    if (method === 'POST') {
      const entityType = query.get('entity_type') || 'job';
      const entityId = Number(query.get('entity_id'));
      if (!entityId) return json(res, 400, { error: 'entity_id is required' });
      const { fields, files } = await readUpload(req);
      const saved = [];
      for (const file of files) {
        const meta = storeFile(file);
        const info = db.prepare(`INSERT INTO attachments (entity_type, entity_id, filename, original_name, mime, size, caption, uploaded_by)
          VALUES (?,?,?,?,?,?,?,?)`).run(entityType, entityId, meta.filename, meta.original_name, meta.mime, meta.size, fields.caption || '', user.id);
        saved.push({ id: info.lastInsertRowid, ...meta });
      }
      return json(res, 200, { ok: true, saved });
    }
    if (method === 'DELETE' && idOrAction) {
      const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(idOrAction);
      if (!a) return json(res, 404, { error: 'Not found' });
      removeFile(a.filename);
      db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
      return json(res, 200, { ok: true });
    }
  }

  // ---- subcontractors ----
  if (resource === 'subcontractors' && method === 'GET' && !idOrAction) {
    const rows = db.prepare('SELECT * FROM subcontractors ORDER BY name').all();
    for (const s of rows) {
      s.documents = db.prepare('SELECT * FROM sub_documents WHERE sub_id = ? ORDER BY expires_on').all(s.id);
      const coi = s.documents.filter(d => d.doc_type === 'COI' && d.expires_on);
      const soonest = coi.sort((a, b) => (b.expires_on || '').localeCompare(a.expires_on || ''))[0];
      s.coi_expires_on = soonest?.expires_on || null;
      s.coi_days_left = soonest?.expires_on ? Math.floor((new Date(soonest.expires_on) - new Date(today())) / 864e5) : null;
      s.compliant = s.coi_days_left !== null && s.coi_days_left >= 0;
      s.jobs = db.prepare(`SELECT js.*, j.job_number, j.title FROM job_subs js JOIN jobs j ON j.id = js.job_id WHERE js.sub_id = ?`).all(s.id);
    }
    return json(res, 200, rows);
  }

  // ---- capacity ----
  if (resource === 'capacity' && method === 'GET') {
    return json(res, 200, capacity(Number(query.get('weeks')) || 4));
  }

  // ---- cash flow ----
  if (resource === 'cashflow' && method === 'GET') {
    return json(res, 200, cashflow(Math.min(26, Number(query.get('weeks')) || 13)));
  }

  // ---- payroll ----
  if (resource === 'payroll' && method === 'GET' && !idOrAction) {
    const from = query.get('from') || addDays(today(), -13);
    const to = query.get('to') || today();
    const rows = payrollPeriod(from, to);
    if (query.get('format') === 'csv') {
      const lines = [['Employee', 'Classification', 'Rate', 'Regular hrs', 'OT hrs', 'Total hrs', 'Gross pay'].map(csvCell).join(',')];
      rows.forEach(r => lines.push([r.name, r.classification, r.rate, r.regular_hours, r.ot_hours, r.total_hours, r.gross_pay].map(csvCell).join(',')));
      return text(res, 200, lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payroll-${from}-to-${to}.csv"` });
    }
    return json(res, 200, { from, to, rows,
      totals: { hours: round2(rows.reduce((s, r) => s + r.total_hours, 0)), gross: round2(rows.reduce((s, r) => s + r.gross_pay, 0)) } });
  }
  if (resource === 'payroll' && idOrAction === 'certified' && method === 'GET') {
    const report = certifiedPayroll(Number(query.get('job_id')), query.get('week_ending'));
    if (!report) return json(res, 404, { error: 'Job not found' });
    if (query.get('format') === 'csv') {
      const lines = [['Employee', 'Classification', ...report.days, 'Total hrs', 'Rate', 'Gross pay', 'Fringe', 'Total package'].map(csvCell).join(',')];
      report.employees.forEach(e => lines.push([e.name, e.classification, ...report.days.map(d => e.days[d] || 0),
        e.total, e.rate, e.gross_pay, e.fringe_total, e.total_package].map(csvCell).join(',')));
      return text(res, 200, lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="certified-payroll-${report.job.job_number}-${report.week_ending}.csv"` });
    }
    return json(res, 200, report);
  }

  // ---- dashboard ----
  if (resource === 'dashboard' && method === 'GET') {
    const one = sql => db.prepare(sql).get().n;
    const aging = { outstanding: 0, overdue: 0 };
    for (const inv of db.prepare(`SELECT * FROM invoices WHERE status NOT IN ('void','draft')`).all()) {
      const t = invoiceTotals(inv, paidOn(inv.id));
      if (t.balance <= 0.005) continue;
      aging.outstanding = round2(aging.outstanding + t.balance);
      if (inv.due_date && inv.due_date < today()) aging.overdue = round2(aging.overdue + t.balance);
    }
    const kpis = {
      activeJobs: one(`SELECT COUNT(*) n FROM jobs WHERE status IN ('planned','in_progress','on_hold')`),
      openWOs: one(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress')`),
      rushWOs: one(`SELECT COUNT(*) n FROM work_orders WHERE status IN ('open','in_progress') AND priority = 'rush'`),
      onClock: one(`SELECT COUNT(*) n FROM time_entries WHERE clock_out IS NULL`),
      pendingQuotes: one(`SELECT COUNT(*) n FROM quotes WHERE status IN ('draft','sent')`),
      lowStock: one(`SELECT COUNT(*) n FROM materials WHERE qty_on_hand <= reorder_point`),
      openPOs: one(`SELECT COUNT(*) n FROM purchase_orders WHERE status = 'ordered'`),
      pendingCards: one(`SELECT COUNT(*) n FROM job_cards WHERE status = 'submitted'`),
      pendingCOs: one(`SELECT COUNT(*) n FROM change_orders WHERE status = 'sent'`),
      quoteValue: round2(db.prepare(`SELECT * FROM quotes WHERE status IN ('draft','sent')`).all().reduce((s, q) => s + docTotals(q).total, 0)),
      arOutstanding: aging.outstanding, arOverdue: aging.overdue,
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
    const wip = db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status = 'in_progress'`).all();
    wip.forEach(r => { r.financials = jobFinancials(r.id); });
    return json(res, 200, {
      kpis, series, wip,
      todaySchedule: db.prepare(`SELECT s.*, e.name AS employee_name, j.job_number, j.title AS job_title FROM schedule s
        JOIN employees e ON e.id = s.employee_id LEFT JOIN jobs j ON j.id = s.job_id WHERE s.date = ? ORDER BY e.name`).all(today()),
      capacity: capacity(3),
    });
  }

  // ---- reports ----
  if (resource === 'reports' && method === 'GET') {
    const byClient = db.prepare(`SELECT c.id, c.name, COUNT(j.id) jobs FROM clients c
      LEFT JOIN jobs j ON j.client_id = c.id GROUP BY c.id`).all();
    byClient.forEach(c => {
      const jobs = db.prepare('SELECT id FROM jobs WHERE client_id = ?').all(c.id);
      const fins = jobs.map(j => jobFinancials(j.id));
      c.revenue = round2(fins.reduce((s, f) => s + f.sold_price, 0));
      c.profit = round2(fins.reduce((s, f) => s + f.profit, 0));
      c.margin_pct = c.revenue > 0 ? round2(c.profit / c.revenue * 100) : 0;
    });
    byClient.sort((a, b) => b.revenue - a.revenue);
    const jobs = db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id ORDER BY j.id DESC`).all()
      .map(j => ({ job_number: j.job_number, title: j.title, client: j.client_name, status: j.status, ...jobFinancials(j.id) }));
    const labor = db.prepare(`SELECT * FROM employees WHERE active = 1`).all().map(e => {
      const entries = db.prepare(`SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NOT NULL AND clock_in >= datetime('now','-30 days')`).all(e.id);
      const hours = entries.reduce((s, t) => s + F.hoursOf(t), 0);
      const billable = entries.filter(t => t.job_id).reduce((s, t) => s + F.hoursOf(t), 0);
      return { name: e.name, role: e.role, hours: round2(hours), billable_hours: round2(billable),
        utilization: hours > 0 ? round2(billable / hours * 100) : 0, cost: round2(hours * e.hourly_rate) };
    }).sort((a, b) => b.hours - a.hours);
    const quotes = db.prepare('SELECT status FROM quotes').all();
    const decided = quotes.filter(q => q.status === 'accepted' || q.status === 'declined');
    return json(res, 200, {
      byClient, jobs, labor,
      topMaterials: db.prepare(`SELECT COALESCE(m.name, jm.description) name, SUM(jm.qty) qty, SUM(jm.qty * jm.unit_cost) spend
        FROM job_materials jm LEFT JOIN materials m ON m.id = jm.material_id
        GROUP BY COALESCE(m.id, jm.description) ORDER BY spend DESC LIMIT 10`).all(),
      winRate: decided.length ? round2(decided.filter(q => q.status === 'accepted').length / decided.length * 100) : null,
      quoteCounts: ['draft', 'sent', 'accepted', 'declined'].map(s => ({ status: s, n: quotes.filter(q => q.status === s).length })),
      accuracy: laborAccuracy(),
      changeOrders: db.prepare(`SELECT * FROM change_orders`).all().reduce((acc, co) => {
        const t = docTotals(co).total;
        acc.count++; acc[co.status] = round2((acc[co.status] || 0) + t);
        return acc;
      }, { count: 0 }),
    });
  }

  // ---- archive search ----
  if (resource === 'search' && method === 'GET') {
    const q = (query.get('q') || '').trim().toLowerCase();
    const like = `%${q}%`;
    const results = [];
    const wos = q
      ? db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id
          WHERE lower(w.title || ' ' || w.description || ' ' || w.wo_number || ' ' || w.items || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY w.id DESC`).all(like)
      : db.prepare(`SELECT w.*, c.name AS client_name FROM work_orders w LEFT JOIN clients c ON c.id = w.client_id ORDER BY w.id DESC`).all();
    for (const w of wos) results.push({ type: 'work_order', id: w.id, number: w.wo_number, title: w.title, client: w.client_name,
      status: w.status, date: (w.completed_at || w.created_at || '').slice(0, 10), items: parseItems(w.items), ...woFinancials(w) });
    const jobs = q
      ? db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id
          WHERE lower(j.title || ' ' || j.description || ' ' || j.job_number || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY j.id DESC`).all(like)
      : db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id ORDER BY j.id DESC`).all();
    for (const j of jobs) results.push({ type: 'job', id: j.id, number: j.job_number, title: j.title, client: j.client_name,
      status: j.status, date: (j.completed_at || j.created_at || '').slice(0, 10),
      items: db.prepare('SELECT description AS desc, qty, unit_cost FROM job_materials WHERE job_id = ?').all(j.id), ...jobFinancials(j.id) });
    if (q) {
      for (const qt of db.prepare(`SELECT qt.*, c.name AS client_name FROM quotes qt LEFT JOIN clients c ON c.id = qt.client_id
          WHERE lower(qt.title || ' ' || qt.description || ' ' || qt.quote_number || ' ' || qt.items || ' ' || COALESCE(c.name,'')) LIKE ? ORDER BY qt.id DESC`).all(like)) {
        const t = docTotals(qt);
        results.push({ type: 'quote', id: qt.id, number: qt.quote_number, title: qt.title, client: qt.client_name,
          status: qt.status, date: (qt.created_at || '').slice(0, 10), items: parseItems(qt.items),
          sold_price: t.total, total_cost: t.est_cost, profit: t.est_profit, margin_pct: t.est_margin_pct });
      }
      for (const co of db.prepare(`SELECT co.*, c.name AS client_name FROM change_orders co LEFT JOIN clients c ON c.id = co.client_id
          WHERE lower(co.title || ' ' || co.description || ' ' || co.co_number || ' ' || co.items) LIKE ? ORDER BY co.id DESC`).all(like)) {
        const t = docTotals(co);
        results.push({ type: 'change_order', id: co.id, number: co.co_number, title: co.title, client: co.client_name,
          status: co.status, date: (co.created_at || '').slice(0, 10), items: parseItems(co.items),
          sold_price: t.total, total_cost: t.est_cost, profit: t.est_profit, margin_pct: t.est_margin_pct });
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
    const add = (kind, severity, title, detail) => insights.push({ kind, severity, title, detail });

    for (const j of db.prepare(`SELECT j.*, c.name AS client_name FROM jobs j LEFT JOIN clients c ON c.id = j.client_id WHERE j.status != 'planned'`).all()) {
      const f = jobFinancials(j.id);
      if (f.sold_price > 0 && f.margin_pct < targetMargin) {
        add('margin', f.margin_pct < 10 ? 'high' : 'medium', `${j.job_number} ${j.title} is running a ${f.margin_pct}% margin`,
          `Sold at ${T.money(f.sold_price)} with ${T.money(f.total_cost)} in costs so far (target ${targetMargin}%). ${j.status === 'completed' ? 'Use this as a pricing reference next time.' : 'Watch labor hours and change-order any added scope.'}`);
      }
      if (f.labor_variance_pct !== null && f.labor_variance_pct > 20 && j.status === 'in_progress') {
        add('labor', 'high', `${j.job_number} is ${f.labor_variance_pct}% over its labor estimate`,
          `Estimated ${f.est_labor_hours} hours, ${f.labor_hours} clocked and still open. If the extra hours came from added scope, raise a change order now rather than absorbing it.`);
      }
    }
    // accounts receivable
    for (const inv of db.prepare(`SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id = i.client_id WHERE i.status NOT IN ('void','draft','paid')`).all()) {
      const t = invoiceTotals(inv, paidOn(inv.id));
      if (t.balance > 0.005 && inv.due_date && inv.due_date < today()) {
        const days = Math.floor((new Date(today()) - new Date(inv.due_date)) / 864e5);
        add('receivable', days > 45 ? 'high' : 'medium', `${inv.invoice_number} is ${days} days past due — ${T.money(t.balance)} from ${inv.client_name || 'client'}`,
          `Due ${inv.due_date}. Money you have already spent on labor and material. Call before it ages another month.`);
      }
    }
    const drafts = db.prepare(`SELECT COUNT(*) n FROM invoices WHERE status = 'draft'`).get().n;
    if (drafts) add('receivable', 'medium', `${drafts} invoice${drafts > 1 ? 's are' : ' is'} still sitting in draft`,
      'Unsent invoices cannot be paid. Send them today and start the clock on your terms.');
    // pending change orders
    for (const co of db.prepare(`SELECT co.*, j.job_number FROM change_orders co LEFT JOIN jobs j ON j.id = co.job_id WHERE co.status = 'sent'`).all()) {
      add('changeorder', 'high', `Change order ${co.co_number} on ${co.job_number} is awaiting client approval`,
        `${T.money(docTotals(co).total)} of work that is not yet under contract. Do not let the crew start this until it is signed.`);
    }
    const unpricedIssues = db.prepare(`SELECT c.*, j.job_number FROM job_cards c LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.issues != '' AND NOT EXISTS (SELECT 1 FROM change_orders co WHERE co.source_card_id = c.id)`).all();
    for (const c of unpricedIssues.slice(0, 5)) {
      add('changeorder', 'medium', `Field issue reported on ${c.job_number || 'a job'} with no change order raised`,
        `"${c.issues.slice(0, 140)}" — if this is outside the original scope, price it as a change order before you eat the cost.`);
    }
    // subcontractor compliance
    for (const s of db.prepare('SELECT * FROM subcontractors WHERE active = 1').all()) {
      const coi = db.prepare(`SELECT * FROM sub_documents WHERE sub_id = ? AND doc_type = 'COI' ORDER BY expires_on DESC`).get(s.id);
      if (!coi || !coi.expires_on) { add('compliance', 'high', `${s.name} has no certificate of insurance on file`, 'Do not let them on a site until you have a current COI. Your policy will not cover an uninsured sub.'); continue; }
      const days = Math.floor((new Date(coi.expires_on) - new Date(today())) / 864e5);
      if (days < 0) add('compliance', 'high', `${s.name}'s insurance expired ${Math.abs(days)} days ago`,
        `COI with ${coi.carrier || 'their carrier'} lapsed ${coi.expires_on}. Pull them off the schedule until a renewal certificate is on file.`);
      else if (days <= 30) add('compliance', 'medium', `${s.name}'s insurance expires in ${days} days (${coi.expires_on})`,
        'Request the renewal certificate now so it does not lapse mid-job.');
    }
    // capacity
    for (const w of capacity(3)) {
      if (w.overcommitted) add('capacity', 'high', `Week of ${w.week_start} is overcommitted — ${w.committed_hours} hrs scheduled against ${w.available_hours} available`,
        'Something will slip. Move work, add a temp, or call the customer before the week starts rather than after.');
      for (const c of w.conflicts.slice(0, 3)) add('capacity', 'medium', `${c.employee} is double-booked on ${c.date}`,
        `Assigned to ${c.jobs.join(' and ')} — ${c.hours} hours in one day. Fix the schedule before they show up at the wrong site.`);
    }
    // stock, overdue work orders, stale quotes
    for (const m of db.prepare(`SELECT * FROM materials WHERE qty_on_hand <= reorder_point`).all()) {
      const used = db.prepare(`SELECT COALESCE(SUM(qty),0) u FROM job_materials WHERE material_id = ? AND created_at >= datetime('now','-90 days')`).get(m.id).u;
      const suggested = Math.max(Math.ceil(m.reorder_point * 1.5 - m.qty_on_hand), Math.ceil(used / 3) || 0, 1);
      add('stock', m.qty_on_hand <= m.reorder_point / 2 ? 'high' : 'medium',
        `${m.name} is low: ${m.qty_on_hand} ${m.unit} on hand (reorder at ${m.reorder_point})`,
        `90-day usage: ${used} ${m.unit}. Suggested order: ${suggested} ${m.unit} from ${m.vendor || 'your usual vendor'} (~${T.money(round2(suggested * m.unit_cost))}).`);
    }
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE status IN ('open','in_progress') AND due_date != '' AND due_date < ?`).all(today())) {
      add('overdue', 'high', `${w.wo_number} "${w.title}" is past due (${w.due_date})`,
        `Priority ${w.priority}. Reassign shop time or call the customer with a new date before it becomes a complaint.`);
    }
    for (const qt of db.prepare(`SELECT q.*, c.name AS client_name FROM quotes q LEFT JOIN clients c ON c.id = q.client_id WHERE q.status = 'sent' AND q.created_at < datetime('now','-5 days')`).all()) {
      add('quote', 'medium', `Quote ${qt.quote_number} to ${qt.client_name || 'client'} has been out ${Math.floor((Date.now() - new Date(qt.created_at.replace(' ', 'T') + 'Z')) / 86400e3)} days`,
        `"${qt.title}" — worth ${T.money(docTotals(qt).total)}. Quotes followed up within a week close at roughly double the rate.`);
    }
    const pendingCards = db.prepare(`SELECT COUNT(*) n FROM job_cards WHERE status = 'submitted'`).get().n;
    if (pendingCards) add('cards', 'medium', `${pendingCards} field job card${pendingCards > 1 ? 's' : ''} waiting on office review`,
      'Crew reports sitting unreviewed are hours and materials not yet costed to the job.');
    // estimating accuracy
    const acc = laborAccuracy();
    if (acc.avg_variance_pct !== null && Math.abs(acc.avg_variance_pct) > 10) {
      add('estimating', acc.avg_variance_pct > 25 ? 'high' : 'medium',
        `Your labor estimates run ${acc.avg_variance_pct > 0 ? acc.avg_variance_pct + '% over' : Math.abs(acc.avg_variance_pct) + '% under'} on average`,
        `Across ${acc.samples.length} jobs with estimates. The quote builder now applies a ${acc.factor}× reality check to new estimates — but the real fix is padding labor at bid time.`);
    }
    const all = db.prepare(`SELECT status FROM quotes`).all();
    const decided = all.filter(x => x.status === 'accepted' || x.status === 'declined');
    if (decided.length) {
      const won = decided.filter(x => x.status === 'accepted').length;
      const rate = Math.round(won / decided.length * 100);
      add('winrate', 'info', `Quote win rate: ${rate}%`, `${won} won of ${decided.length} decided. ${rate > 60 ? 'Strong close rate — you may have room to raise prices.' : rate < 30 ? 'Low close rate — review pricing or qualify leads harder.' : 'Healthy range.'}`);
    }
    const top = db.prepare(`SELECT c.name, SUM(j.sold_price) total FROM jobs j JOIN clients c ON c.id = j.client_id GROUP BY c.id ORDER BY total DESC LIMIT 1`).get();
    if (top) add('client', 'info', `Top client: ${top.name} (${T.money(round2(top.total))} in jobs)`,
      'Repeat clients cost nothing to win. Schedule a check-in and ask what is on their board for next quarter.');
    if (!cfg.smtp_host) add('setup', 'info', 'Email delivery is not configured yet',
      'Quotes, change orders and invoices save to the outbox for preview instead of sending. Add SMTP details in Settings.');

    const order = { high: 0, medium: 1, info: 2 };
    insights.sort((a, b) => order[a.severity] - order[b.severity]);
    return json(res, 200, insights);
  }

  // ---- settings / users / logs ----
  if (resource === 'settings') {
    if (method === 'GET') {
      const s = settings();
      if (s.smtp_pass) s.smtp_pass = '••••••••';
      return json(res, 200, s);
    }
    if (method === 'PUT') {
      const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      for (const [k, v] of Object.entries(body)) {
        if (k === 'seeded') continue;
        if (k === 'smtp_pass' && /^•+$/.test(String(v))) continue;
        stmt.run(k, String(v));
      }
      auth.audit(user, 'settings_updated', Object.keys(body).join(', '));
      return json(res, 200, { ok: true });
    }
  }
  if (resource === 'users') {
    if (method === 'GET') return json(res, 200, db.prepare(`SELECT u.id, u.username, u.role, u.employee_id, u.active, u.last_login, e.name AS employee_name
      FROM users u LEFT JOIN employees e ON e.id = u.employee_id ORDER BY u.role, u.username`).all());
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
      if (target.role === 'admin' && admins <= 1 && ((body.role && body.role !== 'admin') || Number(body.active) === 0)) {
        return json(res, 409, { error: 'This is the last active admin — promote someone else first' });
      }
      if (body.password) {
        if (String(body.password).length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), target.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
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
  // ---- backups & export ----
  if (resource === 'backups') {
    if (method === 'GET' && !idOrAction) return json(res, 200, { backups: backup.list(), keep: backup.KEEP });
    if (method === 'POST' && !idOrAction) {
      const b = backup.snapshot(db, 'manual');
      auth.audit(user, 'backup_created', b.filename);
      return json(res, 200, { ok: true, ...b, message: `Backup written (${Math.round(b.size / 1024)} KB)` });
    }
    if (method === 'GET' && idOrAction) {
      const file = path.join(backup.BACKUP_DIR, path.basename(decodeURIComponent(idOrAction)));
      if (!file.startsWith(backup.BACKUP_DIR) || !fs.existsSync(file)) return json(res, 404, { error: 'Backup not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
      return fs.createReadStream(file).pipe(res);
    }
    if (method === 'DELETE' && idOrAction) {
      const file = path.join(backup.BACKUP_DIR, path.basename(decodeURIComponent(idOrAction)));
      if (file.startsWith(backup.BACKUP_DIR) && fs.existsSync(file)) fs.unlinkSync(file);
      return json(res, 200, { ok: true });
    }
  }
  if (resource === 'export' && method === 'GET') {
    const what = idOrAction || 'json';
    if (what === 'json') {
      auth.audit(user, 'data_exported', 'full json');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="dts-export-${today()}.json"` });
      return res.end(JSON.stringify(backup.exportJson(db), null, 2));
    }
    const table = what.replace(/\.csv$/, '');
    try {
      const csv = backup.exportCsv(db, table);
      return text(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${table}-${today()}.csv"` });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // ---- time entry corrections ----
  if (resource === 'timeentries') {
    const validate = b => {
      if (!b.clock_in) return 'A clock-in time is required';
      const inT = new Date(b.clock_in);
      if (!Number.isFinite(inT.getTime())) return 'Clock-in is not a valid time';
      if (b.clock_out) {
        const outT = new Date(b.clock_out);
        if (!Number.isFinite(outT.getTime())) return 'Clock-out is not a valid time';
        if (outT <= inT) return 'Clock-out must be after clock-in';
        if ((outT - inT) / 3600e3 > 24) return 'That shift is longer than 24 hours — check the dates';
      }
      return null;
    };
    const norm = v => v ? String(v).replace('T', ' ').slice(0, 19) : null;

    if (method === 'POST') {
      const err = validate(body);
      if (err) return json(res, 400, { error: err });
      if (!db.prepare('SELECT id FROM employees WHERE id = ?').get(body.employee_id)) return json(res, 400, { error: 'Unknown employee' });
      const info = db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, clock_out, notes)
        VALUES (?,?,?,?,?,?)`).run(body.employee_id, body.job_id || null, body.job_id ? 'job' : 'shift',
        norm(body.clock_in), norm(body.clock_out), body.notes || '');
      auth.audit(user, 'time_entry_added', `employee ${body.employee_id} ${norm(body.clock_in)}`);
      return json(res, 200, { ok: true, id: info.lastInsertRowid });
    }
    if (method === 'PUT' && idOrAction) {
      const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(idOrAction);
      if (!entry) return json(res, 404, { error: 'Time entry not found' });
      const merged = { ...entry, ...body };
      const err = validate(merged);
      if (err) return json(res, 400, { error: err });
      db.prepare(`UPDATE time_entries SET employee_id = ?, job_id = ?, entry_type = ?, clock_in = ?, clock_out = ?, notes = ? WHERE id = ?`)
        .run(merged.employee_id, merged.job_id || null, merged.job_id ? 'job' : 'shift',
          norm(merged.clock_in), norm(merged.clock_out), merged.notes || '', entry.id);
      auth.audit(user, 'time_entry_edited',
        `#${entry.id}: ${entry.clock_in}–${entry.clock_out || 'open'} → ${norm(merged.clock_in)}–${norm(merged.clock_out) || 'open'}`);
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE' && idOrAction) {
      const entry = db.prepare('SELECT t.*, e.name FROM time_entries t JOIN employees e ON e.id = t.employee_id WHERE t.id = ?').get(idOrAction);
      if (!entry) return json(res, 404, { error: 'Time entry not found' });
      db.prepare('DELETE FROM time_entries WHERE id = ?').run(entry.id);
      auth.audit(user, 'time_entry_deleted', `${entry.name} ${entry.clock_in}`);
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
      co: nextNumber('change_orders', 'co_number', 'CO'), invoice: nextNumber('invoices', 'invoice_number', 'INV'),
    });
  }

  if (RESOURCES[resource]) {
    const result = crudHandler(resource, method, /^\d+$/.test(idOrAction || '') ? idOrAction : null, body);
    if (result && result.error) return json(res, 404, result);
    return json(res, 200, result);
  }
  return json(res, 404, { error: 'Unknown endpoint' });
}

// ---------------------------------------------------------------- static
function serveStatic(res, urlPath, fallback) {
  let filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(PUBLIC_DIR, fallback);
  const ext = path.extname(filePath);
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (ext === '.js' && path.basename(filePath) === 'sw.js') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}
const ASSET = /^\/(css|js|img)\//;

// ---------------------------------------------------------------- request handler
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const urlPath = decodeURIComponent(url.pathname);
  const method = req.method;
  const isUpload = (req.headers['content-type'] || '').includes('multipart/form-data');

  try {
    // the payment webhook needs the raw body to verify its signature, so it runs
    // before any parsing and authenticates on the signature rather than a session
    if (urlPath === '/api/webhooks/stripe' && method === 'POST') return await stripeWebhook(req, res);

    const body = (!isUpload && (method === 'POST' || method === 'PUT')) ? await readBody(req) : {};

    // public customer documents
    if (/^\/(q|co|inv)(\/|$)/.test(urlPath)) return publicRoutes(req, res, urlPath, body);

    // public assets
    if (ASSET.test(urlPath) || urlPath === '/favicon.ico' || urlPath === '/sw.js' || urlPath === '/manifest.webmanifest') {
      return serveStatic(res, urlPath, 'index.html');
    }

    // auth
    if (urlPath === '/api/auth/login' && method === 'POST') {
      const result = auth.login(body.username, body.password);
      if (!result) { auth.audit(null, 'login_failed', String(body.username || '').slice(0, 40)); return json(res, 401, { error: 'Incorrect username or password' }); }
      auth.audit(result.user, 'login', result.user.role);
      return json(res, 200, { ok: true, role: result.user.role, home: result.user.role === 'admin' ? '/' : '/portal' },
        { 'Set-Cookie': auth.sessionCookie(result.session.token, result.session.expires) });
    }
    if (urlPath === '/api/auth/logout' && method === 'POST') {
      auth.logout(req);
      return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }

    const user = auth.currentUser(req);

    if (urlPath === '/api/auth/me' && method === 'GET') {
      if (!user) return json(res, 401, { error: 'Not signed in' });
      return json(res, 200, { id: user.id, username: user.username, role: user.role, employee_id: user.employee_id,
        name: user.employee_name || user.username, employee_role: user.employee_role, company: settings().company_name });
    }
    if (urlPath === '/api/auth/password' && method === 'POST') {
      if (!user) return json(res, 401, { error: 'Not signed in' });
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!verifyPassword(body.current, row.password_hash)) return json(res, 403, { error: 'Current password is incorrect' });
      if (String(body.next || '').length < 6) return json(res, 400, { error: 'New password must be at least 6 characters' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), user.id);
      auth.audit(user, 'password_changed', '');
      return json(res, 200, { ok: true, message: 'Password updated' });
    }

    if (urlPath === '/login' || urlPath === '/login.html') {
      if (user) return redirect(res, user.role === 'admin' ? '/' : '/portal');
      return serveStatic(res, '/login.html', 'login.html');
    }

    if (!user) {
      if (urlPath.startsWith('/api/')) return json(res, 401, { error: 'Session expired — please sign in again' });
      return redirect(res, '/login');
    }

    // uploaded photos are visible to any signed-in employee
    if (urlPath.startsWith('/uploads/')) {
      const file = path.join(UPLOAD_DIR, path.basename(urlPath));
      if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }

    if (urlPath === '/portal' || urlPath === '/portal.html') return serveStatic(res, '/portal.html', 'portal.html');
    if (urlPath.startsWith('/api/portal/')) return await portalApi(req, res, urlPath.split('/').filter(Boolean), body, user, url);

    const isAdmin = user.role === 'admin';
    if (urlPath.startsWith('/api/')) {
      if (!isAdmin) return json(res, 403, { error: 'Admin access required' });
      return await adminApi(req, res, urlPath.split('/').filter(Boolean), body, url.searchParams, user, url);
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
  console.log(`  Office console: /   ·  Crew portal: /portal  ·  Sign in: /login`);
  backup.schedule(db, m => console.log(`  ${m}`));
  console.log('');
});
