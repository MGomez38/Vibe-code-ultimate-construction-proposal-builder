/**
 * Tests for every calculation that ends up on a customer's invoice or an
 * employee's paycheck. Runs against a throwaway in-memory database.
 *
 *   node --test test/
 */
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../lib/schema');
const makeFinance = require('../lib/finance');
const { docTotals, invoiceTotals } = require('../lib/finance');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  schema.create(db);
  return db;
}

/** Insert a completed shift so a job accrues real labor cost. */
function punch(db, employeeId, jobId, dayOffset, hours) {
  const start = new Date(Date.UTC(2026, 0, 5 + dayOffset, 15, 0, 0));
  const end = new Date(start.getTime() + hours * 3600e3);
  const fmt = d => d.toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, clock_out) VALUES (?,?,?,?,?)`)
    .run(employeeId, jobId, 'job', fmt(start), fmt(end));
}

// ---------------------------------------------------------------- priced documents
describe('docTotals — quotes and change orders', () => {
  test('materials, labor, markup and tax compound in the right order', () => {
    const t = docTotals({
      items: JSON.stringify([{ qty: 10, unit_cost: 4, unit_price: 10 }]),  // 100 sell / 40 cost
      labor_hours: 10, labor_rate: 50,                                      // 500
      markup_pct: 10, tax_pct: 5,
    });
    assert.equal(t.materials, 100);
    assert.equal(t.labor, 500);
    assert.equal(t.subtotal, 600);
    assert.equal(t.markup, 60);                       // 10% of subtotal
    assert.equal(t.tax, 33);                          // 5% of (subtotal + markup), not subtotal
    assert.equal(t.total, 693);
  });

  test('estimated cost uses item cost plus a labor burden, never the sell price', () => {
    const t = docTotals({
      items: JSON.stringify([{ qty: 2, unit_cost: 100, unit_price: 250 }]),
      labor_hours: 10, labor_rate: 100, markup_pct: 0, tax_pct: 0,
    });
    assert.equal(t.est_cost, 200 + 600);              // 200 material + 60% of 1000 billed labor
    assert.equal(t.total, 1500);
    assert.equal(t.est_profit, 700);
    assert.equal(t.est_margin_pct, 46.67);
  });

  test('an empty document is all zeroes rather than NaN', () => {
    const t = docTotals({});
    for (const k of ['materials', 'labor', 'subtotal', 'markup', 'tax', 'total', 'est_cost']) {
      assert.equal(t[k], 0, `${k} should be 0`);
    }
    assert.equal(t.est_margin_pct, 0, 'margin must not divide by zero');
  });

  test('malformed item JSON degrades to zero instead of throwing', () => {
    assert.equal(docTotals({ items: 'not json' }).materials, 0);
    assert.equal(docTotals({ items: '{"not":"an array"}' }).materials, 0);
  });

  test('money is rounded to cents', () => {
    const t = docTotals({ items: JSON.stringify([{ qty: 3, unit_price: 33.333 }]), tax_pct: 7.25 });
    assert.equal(t.materials, 100);
    assert.equal(Math.round(t.total * 100), t.total * 100, 'total must be an exact cent value');
  });
});

// ---------------------------------------------------------------- invoices
describe('invoiceTotals — retainage and balance', () => {
  test('retainage is withheld from the billed total, not added to it', () => {
    const t = invoiceTotals({ items: JSON.stringify([{ qty: 1, unit_price: 10000 }]), tax_pct: 0, retainage_pct: 10 });
    assert.equal(t.subtotal, 10000);
    assert.equal(t.retainage, 1000);
    assert.equal(t.total, 9000, 'customer owes the total less retainage');
  });

  test('retainage is calculated after tax', () => {
    const t = invoiceTotals({ items: JSON.stringify([{ qty: 1, unit_price: 1000 }]), tax_pct: 10, retainage_pct: 10 });
    assert.equal(t.tax, 100);
    assert.equal(t.retainage, 110);                   // 10% of 1100, not of 1000
    assert.equal(t.total, 990);
  });

  test('balance subtracts payments and can reach exactly zero', () => {
    const inv = { items: JSON.stringify([{ qty: 1, unit_price: 500 }]) };
    assert.equal(invoiceTotals(inv, 200).balance, 300);
    assert.equal(invoiceTotals(inv, 500).balance, 0);
  });

  test('overpayment produces a negative balance rather than clamping', () => {
    const t = invoiceTotals({ items: JSON.stringify([{ qty: 1, unit_price: 100 }]) }, 150);
    assert.equal(t.balance, -50);
  });
});

// ---------------------------------------------------------------- work orders
describe('woFinancials', () => {
  let F;
  beforeEach(() => { F = makeFinance(freshDb()); });

  test('sold price falls back to items plus labor when left at zero', () => {
    const f = F.woFinancials({
      items: JSON.stringify([{ qty: 2, unit_cost: 50, unit_price: 100 }]),
      labor_hours: 10, labor_rate: 60, sold_price: 0,
    });
    assert.equal(f.sold_price, 200 + 600);
  });

  test('an explicit sold price wins over the computed one', () => {
    const f = F.woFinancials({
      items: JSON.stringify([{ qty: 1, unit_cost: 10, unit_price: 20 }]),
      labor_hours: 1, labor_rate: 100, sold_price: 5000,
    });
    assert.equal(f.sold_price, 5000);
    assert.equal(f.profit, F.round2(5000 - f.total_cost));
  });

  test('margin is zero rather than infinite on a free work order', () => {
    const f = F.woFinancials({ items: '[]', labor_hours: 0, labor_rate: 0, sold_price: 0 });
    assert.equal(f.margin_pct, 0);
  });
});

// ---------------------------------------------------------------- jobs
describe('jobFinancials', () => {
  let db, F, jobId;

  beforeEach(() => {
    db = freshDb();
    F = makeFinance(db);
    db.prepare(`INSERT INTO clients (name) VALUES ('Acme')`).run();
    db.prepare(`INSERT INTO employees (name, hourly_rate) VALUES ('Worker', 40)`).run();
    jobId = db.prepare(`INSERT INTO jobs (job_number, client_id, title, status, sold_price, est_labor_hours)
      VALUES ('J-1', 1, 'Test job', 'in_progress', 10000, 100)`).run().lastInsertRowid;
  });

  test('cost is the sum of materials, clocked labor, shop work and subs', () => {
    db.prepare(`INSERT INTO job_materials (job_id, description, qty, unit_cost) VALUES (?,?,?,?)`).run(jobId, 'Lumber', 10, 25);
    punch(db, 1, jobId, 0, 8);                        // 8h × $40 = 320
    db.prepare(`INSERT INTO work_orders (wo_number, job_id, title, items, labor_hours, labor_rate, sold_price)
      VALUES ('WO-1', ?, 'Fab', ?, 10, 60, 1000)`).run(jobId, JSON.stringify([{ qty: 1, unit_cost: 200, unit_price: 400 }]));
    db.prepare(`INSERT INTO subcontractors (name) VALUES ('Sub')`).run();
    db.prepare(`INSERT INTO job_subs (job_id, sub_id, contract_amount) VALUES (?, 1, 1500)`).run(jobId);

    const f = F.jobFinancials(jobId);
    assert.equal(f.material_cost, 250);
    assert.equal(f.labor_hours, 8);
    assert.equal(f.labor_cost, 320);
    assert.equal(f.wo_cost, 200 + 60 * 10 * 0.55);    // material + burdened shop labor
    assert.equal(f.sub_cost, 1500);
    assert.equal(f.total_cost, F.round2(250 + 320 + f.wo_cost + 1500));
  });

  test('an open punch is ignored until the employee clocks out', () => {
    db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in) VALUES (1, ?, 'job', '2026-01-05 15:00:00')`).run(jobId);
    assert.equal(F.jobFinancials(jobId).labor_hours, 0);
  });

  test('approved change orders raise the contract; pending ones do not', () => {
    const co = (status, price) => db.prepare(`INSERT INTO change_orders (co_number, job_id, title, items, status, schedule_days)
      VALUES (?,?,?,?,?,?)`).run(`CO-${price}`, jobId, 'Extra', JSON.stringify([{ qty: 1, unit_price: price }]), status, 2);
    co('approved', 2000);
    co('sent', 500);
    co('declined', 9999);

    const f = F.jobFinancials(jobId);
    assert.equal(f.base_price, 10000);
    assert.equal(f.change_orders.approved, 2000);
    assert.equal(f.change_orders.pending, 500);
    assert.equal(f.sold_price, 12000, 'contract = base + approved only');
    assert.equal(f.change_orders.added_days, 2, 'only approved change orders extend the schedule');
  });

  test('profit and margin follow the contract value, not the base price', () => {
    db.prepare(`INSERT INTO change_orders (co_number, job_id, title, items, status)
      VALUES ('CO-1', ?, 'Extra', ?, 'approved')`).run(jobId, JSON.stringify([{ qty: 1, unit_price: 10000 }]));
    db.prepare(`INSERT INTO job_materials (job_id, description, qty, unit_cost) VALUES (?, 'Steel', 1, 5000)`).run(jobId);
    const f = F.jobFinancials(jobId);
    assert.equal(f.sold_price, 20000);
    assert.equal(f.profit, 15000);
    assert.equal(f.margin_pct, 75);
  });

  test('labor variance compares clocked hours against the estimate', () => {
    punch(db, 1, jobId, 0, 8);
    punch(db, 1, jobId, 1, 8);                        // 16 of 100 estimated
    assert.equal(F.jobFinancials(jobId).labor_variance_pct, -84);
  });

  test('variance is null when no estimate was recorded', () => {
    db.prepare('UPDATE jobs SET est_labor_hours = 0 WHERE id = ?').run(jobId);
    assert.equal(F.jobFinancials(jobId).labor_variance_pct, null);
  });

  test('invoicing rolls up billed, paid, retained and outstanding', () => {
    const inv = db.prepare(`INSERT INTO invoices (invoice_number, job_id, items, retainage_pct, status)
      VALUES ('INV-1', ?, ?, 10, 'sent')`).run(jobId, JSON.stringify([{ qty: 1, unit_price: 5000 }])).lastInsertRowid;
    db.prepare(`INSERT INTO payments (invoice_id, amount, received_on) VALUES (?, 1000, '2026-01-10')`).run(inv);

    const inv2 = F.jobFinancials(jobId).invoicing;
    assert.equal(inv2.billed, 4500, 'billed is net of retainage');
    assert.equal(inv2.retained, 500);
    assert.equal(inv2.paid, 1000);
    assert.equal(inv2.outstanding, 3500);
  });

  test('voided invoices are excluded from billing totals', () => {
    db.prepare(`INSERT INTO invoices (invoice_number, job_id, items, status) VALUES ('INV-V', ?, ?, 'void')`)
      .run(jobId, JSON.stringify([{ qty: 1, unit_price: 9999 }]));
    assert.equal(F.jobFinancials(jobId).invoicing.billed, 0);
  });

  test('a missing job returns null instead of throwing', () => {
    assert.equal(F.jobFinancials(99999), null);
  });

  test('margin does not divide by zero on an unpriced job', () => {
    db.prepare('UPDATE jobs SET sold_price = 0 WHERE id = ?').run(jobId);
    assert.equal(F.jobFinancials(jobId).margin_pct, 0);
  });
});

// ---------------------------------------------------------------- rounding
describe('rounding', () => {
  test('round2 keeps values at exact cents', () => {
    const F = makeFinance(freshDb());
    assert.equal(F.round2(0.1 + 0.2), 0.3);
    assert.equal(F.round2(1.005), 1.01);
    assert.equal(F.round2(undefined), 0);
    assert.equal(F.round2('12.345'), 12.35);
  });
});
