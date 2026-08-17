/**
 * Minimal SMTP client (no dependencies) + outbox fallback.
 *
 * Speaks enough SMTP to send multipart/alternative mail through a normal
 * provider: implicit TLS (port 465) or STARTTLS (587), AUTH LOGIN / PLAIN.
 * When SMTP is not configured, mail is written to data/outbox/*.html instead
 * so quotes can still be previewed and the feature stays usable out of the box.
 */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUTBOX = path.join(__dirname, 'data', 'outbox');

// ---------------------------------------------------------------- SMTP conversation
class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.pending = null;
    socket.setEncoding('utf8');
    socket.on('data', chunk => this._onData(chunk));
    socket.on('error', err => this._fail(err));
    socket.on('close', () => this._fail(new Error('SMTP connection closed unexpectedly')));
  }

  _onData(chunk) {
    this.buffer += chunk;
    // A reply is complete when a line reads "NNN <text>" (space, not hyphen).
    const lines = this.buffer.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join('\n');
        this.buffer = lines.slice(i + 1).join('\n');
        const p = this.pending;
        this.pending = null;
        if (p) p.resolve({ code: parseInt(reply.slice(0, 3), 10), text: reply });
        return;
      }
    }
  }

  _fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }

  /** Wait for the next server reply, asserting it starts with an expected code. */
  expect(codes) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP timeout waiting for server')), 20000);
      this.pending = {
        resolve: r => {
          clearTimeout(timer);
          if (codes && !codes.includes(r.code)) return reject(new Error(`SMTP error ${r.code}: ${r.text.trim()}`));
          resolve(r);
        },
        reject: e => { clearTimeout(timer); reject(e); },
      };
    });
  }

  send(line, codes) {
    this.socket.write(line + '\r\n');
    return codes ? this.expect(codes) : Promise.resolve();
  }

  upgrade(host) {
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: this.socket, servername: host }, () => {
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('close');
        this.socket = secure;
        this.buffer = '';
        secure.setEncoding('utf8');
        secure.on('data', c => this._onData(c));
        secure.on('error', e => this._fail(e));
        resolve();
      });
      secure.on('error', reject);
    });
  }
}

function connect({ host, port, secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error(`Could not reach ${host}:${port}`)); });
    socket.on('error', reject);
  });
}

// ---------------------------------------------------------------- message building
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
const addrOnly = s => { const m = /<([^>]+)>/.exec(s || ''); return m ? m[1] : String(s || '').trim(); };

function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, subject, text, html, replyTo }) {
  const boundary = '=_dts_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${encodeHeader(from)}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@dts-command-center>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');

  const body = [
    '', `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html || ''),
    `--${boundary}--`, '',
  ].join('\r\n');

  // dot-stuffing so a lone "." never terminates DATA early
  return (headers + '\r\n' + body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

// ---------------------------------------------------------------- public API
/**
 * Send a message. Returns {status:'sent'} when SMTP delivered it, or
 * {status:'outbox', file} when SMTP is unconfigured and it was saved locally.
 * Throws only when SMTP is configured but delivery failed.
 */
async function sendMail(config, message) {
  const { host, port, user, pass, secure } = config;
  const from = config.from || 'no-reply@localhost';
  const raw = buildMessage({ ...message, from });

  if (!host) return saveToOutbox(message, raw, 'SMTP not configured — saved to outbox');

  const socket = await connect({ host, port: Number(port) || 587, secure: !!secure });
  const s = new SmtpSession(socket);
  try {
    await s.expect([220]);
    let ehlo = await s.send(`EHLO ${host}`, [250]);
    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      await s.send('STARTTLS', [220]);
      await s.upgrade(host);
      ehlo = await s.send(`EHLO ${host}`, [250]);
    }
    if (user) {
      if (/AUTH[ -=][^\n]*PLAIN/i.test(ehlo.text)) {
        await s.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`, [235]);
      } else {
        await s.send('AUTH LOGIN', [334]);
        await s.send(Buffer.from(String(user), 'utf8').toString('base64'), [334]);
        await s.send(Buffer.from(String(pass), 'utf8').toString('base64'), [235]);
      }
    }
    await s.send(`MAIL FROM:<${addrOnly(from)}>`, [250]);
    await s.send(`RCPT TO:<${addrOnly(message.to)}>`, [250, 251]);
    await s.send('DATA', [354]);
    s.socket.write(raw + '\r\n.\r\n');
    await s.expect([250]);
    await s.send('QUIT').catch(() => {});
    return { status: 'sent' };
  } finally {
    s.socket.destroy();
  }
}

function saveToOutbox(message, raw, note) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTo = addrOnly(message.to).replace(/[^a-z0-9@._-]/gi, '_');
  const file = `${stamp}__${safeTo}.html`;
  const banner = `<div style="background:#131c26;color:#f5a524;padding:12px 16px;font:600 13px system-ui">
    OUTBOX PREVIEW — ${note}. To: ${addrOnly(message.to)} · Subject: ${message.subject}</div>`;
  fs.writeFileSync(path.join(OUTBOX, file), banner + (message.html || ''), 'utf8');
  fs.writeFileSync(path.join(OUTBOX, file.replace(/\.html$/, '.eml')), raw, 'utf8');
  return { status: 'outbox', file, note };
}

module.exports = { sendMail, OUTBOX };
