/* ============================================================
   DTS Command Center — single-page application
   ============================================================ */
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api/' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => new Date().toISOString().slice(0, 10);
const cap = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 350); }, 3400);
}

function badge(status) { return `<span class="badge b-${esc(status)}">${esc(cap(status))}</span>`; }

function openModal(html, { narrow = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal ${narrow ? 'narrow' : ''}">${html}</div>`;
  root.onclick = e => { if (e.target === root) closeModal(); };
  $$('.modal-close', root).forEach(b => b.onclick = closeModal);
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value;
  }
  return out;
}

// UTC-stored timestamps → local display
function parseTs(ts) { return new Date(ts.replace(' ', 'T') + 'Z'); }
function fmtTime(ts) { return parseTs(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function fmtDateTime(ts) { return parseTs(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function hoursBetween(a, b) { return Math.round((parseTs(b) - parseTs(a)) / 36e5 * 100) / 100; }
function elapsed(ts) {
  const mins = Math.floor((Date.now() - parseTs(ts)) / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

// live top bar clock + on-clock counter
setInterval(() => {
  $('#topbar-clock').textContent = new Date().toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}, 1000);
async function refreshOnClock() {
  try {
    const open = await api('clock/status');
    $('#on-clock-count').textContent = `${open.length} on the clock`;
  } catch { /* ignore */ }
}
async function refreshBadges() {
  try {
    const [cards, cos, aging, subs] = await Promise.all([
      api('jobcards'), api('changeorders'), api('invoices/aging'), api('subcontractors'),
    ]);
    const set = (sel, n) => { const el = $(sel); if (el) el.textContent = n || ''; };
    set('#cards-badge', cards.filter(c => c.status === 'submitted').length);
    set('#co-badge', cos.filter(c => c.status === 'sent').length);
    set('#ar-badge', aging.open.filter(o => o.days_overdue > 0).length);
    set('#sub-badge', subs.filter(s => s.active && !s.compliant).length);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- session / user menu
let ME = null;
async function bootSession() {
  ME = await api('auth/me');
  $('#user-name').textContent = ME.name;
  $('#user-initials').textContent = ME.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
$('#user-chip').onclick = e => { e.stopPropagation(); $('#user-drop').classList.toggle('open'); };
document.addEventListener('click', () => $('#user-drop').classList.remove('open'));
$('#menu-logout').onclick = async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };
$('#menu-password').onclick = () => {
  openModal(`
    <div class="modal-head"><h2>Change your password</h2><button class="modal-close">×</button></div>
    <div class="modal-body"><form id="pw-form" class="form-grid">
      <label class="fld full">Current password<input name="current" type="password" autocomplete="current-password"></label>
      <label class="fld full">New password<input name="next" type="password" autocomplete="new-password" placeholder="at least 6 characters"></label>
    </form></div>
    <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="pw-save">Update Password</button></div>`, { narrow: true });
  $('#pw-save').onclick = async () => {
    try {
      const r = await api('auth/password', 'POST', formData($('#pw-form')));
      closeModal(); toast(r.message, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
};

// ---------------------------------------------------------------- router
const PAGES = {};
const TITLES = {
  dashboard: ['Dashboard', 'Company pulse at a glance'],
  clock: ['Time Clock', 'Clock in, clock out, clock onto jobs'],
  schedule: ['Crew Schedule', 'Who is where, all week'],
  quotes: ['Quotes', 'Estimates, proposals and customer approvals'],
  jobs: ['Jobs', 'Active and planned field work'],
  workorders: ['Work Orders', 'Shop and fabrication queue'],
  jobcards: ['Field Job Cards', 'Daily reports submitted by the crew'],
  changeorders: ['Change Orders', 'Added scope, priced and signed before you build it'],
  invoices: ['Invoices & Receivables', 'What you have billed and what you are owed'],
  payroll: ['Payroll', 'Hours, gross pay and certified payroll for public work'],
  subs: ['Subcontractors', 'Trades, insurance certificates and expiry dates'],
  reports: ['Reports', 'Where the money comes from and where it goes'],
  users: ['Users & Access', 'Who can sign in, and what they can see'],
  settings: ['Settings', 'Company details, pricing defaults and email delivery'],
  inventory: ['Material Inventory', 'Stock on hand and reorder points'],
  purchasing: ['Purchasing', 'Material orders and receiving'],
  archive: ['Archive & Profit Search', 'Every job and work order, what it sold for, what it cost'],
  insights: ['AI Insights', 'What the numbers are trying to tell you'],
  clients: ['Clients', 'Customer directory'],
  team: ['Team', 'Employees, roles and rates'],
};

async function route() {
  const hash = location.hash.replace(/^#\//, '') || 'dashboard';
  const [page, param] = hash.split('/');
  const fn = PAGES[page] || PAGES.dashboard;
  const [title, sub] = TITLES[page] || TITLES.dashboard;
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === page));
  view.innerHTML = '<div class="empty">Loading…</div>';
  try { await fn(param); } catch (e) { view.innerHTML = `<div class="empty">⚠ ${esc(e.message)}</div>`; }
  refreshBadges();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// global search → archive page
$('#global-search').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    location.hash = '#/archive/' + encodeURIComponent(e.target.value.trim());
  }
});

// ---------------------------------------------------------------- line-item editor (shared by quotes & work orders)
function lineItemEditor(container, items, { withPrice = true, onChange } = {}) {
  function render() {
    container.innerHTML = `
      <table class="li-table">
        <thead><tr>
          <th style="width:44%">Description</th><th>Qty</th><th>Unit</th>
          <th>Unit cost</th>${withPrice ? '<th>Unit price</th>' : ''}<th></th>
        </tr></thead>
        <tbody>
          ${items.map((it, i) => `
            <tr data-i="${i}">
              <td><input data-f="desc" value="${esc(it.desc)}" placeholder="Item or material"></td>
              <td><input data-f="qty" type="number" step="any" value="${it.qty ?? 1}" style="width:70px"></td>
              <td><input data-f="unit" value="${esc(it.unit || 'ea')}" style="width:64px"></td>
              <td><input data-f="unit_cost" type="number" step="any" value="${it.unit_cost ?? 0}" style="width:92px"></td>
              ${withPrice ? `<td><input data-f="unit_price" type="number" step="any" value="${it.unit_price ?? 0}" style="width:92px"></td>` : ''}
              <td><button type="button" class="li-del" title="Remove">×</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <button type="button" class="btn ghost sm" id="li-add" style="margin-top:8px">+ Add line</button>`;
    container.oninput = e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const it = items[+tr.dataset.i];
      const f = e.target.dataset.f;
      it[f] = (f === 'desc' || f === 'unit') ? e.target.value : Number(e.target.value);
      onChange && onChange();
    };
    container.onclick = e => {
      if (e.target.id === 'li-add') { items.push({ desc: '', qty: 1, unit: 'ea', unit_cost: 0, unit_price: 0 }); render(); onChange && onChange(); }
      if (e.target.classList.contains('li-del')) { items.splice(+e.target.closest('tr').dataset.i, 1); render(); onChange && onChange(); }
    };
  }
  render();
  return items;
}

function calcQuote(items, laborHours, laborRate, markupPct, taxPct) {
  const materials = items.reduce((s, i) => s + (i.qty || 0) * (i.unit_price || 0), 0);
  const labor = laborHours * laborRate;
  const subtotal = materials + labor;
  const markup = subtotal * markupPct / 100;
  const tax = (subtotal + markup) * taxPct / 100;
  return { materials, labor, subtotal, markup, tax, total: subtotal + markup + tax };
}

// ---------------------------------------------------------------- DASHBOARD
PAGES.dashboard = async () => {
  const d = await api('dashboard');
  const k = d.kpis;
  const maxV = Math.max(...d.series.map(s => s.revenue), 1);
  const bars = d.series.map((s, i) => {
    const x = 30 + i * 55;
    const rh = Math.round(s.revenue / maxV * 100);
    const ph = Math.max(0, Math.round(s.profit / maxV * 100));
    const label = new Date(s.month + '-15').toLocaleString([], { month: 'short' });
    return `
      <g>
        <rect x="${x}" y="${125 - rh}" width="20" height="${rh}" rx="3" fill="#131c26"></rect>
        <rect x="${x + 23}" y="${125 - ph}" width="12" height="${ph}" rx="3" fill="#f5a524"></rect>
        <text x="${x + 17}" y="140" font-size="9" text-anchor="middle" fill="#8496aa">${label}</text>
      </g>`;
  }).join('');

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Active Jobs</div><div class="kpi-value">${k.activeJobs}</div><div class="kpi-note">${d.wip.length} in progress</div></div>
      <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">Open Work Orders</div><div class="kpi-value">${k.openWOs}</div><div class="kpi-note">${k.rushWOs ? `<span class="neg">${k.rushWOs} rush</span>` : 'no rush orders'}</div></div>
      <div class="kpi" style="--kpi-accent:#2e9e6b"><div class="kpi-label">Crew On Clock</div><div class="kpi-value">${k.onClock}</div><div class="kpi-note"><a class="plain" href="#/clock">open time clock →</a></div></div>
      <div class="kpi" style="--kpi-accent:#7c5cd6"><div class="kpi-label">Quotes Outstanding</div><div class="kpi-value">${money0(k.quoteValue)}</div><div class="kpi-note">${k.pendingQuotes} pending decisions</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card chart-wrap">
        <h3>Completed Revenue vs Profit <span class="hint">trailing 6 months</span></h3>
        <svg viewBox="0 0 370 148">${bars}</svg>
        <div class="legend"><span><i style="background:#131c26"></i>Revenue</span><span><i style="background:#f5a524"></i>Profit</span></div>
      </div>
      <div class="card">
        <h3>Today's Crew <span class="hint">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></h3>
        ${d.todaySchedule.length ? `<table class="tbl"><thead><tr><th>Who</th><th>Assignment</th><th>Shift</th></tr></thead><tbody>
          ${d.todaySchedule.map(s => `<tr><td class="strong">${esc(s.employee_name)}</td>
            <td>${s.job_number ? `<span class="mono">${esc(s.job_number)}</span> ${esc(s.job_title)}` : esc(s.notes || 'Shop')}</td>
            <td class="muted">${esc(s.shift)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Nobody scheduled today. <a class="plain" href="#/schedule">Build the schedule →</a></div>'}
      </div>
    </div>

    <div class="card section-gap">
      <h3>Jobs In Progress <span class="hint">live cost vs sold price</span></h3>
      ${d.wip.length ? `<table class="tbl"><thead><tr><th>Job</th><th>Client</th><th class="num">Sold</th><th class="num">Cost to date</th><th class="num">Projected profit</th><th>Budget burn</th></tr></thead><tbody>
        ${d.wip.map(j => {
          const f = j.financials, burn = f.sold_price ? Math.min(100, Math.round(f.total_cost / f.sold_price * 100)) : 0;
          return `<tr class="clickable" onclick="location.hash='#/jobs/${j.id}'">
            <td><span class="mono strong">${esc(j.job_number)}</span> ${esc(j.title)}</td>
            <td class="muted">${esc(j.client_name || '')}</td>
            <td class="num">${money0(f.sold_price)}</td>
            <td class="num">${money0(f.total_cost)}</td>
            <td class="num ${f.profit >= 0 ? 'pos' : 'neg'}">${money0(f.profit)}</td>
            <td><div class="progressbar"><i class="${burn > 85 ? 'bad' : burn > 65 ? 'warn' : ''}" style="width:${burn}%"></i></div></td>
          </tr>`;
        }).join('')}
      </tbody></table>` : '<div class="empty">No jobs in progress.</div>'}
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <h3>Money Owed To You <span class="hint">accounts receivable</span></h3>
        <div class="kpis" style="grid-template-columns:1fr 1fr;margin:0">
          <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Outstanding</div><div class="kpi-value">${money0(k.arOutstanding)}</div><div class="kpi-note"><a class="plain" href="#/invoices">invoices →</a></div></div>
          <div class="kpi" style="--kpi-accent:${k.arOverdue ? '#d64545' : '#2e9e6b'}"><div class="kpi-label">Past Due</div><div class="kpi-value ${k.arOverdue ? 'neg' : ''}">${money0(k.arOverdue)}</div><div class="kpi-note">${k.arOverdue ? 'chase these today' : 'nothing overdue'}</div></div>
        </div>
      </div>
      <div class="card">
        <h3>Crew Capacity <span class="hint">next three weeks</span></h3>
        ${d.capacity.map(w => `
          <div class="bar-row">
            <span class="lbl">Week of ${new Date(w.week_start + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
            <span class="track"><i class="${w.overcommitted ? 'bad' : w.utilization_pct > 85 ? 'warn' : ''}" style="width:${Math.min(100, w.utilization_pct)}%;background:${w.overcommitted ? 'var(--red)' : w.utilization_pct > 85 ? 'var(--amber)' : 'var(--ink)'}"></i></span>
            <span class="val">${w.committed_hours}/${w.available_hours}h</span>
          </div>
          ${w.overcommitted ? `<div class="muted" style="font-size:12px;margin:-4px 0 8px 178px;color:var(--red)">Overcommitted${w.conflicts.length ? ` · ${w.conflicts.length} double-booking${w.conflicts.length > 1 ? 's' : ''}` : ''}</div>` : ''}
        `).join('')}
        <a class="plain" href="#/schedule" style="font-size:12.5px">open the schedule →</a>
      </div>
    </div>

    <div class="kpis section-gap">
      <div class="kpi" style="--kpi-accent:${k.lowStock ? '#d64545' : '#2e9e6b'}"><div class="kpi-label">Low Stock Items</div><div class="kpi-value">${k.lowStock}</div><div class="kpi-note"><a class="plain" href="#/inventory">view inventory →</a></div></div>
      <div class="kpi" style="--kpi-accent:${k.pendingCOs ? '#d64545' : '#8496aa'}"><div class="kpi-label">Unsigned Change Orders</div><div class="kpi-value">${k.pendingCOs}</div><div class="kpi-note"><a class="plain" href="#/changeorders">change orders →</a></div></div>
      <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Pending Quotes</div><div class="kpi-value">${k.pendingQuotes}</div><div class="kpi-note">${money0(k.quoteValue)} · <a class="plain" href="#/quotes">follow up →</a></div></div>
      <div class="kpi" style="--kpi-accent:#7c5cd6"><div class="kpi-label">Smart Insights</div><div class="kpi-value" id="insight-count">…</div><div class="kpi-note"><a class="plain" href="#/insights">AI insights →</a></div></div>
    </div>`;
  api('insights').then(ins => { const el = $('#insight-count'); if (el) el.textContent = ins.length; }).catch(() => {});
};

// ---------------------------------------------------------------- TIME CLOCK
PAGES.clock = async () => {
  const [employees, jobs, open] = await Promise.all([
    api('employees'), api('jobs'), api('clock/status'),
  ]);
  const active = employees.filter(e => e.active).sort((a, b) => a.name.localeCompare(b.name));
  const activeJobs = jobs.filter(j => ['planned', 'in_progress'].includes(j.status));

  view.innerHTML = `
    <div class="clock-layout">
      <div class="kiosk">
        <div class="big-time" id="kiosk-time"></div>
        <div class="big-date">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
        <label>Employee</label>
        <select id="ck-emp">${active.map(e => `<option value="${e.id}">${esc(e.name)} — ${esc(e.role)}</option>`).join('')}</select>
        <label>Job (optional — clock straight onto a job)</label>
        <select id="ck-job"><option value="">General shift / shop</option>
          ${activeJobs.map(j => `<option value="${j.id}">${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}</select>
        <label>PIN</label>
        <input id="ck-pin" type="password" inputmode="numeric" maxlength="6" placeholder="••••" autocomplete="off">
        <div class="kiosk-btns">
          <button class="btn primary" id="ck-in">Clock In</button>
          <button class="btn danger" id="ck-out">Clock Out</button>
        </div>
        <p style="margin-top:14px;font-size:12px;color:#9fb0c3">Already on the clock and starting a job? Pick the job and hit Clock In — your time switches to that job automatically.</p>
      </div>

      <div>
        <div class="card on-clock-list">
          <h3>On The Clock Right Now <span class="hint">${open.length} crew</span></h3>
          ${open.length ? open.map(t => `
            <div class="row">
              <div>
                <div class="who">${esc(t.employee_name)}</div>
                <div class="muted" style="font-size:12px">${t.job_number ? `${esc(t.job_number)} — ${esc(t.job_title)}` : 'General shift'}</div>
              </div>
              <div class="since">in ${fmtTime(t.clock_in)} · ${elapsed(t.clock_in)}</div>
            </div>`).join('') : '<div class="empty">Nobody clocked in.</div>'}
        </div>
        <div class="card">
          <h3>Today's Timesheet</h3>
          <div id="ts-today"></div>
        </div>
      </div>
    </div>`;

  const tick = () => { const el = $('#kiosk-time'); if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  tick(); const iv = setInterval(() => { if (!$('#kiosk-time')) return clearInterval(iv); tick(); }, 1000);

  async function loadTimesheet() {
    const rows = await api(`timesheets?from=${todayStr()}&to=${todayStr()}`);
    $('#ts-today').innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>Who</th><th>Where</th><th>In</th><th>Out</th><th class="num">Hours</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td class="strong">${esc(r.employee_name)}</td>
        <td>${r.job_number ? `<span class="mono">${esc(r.job_number)}</span>` : '<span class="muted">Shift</span>'}</td>
        <td class="mono">${fmtTime(r.clock_in)}</td>
        <td class="mono">${r.clock_out ? fmtTime(r.clock_out) : '<span class="badge b-in">live</span>'}</td>
        <td class="num">${r.hours ?? '—'}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No entries yet today.</div>';
  }
  loadTimesheet();

  async function punch(dir) {
    const body = { employee_id: +$('#ck-emp').value, pin: $('#ck-pin').value };
    if (dir === 'in' && $('#ck-job').value) body.job_id = +$('#ck-job').value;
    try {
      const r = await api(`clock/${dir}`, 'POST', body);
      toast(r.message, 'ok');
      $('#ck-pin').value = '';
      PAGES.clock(); refreshOnClock();
    } catch (e) { toast(e.message, 'err'); }
  }
  $('#ck-in').onclick = () => punch('in');
  $('#ck-out').onclick = () => punch('out');
  $('#ck-pin').addEventListener('keydown', e => { if (e.key === 'Enter') punch('in'); });
};

// ---------------------------------------------------------------- SCHEDULE
PAGES.schedule = async (param) => {
  const weekOffset = Number(param || 0);
  const start = new Date();
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + weekOffset * 7); // Monday
  const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d.toISOString().slice(0, 10); });

  const [employees, jobs, entries] = await Promise.all([api('employees'), api('jobs'), api('schedule')]);
  const active = employees.filter(e => e.active).sort((a, b) => a.name.localeCompare(b.name));
  const activeJobs = jobs.filter(j => ['planned', 'in_progress', 'on_hold'].includes(j.status));
  const jobById = Object.fromEntries(jobs.map(j => [j.id, j]));

  const cell = (emp, date) => {
    const items = entries.filter(s => s.employee_id === emp.id && s.date === date);
    return `<div class="sched-cell" data-emp="${emp.id}" data-date="${date}">
      ${items.map(s => {
        const j = s.job_id ? jobById[s.job_id] : null;
        return `<div class="sched-item ${j ? '' : 'shop'}" data-sid="${s.id}" title="Click to remove">
          <div class="s-title">${j ? esc(j.job_number) : 'Shop'}</div>
          <div class="s-note">${j ? esc(j.title) : esc(s.notes || '')}${s.shift !== 'Full day' ? ` · ${esc(s.shift)}` : ''}</div>
        </div>`;
      }).join('')}
      <button class="sched-add" title="Assign">+</button>
    </div>`;
  };

  view.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        <button class="btn ghost sm" id="wk-prev">← Prev week</button>
        <button class="btn ghost sm" id="wk-this">This week</button>
        <button class="btn ghost sm" id="wk-next">Next week →</button>
      </div>
      <span class="muted">${new Date(days[0] + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(days[6] + 'T12:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · click + to assign, click an assignment to remove it</span>
    </div>
    <div class="sched-wrap"><div class="sched-grid">
      <div class="sched-cell sched-head">Crew</div>
      ${days.map(d => `<div class="sched-cell sched-head ${d === todayStr() ? 'today' : ''}">${new Date(d + 'T12:00').toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' })}</div>`).join('')}
      ${active.map(emp => `
        <div class="sched-cell sched-emp">${esc(emp.name)}<span class="role">${esc(emp.role)}</span></div>
        ${days.map(d => cell(emp, d)).join('')}`).join('')}
    </div></div>`;

  $('#wk-prev').onclick = () => { location.hash = `#/schedule/${weekOffset - 1}`; };
  $('#wk-this').onclick = () => { location.hash = '#/schedule/0'; route(); };
  $('#wk-next').onclick = () => { location.hash = `#/schedule/${weekOffset + 1}`; };

  $('.sched-grid').onclick = async e => {
    const item = e.target.closest('.sched-item');
    if (item) {
      if (!confirm('Remove this assignment?')) return;
      await api('schedule/' + item.dataset.sid, 'DELETE');
      toast('Assignment removed', 'ok'); route();
      return;
    }
    const add = e.target.closest('.sched-add');
    if (add) {
      const cellEl = add.closest('.sched-cell');
      const emp = active.find(x => x.id === +cellEl.dataset.emp);
      openModal(`
        <div class="modal-head"><h2>Assign ${esc(emp.name)} — ${new Date(cellEl.dataset.date + 'T12:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h2><button class="modal-close">×</button></div>
        <div class="modal-body"><form id="sched-form" class="form-grid">
          <label class="fld full">Job<select name="job_id"><option value="">Shop / no job</option>
            ${activeJobs.map(j => `<option value="${j.id}">${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}</select></label>
          <label class="fld">Shift<select name="shift"><option>Full day</option><option>AM</option><option>PM</option></select></label>
          <label class="fld">Note<input name="notes" placeholder="e.g. bring lift"></label>
        </form></div>
        <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="sched-save">Assign</button></div>`, { narrow: true });
      $('#sched-save').onclick = async () => {
        const d = formData($('#sched-form'));
        await api('schedule', 'POST', { employee_id: emp.id, job_id: d.job_id || null, date: cellEl.dataset.date, shift: d.shift, notes: d.notes });
        closeModal(); toast('Crew assigned', 'ok'); route();
      };
    }
  };
};

// ---------------------------------------------------------------- QUOTES
PAGES.quotes = async () => {
  const quotes = await api('quotes');
  view.innerHTML = `
    <div class="toolbar">
      <div class="filters" id="q-filters">
        ${['all', 'draft', 'sent', 'accepted', 'declined'].map(s => `<span class="chip ${s === 'all' ? 'active' : ''}" data-f="${s}">${cap(s)}</span>`).join('')}
      </div>
      <button class="btn primary" id="q-new">+ New Quote</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Quote</th><th>Client</th><th>Title</th><th class="num">Total</th><th class="num">Est. profit</th><th>Status</th><th></th>
    </tr></thead><tbody id="q-body"></tbody></table></div>`;

  function renderRows(filter) {
    const rows = quotes.filter(q => filter === 'all' || q.status === filter);
    $('#q-body').innerHTML = rows.length ? rows.map(q => `
      <tr>
        <td class="mono strong">${esc(q.quote_number)}</td>
        <td>${esc(q.client_name || '—')}</td>
        <td>${esc(q.title)}</td>
        <td class="num">${money(q.totals.total)}</td>
        <td class="num pos">${money0(q.totals.total - q.totals.est_cost)}</td>
        <td>${badge(q.status)}${q.sent_at ? `<div class="muted" style="font-size:11px;margin-top:2px">emailed ${esc(q.sent_at.slice(0, 10))}</div>` : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${q.id}">Edit</button>
          <button class="btn sm" data-mail="${q.id}">✉ Email</button>
          ${q.status !== 'accepted' && q.status !== 'declined' ? `<button class="btn sm green" data-win="${q.id}">Won → Job</button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="7"><div class="empty">No quotes here.</div></td></tr>';
  }
  renderRows('all');
  $('#q-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#q-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); renderRows(c.dataset.f);
  };
  $('#q-new').onclick = () => quoteModal();
  $('#q-body').onclick = e => {
    const editId = e.target.dataset.edit, winId = e.target.dataset.win, mailId = e.target.dataset.mail;
    if (editId) quoteModal(quotes.find(q => q.id === +editId));
    if (winId) convertModal(quotes.find(q => q.id === +winId));
    if (mailId) emailModal(quotes.find(q => q.id === +mailId));
  };

  async function emailModal(q) {
    const cfg = await api('settings');
    const configured = !!cfg.smtp_host;
    const greeting = q.client_contact ? q.client_contact.split(' ')[0] : '';
    openModal(`
      <div class="modal-head"><h2>Email proposal ${esc(q.quote_number)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        ${configured ? '' : `<div class="hr-note"><b>SMTP is not set up yet.</b> Sending now will save a full preview of the customer's email to the outbox instead of delivering it, so you can see exactly what they would get. Add your mail server under <a class="plain" href="#/settings">Settings → Email</a> to send for real.</div>`}
        <form id="em-form" class="form-grid">
          <label class="fld full">To<input name="to" value="${esc(q.client_email || '')}" placeholder="customer@company.com" required></label>
          <label class="fld full">Subject<input name="subject" value="${esc(`Proposal ${q.quote_number}: ${q.title}`)}"></label>
          <label class="fld full">Message<textarea name="message" style="min-height:130px">Hi${greeting ? ' ' + greeting : ''},

Thanks for the opportunity to quote this work. Our proposal is below — you can review and approve it online with the button at the bottom.

Happy to walk through any line item.</textarea></label>
        </form>
        <p class="muted" style="font-size:12.5px;margin-top:10px">The full itemized proposal (${money(q.totals.total)}) is attached to the message automatically, along with a secure link where the customer can approve or decline it. Approvals show up here instantly.</p>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="em-link" style="margin-right:auto">Just get the link</button>
        <button class="btn ghost modal-close">Cancel</button>
        <button class="btn primary" id="em-send">${configured ? 'Send Proposal' : 'Generate Preview'}</button>
      </div>`);

    $('#em-link').onclick = async () => {
      const r = await api(`quotes/${q.id}/link`, 'POST', {});
      $('.modal-body').insertAdjacentHTML('beforeend', `
        <div class="copybox"><input value="${esc(r.link)}" readonly onclick="this.select()"><button class="btn sm ghost" onclick="navigator.clipboard.writeText('${esc(r.link)}');this.textContent='Copied'">Copy</button></div>`);
    };
    $('#em-send').onclick = async () => {
      const f = formData($('#em-form'));
      const btn = $('#em-send'); btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const r = await api(`quotes/${q.id}/email`, 'POST', f);
        closeModal();
        toast(r.message, r.status === 'sent' ? 'ok' : '');
        if (r.preview) window.open(r.preview, '_blank');
        route();
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false; btn.textContent = configured ? 'Send Proposal' : 'Generate Preview';
      }
    };
  }

  async function quoteModal(q) {
    const [clients, numbers, settings, materials] = await Promise.all([api('clients'), api('numbers'), api('settings'), api('materials')]);
    const items = q ? JSON.parse(q.items || '[]') : [];
    const root = openModal(`
      <div class="modal-head"><h2>${q ? 'Edit ' + esc(q.quote_number) : 'New Quote ' + esc(numbers.quote)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="q-form" class="form-grid">
          <label class="fld">Client<select name="client_id">${clients.map(c => `<option value="${c.id}" ${q && q.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="fld">Status<select name="status">${['draft', 'sent', 'accepted', 'declined'].map(s => `<option ${q && q.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label class="fld full">Title<input name="title" required value="${esc(q?.title || '')}" placeholder="e.g. Warehouse mezzanine framing"></label>
          <label class="fld full">Scope description<textarea name="description">${esc(q?.description || '')}</textarea></label>
          <label class="fld">Labor hours<input name="labor_hours" type="number" step="any" value="${q?.labor_hours ?? 0}"></label>
          <label class="fld">Labor rate $/hr<input name="labor_rate" type="number" step="any" value="${q?.labor_rate ?? settings.default_labor_rate ?? 65}"></label>
          <label class="fld">Markup %<input name="markup_pct" type="number" step="any" value="${q?.markup_pct ?? 10}"></label>
          <label class="fld">Tax %<input name="tax_pct" type="number" step="any" value="${q?.tax_pct ?? 0}"></label>
          <label class="fld">Valid until<input name="valid_until" type="date" value="${esc(q?.valid_until || '')}"></label>
          <label class="fld">Pull from inventory<select id="q-mat"><option value="">— pick a material —</option>
            ${materials.map(m => `<option value="${m.id}">${esc(m.name)} (${money(m.sell_price)}/${esc(m.unit)})</option>`).join('')}</select></label>
        </form>
        <h3 style="margin:16px 0 4px;font-size:13px">Line items</h3>
        <div id="q-items"></div>
        <div class="quote-summary" id="q-summary"></div>

        <div class="estimator">
          <h3>Price History <span class="hint">what you have charged for this before</span></h3>
          <input id="est-q" placeholder="Search your history — e.g. railing, plywood, bollard">
          <div id="est-results"></div>
          <div id="est-warnings"></div>
        </div>
      </div>
      <div class="modal-foot">
        ${q ? `<button class="btn danger" id="q-del" style="margin-right:auto">Delete</button>` : ''}
        <button class="btn ghost modal-close">Cancel</button>
        <button class="btn primary" id="q-save">${q ? 'Save Changes' : 'Create Quote'}</button>
      </div>`);

    const summary = () => {
      const f = formData($('#q-form'));
      const t = calcQuote(items, f.labor_hours, f.labor_rate, f.markup_pct, f.tax_pct);
      $('#q-summary').innerHTML = `
        <div>Materials<b>${money(t.materials)}</b></div>
        <div>Labor<b>${money(t.labor)}</b></div>
        <div>Markup<b>${money(t.markup)}</b></div>
        <div>Tax<b>${money(t.tax)}</b></div>
        <div class="grand">Quote total<b>${money(t.total)}</b></div>`;
    };
    lineItemEditor($('#q-items'), items, { onChange: () => { summary(); scheduleBenchmark(); } });
    $('#q-form').addEventListener('input', () => { summary(); scheduleBenchmark(); });
    summary();

    $('#q-mat').onchange = e => {
      const m = materials.find(x => x.id === +e.target.value);
      if (m) { items.push({ desc: m.name, qty: 1, unit: m.unit, unit_cost: m.unit_cost, unit_price: m.sell_price }); redrawItems(); }
      e.target.value = '';
    };

    // ---- estimating feedback loop ----
    function redrawItems() {
      lineItemEditor($('#q-items'), items, { onChange: () => { summary(); scheduleBenchmark(); } });
      summary(); scheduleBenchmark();
    }
    let benchTimer;
    const scheduleBenchmark = () => { clearTimeout(benchTimer); benchTimer = setTimeout(runBenchmark, 500); };

    async function runBenchmark() {
      const box = $('#est-warnings');
      if (!box) return;
      const f = formData($('#q-form'));
      try {
        const b = await api('quotes/benchmark', 'POST', { ...f, items: items.filter(i => i.desc) });
        const bits = [];
        if (b.labor_accuracy.avg_variance_pct !== null) {
          bits.push(`<div class="est-fact">Across ${b.labor_accuracy.samples.length} completed jobs your labor estimates ran
            <b class="${b.labor_accuracy.avg_variance_pct > 0 ? 'neg' : 'pos'}">${b.labor_accuracy.avg_variance_pct > 0 ? '+' : ''}${b.labor_accuracy.avg_variance_pct}%</b> against the clock.</div>`);
        }
        if (b.similar_jobs.length) {
          bits.push(`<div class="est-fact">Similar past work: ${b.similar_jobs.slice(0, 3).map(s =>
            `<span class="mono">${esc(s.job_number)}</span> <b class="${s.margin_pct >= b.target_margin_pct ? 'pos' : 'neg'}">${s.margin_pct}%</b>`).join(' · ')}</div>`);
        }
        box.innerHTML = bits.join('') + b.warnings.map(w => `
          <div class="est-warn ${esc(w.level)}"><h5>${esc(w.title)}</h5><p>${esc(w.detail)}</p></div>`).join('');
      } catch { box.innerHTML = ''; }
    }

    let estTimer;
    $('#est-q').oninput = e => {
      clearTimeout(estTimer);
      const q = e.target.value.trim();
      if (!q) return void ($('#est-results').innerHTML = '');
      estTimer = setTimeout(async () => {
        const { matches } = await api('quotes/estimator?q=' + encodeURIComponent(q));
        $('#est-results').innerHTML = matches.length ? matches.map((m, i) => `
          <div class="est-row" data-i="${i}">
            <div class="est-desc">${esc(m.desc)}
              <span class="muted">${m.times_quoted ? `quoted ${m.times_quoted}×` : 'in inventory'}${m.last_on ? ` · last ${esc(m.last_on)} ${esc(m.last_used)}` : ''}${m.in_stock !== null ? ` · ${m.in_stock} on hand` : ''}</span>
            </div>
            <div class="est-price">
              <b>${money(m.avg_price || m.current_price || 0)}</b>
              <span class="muted">${m.min_price && m.max_price && m.min_price !== m.max_price ? `${money(m.min_price)}–${money(m.max_price)}` : 'avg price'}</span>
            </div>
            <button class="btn sm ghost" data-use="${i}">Use</button>
          </div>`).join('') : '<div class="empty" style="padding:14px">Nothing in your history matches that yet.</div>';
        $('#est-results').onclick = ev => {
          const idx = ev.target.dataset.use;
          if (idx === undefined) return;
          const m = matches[+idx];
          items.push({ desc: m.desc, qty: 1, unit: m.unit || 'ea',
            unit_cost: m.avg_cost || m.current_cost || 0, unit_price: m.avg_price || m.current_price || 0 });
          redrawItems();
          toast(`Added at your historical price of ${money(m.avg_price || m.current_price || 0)}`, 'ok');
        };
      }, 300);
    };
    scheduleBenchmark();

    $('#q-save').onclick = async () => {
      const f = formData($('#q-form'));
      if (!f.title) return toast('Title is required', 'err');
      f.items = items.filter(i => i.desc);
      if (q) { await api('quotes/' + q.id, 'PUT', f); toast('Quote updated', 'ok'); }
      else { f.quote_number = numbers.quote; await api('quotes', 'POST', f); toast(`Quote ${numbers.quote} created`, 'ok'); }
      closeModal(); route();
    };
    if (q) $('#q-del') && ($('#q-del').onclick = async () => {
      if (!confirm(`Delete quote ${q.quote_number}? This cannot be undone.`)) return;
      await api('quotes/' + q.id, 'DELETE'); closeModal(); toast('Quote deleted', 'ok'); route();
    });
    root; // keep reference
  }

  function convertModal(q) {
    openModal(`
      <div class="modal-head"><h2>Convert ${esc(q.quote_number)} to a Job</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p style="margin-bottom:14px">This marks the quote <b>accepted</b>, opens a job card at the quoted price of <b>${money(q.totals.total)}</b>, and can cut a shop work order with the same line items.</p>
        <form id="cv-form" class="form-grid">
          <label class="fld">Start date<input type="date" name="start_date" value="${todayStr()}"></label>
          <label class="fld">Shop work order<select name="create_work_order"><option value="1">Yes — cut a work order</option><option value="">No</option></select></label>
        </form>
      </div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn green" id="cv-go">Create Job</button></div>`, { narrow: true });
    $('#cv-go').onclick = async () => {
      const f = formData($('#cv-form'));
      const r = await api(`quotes/${q.id}/convert`, 'POST', { start_date: f.start_date, create_work_order: !!f.create_work_order });
      closeModal(); toast(`Job ${r.job_number} created${r.work_order_id ? ' with work order' : ''}`, 'ok');
      location.hash = '#/jobs';
    };
  }
};

// ---------------------------------------------------------------- JOBS
PAGES.jobs = async (param) => {
  if (param) return jobDetail(param);
  const jobs = await api('jobs');
  view.innerHTML = `
    <div class="toolbar">
      <div class="filters" id="j-filters">
        ${['all', 'in_progress', 'planned', 'on_hold', 'completed'].map(s => `<span class="chip ${s === 'all' ? 'active' : ''}" data-f="${s}">${cap(s)}</span>`).join('')}
      </div>
      <button class="btn primary" id="j-new">+ New Job Card</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Job</th><th>Client</th><th>Foreman</th><th class="num">Sold</th><th class="num">Cost</th><th class="num">Profit</th><th>Status</th>
    </tr></thead><tbody id="j-body"></tbody></table></div>`;

  function renderRows(filter) {
    const rows = jobs.filter(j => filter === 'all' || j.status === filter);
    $('#j-body').innerHTML = rows.length ? rows.map(j => {
      const f = j.financials;
      return `<tr class="clickable" onclick="location.hash='#/jobs/${j.id}'">
        <td><span class="mono strong">${esc(j.job_number)}</span> ${esc(j.title)}</td>
        <td class="muted">${esc(j.client_name || '—')}</td>
        <td class="muted">${esc(j.foreman_name || '—')}</td>
        <td class="num">${money0(f.sold_price)}</td>
        <td class="num">${money0(f.total_cost)}</td>
        <td class="num ${f.profit >= 0 ? 'pos' : 'neg'}">${money0(f.profit)}</td>
        <td>${badge(j.status)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="7"><div class="empty">No jobs match.</div></td></tr>';
  }
  renderRows('all');
  $('#j-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#j-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); renderRows(c.dataset.f);
  };
  $('#j-new').onclick = () => jobModal();
};

async function jobModal(job) {
  const [clients, employees, numbers] = await Promise.all([api('clients'), api('employees'), api('numbers')]);
  openModal(`
    <div class="modal-head"><h2>${job ? 'Edit ' + esc(job.job_number) : 'New Job Card ' + esc(numbers.job)}</h2><button class="modal-close">×</button></div>
    <div class="modal-body"><form id="j-form" class="form-grid">
      <label class="fld">Client<select name="client_id">${clients.map(c => `<option value="${c.id}" ${job && job.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="fld">Foreman<select name="foreman_id"><option value="">—</option>${employees.filter(e => e.active).map(e => `<option value="${e.id}" ${job && job.foreman_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
      <label class="fld full">Title<input name="title" required value="${esc(job?.title || '')}"></label>
      <label class="fld full">Scope<textarea name="description">${esc(job?.description || '')}</textarea></label>
      <label class="fld full">Site address<input name="address" value="${esc(job?.address || '')}"></label>
      <label class="fld">Sold price $<input name="sold_price" type="number" step="any" value="${job?.sold_price ?? 0}"></label>
      <label class="fld">Status<select name="status">${['planned', 'in_progress', 'on_hold', 'completed'].map(s => `<option value="${s}" ${job && job.status === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></label>
      <label class="fld">Start date<input name="start_date" type="date" value="${esc(job?.start_date || todayStr())}"></label>
      <label class="fld">End date<input name="end_date" type="date" value="${esc(job?.end_date || '')}"></label>
      <label class="fld full">Notes<textarea name="notes">${esc(job?.notes || '')}</textarea></label>
    </form></div>
    <div class="modal-foot">
      ${job ? '<button class="btn danger" id="j-del" style="margin-right:auto">Delete</button>' : ''}
      <button class="btn ghost modal-close">Cancel</button>
      <button class="btn primary" id="j-save">${job ? 'Save' : 'Create Job'}</button>
    </div>`);
  $('#j-save').onclick = async () => {
    const f = formData($('#j-form'));
    if (!f.title) return toast('Title is required', 'err');
    if (f.status === 'completed' && (!job || job.status !== 'completed')) f.completed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (job) { await api('jobs/' + job.id, 'PUT', f); toast('Job updated', 'ok'); }
    else { f.job_number = numbers.job; await api('jobs', 'POST', f); toast(`Job ${numbers.job} created`, 'ok'); }
    closeModal(); route();
  };
  if (job) $('#j-del').onclick = async () => {
    if (!confirm(`Delete job ${job.job_number}?`)) return;
    await api('jobs/' + job.id, 'DELETE'); closeModal(); toast('Job deleted', 'ok'); location.hash = '#/jobs'; route();
  };
}

async function jobDetail(id) {
  const [job, materials, employees] = await Promise.all([api(`jobs/${id}/detail`), api('materials'), api('employees')]);
  const f = job.financials;
  $('#page-title').textContent = `${job.job_number} — ${job.title}`;
  $('#page-sub').textContent = job.client_name || '';
  view.innerHTML = `
    <div class="toolbar">
      <a class="btn ghost sm" href="#/jobs">← All jobs</a>
      <div>
        ${badge(job.status)}
        <button class="btn sm ghost" id="jd-edit" style="margin-left:8px">Edit job</button>
        <button class="btn sm primary" id="jd-mat">+ Log material</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Contract Value</div><div class="kpi-value">${money0(f.sold_price)}</div><div class="kpi-note">${f.change_orders.approved ? `base ${money0(f.base_price)} + ${money0(f.change_orders.approved)} in change orders` : 'no change orders'}</div></div>
      <div class="kpi" style="--kpi-accent:#d64545"><div class="kpi-label">Cost To Date</div><div class="kpi-value">${money0(f.total_cost)}</div><div class="kpi-note">materials ${money0(f.material_cost)} · labor ${money0(f.labor_cost)} · shop ${money0(f.wo_cost)}${f.sub_cost ? ` · subs ${money0(f.sub_cost)}` : ''}</div></div>
      <div class="kpi" style="--kpi-accent:${f.profit >= 0 ? '#2e9e6b' : '#d64545'}"><div class="kpi-label">Profit</div><div class="kpi-value ${f.profit >= 0 ? 'pos' : 'neg'}">${money0(f.profit)}</div><div class="kpi-note">${f.margin_pct}% margin</div></div>
      <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">Labor Hours</div><div class="kpi-value">${f.labor_hours}</div><div class="kpi-note">${f.est_labor_hours ? `${f.est_labor_hours} estimated · <span class="${f.labor_variance_pct > 0 ? 'neg' : 'pos'}">${f.labor_variance_pct > 0 ? '+' : ''}${f.labor_variance_pct}%</span>` : 'from the time clock'}</div></div>
    </div>

    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#7c5cd6"><div class="kpi-label">Billed</div><div class="kpi-value">${money0(f.invoicing.billed)}</div><div class="kpi-note">${f.sold_price ? Math.round(f.invoicing.billed / f.sold_price * 100) : 0}% of contract · ${f.invoicing.count} invoice${f.invoicing.count === 1 ? '' : 's'}</div></div>
      <div class="kpi" style="--kpi-accent:#2e9e6b"><div class="kpi-label">Collected</div><div class="kpi-value pos">${money0(f.invoicing.paid)}</div><div class="kpi-note">cash in the bank</div></div>
      <div class="kpi" style="--kpi-accent:${f.invoicing.outstanding > 0 ? '#d64545' : '#8496aa'}"><div class="kpi-label">Outstanding</div><div class="kpi-value">${money0(f.invoicing.outstanding)}</div><div class="kpi-note">${f.invoicing.retained ? `plus ${money0(f.invoicing.retained)} retainage held` : 'nothing retained'}</div></div>
      <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Unbilled Work</div><div class="kpi-value">${money0(Math.max(0, f.sold_price - f.invoicing.billed))}</div><div class="kpi-note">${f.change_orders.pending ? `<span class="neg">${money0(f.change_orders.pending)} in unsigned change orders</span>` : 'contract not yet invoiced'}</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>Job Card</h3>
        <table class="tbl">
          <tr><td class="muted" style="width:120px">Client</td><td class="strong">${esc(job.client_name || '—')}</td></tr>
          <tr><td class="muted">Site</td><td>${esc(job.address || '—')}</td></tr>
          <tr><td class="muted">Foreman</td><td>${esc(job.foreman_name || '—')}</td></tr>
          <tr><td class="muted">Dates</td><td>${esc(job.start_date || '—')} → ${esc(job.end_date || 'open')}</td></tr>
          <tr><td class="muted">Scope</td><td>${esc(job.description || '—')}</td></tr>
          <tr><td class="muted">Notes</td><td>${esc(job.notes || '—')}</td></tr>
        </table>
      </div>
      <div class="card">
        <h3>Materials Used <span class="hint">deducted from inventory when linked</span></h3>
        ${job.materials.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th></tr></thead><tbody>
          ${job.materials.map(m => `<tr><td>${esc(m.description || m.material_name)}</td><td class="num">${m.qty}</td><td class="num">${money(m.unit_cost)}</td><td class="num">${money(m.qty * m.unit_cost)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No materials logged yet.</div>'}
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <h3>Linked Work Orders</h3>
        ${job.work_orders.length ? `<table class="tbl"><thead><tr><th>WO</th><th>Title</th><th>Status</th><th class="num">Sold</th></tr></thead><tbody>
          ${job.work_orders.map(w => `<tr><td class="mono strong">${esc(w.wo_number)}</td><td>${esc(w.title)}</td><td>${badge(w.status)}</td><td class="num">${money0(w.financials.sold_price)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No work orders linked. Cut one from the Work Orders page.</div>'}
      </div>
      <div class="card">
        <h3>Time Log <span class="hint">latest 50 punches</span></h3>
        ${job.time.length ? `<table class="tbl"><thead><tr><th>Who</th><th>In</th><th>Out</th><th class="num">Hrs</th></tr></thead><tbody>
          ${job.time.map(t => `<tr><td class="strong">${esc(t.employee_name)}</td><td class="mono">${fmtDateTime(t.clock_in)}</td>
            <td class="mono">${t.clock_out ? fmtTime(t.clock_out) : '<span class="badge b-in">live</span>'}</td>
            <td class="num">${t.clock_out ? hoursBetween(t.clock_in, t.clock_out) : '—'}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No time clocked on this job yet.</div>'}
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <h3>Change Orders <span class="hint">added scope on this job</span>
          <button class="btn sm primary" id="jd-co" style="margin-left:auto">+ New</button></h3>
        ${job.change_orders.length ? `<table class="tbl"><thead><tr><th>CO</th><th>What changed</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
          ${job.change_orders.map(c => `<tr class="clickable" onclick="location.hash='#/changeorders'">
            <td class="mono strong">${esc(c.co_number)}</td><td>${esc(c.title)}</td>
            <td class="num">${money(c.totals.total)}</td><td>${badge(c.status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No change orders. Scope creep with no change order is money you gave away.</div>'}
      </div>
      <div class="card">
        <h3>Billing <span class="hint">invoices against this job</span>
          <button class="btn sm primary" id="jd-bill" style="margin-left:auto">+ Bill</button></h3>
        ${job.invoices.length ? `<table class="tbl"><thead><tr><th>Invoice</th><th>Type</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>
          ${job.invoices.map(i => `<tr class="clickable" onclick="location.hash='#/invoices'">
            <td class="mono strong">${esc(i.invoice_number)}</td><td class="muted">${esc(cap(i.invoice_type))}</td>
            <td class="num">${money(i.totals.total)}</td>
            <td class="num ${i.totals.balance > 0 ? 'neg' : 'pos'}">${money(i.totals.balance)}</td>
            <td>${badge(i.status)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Nothing invoiced yet on this job.</div>'}
      </div>
    </div>

    ${job.subs.length ? `<div class="card section-gap">
      <h3>Subcontractors On This Job</h3>
      <table class="tbl"><thead><tr><th>Company</th><th>Trade</th><th>Scope</th><th class="num">Contract</th><th>Insurance</th></tr></thead><tbody>
        ${job.subs.map(s => {
          const coi = s.documents.filter(d => d.doc_type === 'COI' && d.expires_on).sort((a, b) => b.expires_on.localeCompare(a.expires_on))[0];
          const days = coi ? Math.floor((new Date(coi.expires_on) - new Date(todayStr())) / 864e5) : null;
          return `<tr><td class="strong">${esc(s.name)}</td><td class="muted">${esc(s.trade || '')}</td>
            <td class="muted">${esc(s.scope || '')}</td><td class="num">${money0(s.contract_amount)}</td>
            <td>${days === null ? '<span class="badge b-declined">No COI</span>'
              : days < 0 ? `<span class="badge b-declined">Expired ${esc(coi.expires_on)}</span>`
              : days <= 30 ? `<span class="badge b-in_progress">Expires in ${days}d</span>`
              : `<span class="badge b-accepted">Current</span>`}</td></tr>`;
        }).join('')}
      </tbody></table>
    </div>` : ''}

    ${job.job_cards.length ? `<div class="card section-gap">
      <h3>Field Job Cards <span class="hint">what the crew reported</span></h3>
      ${job.job_cards.slice(0, 8).map(c => `
        <div class="jobcard ${c.status === 'approved' ? 'approved' : ''}">
          <div class="jc-head">
            <span class="strong">${esc(c.employee_name)}</span><span class="muted">${esc(c.work_date)}</span>
            <span class="badge b-${c.status === 'approved' ? 'accepted' : 'sent'}">${esc(cap(c.status))}</span>
            <span class="mono" style="margin-left:auto">${c.hours} hrs</span>
          </div>
          <div class="jc-body">${esc(c.work_performed)}</div>
          ${c.materials_used ? `<div class="jc-field"><b>Materials:</b> ${esc(c.materials_used)}</div>` : ''}
          ${c.issues ? `<div class="jc-issue"><b>⚠ Flagged:</b> ${esc(c.issues)}</div>` : ''}
          ${c.photos && c.photos.length ? `<div class="photo-strip">${c.photos.map(p =>
            `<a href="/uploads/${esc(p.filename)}" target="_blank"><img src="/uploads/${esc(p.filename)}" alt="${esc(p.caption || '')}"></a>`).join('')}</div>` : ''}
        </div>`).join('')}
    </div>` : ''}`;

  $('#jd-edit').onclick = () => jobModal(job);
  $('#jd-co').onclick = () => { location.hash = '#/changeorders'; setTimeout(() => window.coModalFor && window.coModalFor(null, job.id), 400); };
  $('#jd-bill').onclick = () => { location.hash = '#/invoices'; setTimeout(() => { const b = $('#inv-progress'); if (b) b.click(); }, 400); };
  $('#jd-mat').onclick = () => {
    openModal(`
      <div class="modal-head"><h2>Log material on ${esc(job.job_number)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="m-form" class="form-grid">
        <label class="fld full">From inventory<select name="material_id"><option value="">— custom item —</option>
          ${materials.map(m => `<option value="${m.id}">${esc(m.name)} (${m.qty_on_hand} ${esc(m.unit)} on hand)</option>`).join('')}</select></label>
        <label class="fld full">Or custom description<input name="description" placeholder="leave blank when picking from inventory"></label>
        <label class="fld">Qty<input name="qty" type="number" step="any" value="1"></label>
        <label class="fld">Unit cost $ (auto for inventory)<input name="unit_cost" type="number" step="any" value=""></label>
      </form></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="m-save">Log It</button></div>`, { narrow: true });
    $('#m-save').onclick = async () => {
      const d = formData($('#m-form'));
      if (!d.material_id && !d.description) return toast('Pick a material or type a description', 'err');
      await api(`jobs/${job.id}/materials`, 'POST', d);
      closeModal(); toast('Material logged & inventory updated', 'ok'); route();
    };
  };
}

// ---------------------------------------------------------------- WORK ORDERS
PAGES.workorders = async () => {
  const [wos, employees, clients, jobs, numbers] = await Promise.all([
    api('workorders'), api('employees'), api('clients'), api('jobs'), api('numbers'),
  ]);
  view.innerHTML = `
    <div class="toolbar">
      <div class="filters" id="w-filters">
        ${['active', 'open', 'in_progress', 'completed', 'archived', 'all'].map((s, i) => `<span class="chip ${i === 0 ? 'active' : ''}" data-f="${s}">${cap(s)}</span>`).join('')}
      </div>
      <button class="btn primary" id="w-new">+ New Work Order</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>WO #</th><th>Title</th><th>Type</th><th>Client / Job</th><th>Assigned</th><th>Due</th><th>Priority</th><th>Status</th><th class="num">Sold</th><th></th>
    </tr></thead><tbody id="w-body"></tbody></table></div>`;

  function renderRows(filter) {
    const rows = wos.filter(w =>
      filter === 'all' ? true :
      filter === 'active' ? ['open', 'in_progress'].includes(w.status) : w.status === filter);
    $('#w-body').innerHTML = rows.length ? rows.map(w => `
      <tr>
        <td class="mono strong">${esc(w.wo_number)}</td>
        <td>${esc(w.title)}</td>
        <td class="muted">${esc(w.wo_type)}</td>
        <td class="muted">${esc(w.client_name || '—')}${w.job_number ? ` · <span class="mono">${esc(w.job_number)}</span>` : ''}</td>
        <td class="muted">${esc(w.assigned_name || '—')}</td>
        <td class="mono">${esc(w.due_date || '—')}</td>
        <td>${badge(w.priority)}</td>
        <td>${badge(w.status)}</td>
        <td class="num">${money0(w.financials.sold_price)}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${w.id}">Open</button>
          ${w.status === 'open' ? `<button class="btn sm" data-start="${w.id}">Start</button>` : ''}
          ${['open', 'in_progress'].includes(w.status) ? `<button class="btn sm green" data-done="${w.id}">Done</button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="10"><div class="empty">Nothing here.</div></td></tr>';
  }
  renderRows('active');
  $('#w-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#w-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); renderRows(c.dataset.f);
  };
  $('#w-new').onclick = () => woModal();
  $('#w-body').onclick = async e => {
    const t = e.target;
    if (t.dataset.edit) return woModal(wos.find(w => w.id === +t.dataset.edit));
    if (t.dataset.start) { await api('workorders/' + t.dataset.start, 'PUT', { status: 'in_progress' }); toast('Work order started', 'ok'); return route(); }
    if (t.dataset.done) {
      await api('workorders/' + t.dataset.done, 'PUT', { status: 'completed', completed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
      toast('Work order completed — it now shows in Archive & Profit', 'ok'); return route();
    }
  };

  function woModal(w) {
    const items = w ? JSON.parse(w.items || '[]') : [];
    openModal(`
      <div class="modal-head"><h2>${w ? esc(w.wo_number) + ' — ' + esc(w.title) : 'New Work Order ' + esc(numbers.wo)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="w-form" class="form-grid">
          <label class="fld full">Title<input name="title" required value="${esc(w?.title || '')}" placeholder="e.g. Fab 12 window bucks"></label>
          <label class="fld full">Description / drawing refs<textarea name="description">${esc(w?.description || '')}</textarea></label>
          <label class="fld">Type<select name="wo_type">${['Shop', 'Fabrication', 'Field', 'Repair', 'Install'].map(t => `<option ${w && w.wo_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="fld">Priority<select name="priority">${['low', 'normal', 'high', 'rush'].map(p => `<option ${w && w.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <label class="fld">Client<select name="client_id"><option value="">—</option>${clients.map(c => `<option value="${c.id}" ${w && w.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="fld">Linked job<select name="job_id"><option value="">—</option>${jobs.map(j => `<option value="${j.id}" ${w && w.job_id === j.id ? 'selected' : ''}>${esc(j.job_number)} ${esc(j.title)}</option>`).join('')}</select></label>
          <label class="fld">Assigned to<select name="assigned_to"><option value="">—</option>${employees.filter(e => e.active).map(e => `<option value="${e.id}" ${w && w.assigned_to === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
          <label class="fld">Due date<input name="due_date" type="date" value="${esc(w?.due_date || '')}"></label>
          <label class="fld">Est. labor hours<input name="labor_hours" type="number" step="any" value="${w?.labor_hours ?? 0}"></label>
          <label class="fld">Shop rate $/hr<input name="labor_rate" type="number" step="any" value="${w?.labor_rate ?? 65}"></label>
          <label class="fld">Sold price $ <span style="font-weight:400">(0 = auto from items+labor)</span><input name="sold_price" type="number" step="any" value="${w?.sold_price ?? 0}"></label>
          <label class="fld">Status<select name="status">${['open', 'in_progress', 'completed', 'archived'].map(s => `<option value="${s}" ${w && w.status === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></label>
        </form>
        <h3 style="margin:16px 0 4px;font-size:13px">Materials / items</h3>
        <div id="w-items"></div>
      </div>
      <div class="modal-foot">
        ${w ? '<button class="btn danger" id="w-del" style="margin-right:auto">Delete</button>' : ''}
        <button class="btn ghost modal-close">Cancel</button>
        <button class="btn primary" id="w-save">${w ? 'Save' : 'Create Work Order'}</button>
      </div>`);
    lineItemEditor($('#w-items'), items);
    $('#w-save').onclick = async () => {
      const f = formData($('#w-form'));
      if (!f.title) return toast('Title is required', 'err');
      f.items = items.filter(i => i.desc);
      if (f.status === 'completed' && (!w || !['completed', 'archived'].includes(w.status))) f.completed_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (w) { await api('workorders/' + w.id, 'PUT', f); toast('Work order saved', 'ok'); }
      else { f.wo_number = numbers.wo; await api('workorders', 'POST', f); toast(`Work order ${numbers.wo} cut`, 'ok'); }
      closeModal(); route();
    };
    if (w) $('#w-del').onclick = async () => {
      if (!confirm(`Delete ${w.wo_number}?`)) return;
      await api('workorders/' + w.id, 'DELETE'); closeModal(); toast('Deleted', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- INVENTORY
PAGES.inventory = async () => {
  const materials = await api('materials');
  const cats = ['all', ...new Set(materials.map(m => m.category))];
  view.innerHTML = `
    <div class="toolbar">
      <div class="filters" id="m-filters">${cats.map((c, i) => `<span class="chip ${i === 0 ? 'active' : ''}" data-f="${esc(c)}">${esc(cap(c))}</span>`).join('')}</div>
      <div>
        <button class="btn ghost" id="m-low">⚠ Low stock only</button>
        <button class="btn primary" id="m-new">+ Add Material</button>
      </div>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>SKU</th><th>Material</th><th>Category</th><th class="num">On hand</th><th class="num">Reorder at</th><th class="num">Unit cost</th><th class="num">Sell price</th><th>Location</th><th>Vendor</th><th></th>
    </tr></thead><tbody id="m-body"></tbody></table></div>`;

  let lowOnly = false, cat = 'all';
  function renderRows() {
    const rows = materials.filter(m => (cat === 'all' || m.category === cat) && (!lowOnly || m.qty_on_hand <= m.reorder_point));
    $('#m-body').innerHTML = rows.length ? rows.map(m => {
      const low = m.qty_on_hand <= m.reorder_point;
      return `<tr>
        <td class="mono muted">${esc(m.sku)}</td>
        <td class="strong">${esc(m.name)}</td>
        <td class="muted">${esc(m.category)}</td>
        <td class="num ${low ? 'stock-low' : ''}">${m.qty_on_hand} ${esc(m.unit)}${low ? ' ⚠' : ''}</td>
        <td class="num muted">${m.reorder_point}</td>
        <td class="num">${money(m.unit_cost)}</td>
        <td class="num">${money(m.sell_price)}</td>
        <td class="muted">${esc(m.location)}</td>
        <td class="muted">${esc(m.vendor)}</td>
        <td><button class="btn sm ghost" data-edit="${m.id}">Edit</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="10"><div class="empty">No materials match.</div></td></tr>';
  }
  renderRows();
  $('#m-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#m-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); cat = c.dataset.f; renderRows();
  };
  $('#m-low').onclick = e => { lowOnly = !lowOnly; e.target.classList.toggle('primary', lowOnly); renderRows(); };
  $('#m-new').onclick = () => matModal();
  $('#m-body').onclick = e => { if (e.target.dataset.edit) matModal(materials.find(m => m.id === +e.target.dataset.edit)); };

  function matModal(m) {
    openModal(`
      <div class="modal-head"><h2>${m ? 'Edit ' + esc(m.name) : 'Add Material'}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="mat-form" class="form-grid">
        <label class="fld">SKU<input name="sku" value="${esc(m?.sku || '')}"></label>
        <label class="fld">Category<input name="category" value="${esc(m?.category || 'General')}" list="cat-list"><datalist id="cat-list">${cats.filter(c => c !== 'all').map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="fld full">Name<input name="name" required value="${esc(m?.name || '')}"></label>
        <label class="fld">Unit<input name="unit" value="${esc(m?.unit || 'ea')}"></label>
        <label class="fld">Qty on hand<input name="qty_on_hand" type="number" step="any" value="${m?.qty_on_hand ?? 0}"></label>
        <label class="fld">Reorder point<input name="reorder_point" type="number" step="any" value="${m?.reorder_point ?? 0}"></label>
        <label class="fld">Unit cost $<input name="unit_cost" type="number" step="any" value="${m?.unit_cost ?? 0}"></label>
        <label class="fld">Sell price $<input name="sell_price" type="number" step="any" value="${m?.sell_price ?? 0}"></label>
        <label class="fld">Location<input name="location" value="${esc(m?.location || '')}"></label>
        <label class="fld">Vendor<input name="vendor" value="${esc(m?.vendor || '')}"></label>
      </form></div>
      <div class="modal-foot">
        ${m ? '<button class="btn danger" id="mat-del" style="margin-right:auto">Delete</button>' : ''}
        <button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="mat-save">Save</button>
      </div>`);
    $('#mat-save').onclick = async () => {
      const f = formData($('#mat-form'));
      if (!f.name) return toast('Name is required', 'err');
      if (m) await api('materials/' + m.id, 'PUT', f); else await api('materials', 'POST', f);
      closeModal(); toast('Material saved', 'ok'); route();
    };
    if (m) $('#mat-del').onclick = async () => {
      if (!confirm(`Delete ${m.name}?`)) return;
      await api('materials/' + m.id, 'DELETE'); closeModal(); toast('Deleted', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- PURCHASING
PAGES.purchasing = async () => {
  const [pos, materials, jobs, numbers] = await Promise.all([api('purchaseorders'), api('materials'), api('jobs'), api('numbers')]);
  const total = po => JSON.parse(po.items || '[]').reduce((s, i) => s + (i.qty || 0) * (i.unit_cost || 0), 0);
  view.innerHTML = `
    <div class="toolbar">
      <span class="muted">Receiving a PO adds the quantities straight into inventory and refreshes unit costs.</span>
      <button class="btn primary" id="po-new">+ New Purchase Order</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>PO #</th><th>Vendor</th><th>Items</th><th>For job</th><th>Expected</th><th class="num">Total</th><th>Status</th><th></th>
    </tr></thead><tbody>
      ${pos.length ? pos.map(po => {
        const items = JSON.parse(po.items || '[]');
        const j = jobs.find(x => x.id === po.job_id);
        return `<tr>
          <td class="mono strong">${esc(po.po_number)}</td>
          <td>${esc(po.vendor)}</td>
          <td class="muted">${items.map(i => `${i.qty}× ${esc(i.desc)}`).join(', ')}</td>
          <td class="muted">${j ? `<span class="mono">${esc(j.job_number)}</span>` : 'Stock'}</td>
          <td class="mono">${esc(po.expected_date || '—')}</td>
          <td class="num">${money(total(po))}</td>
          <td>${badge(po.status)}</td>
          <td>${po.status === 'ordered' ? `<button class="btn sm green" data-recv="${po.id}">Receive</button>` : (po.received_at ? `<span class="muted" style="font-size:12px">recv ${esc(po.received_at.slice(0, 10))}</span>` : '')}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="8"><div class="empty">No purchase orders yet.</div></td></tr>'}
    </tbody></table></div>`;

  view.onclick = async e => {
    if (e.target.dataset.recv) {
      if (!confirm('Receive this PO into inventory?')) return;
      await api(`purchaseorders/${e.target.dataset.recv}/receive`, 'POST', {});
      toast('Received — inventory updated', 'ok'); route();
    }
  };

  $('#po-new').onclick = () => {
    const items = [];
    openModal(`
      <div class="modal-head"><h2>New Purchase Order ${esc(numbers.po)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="po-form" class="form-grid">
          <label class="fld">Vendor<input name="vendor" required placeholder="e.g. SteelServ"></label>
          <label class="fld">Expected date<input name="expected_date" type="date"></label>
          <label class="fld">For job<select name="job_id"><option value="">Stock order</option>
            ${jobs.filter(j => j.status !== 'completed').map(j => `<option value="${j.id}">${esc(j.job_number)} ${esc(j.title)}</option>`).join('')}</select></label>
          <label class="fld">Add inventory item<select id="po-mat"><option value="">— pick material —</option>
            ${materials.map(m => `<option value="${m.id}">${esc(m.name)} (${m.qty_on_hand} on hand)</option>`).join('')}</select></label>
          <label class="fld full">Notes<input name="notes"></label>
        </form>
        <h3 style="margin:14px 0 4px;font-size:13px">Order lines</h3>
        <div id="po-items"></div>
      </div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="po-save">Place Order</button></div>`);
    const redraw = () => lineItemEditor($('#po-items'), items, { withPrice: false });
    redraw();
    $('#po-mat').onchange = e => {
      const m = materials.find(x => x.id === +e.target.value);
      if (m) { items.push({ material_id: m.id, desc: m.name, qty: Math.max(1, Math.ceil(m.reorder_point * 1.5 - m.qty_on_hand)), unit: m.unit, unit_cost: m.unit_cost }); redraw(); }
      e.target.value = '';
    };
    $('#po-save').onclick = async () => {
      const f = formData($('#po-form'));
      if (!f.vendor) return toast('Vendor is required', 'err');
      if (!items.filter(i => i.desc).length) return toast('Add at least one line', 'err');
      f.items = items.filter(i => i.desc);
      f.po_number = numbers.po; f.status = 'ordered';
      await api('purchaseorders', 'POST', f);
      closeModal(); toast(`PO ${numbers.po} placed`, 'ok'); route();
    };
  };
};

// ---------------------------------------------------------------- ARCHIVE & PROFIT SEARCH
PAGES.archive = async (param) => {
  const q = param ? decodeURIComponent(param) : '';
  view.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="global-search" style="width:100%;max-width:640px">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
        <input id="arc-q" placeholder="Search anything — client, item, work order #, 'railing', 'door frames'…" value="${esc(q)}">
      </div>
      <p class="muted" style="margin-top:10px;font-size:12.5px">Searches every job, work order and quote — including line items — and shows what you sold it for, what it cost, and whether you profited. Click a result to see the items.</p>
    </div>
    <div id="arc-results"><div class="empty">Searching…</div></div>`;

  $('#arc-q').addEventListener('keydown', e => {
    if (e.key === 'Enter') { location.hash = '#/archive/' + encodeURIComponent(e.target.value.trim()); }
  });

  const results = await api('search?q=' + encodeURIComponent(q));
  const wrap = $('#arc-results');
  if (!wrap) return;
  wrap.innerHTML = results.length ? results.map(r => `
    <div class="result-item">
      <div class="result-head">
        <span class="rtype ${r.type}">${r.type.replace('_', ' ')}</span>
        <span class="rnum">${esc(r.number)}</span>
        <span class="strong">${esc(r.title)}</span>
        <span class="muted">· ${esc(r.client || '—')} · ${esc(r.date)}</span>
        ${badge(r.status)}
        <div class="result-fin">
          <div><span class="muted">Sold</span><b>${money0(r.sold_price)}</b></div>
          <div><span class="muted">Cost</span><b>${money0(r.total_cost)}</b></div>
          <div><span class="muted">Profit</span><b class="${r.profit >= 0 ? 'pos' : 'neg'}">${money0(r.profit)} (${r.margin_pct}%)</b></div>
        </div>
      </div>
      <div class="result-items">
        ${r.items && r.items.length ? `<table class="tbl"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Unit price</th></tr></thead><tbody>
          ${r.items.map(i => `<tr><td>${esc(i.desc)}</td><td class="num">${i.qty ?? ''}</td><td class="num">${i.unit_cost != null ? money(i.unit_cost) : '—'}</td><td class="num">${i.unit_price != null ? money(i.unit_price) : '—'}</td></tr>`).join('')}
        </tbody></table>` : '<span class="muted">No line items recorded.</span>'}
      </div>
    </div>`).join('') : `<div class="empty">Nothing found for “${esc(q)}”.</div>`;
  wrap.onclick = e => {
    const item = e.target.closest('.result-item');
    if (item && !e.target.closest('.result-items')) item.classList.toggle('open');
  };
};

// ---------------------------------------------------------------- AI INSIGHTS
PAGES.insights = async () => {
  const insights = await api('insights');
  view.innerHTML = `
    <div class="card" style="margin-bottom:16px;background:linear-gradient(120deg,#131c26,#24344a);color:#fff;border:0">
      <h3 style="color:#f5a524">Foreman's Briefing</h3>
      <p style="font-size:13px;line-height:1.6;color:#cfd8e3">The assistant watches your margins, stock levels, shop queue and outstanding quotes, then flags what needs attention — highest priority first. Numbers update live as the crew clocks time and materials get logged.</p>
    </div>
    ${insights.length ? insights.map(i => `
      <div class="insight">
        <div class="sev ${esc(i.severity)}"></div>
        <div><h4>${esc(i.title)}</h4><p>${esc(i.detail)}</p></div>
      </div>`).join('') : '<div class="empty">All clear — nothing needs attention right now.</div>'}`;
};

// ---------------------------------------------------------------- CLIENTS
PAGES.clients = async () => {
  const clients = await api('clients');
  view.innerHTML = `
    <div class="toolbar"><span></span><button class="btn primary" id="c-new">+ Add Client</button></div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Client</th><th>Contact</th><th>Phone</th><th>Email</th><th>Address</th><th></th>
    </tr></thead><tbody>
      ${clients.map(c => `<tr>
        <td class="strong">${esc(c.name)}</td><td>${esc(c.contact)}</td>
        <td class="mono">${esc(c.phone)}</td><td>${esc(c.email)}</td><td class="muted">${esc(c.address)}</td>
        <td><button class="btn sm ghost" data-edit="${c.id}">Edit</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  $('#c-new').onclick = () => cModal();
  view.onclick = e => { if (e.target.dataset.edit) cModal(clients.find(c => c.id === +e.target.dataset.edit)); };
  function cModal(c) {
    openModal(`
      <div class="modal-head"><h2>${c ? 'Edit Client' : 'Add Client'}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="c-form" class="form-grid">
        <label class="fld full">Company / name<input name="name" required value="${esc(c?.name || '')}"></label>
        <label class="fld">Contact person<input name="contact" value="${esc(c?.contact || '')}"></label>
        <label class="fld">Phone<input name="phone" value="${esc(c?.phone || '')}"></label>
        <label class="fld full">Email<input name="email" value="${esc(c?.email || '')}"></label>
        <label class="fld full">Address<input name="address" value="${esc(c?.address || '')}"></label>
        <label class="fld full">Notes<textarea name="notes">${esc(c?.notes || '')}</textarea></label>
      </form></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="c-save">Save</button></div>`, { narrow: true });
    $('#c-save').onclick = async () => {
      const f = formData($('#c-form'));
      if (!f.name) return toast('Name is required', 'err');
      if (c) await api('clients/' + c.id, 'PUT', f); else await api('clients', 'POST', f);
      closeModal(); toast('Client saved', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- TEAM
PAGES.team = async () => {
  const employees = await api('employees');
  view.innerHTML = `
    <div class="toolbar"><span class="muted">PINs are what the crew punches into the time clock.</span><button class="btn primary" id="e-new">+ Add Employee</button></div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Name</th><th>Role</th><th>Phone</th><th class="num">Rate $/hr</th><th>PIN</th><th>Status</th><th></th>
    </tr></thead><tbody>
      ${employees.map(e => `<tr>
        <td class="strong">${esc(e.name)}</td><td>${esc(e.role)}</td><td class="mono">${esc(e.phone)}</td>
        <td class="num">${money(e.hourly_rate)}</td><td class="mono">${esc(e.pin)}</td>
        <td>${e.active ? badge('in').replace('In', 'Active') : badge('out').replace('Out', 'Inactive')}</td>
        <td><button class="btn sm ghost" data-edit="${e.id}">Edit</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  $('#e-new').onclick = () => eModal();
  view.onclick = e => { if (e.target.dataset.edit) eModal(employees.find(x => x.id === +e.target.dataset.edit)); };
  function eModal(emp) {
    openModal(`
      <div class="modal-head"><h2>${emp ? 'Edit ' + esc(emp.name) : 'Add Employee'}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="e-form" class="form-grid">
        <label class="fld full">Name<input name="name" required value="${esc(emp?.name || '')}"></label>
        <label class="fld">Role<input name="role" value="${esc(emp?.role || 'Crew')}"></label>
        <label class="fld">Phone<input name="phone" value="${esc(emp?.phone || '')}"></label>
        <label class="fld">Hourly rate $<input name="hourly_rate" type="number" step="any" value="${emp?.hourly_rate ?? 25}"></label>
        <label class="fld">Time clock PIN<input name="pin" value="${esc(emp?.pin || '')}" maxlength="6"></label>
        <label class="fld">Active<select name="active"><option value="1" ${!emp || emp.active ? 'selected' : ''}>Yes</option><option value="0" ${emp && !emp.active ? 'selected' : ''}>No</option></select></label>
      </form></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="e-save">Save</button></div>`, { narrow: true });
    $('#e-save').onclick = async () => {
      const f = formData($('#e-form'));
      if (!f.name) return toast('Name is required', 'err');
      f.active = Number(f.active);
      if (emp) await api('employees/' + emp.id, 'PUT', f); else await api('employees', 'POST', f);
      closeModal(); toast('Employee saved', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- FIELD JOB CARDS
PAGES.jobcards = async () => {
  const cards = await api('jobcards');
  const pending = cards.filter(c => c.status === 'submitted');
  view.innerHTML = `
    <div class="toolbar">
      <div class="filters" id="jc-filters">
        <span class="chip active" data-f="submitted">Awaiting review (${pending.length})</span>
        <span class="chip" data-f="approved">Approved</span>
        <span class="chip" data-f="all">All</span>
      </div>
      <span class="muted">Crew submit these from the field portal at the end of the day.</span>
    </div>
    <div id="jc-list"></div>`;

  function render(filter) {
    const rows = cards.filter(c => filter === 'all' || c.status === filter);
    $('#jc-list').innerHTML = rows.length ? rows.map(c => `
      <div class="jobcard ${c.status === 'approved' ? 'approved' : ''}">
        <div class="jc-head">
          <span class="strong">${esc(c.employee_name)}</span>
          <span class="muted">${esc(c.work_date)}</span>
          ${c.job_number ? `<span class="mono strong">${esc(c.job_number)}</span> <span class="muted">${esc(c.job_title || '')}</span>` : '<span class="muted">Shop / no job</span>'}
          <span class="badge b-${c.status === 'approved' ? 'accepted' : 'sent'}">${esc(cap(c.status))}</span>
          <span class="mono" style="margin-left:auto">${c.hours} hrs</span>
          ${c.status === 'submitted' ? `<button class="btn sm green" data-ok="${c.id}">Approve</button>` : ''}
        </div>
        <div class="jc-body">${esc(c.work_performed)}</div>
        ${c.materials_used ? `<div class="jc-field"><b>Materials:</b> ${esc(c.materials_used)}</div>` : ''}
        ${c.issues ? `<div class="jc-issue"><b>⚠ Flagged:</b> ${esc(c.issues)}</div>` : ''}
      </div>`).join('') : '<div class="empty">Nothing here.</div>';
  }
  render('submitted');
  $('#jc-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#jc-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); render(c.dataset.f);
  };
  $('#jc-list').onclick = async e => {
    if (e.target.dataset.ok) {
      await api(`jobcards/${e.target.dataset.ok}/approve`, 'POST', {});
      toast('Job card approved', 'ok'); route();
    }
  };
};

// ---------------------------------------------------------------- shared: email a customer document
async function docEmailModal({ kind, endpoint, doc, number, title, total, email, contact, defaultMessage, accent = 'primary' }) {
  const cfg = await api('settings');
  const configured = !!cfg.smtp_host;
  const greeting = contact ? contact.split(' ')[0] : '';
  openModal(`
    <div class="modal-head"><h2>Email ${esc(kind)} ${esc(number)}</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      ${configured ? '' : `<div class="hr-note"><b>SMTP is not set up yet.</b> Sending now saves a full preview of the customer's email to the outbox instead of delivering it. Add your mail server under <a class="plain" href="#/settings">Settings → Email</a>.</div>`}
      <form id="dm-form" class="form-grid">
        <label class="fld full">To<input name="to" value="${esc(email || '')}" placeholder="customer@company.com" required></label>
        <label class="fld full">Subject<input name="subject" value="${esc(title)}"></label>
        <label class="fld full">Message<textarea name="message" style="min-height:120px">${esc(defaultMessage.replace('{name}', greeting ? ' ' + greeting : ''))}</textarea></label>
      </form>
      <p class="muted" style="font-size:12.5px;margin-top:10px">The full ${esc(kind.toLowerCase())} (${money(total)}) is included in the email automatically, with a secure link the customer can open on any device.</p>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" id="dm-link" style="margin-right:auto">Just get the link</button>
      <button class="btn ghost modal-close">Cancel</button>
      <button class="btn ${accent}" id="dm-send">${configured ? 'Send' : 'Generate Preview'}</button>
    </div>`);

  $('#dm-link').onclick = async () => {
    const r = await api(`${endpoint}/${doc.id}/link`, 'POST', {});
    $('.modal-body').insertAdjacentHTML('beforeend', `
      <div class="copybox"><input value="${esc(r.link)}" readonly onclick="this.select()">
      <button class="btn sm ghost" onclick="navigator.clipboard.writeText('${esc(r.link)}');this.textContent='Copied'">Copy</button></div>`);
  };
  $('#dm-send').onclick = async () => {
    const btn = $('#dm-send'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await api(`${endpoint}/${doc.id}/email`, 'POST', formData($('#dm-form')));
      closeModal(); toast(r.message, r.status === 'sent' ? 'ok' : '');
      if (r.preview) window.open(r.preview, '_blank');
      route();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = configured ? 'Send' : 'Generate Preview'; }
  };
}

// ---------------------------------------------------------------- CHANGE ORDERS
PAGES.changeorders = async () => {
  const [cos, jobs, clients, numbers, settings] = await Promise.all([
    api('changeorders'), api('jobs'), api('clients'), api('numbers'), api('settings'),
  ]);
  const pending = cos.filter(c => c.status === 'sent');
  const approvedTotal = cos.filter(c => c.status === 'approved').reduce((s, c) => s + c.totals.total, 0);

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#2e9e6b"><div class="kpi-label">Approved &amp; Under Contract</div><div class="kpi-value">${money0(approvedTotal)}</div><div class="kpi-note">${cos.filter(c => c.status === 'approved').length} signed change orders</div></div>
      <div class="kpi" style="--kpi-accent:#d64545"><div class="kpi-label">Awaiting Signature</div><div class="kpi-value">${money0(pending.reduce((s, c) => s + c.totals.total, 0))}</div><div class="kpi-note">${pending.length} out with customers — do not build these yet</div></div>
      <div class="kpi" style="--kpi-accent:#8496aa"><div class="kpi-label">Drafts</div><div class="kpi-value">${cos.filter(c => c.status === 'draft').length}</div><div class="kpi-note">not sent to anyone yet</div></div>
      <div class="kpi" style="--kpi-accent:#7c5cd6"><div class="kpi-label">Schedule Impact</div><div class="kpi-value">${cos.filter(c => c.status === 'approved').reduce((s, c) => s + (c.schedule_days || 0), 0)} d</div><div class="kpi-note">added by approved changes</div></div>
    </div>

    <div class="toolbar">
      <div class="filters" id="co-filters">
        ${['all', 'draft', 'sent', 'approved', 'declined'].map(s => `<span class="chip ${s === 'all' ? 'active' : ''}" data-f="${s}">${cap(s)}</span>`).join('')}
      </div>
      <button class="btn primary" id="co-new">+ New Change Order</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>CO #</th><th>Job</th><th>What changed</th><th>Reason</th><th class="num">Amount</th><th class="num">Days</th><th>Status</th><th></th>
    </tr></thead><tbody id="co-body"></tbody></table></div>`;

  function render(filter) {
    const rows = cos.filter(c => filter === 'all' || c.status === filter);
    $('#co-body').innerHTML = rows.length ? rows.map(c => `
      <tr>
        <td class="mono strong">${esc(c.co_number)}</td>
        <td><span class="mono">${esc(c.job_number || '')}</span><div class="muted" style="font-size:11.5px">${esc(c.client_name || '')}</div></td>
        <td>${esc(c.title)}</td>
        <td class="muted">${esc(cap(c.reason || '—'))}</td>
        <td class="num strong">${money(c.totals.total)}</td>
        <td class="num muted">${c.schedule_days || 0}</td>
        <td>${badge(c.status)}${c.client_signature ? `<div class="muted" style="font-size:11px;margin-top:2px">✓ ${esc(c.client_signature)}</div>` : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${c.id}">Edit</button>
          ${c.status === 'draft' || c.status === 'sent' ? `<button class="btn sm" data-mail="${c.id}">✉ ${c.status === 'sent' ? 'Resend' : 'Send'}</button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="8"><div class="empty">No change orders here.</div></td></tr>';
  }
  render('all');
  $('#co-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#co-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); render(c.dataset.f);
  };
  $('#co-new').onclick = () => coModal();
  $('#co-body').onclick = e => {
    if (e.target.dataset.edit) return coModal(cos.find(c => c.id === +e.target.dataset.edit));
    if (e.target.dataset.mail) {
      const c = cos.find(x => x.id === +e.target.dataset.mail);
      docEmailModal({ kind: 'Change Order', endpoint: 'changeorders', doc: c, number: c.co_number,
        title: `Change Order ${c.co_number}: ${c.title}`, total: c.totals.total,
        email: c.client_email, contact: c.client_contact,
        defaultMessage: `Hi{name},\n\nWe ran into work outside the original scope on ${c.job_number}. Details and pricing are below — we need your approval before we proceed.\n\nThanks,\n${ME.name}` });
    }
  };

  window.coModalFor = coModal;   // reachable from the job card page
  function coModal(co, presetJobId, presetCard) {
    const items = co ? JSON.parse(co.items || '[]') : [];
    openModal(`
      <div class="modal-head"><h2>${co ? 'Edit ' + esc(co.co_number) : 'New Change Order ' + esc(numbers.co)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="co-form" class="form-grid">
          <label class="fld">Job<select name="job_id" required>
            ${jobs.filter(j => j.status !== 'completed' || (co && co.job_id === j.id)).map(j =>
              `<option value="${j.id}" ${(co ? co.job_id === j.id : presetJobId === j.id) ? 'selected' : ''}>${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}
          </select></label>
          <label class="fld">Reason<select name="reason">
            ${['client request', 'unforeseen condition', 'design change', 'code requirement', 'other']
              .map(r => `<option ${co && co.reason === r ? 'selected' : ''}>${r}</option>`).join('')}
          </select></label>
          <label class="fld full">Title<input name="title" required value="${esc(co?.title || '')}" placeholder="e.g. Reroute irrigation line at footings"></label>
          <label class="fld full">What changed and why<textarea name="description">${esc(co?.description || presetCard?.issues || '')}</textarea></label>
          <label class="fld">Labor hours<input name="labor_hours" type="number" step="any" value="${co?.labor_hours ?? 0}"></label>
          <label class="fld">Labor rate $/hr<input name="labor_rate" type="number" step="any" value="${co?.labor_rate ?? settings.default_labor_rate ?? 65}"></label>
          <label class="fld">Markup %<input name="markup_pct" type="number" step="any" value="${co?.markup_pct ?? 10}"></label>
          <label class="fld">Tax %<input name="tax_pct" type="number" step="any" value="${co?.tax_pct ?? settings.default_tax_pct ?? 0}"></label>
          <label class="fld">Calendar days added<input name="schedule_days" type="number" step="any" value="${co?.schedule_days ?? 0}"></label>
          <label class="fld">Status<select name="status">${['draft', 'sent', 'approved', 'declined'].map(s => `<option value="${s}" ${co && co.status === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></label>
        </form>
        <h3 style="margin:16px 0 4px;font-size:13px">Added scope</h3>
        <div id="co-items"></div>
        <div class="quote-summary" id="co-summary"></div>
      </div>
      <div class="modal-foot">
        ${co ? '<button class="btn danger" id="co-del" style="margin-right:auto">Delete</button>' : ''}
        <button class="btn ghost modal-close">Cancel</button>
        <button class="btn primary" id="co-save">${co ? 'Save' : 'Create Change Order'}</button>
      </div>`);

    const summary = () => {
      const f = formData($('#co-form'));
      const t = calcQuote(items, f.labor_hours, f.labor_rate, f.markup_pct, f.tax_pct);
      $('#co-summary').innerHTML = `
        <div>Materials<b>${money(t.materials)}</b></div>
        <div>Labor<b>${money(t.labor)}</b></div>
        <div>Markup<b>${money(t.markup)}</b></div>
        <div>Tax<b>${money(t.tax)}</b></div>
        <div class="grand">Change order total<b>${money(t.total)}</b></div>`;
    };
    lineItemEditor($('#co-items'), items, { onChange: summary });
    $('#co-form').addEventListener('input', summary);
    summary();

    $('#co-save').onclick = async () => {
      const f = formData($('#co-form'));
      if (!f.title) return toast('Title is required', 'err');
      f.items = items.filter(i => i.desc);
      const job = jobs.find(j => j.id === +f.job_id);
      f.client_id = job ? job.client_id : null;
      if (presetCard) f.source_card_id = presetCard.id;
      try {
        if (co) await api('changeorders/' + co.id, 'PUT', f);
        else { f.co_number = numbers.co; await api('changeorders', 'POST', f); }
        closeModal(); toast('Change order saved', 'ok'); location.hash = '#/changeorders'; route();
      } catch (e) { toast(e.message, 'err'); }
    };
    if (co) $('#co-del').onclick = async () => {
      if (!confirm(`Delete ${co.co_number}?`)) return;
      await api('changeorders/' + co.id, 'DELETE'); closeModal(); toast('Deleted', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- INVOICES & AR
PAGES.invoices = async () => {
  const [invoices, aging, jobs, clients, numbers, settings] = await Promise.all([
    api('invoices'), api('invoices/aging'), api('jobs'), api('clients'), api('numbers'), api('settings'),
  ]);
  const b = aging.buckets;
  const maxBucket = Math.max(...Object.values(b), 1);
  const bucketLabels = { current: 'Not yet due', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90_plus: '90+ days' };
  const bucketColors = { current: '#2e9e6b', d1_30: '#f5a524', d31_60: '#e8833a', d61_90: '#d64545', d90_plus: '#a02020' };

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Outstanding</div><div class="kpi-value">${money0(aging.total_outstanding)}</div><div class="kpi-note">${aging.open.length} unpaid invoices</div></div>
      <div class="kpi" style="--kpi-accent:#d64545"><div class="kpi-label">Past Due</div><div class="kpi-value neg">${money0(aging.open.filter(o => o.days_overdue > 0).reduce((s, o) => s + o.balance, 0))}</div><div class="kpi-note">${aging.open.filter(o => o.days_overdue > 0).length} invoices overdue</div></div>
      <div class="kpi" style="--kpi-accent:#7c5cd6"><div class="kpi-label">Retainage Held</div><div class="kpi-value">${money0(aging.retainage_held)}</div><div class="kpi-note">billable at closeout</div></div>
      <div class="kpi" style="--kpi-accent:#8496aa"><div class="kpi-label">Drafts</div><div class="kpi-value">${invoices.filter(i => i.status === 'draft').length}</div><div class="kpi-note">unsent — cannot be paid</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>Receivables Aging</h3>
        ${Object.entries(b).map(([k, v]) => `
          <div class="bar-row">
            <span class="lbl">${bucketLabels[k]}</span>
            <span class="track"><i style="width:${Math.round(v / maxBucket * 100)}%;background:${bucketColors[k]}"></i></span>
            <span class="val">${money0(v)}</span>
          </div>`).join('')}
        <p class="muted" style="font-size:12.5px;margin-top:12px">Anything past 60 days needs a phone call, not another emailed copy.</p>
      </div>
      <div class="card">
        <h3>Oldest Unpaid</h3>
        ${aging.open.length ? `<table class="tbl"><thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th class="num">Balance</th></tr></thead><tbody>
          ${aging.open.slice(0, 8).map(o => `<tr>
            <td class="mono strong">${esc(o.invoice_number)}</td>
            <td class="muted">${esc(o.client || '')}</td>
            <td class="mono ${o.days_overdue > 0 ? 'neg' : 'muted'}">${esc(o.due_date || '—')}${o.days_overdue > 0 ? ` (+${o.days_overdue}d)` : ''}</td>
            <td class="num strong">${money(o.balance)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">Nothing outstanding — everyone has paid.</div>'}
      </div>
    </div>

    <div class="toolbar section-gap">
      <div class="filters" id="inv-filters">
        ${['all', 'draft', 'sent', 'paid'].map(s => `<span class="chip ${s === 'all' ? 'active' : ''}" data-f="${s}">${cap(s)}</span>`).join('')}
      </div>
      <div>
        <button class="btn ghost" id="inv-progress">Bill a job by % complete</button>
        <button class="btn primary" id="inv-new">+ New Invoice</button>
      </div>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Invoice</th><th>Client / Job</th><th>Type</th><th>Issued</th><th>Due</th>
      <th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th>Status</th><th></th>
    </tr></thead><tbody id="inv-body"></tbody></table></div>`;

  function render(filter) {
    const rows = invoices.filter(i => filter === 'all' || i.status === filter);
    $('#inv-body').innerHTML = rows.length ? rows.map(i => `
      <tr>
        <td class="mono strong">${esc(i.invoice_number)}</td>
        <td>${esc(i.client_name || '—')}${i.job_number ? `<div class="muted" style="font-size:11.5px">${esc(i.job_number)}</div>` : ''}</td>
        <td class="muted">${esc(cap(i.invoice_type))}</td>
        <td class="mono muted">${esc(i.issue_date || '—')}</td>
        <td class="mono ${i.days_overdue > 0 ? 'neg' : 'muted'}">${esc(i.due_date || '—')}${i.days_overdue > 0 ? ` +${i.days_overdue}d` : ''}</td>
        <td class="num">${money(i.totals.total)}</td>
        <td class="num pos">${i.totals.paid ? money(i.totals.paid) : '—'}</td>
        <td class="num strong ${i.totals.balance > 0 ? (i.days_overdue > 0 ? 'neg' : '') : 'pos'}">${money(i.totals.balance)}</td>
        <td>${badge(i.status)}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${i.id}">Open</button>
          <button class="btn sm" data-mail="${i.id}">✉</button>
          ${i.totals.balance > 0 ? `<button class="btn sm green" data-pay="${i.id}">Payment</button>` : ''}
        </td>
      </tr>`).join('') : '<tr><td colspan="10"><div class="empty">No invoices here.</div></td></tr>';
  }
  render('all');
  $('#inv-filters').onclick = e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $$('#inv-filters .chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active'); render(c.dataset.f);
  };
  $('#inv-new').onclick = () => invModal();
  $('#inv-progress').onclick = () => progressModal();
  $('#inv-body').onclick = e => {
    const inv = id => invoices.find(x => x.id === +id);
    if (e.target.dataset.edit) return invModal(inv(e.target.dataset.edit));
    if (e.target.dataset.pay) return payModal(inv(e.target.dataset.pay));
    if (e.target.dataset.mail) {
      const i = inv(e.target.dataset.mail);
      docEmailModal({ kind: 'Invoice', endpoint: 'invoices', doc: i, number: i.invoice_number,
        title: `Invoice ${i.invoice_number}`, total: i.totals.balance, email: i.client_email, contact: i.client_contact,
        defaultMessage: `Hi{name},\n\nInvoice ${i.invoice_number} is below${i.due_date ? `, due ${i.due_date}` : ''}. Thank you for your business.\n\n${ME.name}`,
        accent: 'green' });
    }
  };

  function progressModal() {
    const open = jobs.filter(j => j.status !== 'completed' || j.financials.invoicing.billed < j.financials.sold_price);
    openModal(`
      <div class="modal-head"><h2>Bill a job by percent complete</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p class="muted" style="margin-bottom:14px;font-size:13px">Pick a job and how far along it is. We'll bill the difference between that percentage of the contract and what you have already invoiced.</p>
        <form id="pg-form" class="form-grid">
          <label class="fld full">Job<select name="job_id" id="pg-job">
            ${open.map(j => `<option value="${j.id}">${esc(j.job_number)} — ${esc(j.title)} (${money0(j.financials.sold_price)} contract, ${money0(j.financials.invoicing.billed)} billed)</option>`).join('')}
          </select></label>
          <label class="fld">Percent complete<input name="percent_complete" type="number" min="0" max="100" value="50"></label>
          <label class="fld">Retainage %<input name="retainage_pct" type="number" step="any" value="${settings.default_retainage_pct || 0}"></label>
          <label class="fld">Tax %<input name="tax_pct" type="number" step="any" value="0"></label>
          <label class="fld">Terms (days)<input name="terms_days" type="number" value="${settings.payment_terms_days || 30}"></label>
        </form>
        <div id="pg-preview" class="quote-summary"></div>
      </div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="pg-go">Create Draft Invoice</button></div>`, { narrow: true });

    const preview = () => {
      const f = formData($('#pg-form'));
      const j = jobs.find(x => x.id === +f.job_id);
      if (!j) return;
      const gross = j.financials.sold_price * (Number(f.percent_complete) || 0) / 100;
      const thisBill = Math.max(0, gross - j.financials.invoicing.billed);
      const ret = thisBill * (Number(f.retainage_pct) || 0) / 100;
      $('#pg-preview').innerHTML = `
        <div>Contract<b>${money(j.financials.sold_price)}</b></div>
        <div>Already billed<b>${money(j.financials.invoicing.billed)}</b></div>
        <div>Less retainage<b>${money(ret)}</b></div>
        <div class="grand">This invoice<b>${money(thisBill - ret)}</b></div>`;
    };
    $('#pg-form').addEventListener('input', preview);
    preview();

    $('#pg-go').onclick = async () => {
      const f = formData($('#pg-form'));
      try {
        const r = await api(`invoices/${f.job_id}/generate`, 'POST', f);
        closeModal(); toast(`${r.invoice_number} drafted for ${money(r.amount)}`, 'ok'); route();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function payModal(inv) {
    openModal(`
      <div class="modal-head"><h2>Record payment — ${esc(inv.invoice_number)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p class="muted" style="margin-bottom:14px">${esc(inv.client_name || '')} owes <b class="strong">${money(inv.totals.balance)}</b> of ${money(inv.totals.total)}.</p>
        <form id="pay-form" class="form-grid">
          <label class="fld">Amount $<input name="amount" type="number" step="any" value="${inv.totals.balance}" required></label>
          <label class="fld">Received on<input name="received_on" type="date" value="${todayStr()}"></label>
          <label class="fld">Method<select name="method">${['check', 'ach', 'card', 'cash', 'other'].map(m => `<option value="${m}">${m.toUpperCase()}</option>`).join('')}</select></label>
          <label class="fld">Reference<input name="reference" placeholder="check # / confirmation"></label>
          <label class="fld full">Notes<input name="notes"></label>
        </form>
      </div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn green" id="pay-save">Record Payment</button></div>`, { narrow: true });
    $('#pay-save').onclick = async () => {
      try {
        const r = await api(`invoices/${inv.id}/payments`, 'POST', formData($('#pay-form')));
        closeModal();
        toast(r.paid_in_full ? 'Paid in full — nice' : `Payment recorded, ${money(r.balance)} still open`, 'ok');
        route();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  function invModal(inv) {
    const items = inv ? JSON.parse(inv.items || '[]') : [];
    const payments = inv ? null : [];
    openModal(`
      <div class="modal-head"><h2>${inv ? esc(inv.invoice_number) : 'New Invoice ' + esc(numbers.invoice)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <form id="iv-form" class="form-grid">
          <label class="fld">Client<select name="client_id">${clients.map(c => `<option value="${c.id}" ${inv && inv.client_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="fld">Job<select name="job_id"><option value="">— none —</option>${jobs.map(j => `<option value="${j.id}" ${inv && inv.job_id === j.id ? 'selected' : ''}>${esc(j.job_number)} ${esc(j.title)}</option>`).join('')}</select></label>
          <label class="fld">Type<select name="invoice_type">${['deposit', 'progress', 'final'].map(t => `<option value="${t}" ${inv && inv.invoice_type === t ? 'selected' : ''}>${cap(t)}</option>`).join('')}</select></label>
          <label class="fld">Status<select name="status">${['draft', 'sent', 'paid', 'void'].map(s => `<option value="${s}" ${inv && inv.status === s ? 'selected' : ''}>${cap(s)}</option>`).join('')}</select></label>
          <label class="fld full">Description<input name="description" value="${esc(inv?.description || '')}" placeholder="e.g. Progress billing #2 — drywall complete"></label>
          <label class="fld">Issue date<input name="issue_date" type="date" value="${esc(inv?.issue_date || todayStr())}"></label>
          <label class="fld">Due date<input name="due_date" type="date" value="${esc(inv?.due_date || '')}"></label>
          <label class="fld">Terms (days)<input name="terms_days" type="number" value="${inv?.terms_days ?? settings.payment_terms_days ?? 30}"></label>
          <label class="fld">Retainage %<input name="retainage_pct" type="number" step="any" value="${inv?.retainage_pct ?? 0}"></label>
          <label class="fld">Tax %<input name="tax_pct" type="number" step="any" value="${inv?.tax_pct ?? 0}"></label>
          <label class="fld full">Notes shown to the customer<textarea name="notes">${esc(inv?.notes || '')}</textarea></label>
        </form>
        <h3 style="margin:16px 0 4px;font-size:13px">Line items</h3>
        <div id="iv-items"></div>
        <div class="quote-summary" id="iv-summary"></div>
        ${inv && inv.totals.paid ? `<div class="hr-note" style="margin-top:12px">${money(inv.totals.paid)} in payments has been applied to this invoice.</div>` : ''}
      </div>
      <div class="modal-foot">
        ${inv ? '<button class="btn danger" id="iv-del" style="margin-right:auto">Delete</button>' : ''}
        <button class="btn ghost modal-close">Cancel</button>
        <button class="btn primary" id="iv-save">Save</button>
      </div>`);

    const summary = () => {
      const f = formData($('#iv-form'));
      const sub = items.reduce((s, i) => s + (i.qty || 0) * (i.unit_price || 0), 0);
      const tax = sub * (Number(f.tax_pct) || 0) / 100;
      const ret = (sub + tax) * (Number(f.retainage_pct) || 0) / 100;
      $('#iv-summary').innerHTML = `
        <div>Subtotal<b>${money(sub)}</b></div>
        <div>Tax<b>${money(tax)}</b></div>
        <div>Retainage held<b>−${money(ret)}</b></div>
        <div class="grand">Invoice total<b>${money(sub + tax - ret)}</b></div>`;
    };
    lineItemEditor($('#iv-items'), items, { onChange: summary });
    $('#iv-form').addEventListener('input', summary);
    summary();

    $('#iv-save').onclick = async () => {
      const f = formData($('#iv-form'));
      f.items = items.filter(i => i.desc);
      if (!f.items.length) return toast('Add at least one line item', 'err');
      if (!f.due_date && f.issue_date) {
        const d = new Date(f.issue_date + 'T12:00'); d.setDate(d.getDate() + (Number(f.terms_days) || 0));
        f.due_date = d.toISOString().slice(0, 10);
      }
      try {
        if (inv) await api('invoices/' + inv.id, 'PUT', f);
        else { f.invoice_number = numbers.invoice; await api('invoices', 'POST', f); }
        closeModal(); toast('Invoice saved', 'ok'); route();
      } catch (e) { toast(e.message, 'err'); }
    };
    if (inv) $('#iv-del').onclick = async () => {
      if (!confirm(`Delete ${inv.invoice_number}? Payments recorded against it stay in the ledger.`)) return;
      await api('invoices/' + inv.id, 'DELETE'); closeModal(); toast('Deleted', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- PAYROLL
PAGES.payroll = async () => {
  const jobs = await api('jobs');
  const pwJobs = jobs.filter(j => j.prevailing_wage);
  const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const from = new Date(monday); from.setDate(from.getDate() - 7);

  view.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        <label class="fld" style="flex-direction:row;align-items:center;gap:8px">From<input type="date" id="pr-from" value="${from.toISOString().slice(0, 10)}"></label>
        <label class="fld" style="flex-direction:row;align-items:center;gap:8px">To<input type="date" id="pr-to" value="${todayStr()}"></label>
        <button class="btn ghost sm" id="pr-go">Run</button>
      </div>
      <a class="btn ghost" id="pr-csv" download>⬇ Export CSV</a>
    </div>
    <div id="pr-out"><div class="empty">Loading…</div></div>

    <div class="card section-gap">
      <h3>Certified Payroll <span class="hint">WH-347 style, for prevailing-wage work</span></h3>
      ${pwJobs.length ? `
        <div class="toolbar" style="margin-bottom:12px">
          <div class="filters">
            <label class="fld" style="flex-direction:row;align-items:center;gap:8px">Job<select id="cp-job">
              ${jobs.map(j => `<option value="${j.id}" ${j.prevailing_wage ? 'selected' : ''}>${esc(j.job_number)} — ${esc(j.title)}${j.prevailing_wage ? ' (prevailing wage)' : ''}</option>`).join('')}
            </select></label>
            <label class="fld" style="flex-direction:row;align-items:center;gap:8px">Week ending<input type="date" id="cp-week" value="${todayStr()}"></label>
            <button class="btn ghost sm" id="cp-go">Run</button>
          </div>
          <a class="btn ghost sm" id="cp-csv" download>⬇ CSV</a>
        </div>` : '<div class="hr-note">No jobs are flagged as prevailing wage. Tick <b>prevailing wage</b> on a job to file certified payroll for it.</div>'}
      <div id="cp-out"></div>
    </div>`;

  async function runPayroll() {
    const f = $('#pr-from').value, t = $('#pr-to').value;
    $('#pr-csv').href = `/api/payroll?from=${f}&to=${t}&format=csv`;
    const d = await api(`payroll?from=${f}&to=${t}`);
    $('#pr-out').innerHTML = `
      <div class="kpis">
        <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Total Hours</div><div class="kpi-value">${d.totals.hours}</div><div class="kpi-note">${d.from} → ${d.to}</div></div>
        <div class="kpi" style="--kpi-accent:#2e9e6b"><div class="kpi-label">Gross Payroll</div><div class="kpi-value">${money0(d.totals.gross)}</div><div class="kpi-note">before taxes and withholding</div></div>
        <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Overtime Hours</div><div class="kpi-value">${d.rows.reduce((s, r) => s + r.ot_hours, 0)}</div><div class="kpi-note">over 40 in a week, at 1.5×</div></div>
        <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">On Payroll</div><div class="kpi-value">${d.rows.length}</div><div class="kpi-note">employees with hours</div></div>
      </div>
      <div class="card"><table class="tbl"><thead><tr>
        <th>Employee</th><th>Classification</th><th class="num">Rate</th><th class="num">Regular</th><th class="num">OT</th><th class="num">Total hrs</th><th class="num">Gross</th><th>Jobs worked</th>
      </tr></thead><tbody>
        ${d.rows.length ? d.rows.map(r => `<tr>
          <td class="strong">${esc(r.name)}</td>
          <td class="muted">${esc(r.classification)}</td>
          <td class="num">${money(r.rate)}</td>
          <td class="num">${r.regular_hours}</td>
          <td class="num ${r.ot_hours ? 'neg' : 'muted'}">${r.ot_hours || '—'}</td>
          <td class="num strong">${r.total_hours}</td>
          <td class="num">${money(r.gross_pay)}</td>
          <td class="muted" style="font-size:12px">${Object.entries(r.by_job).map(([j, h]) => `${esc(j)} (${h})`).join(', ')}</td>
        </tr>`).join('') : '<tr><td colspan="8"><div class="empty">No hours in this period.</div></td></tr>'}
      </tbody></table></div>`;
  }
  $('#pr-go').onclick = runPayroll;
  runPayroll();

  if (pwJobs.length) {
    async function runCertified() {
      const jobId = $('#cp-job').value, wk = $('#cp-week').value;
      $('#cp-csv').href = `/api/payroll/certified?job_id=${jobId}&week_ending=${wk}&format=csv`;
      const d = await api(`payroll/certified?job_id=${jobId}&week_ending=${wk}`);
      $('#cp-out').innerHTML = d.employees.length ? `
        <p class="muted" style="font-size:12.5px;margin-bottom:10px">${esc(d.job.job_number)} — ${esc(d.job.title)} · payroll week ${d.week_start} to ${d.week_ending}</p>
        <table class="tbl"><thead><tr>
          <th>Employee</th><th>Classification</th>
          ${d.days.map(x => `<th class="num">${new Date(x + 'T12:00').toLocaleDateString([], { weekday: 'narrow', day: 'numeric' })}</th>`).join('')}
          <th class="num">Total</th><th class="num">Rate</th><th class="num">Gross</th><th class="num">Fringe</th><th class="num">Package</th>
        </tr></thead><tbody>
          ${d.employees.map(e => `<tr>
            <td class="strong">${esc(e.name)}</td><td class="muted">${esc(e.classification)}</td>
            ${d.days.map(x => `<td class="num ${e.days[x] ? '' : 'muted'}">${e.days[x] || '—'}</td>`).join('')}
            <td class="num strong">${e.total}</td><td class="num">${money(e.rate)}</td>
            <td class="num">${money(e.gross_pay)}</td><td class="num muted">${money(e.fringe_total)}</td>
            <td class="num strong">${money(e.total_package)}</td>
          </tr>`).join('')}
        </tbody></table>
        <p class="muted" style="font-size:12px;margin-top:10px">Fringe is calculated from each classification's fringe rate on the Team page. Verify against the current wage determination before filing.</p>`
        : '<div class="empty">No hours clocked on that job during that week.</div>';
    }
    $('#cp-go').onclick = runCertified;
    runCertified();
  }
};

// ---------------------------------------------------------------- SUBCONTRACTORS
PAGES.subs = async () => {
  const [subs, jobs] = await Promise.all([api('subcontractors'), api('jobs')]);
  const bad = subs.filter(s => s.active && !s.compliant);
  const soon = subs.filter(s => s.compliant && s.coi_days_left !== null && s.coi_days_left <= 30);

  view.innerHTML = `
    ${bad.length ? `<div class="insight" style="border-left:5px solid var(--red);margin-bottom:16px">
      <div class="sev high"></div>
      <div><h4>${bad.length} subcontractor${bad.length > 1 ? 's are' : ' is'} not insured right now</h4>
      <p>${bad.map(s => esc(s.name)).join(', ')} — pull them off the schedule until a current certificate is on file. Your general liability policy will not cover work by an uninsured sub, and neither will your customer's.</p></div>
    </div>` : ''}

    <div class="toolbar">
      <span class="muted">${soon.length ? `${soon.length} certificate${soon.length > 1 ? 's expire' : ' expires'} within 30 days.` : 'All certificates current.'}</span>
      <button class="btn primary" id="s-new">+ Add Subcontractor</button>
    </div>

    <div class="grid grid-2" id="s-grid">
      ${subs.map(s => `
        <div class="card sub-card ${s.active && !s.compliant ? 'danger' : ''}">
          <h3>${esc(s.name)}
            <span class="r" style="float:right;font-weight:400">${s.compliant
              ? `<span class="badge b-accepted">Insured${s.coi_days_left <= 30 ? ` · ${s.coi_days_left}d left` : ''}</span>`
              : '<span class="badge b-declined">Not insured</span>'}</span>
          </h3>
          <table class="tbl" style="margin-bottom:10px">
            <tr><td class="muted" style="width:96px">Trade</td><td class="strong">${esc(s.trade || '—')}</td></tr>
            <tr><td class="muted">Contact</td><td>${esc(s.contact || '—')}${s.phone ? ` · <span class="mono">${esc(s.phone)}</span>` : ''}</td></tr>
            <tr><td class="muted">Email</td><td>${esc(s.email || '—')}</td></tr>
            <tr><td class="muted">License</td><td class="mono">${esc(s.license_number || '—')}</td></tr>
            ${s.jobs.length ? `<tr><td class="muted">On jobs</td><td>${s.jobs.map(j => `<span class="mono">${esc(j.job_number)}</span> ${money0(j.contract_amount)}`).join('<br>')}</td></tr>` : ''}
          </table>
          <div class="docs">
            ${s.documents.length ? s.documents.map(d => {
              const days = d.expires_on ? Math.floor((new Date(d.expires_on) - new Date(todayStr())) / 864e5) : null;
              const cls = days === null ? '' : days < 0 ? 'expired' : days <= 30 ? 'soon' : 'ok';
              return `<div class="doc ${cls}">
                <span class="dt">${esc(d.doc_type)}</span>
                <span class="dd">${esc(d.carrier || d.policy_number || '')}</span>
                <span class="de">${d.expires_on ? `${days < 0 ? 'expired' : 'expires'} ${esc(d.expires_on)}${days !== null ? ` (${days < 0 ? Math.abs(days) + 'd ago' : days + 'd'})` : ''}` : 'no expiry'}</span>
                <button class="btn sm ghost" data-deldoc="${d.id}">×</button>
              </div>`;
            }).join('') : '<div class="empty" style="padding:12px;font-size:13px">No documents on file.</div>'}
          </div>
          <div style="margin-top:10px">
            <button class="btn sm ghost" data-edit="${s.id}">Edit</button>
            <button class="btn sm ghost" data-doc="${s.id}">+ Document</button>
            <button class="btn sm ghost" data-assign="${s.id}">Assign to job</button>
          </div>
        </div>`).join('')}
    </div>`;

  view.onclick = async e => {
    const t = e.target;
    if (t.dataset.edit) return subModal(subs.find(s => s.id === +t.dataset.edit));
    if (t.dataset.doc) return docModal(subs.find(s => s.id === +t.dataset.doc));
    if (t.dataset.assign) return assignModal(subs.find(s => s.id === +t.dataset.assign));
    if (t.dataset.deldoc) {
      if (!confirm('Remove this document?')) return;
      await api('subdocuments/' + t.dataset.deldoc, 'DELETE');
      toast('Document removed', 'ok'); route();
    }
  };
  $('#s-new').onclick = () => subModal();

  function subModal(s) {
    openModal(`
      <div class="modal-head"><h2>${s ? 'Edit ' + esc(s.name) : 'Add Subcontractor'}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="sf" class="form-grid">
        <label class="fld full">Company<input name="name" required value="${esc(s?.name || '')}"></label>
        <label class="fld">Trade<input name="trade" value="${esc(s?.trade || '')}" placeholder="Electrical, Plumbing…"></label>
        <label class="fld">License #<input name="license_number" value="${esc(s?.license_number || '')}"></label>
        <label class="fld">Contact<input name="contact" value="${esc(s?.contact || '')}"></label>
        <label class="fld">Phone<input name="phone" value="${esc(s?.phone || '')}"></label>
        <label class="fld full">Email<input name="email" value="${esc(s?.email || '')}"></label>
        <label class="fld full">Notes<textarea name="notes">${esc(s?.notes || '')}</textarea></label>
        ${s ? `<label class="fld full">Status<select name="active"><option value="1" ${s.active ? 'selected' : ''}>Active</option><option value="0" ${s.active ? '' : 'selected'}>Inactive</option></select></label>` : ''}
      </form></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="sf-save">Save</button></div>`, { narrow: true });
    $('#sf-save').onclick = async () => {
      const f = formData($('#sf'));
      if (!f.name) return toast('Company name is required', 'err');
      if (s) await api('subcontractors/' + s.id, 'PUT', f); else await api('subcontractors', 'POST', f);
      closeModal(); toast('Subcontractor saved', 'ok'); route();
    };
  }

  function docModal(s) {
    openModal(`
      <div class="modal-head"><h2>Add document — ${esc(s.name)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="df" class="form-grid">
        <label class="fld">Type<select name="doc_type">${['COI', 'W-9', 'License', 'Contract', 'Other'].map(d => `<option>${d}</option>`).join('')}</select></label>
        <label class="fld">Carrier / issuer<input name="carrier" placeholder="e.g. Travelers"></label>
        <label class="fld">Policy / doc number<input name="policy_number"></label>
        <label class="fld">Issued<input name="issued_on" type="date"></label>
        <label class="fld">Expires<input name="expires_on" type="date"></label>
        <label class="fld full">Notes<input name="notes"></label>
      </form>
      <p class="muted" style="font-size:12.5px;margin-top:10px">Expiry dates drive the warnings on this page and in AI Insights — always fill one in for a COI.</p></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="df-save">Add</button></div>`, { narrow: true });
    $('#df-save').onclick = async () => {
      await api('subdocuments', 'POST', { ...formData($('#df')), sub_id: s.id });
      closeModal(); toast('Document added', 'ok'); route();
    };
  }

  function assignModal(s) {
    openModal(`
      <div class="modal-head"><h2>Assign ${esc(s.name)} to a job</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        ${s.compliant ? '' : '<div class="hr-note"><b>This sub has no current insurance certificate.</b> You can still record the assignment, but do not let them start until you have one.</div>'}
        <form id="af" class="form-grid">
          <label class="fld full">Job<select name="job_id">${jobs.filter(j => j.status !== 'completed').map(j => `<option value="${j.id}">${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}</select></label>
          <label class="fld full">Scope<input name="scope" placeholder="What are they doing?"></label>
          <label class="fld">Contract amount $<input name="contract_amount" type="number" step="any" value="0"></label>
        </form>
        <p class="muted" style="font-size:12.5px;margin-top:10px">The contract amount is counted as a cost against that job's profit.</p>
      </div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="af-save">Assign</button></div>`, { narrow: true });
    $('#af-save').onclick = async () => {
      await api('jobsubs', 'POST', { ...formData($('#af')), sub_id: s.id });
      closeModal(); toast('Assigned to job', 'ok'); route();
    };
  }
};

// ---------------------------------------------------------------- REPORTS
PAGES.reports = async () => {
  const r = await api('reports');
  const maxRev = Math.max(...r.byClient.map(c => c.revenue), 1);
  const completed = r.jobs.filter(j => j.status === 'completed');
  const totalRev = completed.reduce((s, j) => s + j.sold_price, 0);
  const totalProfit = completed.reduce((s, j) => s + j.profit, 0);

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Completed Revenue</div><div class="kpi-value">${money0(totalRev)}</div><div class="kpi-note">${completed.length} finished jobs</div></div>
      <div class="kpi" style="--kpi-accent:#2e9e6b"><div class="kpi-label">Realized Profit</div><div class="kpi-value pos">${money0(totalProfit)}</div><div class="kpi-note">${totalRev ? Math.round(totalProfit / totalRev * 100) : 0}% blended margin</div></div>
      <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Quote Win Rate</div><div class="kpi-value">${r.winRate === null ? '—' : r.winRate + '%'}</div><div class="kpi-note">${r.quoteCounts.map(q => `${q.n} ${q.status}`).join(' · ')}</div></div>
      <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">Crew Utilization</div><div class="kpi-value">${r.labor.length ? Math.round(r.labor.reduce((s, l) => s + l.utilization, 0) / r.labor.length) : 0}%</div><div class="kpi-note">billable hours ÷ clocked hours, 30d</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>Revenue By Client <span class="hint">all time</span></h3>
        ${r.byClient.filter(c => c.revenue > 0).map(c => `
          <div class="bar-row">
            <span class="lbl">${esc(c.name)}</span>
            <span class="track"><i style="width:${Math.round(c.revenue / maxRev * 100)}%"></i></span>
            <span class="val">${money0(c.revenue)}</span>
          </div>`).join('') || '<div class="empty">No revenue recorded yet.</div>'}
        <div class="legend"><span><i style="background:#131c26"></i>Revenue booked against jobs</span></div>
      </div>
      <div class="card">
        <h3>Margin By Client <span class="hint">profit ÷ revenue</span></h3>
        <table class="tbl"><thead><tr><th>Client</th><th class="num">Jobs</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead><tbody>
          ${r.byClient.filter(c => c.revenue > 0).map(c => `<tr>
            <td class="strong">${esc(c.name)}</td><td class="num">${c.jobs}</td>
            <td class="num ${c.profit >= 0 ? 'pos' : 'neg'}">${money0(c.profit)}</td>
            <td class="num">${c.margin_pct}%</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>

    <div class="grid grid-2 section-gap">
      <div class="card">
        <h3>Crew Hours &amp; Utilization <span class="hint">last 30 days</span></h3>
        <table class="tbl"><thead><tr><th>Employee</th><th class="num">Hours</th><th class="num">Billable</th><th class="num">Util.</th><th class="num">Labor cost</th></tr></thead><tbody>
          ${r.labor.map(l => `<tr>
            <td class="strong">${esc(l.name)}<div class="muted" style="font-size:11.5px">${esc(l.role)}</div></td>
            <td class="num">${l.hours}</td><td class="num">${l.billable_hours}</td>
            <td class="num ${l.utilization >= 80 ? 'pos' : l.utilization < 50 ? 'neg' : ''}">${l.utilization}%</td>
            <td class="num">${money0(l.cost)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <h3>Biggest Material Spend</h3>
        <table class="tbl"><thead><tr><th>Material</th><th class="num">Qty used</th><th class="num">Spend</th></tr></thead><tbody>
          ${r.topMaterials.length ? r.topMaterials.map(m => `<tr>
            <td>${esc(m.name)}</td><td class="num">${round(m.qty)}</td><td class="num">${money0(m.spend)}</td></tr>`).join('')
            : '<tr><td colspan="3"><div class="empty">No material usage logged yet.</div></td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="card section-gap">
      <h3>Job Profitability <span class="hint">every job, best margin first</span></h3>
      <table class="tbl"><thead><tr><th>Job</th><th>Client</th><th>Status</th><th class="num">Sold</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead><tbody>
        ${[...r.jobs].sort((a, b) => b.margin_pct - a.margin_pct).map(j => `<tr>
          <td><span class="mono strong">${esc(j.job_number)}</span> ${esc(j.title)}</td>
          <td class="muted">${esc(j.client || '—')}</td>
          <td>${badge(j.status)}</td>
          <td class="num">${money0(j.sold_price)}</td>
          <td class="num">${money0(j.total_cost)}</td>
          <td class="num ${j.profit >= 0 ? 'pos' : 'neg'}">${money0(j.profit)}</td>
          <td class="num">${j.margin_pct}%</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  function round(n) { return Math.round((Number(n) || 0) * 100) / 100; }
};

// ---------------------------------------------------------------- USERS & ACCESS
PAGES.users = async () => {
  const [users, employees] = await Promise.all([api('users'), api('employees')]);
  view.innerHTML = `
    <div class="toolbar">
      <span class="muted">Admins get the full Command Center. Crew get the mobile field portal only — they never see pricing, costs or margins.</span>
      <button class="btn primary" id="u-new">+ Add User</button>
    </div>
    <div class="card"><table class="tbl"><thead><tr>
      <th>Username</th><th>Employee</th><th>Access</th><th>Last sign-in</th><th>Status</th><th></th>
    </tr></thead><tbody>
      ${users.map(u => `<tr>
        <td class="mono strong">${esc(u.username)}${u.id === ME.id ? ' <span class="muted">(you)</span>' : ''}</td>
        <td>${esc(u.employee_name || '—')}</td>
        <td>${u.role === 'admin' ? '<span class="badge b-in_progress">Office / Admin</span>' : '<span class="badge b-open">Crew Portal</span>'}</td>
        <td class="muted mono">${u.last_login ? esc(u.last_login.slice(0, 16)) : 'never'}</td>
        <td>${u.active ? '<span class="badge b-accepted">Active</span>' : '<span class="badge b-archived">Disabled</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${u.id}">Edit</button>
          ${u.id === ME.id ? '' : `<button class="btn sm ghost" data-del="${u.id}">Delete</button>`}
        </td>
      </tr>`).join('')}
    </tbody></table></div>

    <div class="card section-gap">
      <h3>Recent Activity <span class="hint">who did what</span></h3>
      <div id="audit-list"><div class="empty">Loading…</div></div>
    </div>`;

  api('audit').then(rows => {
    const el = $('#audit-list'); if (!el) return;
    el.innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${rows.slice(0, 40).map(a => `<tr>
        <td class="mono muted">${esc(a.created_at.slice(5, 16))}</td>
        <td class="strong">${esc(a.username)}</td>
        <td>${esc(cap(a.action))}</td>
        <td class="muted">${esc(a.detail)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No activity recorded yet.</div>';
  }).catch(() => {});

  $('#u-new').onclick = () => userModal();
  view.onclick = async e => {
    if (e.target.dataset.edit) return userModal(users.find(u => u.id === +e.target.dataset.edit));
    if (e.target.dataset.del) {
      const u = users.find(x => x.id === +e.target.dataset.del);
      if (!confirm(`Delete the login "${u.username}"? Their time records stay intact.`)) return;
      try { await api('users/' + u.id, 'DELETE'); toast('User deleted', 'ok'); route(); }
      catch (err) { toast(err.message, 'err'); }
    }
  };

  function userModal(u) {
    openModal(`
      <div class="modal-head"><h2>${u ? 'Edit ' + esc(u.username) : 'Add User'}</h2><button class="modal-close">×</button></div>
      <div class="modal-body"><form id="u-form" class="form-grid">
        ${u ? '' : '<label class="fld full">Username<input name="username" required autocapitalize="off" placeholder="e.g. dave"></label>'}
        <label class="fld full">${u ? 'New password <span style="font-weight:400">(leave blank to keep current)</span>' : 'Password'}<input name="password" type="password" autocomplete="new-password" placeholder="at least 6 characters"></label>
        <label class="fld">Access level<select name="role">
          <option value="crew" ${u && u.role === 'crew' ? 'selected' : ''}>Crew — field portal only</option>
          <option value="admin" ${u && u.role === 'admin' ? 'selected' : ''}>Admin — full Command Center</option>
        </select></label>
        <label class="fld">Linked employee<select name="employee_id"><option value="">— none —</option>
          ${employees.map(e => `<option value="${e.id}" ${u && u.employee_id === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
        ${u ? `<label class="fld full">Status<select name="active"><option value="1" ${u.active ? 'selected' : ''}>Active</option><option value="0" ${u.active ? '' : 'selected'}>Disabled</option></select></label>` : ''}
      </form>
      <p class="muted" style="font-size:12.5px;margin-top:10px">Linking an employee is what connects a login to their schedule, time clock and assigned work orders.</p></div>
      <div class="modal-foot"><button class="btn ghost modal-close">Cancel</button><button class="btn primary" id="u-save">Save</button></div>`, { narrow: true });
    $('#u-save').onclick = async () => {
      const f = formData($('#u-form'));
      if (!f.password) delete f.password;
      if (f.employee_id === '') f.employee_id = null;
      try {
        if (u) await api('users/' + u.id, 'PUT', f); else await api('users', 'POST', f);
        closeModal(); toast('User saved', 'ok'); route();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
};

// ---------------------------------------------------------------- SETTINGS
PAGES.settings = async () => {
  const [s, emails] = await Promise.all([api('settings'), api('emails')]);
  const f = (name, label, opts = {}) => `
    <label class="fld ${opts.full ? 'full' : ''}">${label}
      ${opts.textarea
        ? `<textarea name="${name}" style="min-height:${opts.height || 90}px">${esc(s[name] || '')}</textarea>`
        : `<input name="${name}" type="${opts.type || 'text'}" value="${esc(s[name] || '')}" placeholder="${esc(opts.placeholder || '')}">`}
    </label>`;

  view.innerHTML = `
    <div class="grid grid-2">
      <div>
        <div class="card">
          <h3>Company</h3>
          <form id="set-company" class="form-grid">
            ${f('company_name', 'Company name', { full: true })}
            ${f('company_address', 'Address', { full: true })}
            ${f('company_phone', 'Phone')}
            ${f('company_email', 'Office email')}
            ${f('company_website', 'Website', { full: true })}
          </form>
        </div>
        <div class="card">
          <h3>Pricing Defaults</h3>
          <form id="set-pricing" class="form-grid">
            ${f('default_labor_rate', 'Default labor rate $/hr', { type: 'number' })}
            ${f('default_tax_pct', 'Default tax %', { type: 'number' })}
            ${f('target_margin_pct', 'Target margin %', { type: 'number' })}
            <div class="fld"><span></span></div>
            ${f('quote_terms', 'Terms printed on every proposal', { textarea: true, full: true, height: 120 })}
          </form>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Email Delivery <span class="hint">${s.smtp_host ? 'configured' : 'not configured'}</span></h3>
          ${s.smtp_host ? '' : `<div class="hr-note">Until this is filled in, emailing a quote writes a <b>full preview to the outbox</b> instead of sending. Use the SMTP details from your email provider — for Gmail/Google Workspace that's <b>smtp.gmail.com</b>, port 587, with an app password.</div>`}
          <form id="set-mail" class="form-grid">
            ${f('smtp_host', 'SMTP host', { full: true, placeholder: 'smtp.gmail.com' })}
            ${f('smtp_port', 'Port', { type: 'number', placeholder: '587' })}
            <label class="fld">Connection<select name="smtp_secure">
              <option value="0" ${s.smtp_secure === '1' ? '' : 'selected'}>STARTTLS (587)</option>
              <option value="1" ${s.smtp_secure === '1' ? 'selected' : ''}>SSL/TLS (465)</option>
            </select></label>
            ${f('smtp_user', 'Username', { full: true })}
            ${f('smtp_pass', 'Password / app password', { type: 'password', full: true })}
            ${f('mail_from', 'Send proposals as', { full: true, placeholder: 'Company <office@company.com>' })}
            ${f('app_base_url', 'Public site address (for customer approval links)', { full: true, placeholder: 'https://quotes.yourcompany.com' })}
          </form>
        </div>
        <div class="card">
          <h3>Sent Proposals <span class="hint">last 100</span></h3>
          ${emails.length ? `<table class="tbl"><thead><tr><th>When</th><th>To</th><th>Status</th><th></th></tr></thead><tbody>
            ${emails.map(e => `<tr>
              <td class="mono muted">${esc(e.created_at.slice(5, 16))}</td>
              <td>${esc(e.to_email)}<div class="muted" style="font-size:11.5px">${esc(e.subject)}</div></td>
              <td>${e.status === 'sent' ? '<span class="badge b-accepted">Sent</span>' : e.status === 'outbox' ? '<span class="badge b-sent">Outbox</span>' : `<span class="badge b-declined" title="${esc(e.error)}">Failed</span>`}</td>
              <td>${e.preview_file ? `<a class="plain" href="/outbox/${esc(e.preview_file)}" target="_blank">Preview</a>` : ''}</td>
            </tr>`).join('')}
          </tbody></table>` : '<div class="empty">No proposals emailed yet.</div>'}
        </div>
      </div>
    </div>
    <div class="toolbar section-gap" style="justify-content:flex-end">
      <span class="muted" id="save-note"></span>
      <button class="btn primary" id="set-save">Save All Settings</button>
    </div>`;

  $('#set-save').onclick = async () => {
    const payload = { ...formData($('#set-company')), ...formData($('#set-pricing')), ...formData($('#set-mail')) };
    // a masked password field means "leave it alone" — the server ignores it too
    if (/^•+$/.test(String(payload.smtp_pass))) delete payload.smtp_pass;
    await api('settings', 'PUT', payload);
    toast('Settings saved', 'ok');
    $('#save-note').textContent = 'Saved ' + new Date().toLocaleTimeString();
  };
};

// go — verify the session first so the console never renders half-signed-in
(async () => {
  try { await bootSession(); }
  catch { return void (location.href = '/login'); }
  refreshOnClock();
  setInterval(refreshOnClock, 30000);
  route();
})();
