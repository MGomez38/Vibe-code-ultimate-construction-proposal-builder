/**
 * Every money calculation in the platform lives here, so a job's profit means
 * the same thing on the dashboard, in reports, and on an invoice.
 *
 * Contract value = original sold price + approved change orders.
 * Job cost = materials logged + labor from the time clock + linked shop work.
 */
'use strict';

/**
 * Round to cents, half up.
 * The epsilon scaling matters: 1.005 * 100 is 100.49999999999999 in binary
 * floating point, so a plain Math.round would bill a half-cent down.
 */
const round2 = n => Math.round((Number(n) || 0) * 100 * (1 + Number.EPSILON)) / 100;
const parseItems = s => {
  if (Array.isArray(s)) return s;
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const itemsCost = items => items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_cost) || 0), 0);
const itemsPrice = items => items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_price) || 0), 0);
const hoursOf = t => (new Date(t.clock_out.replace(' ', 'T') + 'Z') - new Date(t.clock_in.replace(' ', 'T') + 'Z')) / 3600e3;

/** Priced document totals — shared by quotes and change orders. */
function docTotals(d) {
  const items = parseItems(d.items);
  const materials = itemsPrice(items);
  const labor = (Number(d.labor_hours) || 0) * (Number(d.labor_rate) || 0);
  const subtotal = materials + labor;
  const markup = subtotal * (Number(d.markup_pct) || 0) / 100;
  const tax = (subtotal + markup) * (Number(d.tax_pct) || 0) / 100;
  const total = subtotal + markup + tax;
  const cost = itemsCost(items) + labor * 0.6; // internal labor burden vs billed rate
  return {
    materials: round2(materials), labor: round2(labor), subtotal: round2(subtotal),
    markup: round2(markup), tax: round2(tax), total: round2(total),
    est_cost: round2(cost), est_profit: round2(total - cost),
    est_margin_pct: total > 0 ? round2((total - cost) / total * 100) : 0,
  };
}

function invoiceTotals(inv, paid = 0) {
  const items = parseItems(inv.items);
  const subtotal = itemsPrice(items);
  const tax = subtotal * (Number(inv.tax_pct) || 0) / 100;
  const retainage = (subtotal + tax) * (Number(inv.retainage_pct) || 0) / 100;
  const total = subtotal + tax - retainage;
  return {
    subtotal: round2(subtotal), tax: round2(tax), retainage: round2(retainage),
    total: round2(total), paid: round2(paid), balance: round2(total - paid),
  };
}

