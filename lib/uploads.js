/**
 * multipart/form-data parsing and photo storage — no dependencies.
 *
 * The browser downscales photos before upload (see portal.js), so these stay
 * small; anything over MAX_BYTES is rejected outright rather than buffered.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf',
};

/** Buffer a request body up to MAX_BYTES. */
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BYTES) { req.destroy(); return reject(new Error('File too large (12 MB max)')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Split a multipart body into { fields, files }.
 * Parts are located by boundary markers; each part's headers end at CRLFCRLF.
 */
function parseMultipart(buffer, boundary) {
  const fields = {}, files = [];
  const delim = Buffer.from(`--${boundary}`);
  const positions = [];
  let at = buffer.indexOf(delim);
  while (at !== -1) { positions.push(at); at = buffer.indexOf(delim, at + delim.length); }

  for (let i = 0; i < positions.length - 1; i++) {
    // skip the boundary line itself (delim + CRLF)
    let start = positions[i] + delim.length;
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) continue; // closing "--"
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1 || headerEnd > positions[i + 1]) continue;

    const headers = buffer.slice(start, headerEnd).toString('utf8');
    // the part's content ends two bytes before the next boundary (trailing CRLF)
    const body = buffer.slice(headerEnd + 4, Math.max(headerEnd + 4, positions[i + 1] - 2));

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n;]+)/i.exec(headers);

    if (fileMatch && fileMatch[1]) {
      files.push({ field: name, original_name: fileMatch[1], mime: (typeMatch ? typeMatch[1] : '').trim().toLowerCase(), data: body });
    } else {
      fields[name] = body.toString('utf8');
    }
  }
  return { fields, files };
}

/** Parse an upload request; throws on an unsupported content type. */
async function readUpload(req) {
  const ct = req.headers['content-type'] || '';
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!/multipart\/form-data/i.test(ct) || !m) throw new Error('Expected a file upload');
  return parseMultipart(await readRaw(req), (m[1] || m[2]).trim());
}

/** Write one uploaded file to disk, returning its stored metadata. */
function storeFile(file) {
  if (!ALLOWED[file.mime]) throw new Error(`Unsupported file type: ${file.mime || 'unknown'}`);
  if (!file.data.length) throw new Error('Empty file');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ALLOWED[file.mime]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
  return { filename, original_name: file.original_name.slice(0, 180), mime: file.mime, size: file.data.length };
}

function removeFile(filename) {
  const p = path.join(UPLOAD_DIR, path.basename(filename));
  if (p.startsWith(UPLOAD_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = { readUpload, storeFile, removeFile, UPLOAD_DIR, ALLOWED, MAX_BYTES };
