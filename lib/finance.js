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

    const woCost = db.prepare('SELECT * FROM work_orders WHERE job_id = ?').all(jobId)
      .reduce((s, wo) => s + woFinancials(wo).total_cost, 0);
    const subCost = db.prepare('SELECT COALESCE(SUM(contract_amount),0) s FROM job_subs WHERE job_id = ?').get(jobId).s;

    const co = changeOrderValue(jobId);
    const contract = round2((Number(job.sold_price) || 0) + co.approved);
    const totalCost = round2(materialCost + laborCost + woCost + subCost);
    const profit = round2(contract - totalCost);

    // estimate accuracy — only meaningful once hours were estimated
    const est = Number(job.est_labor_hours) || 0;
    const laborVariance = est > 0 ? round2((hours - est) / est * 100) : null;

    return {
      material_cost: round2(materialCost), labor_hours: round2(hours), labor_cost: round2(laborCost),
      wo_cost: round2(woCost), sub_cost: round2(subCost), total_cost: totalCost,
      base_price: round2(Number(job.sold_price) || 0), change_orders: co, sold_price: contract,
      profit, margin_pct: contract > 0 ? round2(profit / contract * 100) : 0,
      est_labor_hours: est, labor_variance_pct: laborVariance,
      invoicing: invoiceState(jobId),
    };
  }

  return { docTotals, invoiceTotals, woFinancials, jobFinancials, changeOrderValue, invoiceState, round2, parseItems, itemsCost, itemsPrice, hoursOf };
};

module.exports.docTotals = docTotals;
module.exports.invoiceTotals = invoiceTotals;
module.exports.round2 = round2;
module.exports.parseItems = parseItems;
