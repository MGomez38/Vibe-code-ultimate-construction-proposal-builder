/* ============================================================
   Crew Portal — the field-facing app.
   Everything here runs as the signed-in employee; the server never
   returns pricing or other crews' data to this surface.
   ============================================================ */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#p-view');

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api/' + path, opts);
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => new Date().toISOString().slice(0, 10);
const parseTs = ts => new Date(ts.replace(' ', 'T') + 'Z');
const fmtTime = ts => parseTs(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const cap = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function elapsed(ts) {
  const mins = Math.max(0, Math.floor((Date.now() - parseTs(ts)) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
function msg(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'p-msg ' + kind;
  el.textContent = text;
  $('#p-toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3200);
}

let me = null;

// ---------------------------------------------------------------- Today
async function pageHome() {
  const d = await api('portal/summary');
  const open = d.open_entry;
  view.innerHTML = `
    <div class="pc clock-card">
      <div class="time" id="live-time"></div>
      <div class="date">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="status-pill ${open ? 'on' : 'off'}"><i></i>${open ? 'On the clock' : 'Not clocked in'}</div>
      ${open ? `<div class="on-since">Since ${fmtTime(open.clock_in)} · <b id="run">${elapsed(open.clock_in)}</b>${open.job_number ? ` on ${esc(open.job_number)}` : ' (general shift)'}</div>` : '<div class="on-since">Pick your job and clock in to start the day.</div>'}
      <label class="fldlabel">${open ? 'Switch to another job' : 'Job'}</label>
      <select id="job-sel">
        <option value="">General shift / shop</option>
        ${d.jobs.map(j => `<option value="${j.id}" ${open && open.job_id === j.id ? 'selected' : ''}>${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}
      </select>
      <div class="${open ? 'btn-row' : ''}">
        <button class="big-btn go" id="btn-in">${open ? 'Switch Job' : 'Clock In'}</button>
        ${open ? '<button class="big-btn stop" id="btn-out">Clock Out</button>' : ''}
      </div>
    </div>

    <div class="pc">
      <h3>Today's Assignment<span class="r">${d.week_hours} hrs this week</span></h3>
      ${d.today.length ? d.today.map(s => `
        <div class="assign">
          <span class="jn ${s.job_number ? '' : 'shop'}">${esc(s.job_number || 'SHOP')}</span>
          <div>
            <div class="t">${esc(s.job_title || s.notes || 'Shop work')}</div>
            <div class="s">${esc(s.shift)}${s.address ? ' · ' + esc(s.address) : ''}${s.notes && s.job_title ? ' · ' + esc(s.notes) : ''}</div>
          </div>
        </div>`).join('') : '<div class="p-empty">Nothing scheduled for you today — check with the office.</div>'}
    </div>

    ${d.work_orders.length ? `<div class="pc">
      <h3>Your Open Work Orders<span class="r">${d.work_orders.length}</span></h3>
      ${d.work_orders.slice(0, 3).map(w => `
        <div class="assign">
          <span class="jn ${w.priority === 'rush' ? '' : 'shop'}">${esc(w.wo_number)}</span>
          <div><div class="t">${esc(w.title)}</div>
          <div class="s">${cap(w.wo_type)}${w.due_date ? ' · due ' + esc(w.due_date) : ''}${w.priority === 'rush' ? ' · RUSH' : ''}</div></div>
        </div>`).join('')}
      <button class="linkish" style="margin-top:10px" onclick="location.hash='#/work'">See all my work →</button>
    </div>` : ''}`;

  const tick = () => {
    const t = $('#live-time'); if (!t) return false;
    t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const r = $('#run'); if (r && open) r.textContent = elapsed(open.clock_in);
    return true;
  };
  tick();
  const iv = setInterval(() => { if (!tick()) clearInterval(iv); }, 1000);

  $('#btn-in').onclick = async () => {
    const jobId = $('#job-sel').value;
    if (open && String(open.job_id || '') === String(jobId)) return msg('You are already on that job', 'err');
    try { const r = await api('portal/clock/in', 'POST', { job_id: jobId ? Number(jobId) : null }); msg(r.message, 'ok'); pageHome(); }
    catch (e) { msg(e.message, 'err'); }
  };
  const outBtn = $('#btn-out');
  if (outBtn) outBtn.onclick = async () => {
    try { const r = await api('portal/clock/out', 'POST', {}); msg(r.message, 'ok'); pageHome(); }
    catch (e) { msg(e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- Schedule
async function pageWeek() {
  const rows = await api('portal/schedule');
  const byDate = {};
  rows.forEach(r => { (byDate[r.date] ||= []).push(r); });
  const start = new Date(); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = [...Array(14)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });

  view.innerHTML = `
    <div class="pc">
      <h3>Your Next Two Weeks</h3>
      ${days.map(d => {
        const key = d.toISOString().slice(0, 10);
        const items = byDate[key] || [];
        const isToday = key === todayStr();
        return `<div class="day ${isToday ? 'today' : ''}">
          <div class="dd"><div class="dow">${d.toLocaleDateString([], { weekday: 'short' })}</div><div class="num">${d.getDate()}</div></div>
          <div style="flex:1">
            ${items.length ? items.map(s => `
              <div class="t">${esc(s.job_number ? s.job_number + ' — ' + s.job_title : s.notes || 'Shop work')}</div>
              <div class="s">${esc(s.shift)}${s.address ? ' · ' + esc(s.address) : ''}</div>`).join('')
              : '<div class="s">—</div>'}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ---------------------------------------------------------------- My Hours
async function pageHours() {
  const rows = await api('portal/timesheet');
  const total = rows.reduce((s, r) => s + (r.hours || 0), 0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const thisWeek = rows.filter(r => r.clock_in.slice(0, 10) >= weekStart.toISOString().slice(0, 10))
    .reduce((s, r) => s + (r.hours || 0), 0);

  view.innerHTML = `
    <div class="hours-top">
      <div class="hstat"><div class="n">${Math.round(thisWeek * 10) / 10}</div><div class="l">This week</div></div>
      <div class="hstat"><div class="n">${Math.round(total * 10) / 10}</div><div class="l">Last 14 days</div></div>
    </div>
    <div class="pc">
      <h3>Your Punches</h3>
      ${rows.length ? rows.map(r => `
        <div class="tsrow">
          <div>
            <div class="l1">${esc(r.job_number ? r.job_number + ' — ' + r.job_title : 'General shift')}</div>
            <div class="l2">${parseTs(r.clock_in).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmtTime(r.clock_in)} → ${r.clock_out ? fmtTime(r.clock_out) : 'now'}</div>
          </div>
          <div class="hh ${r.clock_out ? '' : 'live'}">${r.hours !== null ? r.hours : '●'}</div>
        </div>`).join('') : '<div class="p-empty">No time recorded in the last two weeks.</div>'}
      <div class="p-empty" style="padding:14px 0 0;font-size:12.5px">Something look wrong? Tell the office — they can correct any punch.</div>
    </div>`;
}

// ---------------------------------------------------------------- My Work
async function pageWork() {
  const d = await api('portal/summary');
  view.innerHTML = `
    <div class="pc">
      <h3>Assigned To You<span class="r">${d.work_orders.length} open</span></h3>
      ${d.work_orders.length ? d.work_orders.map(w => {
        const late = w.due_date && w.due_date < todayStr();
        return `<div class="wo ${esc(w.priority)}">
          <div class="top">
            <span class="num">${esc(w.wo_number)}</span>
            <span class="tag t-${esc(w.priority)}">${esc(w.priority)}</span>
            <span class="tag t-${esc(w.status)}">${esc(cap(w.status))}</span>
            ${late ? '<span class="tag t-late">Past due</span>' : ''}
            ${w.job_number ? `<span class="s" style="color:var(--mist);font-size:12.5px">${esc(w.job_number)}</span>` : ''}
          </div>
          <div class="ttl">${esc(w.title)}</div>
          ${w.description ? `<div class="desc">${esc(w.description)}</div>` : ''}
          <div class="s" style="font-size:12.5px;color:var(--mist);margin-bottom:10px">${cap(w.wo_type)}${w.due_date ? ' · due ' + esc(w.due_date) : ''}</div>
          <div class="acts">
            ${w.status === 'open' ? `<button class="act-start" data-start="${w.id}">Start Work</button>` : ''}
            <button class="act-done" data-done="${w.id}">Mark Complete</button>
          </div>
        </div>`;
      }).join('') : '<div class="p-empty">No work orders assigned to you right now.</div>'}
    </div>

    <div class="pc">
      <h3>Shop Stock Lookup</h3>
      <input id="mat-q" placeholder="Search materials — e.g. plywood, breaker" style="margin-bottom:12px">
      <div id="mat-list"></div>
    </div>`;

  view.onclick = async e => {
    const start = e.target.dataset.start, done = e.target.dataset.done;
    try {
      if (start) { await api('portal/workorders/' + start, 'PUT', { status: 'in_progress' }); msg('Started — the office can see it', 'ok'); pageWork(); }
      if (done) { await api('portal/workorders/' + done, 'PUT', { status: 'completed' }); msg('Marked complete. Nice work.', 'ok'); pageWork(); }
    } catch (err) { msg(err.message, 'err'); }
  };

  const materials = await api('portal/materials');
  const renderMats = q => {
    const list = materials.filter(m => !q || (m.name + ' ' + m.sku + ' ' + m.category).toLowerCase().includes(q.toLowerCase())).slice(0, 25);
    $('#mat-list').innerHTML = list.length ? list.map(m => `
      <div class="mat-row">
        <div><div style="font-weight:650">${esc(m.name)}</div>
        <div style="font-size:12.5px;color:var(--mist)">${esc(m.location || m.category)}</div></div>
        <div class="qty ${m.qty_on_hand <= m.reorder_point ? 'low' : ''}">${m.qty_on_hand} ${esc(m.unit)}</div>
      </div>`).join('') : '<div class="p-empty">No match.</div>';
  };
  renderMats('');
  $('#mat-q').oninput = e => renderMats(e.target.value);
}

// ---------------------------------------------------------------- Job Card
async function pageCard() {
  const [d, mine] = await Promise.all([api('portal/summary'), api('portal/jobcards')]);
  view.innerHTML = `
    <div class="pc">
      <h3>Submit A Job Card</h3>
      <div class="fld"><label class="fldlabel">Job</label>
        <select id="c-job"><option value="">No specific job / shop</option>
          ${d.jobs.map(j => `<option value="${j.id}" ${d.today[0] && d.today[0].job_id === j.id ? 'selected' : ''}>${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}</select></div>
      <div class="fld"><label class="fldlabel">Date</label><input id="c-date" type="date" value="${todayStr()}"></div>
      <div class="fld"><label class="fldlabel">Hours worked</label><input id="c-hours" type="number" step="0.25" inputmode="decimal" value="8"></div>
      <div class="fld"><label class="fldlabel">Work performed</label>
        <textarea id="c-work" placeholder="What did you get done today?"></textarea></div>
      <div class="fld"><label class="fldlabel">Materials used</label>
        <input id="c-mats" placeholder="e.g. 40 studs, 6 sheets plywood"></div>
      <div class="fld"><label class="fldlabel">Problems / delays <span style="font-weight:500;text-transform:none;letter-spacing:0">(optional)</span></label>
        <textarea id="c-issues" placeholder="Anything the office needs to know — damage, extra scope, missing material" style="min-height:64px"></textarea></div>
      <button class="big-btn dark" id="c-save">Submit To Office</button>
    </div>

    <div class="pc">
      <h3>Your Recent Cards</h3>
      ${mine.length ? mine.map(c => `
        <div class="assign">
          <span class="jn ${c.job_number ? '' : 'shop'}">${esc(c.job_number || 'SHOP')}</span>
          <div style="flex:1">
            <div class="t">${esc(c.work_performed.slice(0, 90))}${c.work_performed.length > 90 ? '…' : ''}</div>
            <div class="s">${esc(c.work_date)} · ${c.hours} hrs <span class="tag t-${esc(c.status)}" style="margin-left:4px">${esc(cap(c.status))}</span></div>
          </div>
        </div>`).join('') : '<div class="p-empty">No job cards submitted yet.</div>'}
    </div>`;

  $('#c-save').onclick = async () => {
    const work = $('#c-work').value.trim();
    if (!work) return msg('Tell us what work you performed', 'err');
    try {
      const r = await api('portal/jobcards', 'POST', {
        job_id: $('#c-job').value ? Number($('#c-job').value) : null,
        work_date: $('#c-date').value, hours: Number($('#c-hours').value) || 0,
        work_performed: work, materials_used: $('#c-mats').value.trim(), issues: $('#c-issues').value.trim(),
      });
      msg(r.message, 'ok'); pageCard();
    } catch (e) { msg(e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- router
const TABS = { home: pageHome, week: pageWeek, hours: pageHours, work: pageWork, card: pageCard };

async function route() {
  const tab = (location.hash.replace(/^#\//, '') || 'home').split('/')[0];
  const fn = TABS[tab] || pageHome;
  $$('.p-tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  view.innerHTML = '<div class="p-empty">Loading…</div>';
  try { await fn(); } catch (e) { view.innerHTML = `<div class="p-empty">⚠ ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

$('#p-logout').onclick = async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
};

(async () => {
  try {
    me = await api('auth/me');
    $('#p-who').textContent = me.name;
    $('#p-role').textContent = me.employee_role || 'Crew Portal';
  } catch { return; }
  route();
})();
