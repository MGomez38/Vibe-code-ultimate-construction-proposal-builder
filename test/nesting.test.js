/**
 * Drop calculation. If this is wrong the shop either throws away good material
 * or racks a strip that turns out to be scrap, so the geometry is pinned down.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { calculateDrops, parseSheetSize, describe: label } = require('../lib/nesting');

describe('calculateDrops', () => {
  test('the case from the shop floor: 24x120 out of a 4x10 sheet', () => {
    const r = calculateDrops(48, 120, 24, 120, 1);
    assert.equal(r.ok, true);
    assert.equal(r.drops.length, 1, 'a straight rip leaves one drop, not two');
    assert.deepEqual(
      { width: r.drops[0].width, length: r.drops[0].length },
      { width: 24, length: 120 },
      'half a 48" sheet leaves the other half'
    );
    assert.equal(r.drops[0].area_sqft, 20);
    assert.equal(r.scrap_area_sqft, 0, 'a clean rip wastes nothing');
    assert.equal(r.yield_pct, 100);
  });

  test('cutting both pieces out of the sheet leaves no drop', () => {
    const r = calculateDrops(48, 120, 24, 120, 2);
    assert.equal(r.capacity_per_sheet, 2);
    assert.equal(r.drops.length, 0);
    assert.equal(r.sheets_needed, 1);
  });

  test('a corner cut leaves a side drop and an end drop', () => {
    const r = calculateDrops(48, 120, 30, 80, 1);
    assert.equal(r.drops.length, 2);
    const side = r.drops.find(d => d.label === 'side');
    const end = r.drops.find(d => d.label === 'end');
    assert.deepEqual([side.width, side.length], [18, 120]);
    assert.deepEqual([end.width, end.length], [30, 40]);
  });

  test('slivers below the usable threshold are scrap, not drops', () => {
    const r = calculateDrops(48, 120, 46, 120, 1);   // leaves a 2" strip
    assert.equal(r.drops.length, 0);
    assert.ok(r.scrap_area_sqft > 0);
    assert.ok(r.yield_pct < 100);
  });

  test('the threshold is adjustable for shops that keep narrower stock', () => {
    const r = calculateDrops(48, 120, 46, 120, 1, 2);
    assert.equal(r.drops.length, 1);
    assert.equal(r.drops[0].width, 2);
  });

  test('the piece is rotated when that fits more per sheet', () => {
    const r = calculateDrops(48, 120, 120, 10, 1);   // only fits turned sideways
    assert.equal(r.ok, true);
    assert.equal(r.rotated, true);
  });

  test('more pieces than one sheet holds reports how many sheets are needed', () => {
    const r = calculateDrops(48, 120, 24, 60, 5);    // 4 per sheet
    assert.equal(r.capacity_per_sheet, 4);
    assert.equal(r.sheets_needed, 2);
    assert.equal(r.pieces_on_last_sheet, 1, 'drops come off the last sheet only');
  });

  test('a piece too big for the sheet is refused rather than guessed at', () => {
    const r = calculateDrops(48, 120, 60, 130, 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /does not fit/);
  });

  test('missing dimensions are refused', () => {
    assert.equal(calculateDrops(48, 120, 0, 100).ok, false);
    assert.equal(calculateDrops(0, 0, 10, 10).ok, false);
  });

  test('areas add up to the whole sheet', () => {
    const r = calculateDrops(48, 120, 30, 80, 1);
    const total = r.cut_area_sqft + r.drop_area_sqft + r.scrap_area_sqft;
    assert.equal(Math.round(total), Math.round(48 * 120 / 144));
  });
});

describe('parseSheetSize', () => {
  test('reads shop shorthand as feet', () => {
    assert.deepEqual(parseSheetSize('4x10 sheet'), { width: 48, length: 120 });
    assert.deepEqual(parseSheetSize('5 x 10'), { width: 60, length: 120 });
  });

  test('reads explicit inches as inches', () => {
    assert.deepEqual(parseSheetSize('48" x 120"'), { width: 48, length: 120 });
    assert.deepEqual(parseSheetSize('24 in x 96 in'), { width: 24, length: 96 });
  });

  test('returns null when there is no size in the text', () => {
    assert.equal(parseSheetSize('Coil'), null);
    assert.equal(parseSheetSize(''), null);
  });
});

describe('describe', () => {
  test('formats a drop the way the rack tag reads', () => {
    assert.equal(label({ width: 24, length: 120 }), '24" × 120"');
  });
});
