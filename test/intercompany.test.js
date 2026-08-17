/**
 * Two legal entities, one of which builds what the other installs.
 *
 * The rule these tests pin down: when All Spec fabricates for DTS, All Spec's
 * revenue is the transfer price and DTS's job cost is that same transfer price
 * — not All Spec's internal cost. At group level the two cancel, so only what
 * an outside customer paid counts as revenue.
 */
'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const schema = require('../lib/schema');
const makeFinance = require('../lib/finance');
const makeScope = require('../lib/scope');

function build() {
  const db = new DatabaseSync(':memory:');
  schema.create(db);
  const F = makeFinance(db);

  const co = (code, name, kind) => db.prepare(
    `INSERT INTO companies (code, name, kind) VALUES (?,?,?)`).run(code, name, kind).lastInsertRowid;
  const SHOP = co('AS', 'All Spec Sheetmetal', 'fabrication');
  const FIELD = co('DTS', 'Diverse Trade Services', 'construction');

  // each entity carries the other as a customer
  const shopSeesField = db.prepare(`INSERT INTO clients (company_id, name, is_internal) VALUES (?,?,1)`).run(SHOP, 'DTS LLC').lastInsertRowid;
  const outsideCustomer = db.prepare(`INSERT INTO clients (company_id, name, is_internal) VALUES (?,?,0)`).run(FIELD, 'Ironwood Builders').lastInsertRowid;
  db.prepare('UPDATE companies SET sister_client_id = ? WHERE id = ?').run(shopSeesField, SHOP);

  return { db, F, SHOP, FIELD, shopSeesField, outsideCustomer };
}

