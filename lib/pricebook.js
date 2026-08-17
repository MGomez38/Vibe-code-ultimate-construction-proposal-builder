/* ============================================================
   Price book import.

   Reads the spreadsheet the office already keeps and turns it into
   the material list the whole app prices from — including the AI
   quoting engine, which will only quote from your own catalog.

   Nothing about the incoming file is assumed. Real price books have
   a company name in row 1, a blank row, merged title cells, section
   dividers, "$" in the numbers, and column headings nobody agreed
   on. So: find the header row by looking for it, guess the columns
   by name, then show the office what will happen before it happens.
   ============================================================ */
'use strict';

const round2 = n => Math.round((Number(n) || 0) * 100 * (1 + Number.EPSILON)) / 100;

/** The fields a material row can carry, and what a heading might call them. */
const FIELDS = {
  sku: { label: 'Item # / SKU', syn: ['sku', 'item #', 'item no', 'item number', 'itemno', 'item code', 'part #', 'part no', 'part number', 'catalog', 'cat #', 'code', 'stock #', 'mfg #', 'model'] },
  name: { label: 'Description', syn: ['description', 'item description', 'desc', 'item', 'name', 'product', 'material', 'part', 'details'] },
  unit: { label: 'Unit', syn: ['uom', 'u/m', 'unit', 'units', 'unit of measure', 'measure', 'per', 'ea/lf'] },
  unit_cost: { label: 'Your cost', syn: ['cost', 'our cost', 'unit cost', 'cost each', 'cost ea', 'net cost', 'buy', 'buy price', 'purchase', 'purchase price', 'wholesale', 'material cost'] },
  sell_price: { label: 'Sell price', syn: ['price', 'sell', 'sell price', 'selling price', 'unit price', 'retail', 'list', 'list price', 'sale price', 'charge', 'billing rate', 'rate', 'quoted'] },
  qty_on_hand: { label: 'On hand', syn: ['on hand', 'onhand', 'qty', 'quantity', 'stock', 'in stock', 'inventory', 'qty on hand', 'count'] },
  reorder_point: { label: 'Reorder at', syn: ['reorder', 'reorder point', 'min', 'minimum', 'par', 'par level', 'restock'] },
  category: { label: 'Category', syn: ['category', 'group', 'type', 'class', 'dept', 'department', 'family'] },
  location: { label: 'Location', syn: ['location', 'bin', 'rack', 'shelf', 'aisle', 'where', 'yard'] },
  vendor: { label: 'Vendor', syn: ['vendor', 'supplier', 'mfg', 'manufacturer', 'source', 'buy from'] },
};
const FIELD_KEYS = Object.keys(FIELDS);

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 /#]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Which field a heading means. "Cost each" and "Unit price" both contain a
 * money word; the one that says cost is the cost, and that has to be decided
 * before the generic price match runs or every cost column becomes a price.
 */
function fieldFor(heading) {
  const h = norm(heading);
  if (!h) return null;
  const isCost = /\bcost\b|\bbuy\b|wholesale|purchase/.test(h);
  const isSell = /\bsell\b|\bretail\b|\blist\b|\bcharge\b|\bprice\b|\brate\b/.test(h);
  if (isCost) return 'unit_cost';
  if (isSell && !isCost) return 'sell_price';

  let best = null;
  for (const key of FIELD_KEYS) {
    for (const s of FIELDS[key].syn) {
      if (h === s) return key;                                  // exact wins outright
      if (h.includes(s) && (!best || s.length > best.len)) best = { key, len: s.length };
    }
  }
  return best ? best.key : null;
}

/**
 * Find the header row. It is the row where the most cells look like column
 * headings — not necessarily row 1, because row 1 is usually the company name.
 */
function findHeader(rows) {
  let best = { index: 0, score: 0, mapping: {} };
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i] || [];
    const mapping = {};
    let score = 0;
    for (let c = 0; c < cells.length; c++) {
      const f = fieldFor(cells[c]);
      if (f && mapping[f] === undefined) { mapping[f] = c; score++; }
    }
    // a header needs a description-ish column and at least one number column
    if (mapping.name === undefined && mapping.sku === undefined) score = 0;
    if (mapping.unit_cost === undefined && mapping.sell_price === undefined) score -= 1;
    if (score > best.score) best = { index: i, score, mapping };
  }
  return best;
}

