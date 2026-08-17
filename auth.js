/**
 * Authentication — scrypt password hashing and cookie-backed sessions.
 * Two roles: `admin` (office / owner — full Command Center) and
 * `crew` (field employee — the mobile portal, own data only).
 */
'use strict';

const crypto = require('node:crypto');

const SESSION_DAYS = 14;
const COOKIE = 'dts_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeAuth(db) {
  const stamp = d => d.toISOString().replace('T', ' ').slice(0, 19);

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, stamp(expires));
    db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
    return { token, expires };
  }

  function sessionCookie(token, expires) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}`;
  }
  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  /** Resolve the signed-in user for a request, or null. */
  function currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const row = db.prepare(`
      SELECT u.id, u.username, u.role, u.employee_id, u.active, s.token, e.name AS employee_name, e.role AS employee_role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN employees e ON e.id = u.employee_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
    if (!row || !row.active) return null;
    return row;
  }

  function login(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(stamp(new Date()), user.id);
    return { user, session: createSession(user.id) };
  }

  function logout(req) {
    const token = parseCookies(req)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  function audit(user, action, detail = '') {
    db.prepare('INSERT INTO audit_log (user_id, username, action, detail) VALUES (?,?,?,?)')
      .run(user?.id || null, user?.username || 'system', action, detail);
  }

  return { currentUser, login, logout, createSession, sessionCookie, clearCookie, audit, COOKIE };
}

module.exports = { makeAuth, hashPassword, verifyPassword, parseCookies };
