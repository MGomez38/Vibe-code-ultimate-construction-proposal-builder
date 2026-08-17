/**
 * Reading the office price book.
 *
 * Everything the company charges for arrives through this path, so the
 * things that must not break quietly: a "$1,020.50" that becomes 1020.50
 * and not 1, a cost column that never lands in the price column, and a
 * re-import that does not wipe the counts the shop keeps by hand.
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { readCsv, read, colIndex } = require('../lib/xlsx');
const { fieldFor, findHeader, buildRows, money, unitOf, analyze } = require('../lib/pricebook');

describe('money out of a spreadsheet cell', () => {
  test('currency symbols and thousands separators come off', () => {
    assert.equal(money('$1,020.50'), 1020.5);
    assert.equal(money(' 68.40 '), 68.4);
    assert.equal(money('€2.400'), 2.4);
  });

  test('accounting negatives are negative', () => {
    assert.equal(money('(3.00)'), -3);
  });

  test('a per-unit suffix is trimmed', () => {
    assert.equal(money('9.25/lf'), 9.25);
  });

  test('empty means not given, which is not the same as zero', () => {
    assert.equal(money(''), null);
    assert.equal(money(null), null);
    assert.equal(money('   '), null);
    assert.equal(money(0), 0, 'a real zero is still a zero');
  });

  test('text that is not a number is refused rather than coerced', () => {
    assert.equal(money('CALL FOR PRICE'), null);
    assert.equal(money('TBD'), null);
    assert.equal(money('N/A'), null);
  });
});

describe('working out what a column heading means', () => {
  test('cost words and price words do not cross', () => {
    assert.equal(fieldFor('Our Cost'), 'unit_cost');
    assert.equal(fieldFor('Cost Each'), 'unit_cost');
    assert.equal(fieldFor('Sell Price'), 'sell_price');
    assert.equal(fieldFor('Unit Price'), 'sell_price');
  });

  test('"unit cost" is a cost, not a unit — the money word wins', () => {
    // Getting this backwards puts your cost in the sell column and quotes
    // every job at cost.
    assert.equal(fieldFor('Unit Cost'), 'unit_cost');
  });

  test('the common aliases resolve', () => {
    assert.equal(fieldFor('UOM'), 'unit');
    assert.equal(fieldFor('Item #'), 'sku');
    assert.equal(fieldFor('Item Description'), 'name');
    assert.equal(fieldFor('On Hand'), 'qty_on_hand');
    assert.equal(fieldFor('Supplier'), 'vendor');
  });

  test('a heading it does not know is left alone', () => {
    assert.equal(fieldFor('Notes'), null);
    assert.equal(fieldFor(''), null);
  });
});

describe('finding the header row', () => {
  const rows = [
    ['ALL SPEC SHEETMETAL — MASTER PRICE LIST', '', '', ''],
    ['Updated', '2026-07-01', '', ''],
    ['', '', '', ''],
    ['Item #', 'Description', 'UOM', 'Sell Price'],
    ['AS-1001', '24ga Galvanized Sheet', 'sheet', '112.00'],
  ];

  test('row 1 being the company name does not fool it', () => {
    const h = findHeader(rows);
    assert.equal(h.index, 3);
    assert.deepEqual(h.mapping, { sku: 0, name: 1, unit: 2, sell_price: 3 });
  });
});

describe('turning rows into materials', () => {
  const mapping = { sku: 0, name: 1, unit: 2, unit_cost: 3, sell_price: 4 };
  const header = ['Item #', 'Description', 'UOM', 'Cost', 'Price'];

  test('a normal row becomes a material', () => {
    const { items } = buildRows([header, ['AS-1', 'Spiral Duct 8"', 'LF', '$4.85', '$9.25']], 0, mapping);
    assert.deepEqual(items[0].sku, 'AS-1');
    assert.equal(items[0].unit, 'lf', 'units are normalised so LF and lf are one unit');
    assert.equal(items[0].unit_cost, 4.85);
    assert.equal(items[0].sell_price, 9.25);
  });

  test('a section divider is skipped and said so', () => {
    const { items, skipped } = buildRows([header, ['', 'SHEET METAL', '', '', ''], ['AS-1', 'Duct', 'lf', '1', '2']], 0, mapping);
    assert.equal(items.length, 1);
    assert.equal(skipped[0].reason, 'looks like a section heading');
    assert.equal(skipped[0].row, 2, 'the row number is the one shown in Excel');
  });

  test('a row with no money at all is skipped, not imported at zero', () => {
    const { items, skipped } = buildRows([header, ['AS-9', 'Call for pricing', 'ea', '', '']], 0, mapping);
    assert.equal(items.length, 0);
    assert.equal(skipped[0].reason, 'no cost and no price');
  });

  test('blank spacer rows are ignored silently', () => {
    const { items, skipped } = buildRows([header, ['', '', '', '', ''], ['AS-1', 'Duct', 'lf', '1', '2']], 0, mapping);
    assert.equal(items.length, 1);
    assert.equal(skipped.length, 0, 'an empty row is not worth reporting');
  });

  test('a cost with no sell price imports but is flagged', () => {
    const { items } = buildRows([header, ['AS-5', 'Widget', 'ea', '10.00', '']], 0, mapping);
    assert.equal(items[0].sell_price, 0);
    assert.equal(items[0].no_price, true, 'the office has to see the margin hole before quoting it');
  });

  test('an unmapped column reads as absent, not as zero', () => {
    // qty_on_hand is not in the mapping. It must come back null so the
    // import leaves the shop's physical count alone.
    const { items } = buildRows([header, ['AS-1', 'Duct', 'lf', '1', '2']], 0, mapping);
    assert.equal(items[0].qty_on_hand, null);
    assert.equal(items[0].reorder_point, null);
  });
});

describe('units', () => {
  test('the same unit spelled differently collapses', () => {
    assert.equal(unitOf('EA'), 'ea');
    assert.equal(unitOf('Each'), 'ea');
    assert.equal(unitOf('LF'), 'lf');
    assert.equal(unitOf('Linear Feet'), 'lf');
    assert.equal(unitOf('SHEETS'), 'sheet');
  });

  test('a unit it does not know is kept as typed', () => {
    assert.equal(unitOf('drum'), 'drum');
  });

  test('no unit means each', () => {
    assert.equal(unitOf(''), 'ea');
  });
});

describe('CSV', () => {
  test('quoted fields with commas survive', () => {
    const [sheet] = readCsv('SKU,Description,Price\nA-1,"Duct, 8 inch, galvanized",9.25\n');
    assert.deepEqual(sheet.rows[1], ['A-1', 'Duct, 8 inch, galvanized', '9.25']);
  });

  test('doubled quotes inside a field are one quote', () => {
    const [sheet] = readCsv('SKU,Description\nA-1,"Sheet 5/8"" thick"\n');
    assert.equal(sheet.rows[1][1], 'Sheet 5/8" thick');
  });

  test('a bare inch mark inside a quoted field does not swallow the file', () => {
    // Excel doubles quotes on export, but hand-built price books in this
    // trade are full of 1-1/2" and 5/8". Treating that as a closing quote
    // merges every following row into one cell.
    const [sheet] = readCsv('SKU,Description,Price\nA-1,"Handrail, 1-1/2" sch40",39.00\nA-2,Bollard,50.00\n');
    assert.equal(sheet.rows.length, 3, 'the second item must still be its own row');
    assert.equal(sheet.rows[1][1], 'Handrail, 1-1/2" sch40');
    assert.equal(sheet.rows[1][2], '39.00');
  });

  test('a byte-order mark does not end up in the first heading', () => {
    const [sheet] = readCsv('﻿SKU,Price\nA-1,2\n');
    assert.equal(sheet.rows[0][0], 'SKU');
  });

  test('short rows are padded so the columns stay aligned', () => {
    const [sheet] = readCsv('a,b,c\n1,2\n');
    assert.equal(sheet.rows[1].length, 3);
  });
});

describe('the .xlsx reader', () => {
  test('spreadsheet column letters map to indexes', () => {
    assert.equal(colIndex('A1'), 0);
    assert.equal(colIndex('Z9'), 25);
    assert.equal(colIndex('AA1'), 26);
    assert.equal(colIndex('BC12'), 54);
  });

  /** The smallest real .xlsx: a ZIP with the three parts that matter. */
  function tinyXlsx() {
    const parts = [
      ['xl/workbook.xml', '<workbook><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/sharedStrings.xml', '<sst><si><t>Description</t></si><si><t>Duct 8&quot; &amp; fittings</t></si></sst>'],
      ['xl/worksheets/sheet1.xml',
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Price</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>9.25</v></c></row>' +
        '</sheetData></worksheet>'],
    ];
    const locals = [], central = [];
    let offset = 0;
    for (const [name, xml] of parts) {
      const body = Buffer.from(xml, 'utf8');
      const comp = zlib.deflateRawSync(body);
      const nameBuf = Buffer.from(name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      locals.push(local, nameBuf, comp);

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(body.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
      central.push(cd, nameBuf);
      offset += local.length + nameBuf.length + comp.length;
    }
    const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
    return Buffer.concat([localBuf, centralBuf, eocd]);
  }

  test('a real .xlsx is unzipped and read', () => {
    const [sheet] = read(tinyXlsx(), 'book.xlsx');
    assert.equal(sheet.name, 'Prices');
    assert.deepEqual(sheet.rows[0], ['Description', '', 'Price']);
  });

  test('XML entities in a shared string are decoded', () => {
    const [sheet] = read(tinyXlsx(), 'book.xlsx');
    assert.equal(sheet.rows[1][0], 'Duct 8" & fittings');
  });

  test('a gap in the columns is preserved so column C stays column C', () => {
    const [sheet] = read(tinyXlsx(), 'book.xlsx');
    assert.equal(sheet.rows[1][2], '9.25', 'B was empty; the price must not slide left into it');
  });

  test('the whole path holds together', () => {
    const [a] = analyze(read(tinyXlsx(), 'book.xlsx'));
    assert.equal(a.header_index, 0);
    assert.equal(a.mapping.name, 0);
    assert.equal(a.mapping.sell_price, 2);
    assert.equal(a.item_count, 1);
    assert.equal(a.preview[0].sell_price, 9.25);
  });

  test('something that is not a spreadsheet at all fails clearly', () => {
    // A .csv misnamed .xlsx falls through to the CSV reader rather than
    // throwing at the office.
    const [sheet] = read(Buffer.from('a,b\n1,2\n'), 'weird.xlsx');
    assert.equal(sheet.rows[0][0], 'a');
  });
});
