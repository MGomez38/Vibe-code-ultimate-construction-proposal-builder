/**
 * The duct formula.
 *
 * This is the one place in the app that produces a price out of arithmetic
 * rather than out of a list, so it is pinned to numbers taken straight from
 * a real shop workbook. If these move, quotes move.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const duct = require('../lib/duct');
const { ductSpec, localDraft } = require('../lib/ai');

/** Rates and timings lifted from a working fabrication book. */
const M = {
  steel_per_sqft: { 26: 2.1275, 24: 2.6125, 22: 3.15, 20: 3.75, 18: 4.85 },
  liner_per_sqft: { 0.5: 2.1333333333333333, 1: 2.6166666666666667, 1.5: 4.916666666666667 },
  labor_rate: { a: 2.5, b: 2.7766666666666664, c: 3.0533333333333332, d: 3.33 },
  markup: 1.15,
  default_gauge: '24', default_labor_class: 'a',
  labor: {
    '12x2': { fab: 9, liner: 5 },
    '16x2': { fab: 9.666666666666668, liner: 5.555555555555555 },
    '20x12': { fab: 12.887755102040813, liner: 7.346938775510203 },
  },
};

describe('the price a shop workbook produces', () => {
  test('the cell I checked by hand comes out to the cent', () => {
    // 12" girth, 2" long, 24ga, 1/2" liner, class A — $42.32 in the book.
    const r = duct.price(M, { girth: 12, length: 2, gauge: 24, liner: 0.5, labor_class: 'a' });
    assert.equal(r.ok, true);
    assert.equal(r.price, 42.32);
  });

  test('and a second one', () => {
    const r = duct.price(M, { girth: 16, length: 2, gauge: 24, liner: 0.5, labor_class: 'a' });
    assert.equal(r.price, 46.5);
  });

  test('the same size at a gauge the grid never held', () => {
    // The imported grid is 24ga only. The formula prices any of them.
    const heavy = duct.price(M, { girth: 20, length: 12, gauge: 18, liner: 1 });
    const light = duct.price(M, { girth: 20, length: 12, gauge: 26, liner: 1 });
    assert.ok(heavy.price > light.price, '18ga costs more metal than 26ga');
    assert.equal(heavy.ok && light.ok, true);
  });

  test('unlined is cheaper than lined, and the liner is itemised', () => {
    const bare = duct.price(M, { girth: 20, length: 12, gauge: 24, liner: 0 });
    const lined = duct.price(M, { girth: 20, length: 12, gauge: 24, liner: 1 });
    assert.ok(lined.price > bare.price);
    assert.equal(bare.breakdown.liner_material, 0);
    assert.equal(bare.breakdown.liner_labor, 0);
    assert.ok(lined.breakdown.liner_material > 0);
  });

  test('a steel increase moves every size', () => {
    const before = duct.price(M, { girth: 12, length: 2, gauge: 24, liner: 0.5 }).price;
    const dearer = { ...M, steel_per_sqft: { ...M.steel_per_sqft, 24: M.steel_per_sqft[24] * 1.2 } };
    const after = duct.price(dearer, { girth: 12, length: 2, gauge: 24, liner: 0.5 }).price;
    assert.ok(after > before, 'that is the whole point of holding the formula rather than the grid');
  });

  test('a gauge with no price on file is refused, not guessed', () => {
    const r = duct.price(M, { girth: 12, length: 2, gauge: 14, liner: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /14ga/);
  });

  test('a size nobody has timed falls back to the nearest, and says so', () => {
    const r = duct.price(M, { girth: 13, length: 2, gauge: 24, liner: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.used.exact_size, false);
  });

  test('a size nowhere near the grid is refused', () => {
    const r = duct.price(M, { girth: 400, length: 900, gauge: 24, liner: 0 });
    assert.equal(r.ok, false);
  });

  test('missing dimensions are refused', () => {
    assert.equal(duct.price(M, { girth: 12, gauge: 24 }).ok, false);
  });

  test('a broken model is reported rather than used', () => {
    assert.ok(duct.check({ steel_per_sqft: {}, labor_rate: {}, labor: {}, markup: 0 }).length >= 3);
    assert.deepEqual(duct.check(M), []);
  });
});

describe('transitions', () => {
  // Rates and bands as they stand in the shop's transition sheet.
  const T = {
    ...M,
    transition_bands: [
      { band: '0-1800', units: 22 }, { band: '1801-2800', units: 30 },
      { band: '2801-4000', units: 47 }, { band: '4001-6000', units: 56.5 },
      { band: '6001-8000', units: 66 }, { band: '8001-10000', units: 75 },
      { band: '10001-12000', units: 82 }, { band: '12001-', units: 90 },
    ],
    transition_liner_per_sqft: { 0.5: 1.9833333333333334, 1: 2.4666666666666663, 1.5: 4.766666666666667 },
  };
  const EXAMPLE = { width_in: 36, depth_in: 24, width_out: 24, depth_out: 36, length: 18, gauge: 24, liner: 0, labor_class: 'a' };

  test('the developed area matches the shop\'s own worked example', () => {
    assert.equal(duct.transitionArea(EXAMPLE), 3456);
  });

  test('area picks the labor band', () => {
    assert.equal(duct.transitionLabor(T.transition_bands, 3456), 47);
    assert.equal(duct.transitionLabor(T.transition_bands, 1800), 22, 'the top of a band is inside it');
    assert.equal(duct.transitionLabor(T.transition_bands, 1801), 30, 'and the next inch is the next band');
    assert.equal(duct.transitionLabor(T.transition_bands, 99999), 90, 'past the last band, the last band holds');
  });

  test('the whole calculation reproduces their sheet to the cent', () => {
    const r = duct.transitionPrice(T, EXAMPLE);
    assert.equal(r.ok, true);
    assert.equal(r.breakdown.steel_sqft, 26.4);
    assert.equal(r.breakdown.steel, 68.97);
    assert.equal(r.breakdown.fab_labor, 117.5);
    assert.equal(r.breakdown.subtotal, 186.47, 'this is the number their workbook prints');
  });

  test('the bigger opening drives the metal, whichever end it is on', () => {
    // A transition narrowing 36→24 and one widening 24→36 are the same
    // piece of metal. Reading only the inlet would underprice one of them.
    const a = duct.transitionArea({ width_in: 36, depth_in: 24, width_out: 24, depth_out: 36, length: 18 });
    const b = duct.transitionArea({ width_in: 24, depth_in: 36, width_out: 36, depth_out: 24, length: 18 });
    assert.equal(a, b);
  });

  test('length moves the price and gauge moves the price', () => {
    const short = duct.transitionPrice(T, EXAMPLE).price;
    const long = duct.transitionPrice(T, { ...EXAMPLE, length: 36 }).price;
    const heavy = duct.transitionPrice(T, { ...EXAMPLE, gauge: 18 }).price;
    assert.ok(long > short);
    assert.ok(heavy > short);
  });

  test('a transition with no size is refused', () => {
    assert.equal(duct.transitionPrice(T, { length: 18, gauge: 24 }).ok, false);
  });
});

describe('reading a duct line out of English', () => {
  test('girth, length, gauge and liner all come off', () => {
    assert.deepEqual(ductSpec('register taps 20 girth x 12, 24ga, 1/2" liner'),
      { girth: 20, length: 12, gauge: '24', liner: 0.5, labor_class: undefined });
  });

  test('"no liner" means none, not unspecified', () => {
    assert.equal(ductSpec('duct 36 girth x 48 26ga no liner').liner, 0);
  });

  test('a sheet of metal is not a duct fitting', () => {
    // "24ga 48x120 galv" has two numbers and a gauge but is a sheet.
    // Pricing it through the duct formula would be nonsense.
    assert.equal(ductSpec('24ga 48x120 galv sheet'), null);
  });

  test('a duct line with no size is left alone', () => {
    assert.equal(ductSpec('spiral duct 26ga'), null);
  });
});

describe('quoting duct through the estimator', () => {
  const ctx = {
    catalog: [], company: { name: 'All Spec', trade: 'sheet metal' },
    labor_rate: 72, target_margin_pct: 32, labor_variance_pct: 0, similar: [], client: '',
    duct: M,
  };

  test('a duct line prices from the formula, not the catalog', () => {
    const d = localDraft('6 register taps 12 girth x 2, 24ga, 1/2" liner', ctx);
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].qty, 6);
    assert.equal(d.items[0].unit_price, 42.32);
    assert.equal(d.items[0].source, 'calculated');
  });

  test('the gauge and liner qualifiers stay attached to their line', () => {
    // Split on the commas, "24ga" becomes a mystery product with no price.
    const d = localDraft('6 register taps 12 girth x 2, 24ga, 1/2" liner', ctx);
    assert.equal(d.items.length, 1, 'one item, not three');
  });

  test('with no model saved, duct falls through to ordinary matching', () => {
    const d = localDraft('6 register taps 12 girth x 2, 24ga', { ...ctx, duct: null });
    assert.equal(d.items[0].source, 'new');
  });
});