describe('intercompany fabrication', () => {
  let ctx, jobId;

  beforeEach(() => {
    ctx = build();
    // DTS wins a $50k install from an outside customer
    jobId = ctx.db.prepare(`INSERT INTO jobs (company_id, job_number, client_id, title, status, sold_price)
      VALUES (?,?,?,?,?,?)`).run(ctx.FIELD, 'DTS-J-1', ctx.outsideCustomer, 'Office buildout', 'in_progress', 50000).lastInsertRowid;
  });

  /** All Spec builds it for 4,000 of material+labour and charges DTS 10,000. */
  function raiseFab({ charge = 10000, materialCost = 4000, status = 'completed' } = {}) {
    return ctx.db.prepare(`INSERT INTO work_orders
      (company_id, wo_number, client_id, title, items, labor_hours, labor_rate, sold_price,
       origin_job_id, origin_company_id, status, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ctx.SHOP, 'AS-WO-1', ctx.shopSeesField, 'Window bucks',
      JSON.stringify([{ desc: 'Steel', qty: 1, unit_cost: materialCost, unit_price: materialCost * 1.6 }]),
      0, 0, charge, jobId, ctx.FIELD, status, '2026-01-20 12:00:00').lastInsertRowid;
  }

  test("the buying job is charged the transfer price, not the shop's cost", () => {
    raiseFab({ charge: 10000, materialCost: 4000 });
    const f = ctx.F.jobFinancials(jobId);
    assert.equal(f.intercompany_cost, 10000, 'DTS pays what it was billed');
    assert.equal(f.total_cost, 10000);
    assert.equal(f.profit, 40000);
  });

  test("the shop keeps the margin between its cost and the transfer price", () => {
    const woId = raiseFab({ charge: 10000, materialCost: 4000 });
    const wo = ctx.db.prepare('SELECT * FROM work_orders WHERE id = ?').get(woId);
    const f = ctx.F.woFinancials(wo);
    assert.equal(f.sold_price, 10000);
    assert.equal(f.total_cost, 4000);
    assert.equal(f.profit, 6000);
  });

  test('intercompany work is not double counted as the job\'s own shop work', () => {
    raiseFab();
    const f = ctx.F.jobFinancials(jobId);
    assert.equal(f.wo_cost, 0, 'the ticket lives on the other company, not this job');
    assert.equal(f.intercompany_cost, 10000);
  });

  test('the flow is listed on the job so the office can see what is in the shop', () => {
    raiseFab({ status: 'in_progress' });
    const f = ctx.F.jobFinancials(jobId);
    assert.equal(f.intercompany.length, 1);
    assert.equal(f.intercompany[0].charged, 10000);
    assert.equal(f.intercompany[0].status, 'in_progress');
  });

  test('work in progress still costs the job — you owe for it either way', () => {
    raiseFab({ status: 'in_progress' });
    assert.equal(ctx.F.jobFinancials(jobId).intercompany_cost, 10000);
  });
});

describe('group consolidation', () => {
  let ctx;

  beforeEach(() => {
    ctx = build();
    // completed DTS job for an outside customer, with fab bought from All Spec
    const jobId = ctx.db.prepare(`INSERT INTO jobs (company_id, job_number, client_id, title, status, sold_price, completed_at)
      VALUES (?,?,?,?,?,?,?)`).run(ctx.FIELD, 'DTS-J-1', ctx.outsideCustomer, 'Buildout', 'completed', 50000, '2026-02-01 12:00:00').lastInsertRowid;
    ctx.db.prepare(`INSERT INTO work_orders (company_id, wo_number, client_id, title, items, sold_price,
      origin_job_id, origin_company_id, status, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      ctx.SHOP, 'AS-WO-1', ctx.shopSeesField, 'Window bucks',
      JSON.stringify([{ desc: 'Steel', qty: 1, unit_cost: 4000, unit_price: 6400 }]), 10000,
      jobId, ctx.FIELD, 'archived', '2026-01-20 12:00:00');
    // plus DTS's own labour cost on the job
    ctx.db.prepare(`INSERT INTO job_materials (job_id, description, qty, unit_cost) VALUES (?,?,?,?)`).run(jobId, 'Drywall', 1, 5000);
  });

  test('each entity stands alone on its own books', () => {
    const g = ctx.F.groupSummary();
    const shop = g.entities.find(e => e.code === 'AS');
    const field = g.entities.find(e => e.code === 'DTS');
    assert.equal(shop.revenue, 10000);
    assert.equal(shop.internal_revenue, 10000, 'all of the shop revenue came from the sister company');
    assert.equal(shop.external_revenue, 0);
    assert.equal(shop.profit, 6000);
    assert.equal(field.revenue, 50000);
    assert.equal(field.external_revenue, 50000);
    assert.equal(field.profit, 35000, '50k less 10k fab less 5k materials');
  });

  test('group revenue counts only what an outside customer paid', () => {
    const { group } = ctx.F.groupSummary();
    assert.equal(group.combined_revenue_before_elimination, 60000);
    assert.equal(group.intercompany_revenue, 10000);
    assert.equal(group.external_revenue, 50000, 'the 10k never left the group');
  });

  test('group profit equals the sum of both entities once work is delivered', () => {
    const g = ctx.F.groupSummary();
    const sum = g.entities.reduce((s, e) => s + e.profit, 0);
    assert.equal(g.group.profit, sum);
    assert.equal(g.group.profit, 41000, '50k revenue less 4k steel less 5k drywall');
  });

  test('unfinished intercompany work is not eliminated early', () => {
    // a second fab ticket for a job that has NOT completed
    const openJob = ctx.db.prepare(`INSERT INTO jobs (company_id, job_number, client_id, title, status, sold_price)
      VALUES (?,?,?,?,?,?)`).run(ctx.FIELD, 'DTS-J-2', ctx.outsideCustomer, 'Deck', 'in_progress', 20000).lastInsertRowid;
    ctx.db.prepare(`INSERT INTO work_orders (company_id, wo_number, client_id, title, items, sold_price,
      origin_job_id, origin_company_id, status, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      ctx.SHOP, 'AS-WO-2', ctx.shopSeesField, 'Railing',
      JSON.stringify([{ desc: 'Tube', qty: 1, unit_cost: 1000, unit_price: 1600 }]), 3000,
      openJob, ctx.FIELD, 'archived', '2026-02-10 12:00:00');

    const { group } = ctx.F.groupSummary();
    // the shop has recognised 13k of internal revenue, but only 10k of it has
    // reached a completed job, so only 10k may be netted out of cost
    assert.equal(group.intercompany_revenue, 13000);
    assert.equal(group.intercompany_cost, 10000);
  });
});

describe('scope isolation', () => {
  test('a pinned user is locked to one entity and cannot switch', () => {
    const { db, SHOP, FIELD } = build();
    const SC = makeScope(db);
    const pinned = SC.resolve({ company_id: SHOP }, 'DTS');   // cookie asks for the other company
    assert.deepEqual(pinned.ids, [SHOP], 'the cookie must not widen access');
    assert.equal(pinned.canSwitch, false);
    assert.equal(pinned.isGroup, false);
  });

  test('a group user sees everything by default and can narrow', () => {
    const { db, SHOP, FIELD } = build();
    const SC = makeScope(db);
    const group = SC.resolve({ company_id: null }, null);
    assert.equal(group.isGroup, true);
    assert.deepEqual(group.ids.sort(), [SHOP, FIELD].sort());

    const narrowed = SC.resolve({ company_id: null }, 'AS');
    assert.deepEqual(narrowed.ids, [SHOP]);
    assert.equal(narrowed.active.code, 'AS');
  });

  test('an unknown company in the cookie falls back to the group, not to nothing', () => {
    const { db } = build();
    const SC = makeScope(db);
    const s = SC.resolve({ company_id: null }, 'NOPE');
    assert.equal(s.isGroup, true);
    assert.equal(s.ids.length, 2);
  });

  test('the where clause restricts to the readable entities', () => {
    const { db, SHOP } = build();
    const SC = makeScope(db);
    const w = SC.where(SC.resolve({ company_id: SHOP }, null), 'j');
    assert.match(w.sql, /j\.company_id IN \(\?\)/);
    assert.deepEqual(w.params, [SHOP]);
  });

  test('new records are stamped with the active entity', () => {
    const { db, SHOP, FIELD } = build();
    const SC = makeScope(db);
    assert.equal(SC.writeCompanyId(SC.resolve({ company_id: SHOP }, null)), SHOP);
    // a group user writing without saying which entity falls back to the first
    assert.equal(SC.writeCompanyId(SC.resolve({ company_id: null }, null)), SHOP);
    // an explicit choice is honoured when permitted
    assert.equal(SC.writeCompanyId(SC.resolve({ company_id: null }, null), FIELD), FIELD);
    // but never one outside the user's reach
    assert.equal(SC.writeCompanyId(SC.resolve({ company_id: SHOP }, null), FIELD), SHOP);
  });
});