module.exports = function makeFinance(db) {
  function woFinancials(wo) {
    const items = parseItems(wo.items);
    const materialCost = itemsCost(items);
    const laborCost = (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0) * 0.55;
    const totalCost = round2(materialCost + laborCost);
    const sold = Number(wo.sold_price) || round2(itemsPrice(items) + (Number(wo.labor_hours) || 0) * (Number(wo.labor_rate) || 0));
    const profit = round2(sold - totalCost);
    return {
      material_cost: round2(materialCost), labor_cost: round2(laborCost), total_cost: totalCost,
      sold_price: round2(sold), profit, margin_pct: sold > 0 ? round2(profit / sold * 100) : 0,
    };
  }

  /** Approved change orders add to the contract; pending ones are tracked separately. */
  function changeOrderValue(jobId) {
    const cos = db.prepare('SELECT * FROM change_orders WHERE job_id = ?').all(jobId);
    let approved = 0, pending = 0, days = 0;
    for (const co of cos) {
      const t = docTotals(co).total;
      if (co.status === 'approved') { approved += t; days += Number(co.schedule_days) || 0; }
      else if (co.status === 'sent') pending += t;
    }
    return { approved: round2(approved), pending: round2(pending), added_days: days, count: cos.length };
  }

  function invoiceState(jobId) {
    const invoices = db.prepare(`SELECT * FROM invoices WHERE job_id = ? AND status != 'void'`).all(jobId);
    let billed = 0, paid = 0, retained = 0;
    for (const inv of invoices) {
      const p = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(inv.id).s;
      const t = invoiceTotals(inv, p);
      billed += t.total; paid += t.paid; retained += t.retainage;
    }
    return { billed: round2(billed), paid: round2(paid), retained: round2(retained), outstanding: round2(billed - paid), count: invoices.length };
  }

  function jobFinancials(jobId) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return null;

    const materialCost = db.prepare('SELECT * FROM job_materials WHERE job_id = ?').all(jobId)
      .reduce((s, m) => s + (m.qty || 0) * (m.unit_cost || 0), 0);

    const time = db.prepare(`
      SELECT t.*, e.hourly_rate FROM time_entries t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.job_id = ? AND t.clock_out IS NOT NULL`).all(jobId);
    let hours = 0, laborCost = 0;
    for (const t of time) { const h = hoursOf(t); hours += h; laborCost += h * (t.hourly_rate || 0); }

    // Work this entity did in its own shop costs what it cost to do.
    const woCost = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(jobId)
      .reduce((s, wo) => s + woFinancials(wo).total_cost, 0);
    // Work the sister entity fabricated costs this job what it was CHARGED —
    // the transfer price — not what the shop's internal cost happened to be.
    const icWos = db.prepare('SELECT * FROM work_orders WHERE origin_job_id = ?').all(jobId);
    const icCost = icWos.reduce((s, wo) => s + woFinancials(wo).sold_price, 0);
    const subCost = db.prepare('SELECT COALESCE(SUM(contract_amount),0) s FROM job_subs WHERE job_id = ?').get(jobId).s;

    const co = changeOrderValue(jobId);
    const contract = round2((Number(job.sold_price) || 0) + co.approved);
    const totalCost = round2(materialCost + laborCost + woCost + icCost + subCost);
    const profit = round2(contract - totalCost);

    // estimate accuracy — only meaningful once hours were estimated
    const est = Number(job.est_labor_hours) || 0;
    const laborVariance = est > 0 ? round2((hours - est) / est * 100) : null;

    return {
      material_cost: round2(materialCost), labor_hours: round2(hours), labor_cost: round2(laborCost),
      wo_cost: round2(woCost), sub_cost: round2(subCost), total_cost: totalCost,
      intercompany_cost: round2(icCost),
      intercompany: icWos.map(w => ({ id: w.id, wo_number: w.wo_number, title: w.title, status: w.status,
        charged: woFinancials(w).sold_price, company_id: w.company_id, billed_invoice_id: w.billed_invoice_id })),
      base_price: round2(Number(job.sold_price) || 0), change_orders: co, sold_price: contract,
      profit, margin_pct: contract > 0 ? round2(profit / contract * 100) : 0,
      est_labor_hours: est, labor_variance_pct: laborVariance,
      invoicing: invoiceState(jobId),
    };
  }

  /**
   * One entity's realised P&L, split by whether the money came from outside
   * the group or from the sister company.
   */
  function companyPnl(companyId) {
    let external = { revenue: 0, cost: 0 }, internal = { revenue: 0, cost: 0 };
    const bucket = isInternal => (isInternal ? internal : external);

    for (const j of db.prepare(`SELECT * FROM jobs WHERE company_id = ? AND status = 'completed'`).all(companyId)) {
      const f = jobFinancials(j.id);
      const client = j.client_id ? db.prepare('SELECT is_internal FROM clients WHERE id = ?').get(j.client_id) : null;
      const b = bucket(client && client.is_internal);
      b.revenue += f.sold_price; b.cost += f.total_cost;
    }
    // standalone shop tickets — the fab shop's bread and butter
    for (const w of db.prepare(`SELECT * FROM work_orders WHERE company_id = ? AND job_id IS NULL
        AND status IN ('completed','archived')`).all(companyId)) {
      const f = woFinancials(w);
      const client = w.client_id ? db.prepare('SELECT is_internal FROM clients WHERE id = ?').get(w.client_id) : null;
      const b = bucket((client && client.is_internal) || !!w.origin_company_id);
      b.revenue += f.sold_price; b.cost += f.total_cost;
    }
    const revenue = round2(external.revenue + internal.revenue);
    const cost = round2(external.cost + internal.cost);
    return {
      company_id: companyId, revenue, cost, profit: round2(revenue - cost),
      margin_pct: revenue > 0 ? round2((revenue - cost) / revenue * 100) : 0,
      external_revenue: round2(external.revenue), external_cost: round2(external.cost),
      external_profit: round2(external.revenue - external.cost),
      internal_revenue: round2(internal.revenue), internal_cost: round2(internal.cost),
      internal_profit: round2(internal.revenue - internal.cost),
      open_receivables: round2(db.prepare(`SELECT * FROM invoices WHERE company_id = ? AND status NOT IN ('void','draft','paid')`).all(companyId)
        .reduce((s, inv) => s + invoiceTotals(inv, db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id = ?').get(inv.id).s).balance, 0)),
    };
  }

  /**
   * The whole group. Intercompany revenue is eliminated: when All Spec bills DTS,
   * that money never left the group, so counting it twice would overstate the
   * business. Only what outside customers paid is group revenue.
   */
  function groupSummary() {
    const companies = db.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY id').all();
    const entities = companies.map(c => ({
      id: c.id, code: c.code, name: c.name, kind: c.kind, accent: c.accent, ...companyPnl(c.id),
    }));
    const intercompanyRevenue = round2(entities.reduce((s, e) => s + e.internal_revenue, 0));
    // Eliminate only what the buyer has actually taken into cost — that is,
    // intercompany work sitting inside a COMPLETED job. Work still in progress
    // is on the seller's books but not yet on the buyer's, so netting it here
    // would flatter group profit by the margin on unfinished work.
    const intercompanyCost = round2(db.prepare(`SELECT id FROM jobs WHERE status = 'completed'`).all()
      .reduce((s, j) => s + (jobFinancials(j.id)?.intercompany_cost || 0), 0));
    const externalRevenue = round2(entities.reduce((s, e) => s + e.external_revenue, 0));
    const groupCost = round2(entities.reduce((s, e) => s + e.cost, 0) - intercompanyCost);
    return {
      entities,
      group: {
        external_revenue: externalRevenue,
        cost: groupCost,
        profit: round2(externalRevenue - groupCost),
        margin_pct: externalRevenue > 0 ? round2((externalRevenue - groupCost) / externalRevenue * 100) : 0,
        intercompany_revenue: intercompanyRevenue,
        intercompany_cost: intercompanyCost,
        combined_revenue_before_elimination: round2(entities.reduce((s, e) => s + e.revenue, 0)),
        open_receivables: round2(entities.reduce((s, e) => s + e.open_receivables, 0)),
      },
    };
  }

  return { docTotals, invoiceTotals, woFinancials, jobFinancials, changeOrderValue, invoiceState,
    companyPnl, groupSummary, round2, parseItems, itemsCost, itemsPrice, hoursOf };
};

module.exports.docTotals = docTotals;
module.exports.invoiceTotals = invoiceTotals;
module.exports.round2 = round2;
module.exports.parseItems = parseItems;
