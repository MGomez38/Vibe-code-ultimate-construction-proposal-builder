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
  name_extra: { label: 'Grade / spec (joins the description)', syn: ['grade', 'spec', 'alloy', 'finish', 'gauge', 'size', 'thickness', 'material type'] },
  priced_on: { label: 'Last priced', syn: ['date', 'last priced', 'priced', 'as of', 'updated', 'effective', 'quote date'] },
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
      // Short synonyms only ever match exactly. "ga" inside "Galvanized"
      // is not a gauge column, and a heading misread here mislabels a
      // whole column of the price book.
      if (s.length > 3 && h.includes(s) && (!best || s.length > best.len)) best = { key, len: s.length };
    }
  }
  return best ? best.key : null;
}

/**
 * Find the header row. It is the row where the most cells look like column
 * headings — not necessarily row 1, because row 1 is usually the company name.
 */
/** Does this column actually hold descriptions, or is it numbers wearing a label? */
function looksLikeText(rows, headerIndex, col) {
  let text = 0, numeric = 0;
  for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 40); i++) {
    const v = String((rows[i] || [])[col] ?? '').trim();
    if (!v) continue;
    if (money(v) !== null || /^[\d.\s/]+$/.test(v)) numeric++; else text++;
  }
  return text >= numeric;
}

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
    // A column of numbers is not a description, whatever the heading says.
    // Estimating workbooks are full of calculation grids whose first column
    // happens to sit under something that reads like a label.
    if (mapping.name !== undefined && !looksLikeText(rows, i, mapping.name)) { delete mapping.name; score--; }
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

  // A price book is organised in sections — "Galvanized and Bond", "Stainless
  // Steel", "5052 Aluminum" — and the same description repeats under several
  // of them. 26ga 48" x 120" is a different sheet of metal in each. Carry the
  // section down as the category, and fold it into the name where the name
  // alone would collide, or the second one silently overwrites the first.
  let section = '';
  const headerName = (rows[headerIndex] || [])[Number(mapping.name)] ;
  if (headerName && !fieldFor(headerName)) section = String(headerName).trim().slice(0, 60);

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    const filled = cells.filter(c => String(c || '').trim()).length;
    if (!filled) continue;                                       // blank spacer row

    const name = at(cells, 'name');
    const sku = at(cells, 'sku');
    const cost = money(at(cells, 'unit_cost'));
    const price = money(at(cells, 'sell_price'));

    // A described row carrying no money at all is the heading for what follows.
    if (name && cost === null && price === null && filled <= 2) {
      section = name.slice(0, 60);
      continue;
    }
    if (!name && !sku) { skipped.push({ row: i + 1, text: cells.find(c => String(c || '').trim()) || '', reason: 'no description' }); continue; }
    if (filled === 1) { section = (name || sku).slice(0, 60); continue; }
    // A zero is not a price. Price books carry placeholder rows for products
    // nobody has costed yet, and importing those at $0 puts a free line item
    // one click away from a customer.
    if (!cost && !price) { skipped.push({ row: i + 1, text: name || sku, reason: cost === 0 || price === 0 ? 'priced at zero' : 'no cost and no price' }); continue; }

    const qty = money(at(cells, 'qty_on_hand'));
    const reorder = money(at(cells, 'reorder_point'));
    const extra = at(cells, 'name_extra');
    const fullName = [name || sku, extra].filter(Boolean).join(' ');
    items.push({
      sku: sku.slice(0, 40),
      name: fullName.slice(0, 160),
      section,
      priced_on: (at(cells, 'priced_on').match(/\d{4}-\d{2}-\d{2}/) || [''])[0],
      category: (at(cells, 'category') || section).slice(0, 60),
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

  // Two rows with the same description are two different products that happen
  // to share a name — 26ga 48" x 120" under Galvanized and again under
  // Bonderized. Qualify them with their section so both survive the import.
  const seen = new Map();
  for (const it of items) seen.set(it.name.toLowerCase(), (seen.get(it.name.toLowerCase()) || 0) + 1);
  for (const it of items) {
    if (seen.get(it.name.toLowerCase()) > 1 && it.section && !it.name.toLowerCase().includes(it.section.toLowerCase())) {
      it.name = `${it.name} — ${it.section}`.slice(0, 160);
      it.disambiguated = true;
    }
  }
  return { items, skipped };
}

/* ------------------------------------------------------------------
   Size tables.

   A fabrication book does not list saddles the way it lists sheet metal.
   It has one row per width with the finished price beside it, and often a
   second axis across the top — girth down the side, length across — with
   a price at every crossing. That is a catalog; it is just not shaped
   like one. This turns it into one priced item per size.
   ------------------------------------------------------------------ */

/**
 * Columns holding prices in a two-axis grid: the ones where the variant
 * row carries a number (the length, the tap size) and the rows underneath
 * carry money. Their sheets repeat a block every few columns, so the
 * columns are found rather than described.
 */
function priceColumns(rows, headerIndex, sizeCol, variantRow) {
  const labels = rows[variantRow] || [];
  const out = [];
  for (let c = 0; c < labels.length; c++) {
    if (c === sizeCol) continue;
    const label = String(labels[c] ?? '').trim();
    if (!label || money(label) === null) continue;
    let hits = 0;
    for (let i = headerIndex + 1; i < Math.min(rows.length, headerIndex + 30); i++) {
      const v = money(String((rows[i] || [])[c] ?? ''));
      if (v !== null && v > 0) hits++;
    }
    if (hits >= 2) out.push({ col: c, label });
  }
  return out;
}

/**
 * @param opts.size_col      column holding the size (width, girth, round)
 * @param opts.price_col     1-D: the finished price column
 * @param opts.variant_row   2-D: row whose numbers label each price column
 * @param opts.cost_col      optional, where the book separates cost from price
 * @param opts.name          what the thing is called — "Saddle", "Register tap"
 * @param opts.size_unit     what the size number means — in, ga, lf
 * @param opts.variant_unit  what the second axis means
 */
function buildSizeRows(rows, opts = {}) {
  const headerIndex = Number(opts.header_index) || 0;
  const sizeCol = Number(opts.size_col) || 0;
  const label = String(opts.name || 'Item').trim();
  const sizeUnit = String(opts.size_unit ?? '"');
  const items = [], skipped = [];

  const cols = opts.variant_row !== undefined && opts.variant_row !== null && opts.variant_row !== ''
    ? priceColumns(rows, headerIndex, sizeCol, Number(opts.variant_row))
    : [{ col: Number(opts.price_col), label: '' }];
  if (!cols.length || cols.some(c => !Number.isFinite(c.col))) return { items, skipped, columns: [] };

  // These sheets run to the bottom of the workbook with stray notes and
  // scratch numbers below the table. The table ends where the sizes stop;
  // reading past it invents products like a 322" saddle.
  let gap = 0;
  const lastRow = opts.last_row === undefined || opts.last_row === '' || opts.last_row === null
    ? rows.length : Math.min(rows.length, Number(opts.last_row));
  for (let i = headerIndex + 1; i < lastRow; i++) {
    const cells = rows[i] || [];
    const rawSize = String(cells[sizeCol] ?? '').trim();
    const size = rawSize ? money(rawSize) : null;
    if (size === null || size <= 0) {
      if (rawSize) skipped.push({ row: i + 1, text: rawSize.slice(0, 50), reason: 'not a size' });
      if (++gap >= 6) break;
      continue;
    }
    gap = 0;

    for (const c of cols) {
      const price = money(String(cells[c.col] ?? ''));
      if (price === null || price <= 0) continue;
      const cost = opts.cost_col === undefined || opts.cost_col === '' ? null : money(String(cells[Number(opts.cost_col)] ?? ''));
      const name = [
        label,
        `${rawSize}${sizeUnit}`,
        c.label ? `× ${c.label}${opts.variant_unit ?? '"'}` : '',
      ].filter(Boolean).join(' ');
      items.push({
        sku: '', name: name.slice(0, 160), section: label,
        category: (opts.category || label).slice(0, 60),
        unit: opts.unit || 'ea',
        unit_cost: cost ?? 0,
        sell_price: price,
        qty_on_hand: null, reorder_point: null,
        location: '', vendor: '', priced_on: opts.priced_on || '',
        source_row: i + 1, no_price: false,
      });
    }
  }
  // One sheet often stacks several tables — square ells, then ells with
  // vanes, then radius. Scanning straight through produces three products
  // all called 52" at three different prices. Say so; the office fixes it
  // by setting the last row.
  const bySize = new Map();
  for (const it of items) bySize.set(it.name, (bySize.get(it.name) || 0) + 1);
  const repeats = [...bySize.entries()].filter(([, n]) => n > 1);
  return {
    items, skipped, columns: cols,
    repeated: repeats.length,
    repeated_example: repeats.length ? repeats[0][0] : '',
  };
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

module.exports = { analyze, buildRows, buildSizeRows, priceColumns, findHeader, fieldFor, money, unitOf, FIELDS, FIELD_KEYS };