/** "$1,020.50" → 1020.5 · "(3.00)" → -3 · "" → null (null means "not given"). */
function money(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '').replace(/[$£€\s]/g, '').replace(/,/g, '');
  s = s.replace(/\/(ea|lf|sf|sqft|sheet|hr|lb)\b.*$/i, '');   // "9.25/lf"
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return round2(neg ? -n : n);
}

const UNIT_FIX = { each: 'ea', ea: 'ea', pc: 'ea', pcs: 'ea', piece: 'ea', unit: 'ea', 'linear feet': 'lf', 'lin ft': 'lf', ft: 'lf', feet: 'lf', foot: 'lf', lf: 'lf', 'sq ft': 'sqft', sf: 'sqft', sqft: 'sqft', 'square feet': 'sqft', lbs: 'lb', lb: 'lb', pound: 'lb', pounds: 'lb', hrs: 'hr', hour: 'hr', hours: 'hr', hr: 'hr', sheets: 'sheet', sheet: 'sheet', rolls: 'roll', roll: 'roll', box: 'box', boxes: 'box', gal: 'gal', gallon: 'gal', bag: 'bag', bags: 'bag', pail: 'pail', stick: 'stick', sticks: 'stick', set: 'set', ls: 'ls' };
const unitOf = v => {
  const s = String(v || '').trim().toLowerCase().replace(/\.$/, '');
  return UNIT_FIX[s] || (s ? s.slice(0, 12) : 'ea');
};

/**
 * Turn the sheet into material rows using a confirmed column mapping.
 * Rows that cannot become a material are returned with the reason, so
 * nothing is dropped silently — a price book with 400 lines that imports
 * 340 needs to say which 60 and why.
 */
function buildRows(rows, headerIndex, mapping) {
  const items = [], skipped = [];
  const at = (cells, key) => (mapping[key] === undefined || mapping[key] === null || mapping[key] === '')
    ? '' : String(cells[Number(mapping[key])] ?? '').trim();

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    const filled = cells.filter(c => String(c || '').trim()).length;
    if (!filled) continue;                                       // blank spacer row

    const name = at(cells, 'name');
    const sku = at(cells, 'sku');
    const cost = money(at(cells, 'unit_cost'));
    const price = money(at(cells, 'sell_price'));

    if (!name && !sku) { skipped.push({ row: i + 1, text: cells.find(c => String(c || '').trim()) || '', reason: 'no description' }); continue; }
    if (filled === 1) { skipped.push({ row: i + 1, text: name || sku, reason: 'looks like a section heading' }); continue; }
    if (cost === null && price === null) { skipped.push({ row: i + 1, text: name || sku, reason: 'no cost and no price' }); continue; }

    const qty = money(at(cells, 'qty_on_hand'));
    const reorder = money(at(cells, 'reorder_point'));
    items.push({
      sku: sku.slice(0, 40),
      name: (name || sku).slice(0, 160),
      category: at(cells, 'category').slice(0, 60),
      unit: unitOf(at(cells, 'unit')),
      unit_cost: cost ?? 0,
      sell_price: price ?? 0,
      qty_on_hand: qty === null ? null : Math.max(0, qty),
      reorder_point: reorder === null ? null : Math.max(0, reorder),
      location: at(cells, 'location').slice(0, 60),
      vendor: at(cells, 'vendor').slice(0, 80),
      source_row: i + 1,
      // a price book line with a cost and no sell price is a margin hole —
      // the office should see these before they end up on a quote at cost
      no_price: price === null || price === 0,
    });
  }
  return { items, skipped };
}

/** Read a workbook and come back with everything the office needs to confirm. */
function analyze(sheets) {
  return sheets.map(s => {
    const h = findHeader(s.rows);
    const built = buildRows(s.rows, h.index, h.mapping);
    return {
      name: s.name,
      total_rows: s.rows.length,
      header_index: h.index,
      headers: (s.rows[h.index] || []).map(c => String(c || '')),
      mapping: h.mapping,
      confidence: h.score,
      preview: built.items.slice(0, 8),
      item_count: built.items.length,
      skipped_count: built.skipped.length,
      skipped: built.skipped.slice(0, 10),
      stale_formulas: s.stale_formulas || 0,
    };
  }).sort((a, b) => b.item_count - a.item_count);
}

module.exports = { analyze, buildRows, findHeader, fieldFor, money, unitOf, FIELDS, FIELD_KEYS };
