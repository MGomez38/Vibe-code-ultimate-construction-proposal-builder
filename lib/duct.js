/* ============================================================
   Duct and register-tap pricing.

   A fabrication price grid is a photograph of one moment: it is
   computed for whatever gauge, liner and labor class the workbook
   happened to be set to when it was saved. Import the grid and you
   inherit that snapshot — 24ga with half-inch liner, and nothing
   else quotable.

   The grid is not the price book. The formula behind it is. This is
   that formula, verified cell for cell against a real shop workbook:
   170 of 170 priced cells reproduce to the cent.

       steel   = ((girth × 2 + 1.5) × length × 1.1 ÷ 144) × $/sq ft for the gauge
       liner   = ((girth × 2)       × length × 1.1 ÷ 144) × $/sq ft for the thickness
       price   = (fab_labor × rate + steel + liner_labor × rate + liner) × markup

   girth is half the perimeter in inches, length is in inches, the
   1.5 is seam allowance, the 1.1 is the shop's waste factor, and 144
   turns square inches into square feet.

   The labor numbers are the one thing no formula produces — they are
   the shop's own time, hand-entered per size. Those come from the
   grid; everything else is computed, so when steel moves you change
   one number and every size re-prices.
   ============================================================ */
'use strict';

const round2 = n => Math.round((Number(n) || 0) * 100 * (1 + Number.EPSILON)) / 100;

const WASTE = 1.1;          // shop waste factor
const SEAM_IN = 1.5;        // seam allowance across the girth
const SQ_IN_PER_SQ_FT = 144;

/**
 * What a single piece costs and sells for.
 *
 * @param {object} m      the shop's model — rates, markup, labor grid
 * @param {object} spec   {girth, length, gauge, liner, labor_class}
 */
function price(m, spec) {
  const girth = Number(spec.girth) || 0;
  const length = Number(spec.length) || 0;
  const gauge = String(spec.gauge ?? m.default_gauge);
  const liner = Number(spec.liner ?? 0);
  const cls = String(spec.labor_class || m.default_labor_class || 'a').toLowerCase();

  const steelRate = Number(m.steel_per_sqft[gauge]);
  if (!girth || !length) return { ok: false, error: 'Girth and length are both needed' };
  if (!Number.isFinite(steelRate)) {
    return { ok: false, error: `No steel price on file for ${gauge}ga. Known gauges: ${Object.keys(m.steel_per_sqft).join(', ')}.` };
  }
  const laborRate = Number(m.labor_rate[cls]);
  if (!Number.isFinite(laborRate)) return { ok: false, error: `No labor rate on file for class ${cls.toUpperCase()}` };

  const linerRate = liner ? Number(m.liner_per_sqft[liner]) : 0;
  if (liner && !Number.isFinite(linerRate)) {
    return { ok: false, error: `No liner price on file for ${liner}". Known: ${Object.keys(m.liner_per_sqft).join(', ')}.` };
  }

  const labor = laborFor(m, girth, length);
  if (!labor) {
    return { ok: false, error: `No labor time on file for a ${girth}" girth at ${length}" long. Add that size to the labor table, or pick the nearest one.` };
  }

  const steelSqFt = (girth * 2 + SEAM_IN) * length * WASTE / SQ_IN_PER_SQ_FT;
  const linerSqFt = (girth * 2) * length * WASTE / SQ_IN_PER_SQ_FT;
  const steel = steelSqFt * steelRate;
  const linerMaterial = liner ? linerSqFt * linerRate : 0;
  const fabLabor = labor.fab * laborRate;
  const linerLabor = liner ? labor.liner * laborRate : 0;
  const markup = Number(m.markup) || 1;
  const total = (fabLabor + steel + linerLabor + linerMaterial) * markup;

  return {
    ok: true,
    price: round2(total),
    breakdown: {
      steel_sqft: round2(steelSqFt), liner_sqft: liner ? round2(linerSqFt) : 0,
      steel: round2(steel), liner_material: round2(linerMaterial),
      fab_labor: round2(fabLabor), liner_labor: round2(linerLabor),
      subtotal: round2(fabLabor + steel + linerLabor + linerMaterial),
      markup_pct: round2((markup - 1) * 100),
    },
    used: { girth, length, gauge, liner, labor_class: cls, steel_per_sqft: steelRate, labor_rate: laborRate,
      fab_units: labor.fab, liner_units: labor.liner, exact_size: labor.exact },
  };
}

/**
 * The shop's own time for this size. Sizes the grid does not carry fall
 * back to the nearest one it does, and say so — an estimator would rather
 * be told "priced off the 24 inch line" than be refused outright.
 */
