/**
 * Company scoping — which entity's books you are looking at.
 *
 * A user pinned to one company (`users.company_id`) only ever sees that one.
 * A group user (company_id NULL, i.e. the owner) can switch between entities,
 * or view the group consolidated. The active choice rides in a cookie, but the
 * user's own pin always wins — the switcher can never widen access.
 */
'use strict';

const COOKIE = 'dts_scope';

module.exports = function makeScope(db) {
  const all = () => db.prepare('SELECT * FROM companies WHERE active = 1 ORDER BY id').all();
  const byId = id => db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  const byCode = code => db.prepare('SELECT * FROM companies WHERE code = ?').get(String(code || '').toUpperCase());

  /**
   * Resolve the active scope for a request.
   * Returns { companies, activeId, active, isGroup, canSwitch, ids }
   *   activeId  — the single entity in focus, or null when viewing the group
   *   ids       — every company id this user may read, for query filtering
   */
  function resolve(user, cookieValue) {
    const companies = all();
    if (user && user.company_id) {
      const pinned = byId(user.company_id) || companies[0];
      return { companies: [pinned], activeId: pinned.id, active: pinned, isGroup: false, canSwitch: false, ids: [pinned.id] };
    }
    // group user: honour the switcher, defaulting to the whole group
    const wanted = String(cookieValue || '').trim();
    if (wanted && wanted !== 'group') {
      const picked = /^\d+$/.test(wanted) ? byId(Number(wanted)) : byCode(wanted);
      if (picked && picked.active) {
        return { companies, activeId: picked.id, active: picked, isGroup: false, canSwitch: true, ids: [picked.id] };
      }
    }
    return { companies, activeId: null, active: null, isGroup: true, canSwitch: true, ids: companies.map(c => c.id) };
  }

  /**
   * A SQL fragment restricting a table to the readable companies.
   * Rows with no company (legacy or system rows) stay visible so nothing
   * silently disappears from an upgraded database.
   */
  function where(scope, alias = '') {
    const col = `${alias ? alias + '.' : ''}company_id`;
    if (!scope.ids.length) return { sql: '1=1', params: [] };
    return { sql: `(${col} IN (${scope.ids.map(() => '?').join(',')}) OR ${col} IS NULL)`, params: [...scope.ids] };
  }

  /** The company a newly created record should belong to. */
  function writeCompanyId(scope, explicit) {
    if (explicit && scope.ids.includes(Number(explicit))) return Number(explicit);
    if (scope.activeId) return scope.activeId;
    return scope.ids[0] || null;   // group view: fall back to the first entity
  }

  const cookie = value => `${COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

  return { resolve, where, writeCompanyId, all, byId, byCode, cookie, COOKIE };
};
