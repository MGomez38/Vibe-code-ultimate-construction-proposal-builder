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
refreshOnClock();
setInterval(refreshOnClock, 30000);

// ---------------------------------------------------------------- router
const PAGES = {};
const TITLES = {
  dashboard: ['Dashboard', 'Company pulse at a glance'],
  clock: ['Time Clock', 'Clock in, clock out, clock onto jobs'],
  schedule: ['Crew Schedule', 'Who is where, all week'],
  quotes: ['Quotes', 'Estimates and proposals'],
  jobs: ['Job Cards', 'Active and planned field work'],
  workorders: ['Work Orders', 'Shop and fabrication queue'],
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

    <div class="kpis section-gap">
      <div class="kpi" style="--kpi-accent:${k.lowStock ? '#d64545' : '#2e9e6b'}"><div class="kpi-label">Low Stock Items</div><div class="kpi-value">${k.lowStock}</div><div class="kpi-note"><a class="plain" href="#/inventory">view inventory →</a></div></div>
      <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">POs In Transit</div><div class="kpi-value">${k.openPOs}</div><div class="kpi-note"><a class="plain" href="#/purchasing">purchasing →</a></div></div>
      <div class="kpi" style="--kpi-accent:#f5a524"><div class="kpi-label">Pending Quotes</div><div class="kpi-value">${k.pendingQuotes}</div><div class="kpi-note"><a class="plain" href="#/quotes">follow up →</a></div></div>
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
        <td>${badge(q.status)}</td>
        <td style="white-space:nowrap">
          <button class="btn sm ghost" data-edit="${q.id}">Edit</button>
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
    const editId = e.target.dataset.edit, winId = e.target.dataset.win;
    if (editId) quoteModal(quotes.find(q => q.id === +editId));
    if (winId) convertModal(quotes.find(q => q.id === +winId));
  };

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
    lineItemEditor($('#q-items'), items, { onChange: summary });
    $('#q-form').addEventListener('input', summary);
    summary();

    $('#q-mat').onchange = e => {
      const m = materials.find(x => x.id === +e.target.value);
      if (m) { items.push({ desc: m.name, qty: 1, unit: m.unit, unit_cost: m.unit_cost, unit_price: m.sell_price }); lineItemEditor($('#q-items'), items, { onChange: summary }); summary(); }
      e.target.value = '';
    };

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
      <div class="kpi" style="--kpi-accent:#131c26"><div class="kpi-label">Sold Price</div><div class="kpi-value">${money0(f.sold_price)}</div></div>
      <div class="kpi" style="--kpi-accent:#d64545"><div class="kpi-label">Cost To Date</div><div class="kpi-value">${money0(f.total_cost)}</div><div class="kpi-note">materials ${money0(f.material_cost)} · labor ${money0(f.labor_cost)} · shop ${money0(f.wo_cost)}</div></div>
      <div class="kpi" style="--kpi-accent:${f.profit >= 0 ? '#2e9e6b' : '#d64545'}"><div class="kpi-label">Profit</div><div class="kpi-value ${f.profit >= 0 ? 'pos' : 'neg'}">${money0(f.profit)}</div><div class="kpi-note">${f.margin_pct}% margin</div></div>
      <div class="kpi" style="--kpi-accent:#3b7dd8"><div class="kpi-label">Labor Hours</div><div class="kpi-value">${f.labor_hours}</div><div class="kpi-note">from the time clock</div></div>
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
    </div>`;

  $('#jd-edit').onclick = () => jobModal(job);
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

// go
route();