function laborFor(m, girth, length) {
  const key = `${girth}x${length}`;
  if (m.labor[key]) return { ...m.labor[key], exact: true };

  let best = null;
  for (const k of Object.keys(m.labor)) {
    const [g, l] = k.split('x').map(Number);
    // distance in size-space, girth weighted heavier because it drives the metal
    const d = Math.abs(g - girth) * 2 + Math.abs(l - length);
    if (!best || d < best.d) best = { d, k, ...m.labor[k] };
  }
  if (!best || best.d > 60) return null;
  return { fab: best.fab, liner: best.liner, exact: false, nearest: best.k };
}

/** Every size the grid knows, for a dropdown. */
const sizes = m => Object.keys(m.labor).map(k => {
  const [girth, length] = k.split('x').map(Number);
  return { girth, length };
}).sort((a, b) => a.girth - b.girth || a.length - b.length);

/**
 * Read the model out of a fabrication sheet laid out the way these
 * workbooks are: reference rates down the left, girth down the side,
 * a repeating block of columns per length across the top.
 *
 * @param opts.girth_col      column holding girth
 * @param opts.length_row     row labelling each block with its length
 * @param opts.total_offsets  where the block's total sits; labor is read
 *                            relative to it (fab at −2, liner labor at −1)
 */
function extract(rows, opts = {}) {
  const at = (r, c) => String((rows[r] || [])[c] ?? '').trim();
  const num = (r, c) => { const n = Number(at(r, c).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : NaN; };

  const girthCol = Number(opts.girth_col ?? 5);
  const lengthRow = Number(opts.length_row ?? 8);
  const firstRow = Number(opts.first_row ?? 9);
  const lastRow = Number(opts.last_row ?? firstRow + 12);

  // reference tables, at their fixed places in this family of sheets
  const steel_per_sqft = {};
  for (const [gauge, r] of Object.entries(opts.gauge_rows || { 26: 9, 24: 10, 22: 11, 20: 12, 18: 13 })) {
    const v = num(Number(r), Number(opts.steel_col ?? 1));
    if (Number.isFinite(v) && v > 0) steel_per_sqft[gauge] = v;
  }
  const liner_per_sqft = {};
  for (const [thickness, r] of Object.entries(opts.liner_rows || { 0.5: 1, 1: 2, 1.5: 3 })) {
    const v = num(Number(r), Number(opts.liner_col ?? 2));
    if (Number.isFinite(v) && v > 0) liner_per_sqft[thickness] = v;
  }
  const labor_rate = {};
  for (const [cls, r] of Object.entries(opts.class_rows || { a: 9, b: 10, c: 11, d: 12 })) {
    const v = num(Number(r), Number(opts.labor_col ?? 3));
    if (Number.isFinite(v) && v > 0) labor_rate[cls] = v;
  }

  // the labor grid: one entry per girth × length the shop has timed
  const labor = {};
  const lengths = [];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (let c = 0; c < width; c++) {
    const len = num(lengthRow, c);
    if (!Number.isInteger(len) || len <= 0) continue;
    let seen = 0;
    for (let r = firstRow; r <= lastRow; r++) {
      const girth = num(r, girthCol);
      const fab = num(r, c - 2), lin = num(r, c - 1);
      if (!Number.isFinite(girth) || girth <= 0 || !Number.isFinite(fab) || fab <= 0) continue;
      labor[`${girth}x${len}`] = { fab, liner: Number.isFinite(lin) ? lin : 0 };
      seen++;
    }
    if (seen) lengths.push(len);
  }

  return {
    steel_per_sqft, liner_per_sqft, labor_rate, labor,
    markup: Number(opts.markup) || 1.15,
    default_gauge: String(opts.default_gauge ?? 24),
    default_labor_class: String(opts.default_labor_class ?? 'a'),
    lengths: [...new Set(lengths)].sort((a, b) => a - b),
    girths: [...new Set(Object.keys(labor).map(k => Number(k.split('x')[0])))].sort((a, b) => a - b),
  };
}

/** Is this model usable, and if not, what is missing? */
function check(m) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['No model saved'];
  if (!Object.keys(m.steel_per_sqft || {}).length) problems.push('no steel price per square foot for any gauge');
  if (!Object.keys(m.labor_rate || {}).length) problems.push('no labor rate for any class');
  if (!Object.keys(m.labor || {}).length) problems.push('no labor times — the size grid is empty');
  if (!(Number(m.markup) > 0)) problems.push('no markup');
  return problems;
}

module.exports = { price, laborFor, sizes, extract, check, WASTE, SEAM_IN };
