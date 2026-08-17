/**
 * Sheet drop calculation.
 *
 * When the shop cuts pieces out of a full sheet, what is left over is a drop —
 * still good material that should go back on the rack rather than being written
 * off. This works out the drops from a guillotine (straight-through) cut, which
 * is how a shear and a brake actually cut.
 *
 * Cutting a block of pieces out of the corner of a sheet leaves two rectangles:
 *
 *      ┌───────────────┬────────┐
 *      │   pieces cut  │  side  │   side  = (sheetW − usedW) × sheetL
 *      ├───────────────┤  drop  │
 *      │   end drop    │        │   end   = usedW × (sheetL − usedL)
 *      └───────────────┴────────┘
 *
 * Anything narrower than the usable threshold is scrap, not a drop — a 2" strip
 * is not worth a rack slot.
 */
'use strict';

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const sqft = sqin => round2(sqin / 144);

/**
 * @param {number} sheetW  sheet width in inches (e.g. 48)
 * @param {number} sheetL  sheet length in inches (e.g. 120)
 * @param {number} cutW    piece width in inches
 * @param {number} cutL    piece length in inches
 * @param {number} pieces  how many of that piece were cut
 * @param {number} minUsable  smallest dimension worth keeping, inches
 */
function calculateDrops(sheetW, sheetL, cutW, cutL, pieces = 1, minUsable = 6) {
  const SW = Number(sheetW) || 0, SL = Number(sheetL) || 0;
  const W = Number(cutW) || 0, L = Number(cutL) || 0;
  const n = Math.max(1, Math.floor(Number(pieces) || 1));
  if (SW <= 0 || SL <= 0 || W <= 0 || L <= 0) {
    return { ok: false, error: 'Need both the sheet size and the cut size' };
  }

  // Try the piece both ways round and keep whichever fits more per sheet.
  const layout = (pw, pl) => {
    const across = Math.floor(SW / pw), down = Math.floor(SL / pl);
    return { pw, pl, across, down, capacity: across * down };
  };
  const options = [layout(W, L), layout(L, W)].filter(o => o.capacity > 0);
  if (!options.length) {
    return { ok: false, error: `A ${W}" × ${L}" piece does not fit on a ${SW}" × ${SL}" sheet` };
  }
  const best = options.sort((a, b) => b.capacity - a.capacity)[0];
  const rotated = best.pw !== W;

  const sheetsNeeded = Math.ceil(n / best.capacity);
  // Drops come off the last sheet; earlier sheets in a run are cut out fully.
  const onLastSheet = n - (sheetsNeeded - 1) * best.capacity;

  const cols = Math.min(best.across, onLastSheet);
  const rows = Math.ceil(onLastSheet / best.across);
  const usedW = round2((rows > 1 ? best.across : cols) * best.pw);
  const usedL = round2(rows * best.pl);

  const candidates = [
    { label: 'side', width: round2(SW - usedW), length: SL },
    { label: 'end', width: usedW, length: round2(SL - usedL) },
  ];
  const drops = candidates
    .filter(d => d.width >= minUsable && d.length >= minUsable)
    .map(d => ({ ...d, area_sqft: sqft(d.width * d.length) }));

  const cutArea = onLastSheet * best.pw * best.pl;
  const dropArea = drops.reduce((s, d) => s + d.width * d.length, 0);
  const scrapArea = Math.max(0, SW * SL - cutArea - dropArea);

  return {
    ok: true, rotated, capacity_per_sheet: best.capacity, sheets_needed: sheetsNeeded,
    pieces_on_last_sheet: onLastSheet,
    used: { width: usedW, length: usedL },
    drops,
    cut_area_sqft: sqft(cutArea),
    drop_area_sqft: sqft(dropArea),
    scrap_area_sqft: sqft(scrapArea),
    // how much of the last sheet turned into either finished parts or usable drop
    yield_pct: round2((cutArea + dropArea) / (SW * SL) * 100),
  };
}

/** "48 x 120" / "4x10 sheet" / "4' x 10'" → { width, length } in inches. */
function parseSheetSize(text) {
  const s = String(text || '').toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(?:"|in|inch)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:"|in|inch)?/.exec(s);
  if (!m) return null;
  let w = Number(m[1]), l = Number(m[2]);
  // "4x10" in a sheet-goods context means feet
  if (w <= 12 && l <= 20 && !/"|in|inch/.test(s)) { w *= 12; l *= 12; }
  return { width: w, length: l };
}

const describe = d => `${d.width}" × ${d.length}"`;

module.exports = { calculateDrops, parseSheetSize, describe, sqft };
