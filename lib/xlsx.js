/* ============================================================
   Spreadsheet reader — .xlsx and .csv, no dependencies.

   An .xlsx file is a ZIP of XML. Node ships both a ZIP-capable
   inflater (zlib) and everything needed to walk the archive, so
   the price book on the office computer can be read directly
   rather than asking anyone to convert it first.

   This reads values only: text, numbers, dates as they were
   typed. Formulas come back as their last-calculated result,
   which is what Excel stores next to them and what a price book
   actually wants.
   ============================================================ */
'use strict';

const zlib = require('node:zlib');

// ---------------------------------------------------------------- ZIP
/**
 * Walk the central directory rather than scanning for local headers.
 * Entries written with a streaming writer leave the sizes zeroed in the
 * local header and only fill them into the central directory, so that
 * is the only place the sizes can be trusted.
 */
function unzip(buf) {
  const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP directory found)');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64: the 32-bit fields saturate and the real values live in a locator
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const files = new Map();
  let p = cdOffset;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: () => [...files.keys()],
    read(name) {
      const e = files.get(name);
      if (!e) return null;
      const lo = e.localOffset;
      if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`Unsupported compression in the spreadsheet (method ${e.method})`);
    },
  };
}

// ---------------------------------------------------------------- XML
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => String(s).replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** Every <tag ...>inner</tag> and <tag ... /> at any depth, in document order. */
function* elements(xml, tag) {
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    if (m[2]) { yield { attrs, inner: '' }; continue; }
    const close = xml.indexOf(`</${tag}>`, re.lastIndex);
    if (close < 0) return;
    yield { attrs, inner: xml.slice(re.lastIndex, close) };
    re.lastIndex = close + tag.length + 3;
  }
}

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decode(m[1]) : '';
};

/** All the text inside an element, with runs joined — rich text counts as one string. */
const textOf = xml => [...elements(xml, 't')].map(e => decode(e.inner)).join('');

// ---------------------------------------------------------------- cells
/** "BC12" → 54 (zero-based column index). */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Excel serial → ISO date. Day 60 is Excel's phantom 1900 leap day. */
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

/**
 * Read one worksheet into a rectangular array of strings.
 * Blank cells and skipped columns are filled in, so column N of every
 * row lines up with column N of the header no matter how sparse the
 * original sheet was.
 */
function readSheet(xml, shared, dateStyles) {
  const rows = [];
  let staleFormulas = 0;
  for (const row of elements(xml, 'row')) {
    const cells = [];
    for (const c of elements(row.inner, 'c')) {
      const ref = attr(c.attrs, 'r');
      const type = attr(c.attrs, 't');
      const style = attr(c.attrs, 's');
      const at = ref ? colIndex(ref) : cells.length;
      let value = '';
      if (type === 'inlineStr') value = textOf(c.inner);
      else {
        const v = c.inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? decode(v[1]) : '';
        // Excel caches every formula's last result next to it. A formula with
        // no cached result was written by something other than Excel, and its
        // value is genuinely unknown to us — worth telling the office rather
        // than importing a silent zero.
        if (!v && /<f[\s>]/.test(c.inner)) staleFormulas++;
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = '';                       // #REF!, #N/A — treat as empty
        else if (raw !== '' && dateStyles.has(style) && Number.isFinite(Number(raw))) value = serialToDate(Number(raw));
        else value = raw;
      }
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    const idx = Number(attr(row.attrs, 'r') || 0) - 1;
    if (idx >= 0) { while (rows.length < idx) rows.push([]); rows[idx] = cells; }
    else rows.push(cells);
  }
  // pad every row to the widest
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return { rows, staleFormulas };
}

/** Which style ids format as a date, so 45292 comes back as 2024-01-01. */
function dateStyleIds(stylesXml) {
  const ids = new Set();
  if (!stylesXml) return ids;
  const custom = new Set();
  for (const f of elements(stylesXml, 'numFmt')) {
    const code = attr(f.attrs, 'formatCode');
    if (/[dmy]/i.test(code) && !/[#0]/.test(code.replace(/\[[^\]]*\]/g, ''))) custom.add(attr(f.attrs, 'numFmtId'));
  }
  const builtin = new Set(['14', '15', '16', '17', '22']);
  const xfs = [...elements(stylesXml, 'cellXfs')][0];
  if (!xfs) return ids;
  let i = 0;
  for (const xf of elements(xfs.inner, 'xf')) {
    const id = attr(xf.attrs, 'numFmtId');
    if (builtin.has(id) || custom.has(id)) ids.add(String(i));
    i++;
  }
  return ids;
}

// ---------------------------------------------------------------- public
/** Every sheet in an .xlsx, as arrays of strings. */
function readXlsx(buffer) {
  const zip = unzip(buffer);
  const get = name => { const b = zip.read(name); return b ? b.toString('utf8') : ''; };

  const sharedXml = get('xl/sharedStrings.xml');
  const shared = sharedXml ? [...elements(sharedXml, 'si')].map(si => textOf(si.inner)) : [];
  const dateStyles = dateStyleIds(get('xl/styles.xml'));

  // sheet name → file, via the workbook's relationship ids
  const relsXml = get('xl/_rels/workbook.xml.rels');
  const rels = new Map();
  for (const r of elements(relsXml, 'Relationship')) {
    rels.set(attr(r.attrs, 'Id'), attr(r.attrs, 'Target').replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const wbXml = get('xl/workbook.xml');
  const sheets = [];
  for (const s of elements(wbXml, 'sheet')) {
    const name = attr(s.attrs, 'name');
    const rid = attr(s.attrs, 'r:id') || attr(s.attrs, 'id');
    const target = rels.get(rid);
    const xml = target ? get(`xl/${target}`) : '';
    if (!xml) continue;
    if (attr(s.attrs, 'state') === 'hidden') continue;
    const { rows, staleFormulas } = readSheet(xml, shared, dateStyles);
    sheets.push({ name, rows, stale_formulas: staleFormulas });
  }
  if (!sheets.length) throw new Error('No readable sheets in that file');
  return sheets;
}

/** CSV with quoted fields, embedded commas, newlines and doubled quotes. */
function readCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        const next = src[i + 1];
        if (next === '"') { field += '"'; i++; }                       // escaped quote
        else if (next === undefined || next === ',' || next === '\t' || next === '\r' || next === '\n') quoted = false;
        // A lone quote mid-field is an inch mark, not the end of the field.
        // Excel doubles them on export, but hand-made files in this trade are
        // full of 1-1/2" and 5/8" — reading that as a closing quote swallows
        // the rest of the file into one cell.
        else field += ch;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\r') { /* handled by \n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (const r of rows) while (r.length < width) r.push('');
  return [{ name: 'Sheet1', rows, stale_formulas: 0 }];
}

/** Read whatever they uploaded. */
function read(buffer, filename = '') {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (isZip) return readXlsx(buf);
  if (/\.xls$/i.test(filename) && !isZip) {
    throw new Error('That is an old .xls file. Open it in Excel and use Save As → .xlsx (or .csv), then upload again.');
  }
  return readCsv(buf.toString('utf8'));
}

module.exports = { read, readXlsx, readCsv, unzip, colIndex, elements, attr, textOf };
