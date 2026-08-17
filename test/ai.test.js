/**
 * The estimating assistant. Two things here can cost real money if they
 * break quietly: reading a quantity out of a sentence, and letting a price
 * onto a quote that did not come from the company's own catalog. Both are
 * pinned down below.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { localDraft, reground, parseQty, clauses, buildMatcher } = require('../lib/ai');

const CATALOG = [
  { desc: '2x4 Stud 8ft SPF', unit: 'ea', source: 'catalog', times: 0, price: 6.5, cost: 3.85, qty_on_hand: 240 },
  { desc: 'Drywall 5/8" 4x8', unit: 'sheet', source: 'catalog', times: 0, price: 22, cost: 13.9, qty_on_hand: 52 },
  { desc: 'Duct liner & sealant', unit: 'set', source: 'history', times: 1, price: 88, cost: 44, last_on: 'AS-Q-2211' },
  { desc: 'Powder Coat Black (per sqft)', unit: 'sqft', source: 'history', times: 3, price: 2.4, cost: 1.1, last_on: 'AS-WO-5122' },
];
const CTX = {
  catalog: CATALOG,
  company: { name: 'All Spec', trade: 'sheet metal' },
  labor_rate: 72, target_margin_pct: 32, labor_variance_pct: 0, similar: [], client: '',
};

describe('reading quantities out of English', () => {
  test('a leading count is a count', () => {
    assert.deepEqual(parseQty('120 2x4 studs 8ft'), { qty: 120, unit: 'ea', desc: '2x4 studs 8ft' });
  });

  test('a leading count with a unit keeps the unit', () => {
    assert.deepEqual(parseQty('40 lf of spiral duct'), { qty: 40, unit: 'lf', desc: 'spiral duct' });
  });

  test('a trailing quantity is read only when nothing leads', () => {
    assert.deepEqual(parseQty('powder coat black 220 sqft'), { qty: 220, unit: 'sqft', desc: 'powder coat black' });
  });

  test('a trailing size is NOT mistaken for a quantity', () => {
    // "8ft" here describes the stud, not how many there are — reading it as
    // a count would quote 8 studs instead of 120.
    assert.equal(parseQty('120 2x4 studs 8ft').qty, 120);
  });

  test('the x-form works', () => {
    assert.deepEqual(parseQty('Rebar #4 20ft x 30'), { qty: 30, unit: 'ea', desc: 'Rebar #4 20ft' });
  });

  test('a gauge is not a quantity', () => {
    assert.equal(parseQty('16ga galvanized duct').qty, 1);
  });

  test('no number at all means one of it', () => {
    assert.deepEqual(parseQty('Hang a new steel man door'), { qty: 1, unit: 'ea', desc: 'Hang a new steel man door' });
  });
});

describe('splitting a scope into lines', () => {
  test('bullets and list markers come off, quantities stay on', () => {
    const c = clauses('- 120 studs\n2. 14 sheets drywall\n• 4 sheets plywood');
    assert.deepEqual(c, ['120 studs', '14 sheets drywall', '4 sheets plywood']);
  });

  test('newlines separate items', () => {
    assert.equal(clauses('a line\nanother line\n\nthird').length, 3);
  });
});

describe('matching against the company catalog', () => {
  const match = buildMatcher(CATALOG);

  test('a real match is found', () => {
    assert.equal(match('2x4 studs 8ft').entry.desc, '2x4 Stud 8ft SPF');
  });

  test('plural and singular are the same item', () => {
    assert.equal(match('drywall sheets').entry.desc, 'Drywall 5/8" 4x8');
  });

  test('one shared word is not a match', () => {
    // "spiral duct" overlaps "Duct liner & sealant" on the word duct only.
    // Quoting duct liner for spiral duct is how the wrong item gets sold.
    assert.equal(match('spiral duct'), null);
  });

  test('nothing in common returns nothing', () => {
    assert.equal(match('hydraulic elevator controller'), null);
  });
});

describe('drafting from the company history alone', () => {
  test('quantities and catalog prices land on the right lines', () => {
    const d = localDraft('120 2x4 studs 8ft\n14 sheets of 5/8 drywall', CTX);
    assert.equal(d.mode, 'local');
    assert.deepEqual(d.items.map(i => [i.desc, i.qty, i.unit_price]), [
      ['2x4 Stud 8ft SPF', 120, 6.5],
      ['Drywall 5/8" 4x8', 14, 22],
    ]);
  });

  test('an unknown line comes back blank, not guessed', () => {
    const d = localDraft('4 unobtanium flange widgets', CTX);
    assert.equal(d.items[0].unit_price, 0);
    assert.equal(d.items[0].unit_cost, 0);
    assert.equal(d.items[0].source, 'new');
    assert.match(d.questions[0], /What do you charge/);
  });

  test('an hours callout becomes labor, not a line item', () => {
    const d = localDraft('120 2x4 studs 8ft\n24 hours of framing', CTX);
    assert.equal(d.labor_hours, 24);
    assert.equal(d.items.length, 1, 'the hours line must not also be quoted as material');
  });

  test('a known labor overrun is stated, not buried', () => {
    const d = localDraft('16 hours of framing', { ...CTX, labor_variance_pct: 12 });
    assert.ok(d.assumptions.some(a => a.includes('12%')), 'the estimator should be told their hours run over');
  });
});

describe('re-grounding whatever a model hands back', () => {
  test("a model's price for a known item is replaced by the real one", () => {
    const [line] = reground([
      { desc: '2x4 Stud 8ft SPF', qty: 120, unit: 'ea', unit_cost: 3.2, unit_price: 4.25, source: 'catalog', why: 'lumber' },
    ], CTX);
    assert.equal(line.unit_price, 6.5, 'the catalog price wins');
    assert.equal(line.unit_cost, 3.85);
    assert.match(line.why, /4\.25/, 'and the override is disclosed, not silent');
  });

  test('a price claimed from history with no match behind it is stripped', () => {
    const [line] = reground([
      { desc: 'Unobtanium flange widget', qty: 2, unit: 'ea', unit_cost: 400, unit_price: 900, source: 'history', why: 'we quoted this before' },
    ], CTX);
    assert.equal(line.unit_price, 0, 'an invented price must never reach a quote');
    assert.equal(line.unit_cost, 0);
    assert.equal(line.source, 'new');
  });

  test('an honestly blank line stays blank', () => {
    const [line] = reground([
      { desc: 'Stainless grease duct, welded, 16ga', qty: 40, unit: 'lf', unit_cost: 0, unit_price: 0, source: 'new', why: 'not in catalog' },
    ], CTX);
    assert.equal(line.unit_price, 0);
    assert.equal(line.source, 'new');
  });

  test('garbage fields are coerced rather than trusted', () => {
    const [line] = reground([{ desc: 'x', qty: 'not a number', unit: null, unit_cost: 'abc', unit_price: undefined, source: 'wat', why: null }], CTX);
    assert.equal(line.qty, 1);
    assert.equal(line.unit, 'ea');
    assert.equal(line.unit_price, 0);
    assert.equal(line.source, 'new');
  });
});
