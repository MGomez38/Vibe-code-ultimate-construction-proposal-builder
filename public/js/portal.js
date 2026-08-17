/* ============================================================
   Crew Portal — the field-facing app.
   Runs as the signed-in employee; the server never returns pricing
   or other crews' data here. Works with no signal: punches and job
   cards queue locally and sync when the phone gets bars again.
   ============================================================ */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#p-view');

// ---------------------------------------------------------------- offline queue
const QUEUE_KEY = 'dts_offline_queue';
const loadQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const saveQueue = q => localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function enqueue(type, payload) {
  const q = loadQueue();
  const op = { type, payload, at: new Date().toISOString(), client_ref: newRef() };
  q.push(op);
  saveQueue(q);
  renderQueueBadge();
  return op;
}

/** Push everything queued; anything the server accepts (or already had) leaves the queue. */
async function drainQueue(silent = false) {
  const q = loadQueue();
  if (!q.length || !navigator.onLine) return { synced: 0 };
  try {
    const res = await fetch('/api/portal/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queue: q }),
    });
    if (!res.ok) throw new Error('sync failed');
    const { results } = await res.json();
    const accepted = new Set(results.filter(r => r.ok).map(r => r.client_ref));
    const rejected = results.filter(r => r.error);
    saveQueue(q.filter(op => !accepted.has(op.client_ref) && !rejected.some(r => r.client_ref === op.client_ref)));
    renderQueueBadge();
    if (accepted.size && !silent) msg(`${accepted.size} offline ${accepted.size === 1 ? 'entry' : 'entries'} synced`, 'ok');
    if (rejected.length && !silent) msg(rejected[0].error, 'err');
    return { synced: accepted.size };
  } catch { return { synced: 0 }; }
}

function renderQueueBadge() {
  const n = loadQueue().length;
  const bar = $('#p-offline');
  if (!bar) return;
  if (!navigator.onLine) {
    bar.className = 'p-offline show off';
    bar.textContent = n ? `Offline — ${n} ${n === 1 ? 'entry' : 'entries'} saved on this phone, will sync automatically` : 'Offline — you can still clock in and write job cards';
  } else if (n) {
    bar.className = 'p-offline show pending';
    bar.textContent = `Syncing ${n} saved ${n === 1 ? 'entry' : 'entries'}…`;
  } else {
    bar.className = 'p-offline';
    bar.textContent = '';
  }
}

window.addEventListener('online', async () => { renderQueueBadge(); await drainQueue(); route(); });
window.addEventListener('offline', renderQueueBadge);

// ---------------------------------------------------------------- api
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
function msg(t, kind = '') {
  const el = document.createElement('div');
  el.className = 'p-msg ' + kind;
  el.textContent = t;
  $('#p-toast').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3400);
}

// cache the last good summary so the Today screen still renders with no signal
const CACHE_KEY = 'dts_portal_cache';
async function cachedApi(path) {
  try {
    const data = await api(path);
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    c[path] = data;
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    return data;
  } catch (e) {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    if (c[path]) { return c[path]; }
    throw e;
  }
}

let me = null;

// ---------------------------------------------------------------- photos
/** Shrink a phone photo before upload — job sites rarely have good signal. */
function downscale(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not process photo')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read photo')); };
    img.src = url;
  });
}

async function uploadPhotos(cardId, files) {
  const form = new FormData();
  for (const f of files) {
    const blob = f.type.startsWith('image/') ? await downscale(f) : f;
    form.append('photo', blob, (f.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg');
  }
  const res = await fetch(`/api/portal/attachments?entity_id=${cardId}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// ---------------------------------------------------------------- voice dictation
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
function attachDictation(button, target) {
  if (!SpeechRec) { button.style.display = 'none'; return; }
  let rec = null, listening = false;
  button.onclick = () => {
    if (listening) { rec && rec.stop(); return; }
    rec = new SpeechRec();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    const base = target.value ? target.value.trim() + ' ' : '';
    rec.onstart = () => { listening = true; button.classList.add('listening'); button.textContent = '● Listening — tap to stop'; };
    rec.onresult = e => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      target.value = base + text;
    };
    rec.onerror = e => { msg(e.error === 'not-allowed' ? 'Microphone permission denied' : 'Dictation stopped', 'err'); };
    rec.onend = () => { listening = false; button.classList.remove('listening'); button.textContent = '🎤 Dictate'; };
    try { rec.start(); } catch { msg('Dictation unavailable', 'err'); }
  };
}

// ---------------------------------------------------------------- Today
async function pageHome() {
  const d = await cachedApi('portal/summary');
  const open = d.open_entry;
  view.innerHTML = `
    <div class="pc clock-card">
      <div class="time" id="live-time"></div>
      <div class="date">${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      <div class="status-pill ${open ? 'on' : 'off'}"><i></i>${open ? 'On the clock' : 'Not clocked in'}</div>
      ${open ? `<div class="on-since">Since ${fmtTime(open.clock_in)} · <b id="run">${elapsed(open.clock_in)}</b>${open.job_number ? ` on ${esc(open.job_number)}` : ' (general shift)'}</div>`
             : '<div class="on-since">Pick your job and clock in to start the day.</div>'}
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
          <div><div class="t">${esc(s.job_title || s.notes || 'Shop work')}</div>
          <div class="s">${esc(s.shift)}${s.address ? ' · ' + esc(s.address) : ''}${s.notes && s.job_title ? ' · ' + esc(s.notes) : ''}</div></div>
        </div>`).join('') : '<div class="p-empty">Nothing scheduled for you today — check with the office.</div>'}
    </div>

    ${d.work_orders.length ? `<div class="pc">
      <h3>Your Open Work Orders<span class="r">${d.work_orders.length}</span></h3>
      ${d.work_orders.slice(0, 3).map(w => `
        <div class="assign tappable" onclick="location.hash='#/work/${w.id}'">
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
    const jobId = $('#job-sel').value ? Number($('#job-sel').value) : null;
    if (open && (open.job_id || null) === jobId) return msg('You are already on that job', 'err');
    if (!navigator.onLine) {
      enqueue('clock_in', { job_id: jobId });
      return msg('Saved on this phone — will sync when you have signal', 'ok');
    }
    try { const r = await api('portal/clock/in', 'POST', { job_id: jobId }); msg(r.message, 'ok'); pageHome(); }
    catch (e) { msg(e.message, 'err'); }
  };
  const outBtn = $('#btn-out');
  if (outBtn) outBtn.onclick = async () => {
    if (!navigator.onLine) {
      enqueue('clock_out', {});
      return msg('Clock-out saved on this phone — will sync when you have signal', 'ok');
    }
    try { const r = await api('portal/clock/out', 'POST', {}); msg(r.message, 'ok'); pageHome(); }
    catch (e) { msg(e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- Schedule
async function pageWeek() {
  const rows = await cachedApi('portal/schedule');
  const byDate = {};
  rows.forEach(r => { (byDate[r.date] ||= []).push(r); });
  const start = new Date(); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = [...Array(14)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });

  view.innerHTML = `<div class="pc"><h3>Your Next Two Weeks</h3>
    ${days.map(d => {
      const key = d.toISOString().slice(0, 10);
      const items = byDate[key] || [];
      return `<div class="day ${key === todayStr() ? 'today' : ''}">
        <div class="dd"><div class="dow">${d.toLocaleDateString([], { weekday: 'short' })}</div><div class="num">${d.getDate()}</div></div>
        <div style="flex:1">
          ${items.length ? items.map(s => `
            <div class="t">${esc(s.job_number ? s.job_number + ' — ' + s.job_title : s.notes || 'Shop work')}</div>
            <div class="s">${esc(s.shift)}${s.address ? ' · ' + esc(s.address) : ''}</div>`).join('')
            : '<div class="s">—</div>'}
        </div></div>`;
    }).join('')}</div>`;
}

// ---------------------------------------------------------------- My Hours
async function pageHours() {
  const rows = await cachedApi('portal/timesheet');
  const total = rows.reduce((s, r) => s + (r.hours || 0), 0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const thisWeek = rows.filter(r => r.clock_in.slice(0, 10) >= weekStart.toISOString().slice(0, 10))
    .reduce((s, r) => s + (r.hours || 0), 0);

  view.innerHTML = `
    <div class="hours-top">
      <div class="hstat"><div class="n">${Math.round(thisWeek * 10) / 10}</div><div class="l">This week</div></div>
      <div class="hstat"><div class="n">${Math.round(total * 10) / 10}</div><div class="l">Last 14 days</div></div>
    </div>
    <div class="pc"><h3>Your Punches</h3>
      ${rows.length ? rows.map(r => `
        <div class="tsrow">
          <div><div class="l1">${esc(r.job_number ? r.job_number + ' — ' + r.job_title : 'General shift')}</div>
          <div class="l2">${parseTs(r.clock_in).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmtTime(r.clock_in)} → ${r.clock_out ? fmtTime(r.clock_out) : 'now'}</div></div>
          <div class="hh ${r.clock_out ? '' : 'live'}">${r.hours !== null ? r.hours : '●'}</div>
        </div>`).join('') : '<div class="p-empty">No time recorded in the last two weeks.</div>'}
      <div class="p-empty" style="padding:14px 0 0;font-size:12.5px">Something look wrong? Tell the office — they can correct any punch.</div>
    </div>`;
}

// ---------------------------------------------------------------- My Work
function woTile(w) {
  const late = w.due_date && w.due_date < todayStr();
  return `<div class="wo ${esc(w.priority)} tappable" data-open="${w.id}">
    <div class="top">
      <span class="num">${esc(w.wo_number)}</span>
      <span class="tag t-${esc(w.priority)}">${esc(w.priority)}</span>
      <span class="tag t-${esc(w.status)}">${esc(cap(w.status))}</span>
      ${late ? '<span class="tag t-late">Past due</span>' : ''}
      ${w.plan_count ? `<span class="tag t-plans">📎 ${w.plan_count} plan${w.plan_count === 1 ? '' : 's'}</span>` : ''}
    </div>
    <div class="ttl">${esc(w.title)}</div>
    <div class="s" style="font-size:12.5px;color:var(--mist)">
      ${cap(w.wo_type)}${w.job_number ? ' · ' + esc(w.job_number) : ''}${w.due_date ? ' · due ' + esc(w.due_date) : ''}${!w.mine && w.assigned_name ? ' · ' + esc(w.assigned_name) : ''}
    </div>
    <div class="wo-open">Open build sheet →</div>
  </div>`;
}

async function pageWork() {
  const list = await cachedApi('portal/workorders');
  const mine = list.filter(w => w.mine);
  const shop = list.filter(w => !w.mine);
  view.innerHTML = `
    <div class="pc">
      <h3>Your Work<span class="r">${mine.length} open</span></h3>
      ${mine.length ? mine.map(woTile).join('') : '<div class="p-empty">Nothing assigned to you right now — pick something up from the shop queue below.</div>'}
    </div>

    ${shop.length ? `<div class="pc">
      <h3>Shop Queue<span class="r">${shop.length} more</span></h3>
      ${shop.map(woTile).join('')}
    </div>` : ''}

    <div class="pc">
      <h3>Shop Stock Lookup</h3>
      <input id="mat-q" placeholder="Search materials — e.g. plywood, breaker" style="margin-bottom:12px">
      <div id="mat-list"></div>
    </div>`;

  view.onclick = e => {
    const tile = e.target.closest('[data-open]');
    if (tile) location.hash = `#/work/${tile.dataset.open}`;
  };

  const materials = await cachedApi('portal/materials');
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

// ---------------------------------------------------------------- Build sheet
/** One work order, full screen: what to build, and the plans to build it from. */
async function pageWorkDetail(id) {
  const w = await cachedApi('portal/workorders/' + id);
  const late = w.due_date && w.due_date < todayStr();
  const planTile = (p, label) => `
    <a class="plan-tile" href="/uploads/${esc(p.filename)}" target="_blank" rel="noopener">
      ${p.mime === 'application/pdf'
        ? `<span class="plan-pdf">PDF</span>`
        : `<img src="/uploads/${esc(p.filename)}" alt="" loading="lazy">`}
      <span class="plan-cap">${esc(p.caption || p.original_name || label)}</span>
    </a>`;

  view.innerHTML = `
    <button class="back-link" id="wd-back">← Back to my work</button>

    <div class="pc build-head ${esc(w.priority)}">
      <div class="top">
        <span class="num">${esc(w.wo_number)}</span>
        <span class="tag t-${esc(w.priority)}">${esc(w.priority)}</span>
        <span class="tag t-${esc(w.status)}">${esc(cap(w.status))}</span>
        ${late ? '<span class="tag t-late">Past due</span>' : ''}
      </div>
      <h2>${esc(w.title)}</h2>
      <div class="build-meta">
        ${cap(w.wo_type)}${w.due_date ? ` · due <b>${esc(w.due_date)}</b>` : ''}${w.labor_hours ? ` · ${w.labor_hours} hrs estimated` : ''}
        ${w.job_number ? `<br>${esc(w.job_number)} — ${esc(w.job_title || '')}` : ''}
        ${w.client_name ? `<br>For ${esc(w.client_name)}` : ''}
        ${w.address ? `<br>${esc(w.address)}` : ''}
        ${w.assigned_name && !w.mine ? `<br>Assigned to ${esc(w.assigned_name)}` : ''}
      </div>
    </div>

    ${w.description ? `<div class="pc">
      <h3>What You're Building</h3>
      <div class="build-desc">${esc(w.description)}</div>
    </div>` : ''}

    ${w.build_list.length ? `<div class="pc">
      <h3>Cut / Material List</h3>
      ${w.build_list.map(i => `<div class="build-item">
        <span class="q">${esc(i.qty)}${i.unit ? ' ' + esc(i.unit) : ''}</span>
        <span class="d">${esc(i.desc)}</span>
      </div>`).join('')}
    </div>` : ''}

    ${w.plans.length ? `<div class="pc">
      <h3>Plans &amp; Photos<span class="r">tap to open full size</span></h3>
      <div class="plan-tiles">${w.plans.map(p => planTile(p, 'Plan')).join('')}</div>
    </div>` : ''}

    ${w.job_plans.length ? `<div class="pc">
      <h3>Job Plans<span class="r">from ${esc(w.job_number || 'the job')}</span></h3>
      <div class="plan-tiles">${w.job_plans.map(p => planTile(p, 'Job plan')).join('')}</div>
    </div>` : ''}

    ${!w.plans.length && !w.job_plans.length ? `<div class="pc">
      <h3>Plans &amp; Photos</h3>
      <div class="p-empty">No drawings attached yet. Ask the office to add them — they show up here automatically.</div>
    </div>` : ''}

    <div class="pc">
      <h3>Materials Used<span class="r">${w.usage.length} logged</span></h3>
      ${w.usage.length ? `<div class="used-list">
        ${w.usage.map(u => `<div class="used ${esc(u.kind)}">
          <span class="uq">${esc(u.qty)}<small>${esc(u.unit)}</small></span>
          <div class="ud">
            <div class="un">${esc([u.metal_type, u.gauge, u.size].filter(Boolean).join(' · ') || u.description)}</div>
            <div class="us">${esc(u.description)}${u.notes ? ' — ' + esc(u.notes) : ''}</div>
            <div class="us muted">${esc(u.employee_name || '')} · ${esc((u.logged_at || '').slice(5, 16))}</div>
          </div>
        </div>`).join('')}
      </div>` : '<div class="p-empty">Nothing logged yet.</div>'}
      <button class="big-btn dark" id="wd-log" style="margin-top:12px">+ Log Materials Used</button>
    </div>

    ${w.notes ? `<div class="pc"><h3>Shop Notes</h3><div class="build-desc">${esc(w.notes)}</div></div>` : ''}

    ${w.mine ? `<div class="pc">
      <h3>Update Status</h3>
      <div class="btn-row">
        ${w.status === 'open' ? '<button class="big-btn dark" id="wd-start">Start Work</button>' : ''}
        <button class="big-btn go" id="wd-done" ${w.status === 'open' ? '' : 'style="grid-column:1/-1"'}>Mark Complete</button>
      </div>
    </div>` : `<div class="pc"><div class="p-empty">This one is assigned to ${esc(w.assigned_name || 'someone else')}. You can read the plans, but they close it out.</div></div>`}`;

  $('#wd-back').onclick = () => { location.hash = '#/work'; };

  const update = async status => {
    if (!navigator.onLine) return msg('You need signal to update a work order', 'err');
    try {
      await api('portal/workorders/' + w.id, 'PUT', { status });
      msg(status === 'completed' ? 'Marked complete. Nice work.' : 'Started — the office can see it', 'ok');
      if (status === 'completed') location.hash = '#/work'; else pageWorkDetail(id);
    } catch (e) { msg(e.message, 'err'); }
  };
  const startBtn = $('#wd-start'); if (startBtn) startBtn.onclick = () => update('in_progress');
  const doneBtn = $('#wd-done'); if (doneBtn) doneBtn.onclick = () => update('completed');
  $('#wd-log').onclick = () => materialLogger({ work_order_id: w.id, label: w.wo_number, isFab: w.is_fab_shop, onDone: () => pageWorkDetail(id) });
}

// ---------------------------------------------------------------- logging what you used
const METAL_TYPES = ['Galvanized', 'Galvalume', 'Paint Grip', 'Stainless 304', 'Stainless 316',
  'Aluminum', 'Cold Rolled Steel', 'Hot Rolled Steel', 'Copper', 'Brass'];
const GAUGES = ['26 ga', '24 ga', '22 ga', '20 ga', '18 ga', '16 ga', '14 ga', '12 ga', '11 ga', '10 ga',
  '.032"', '.040"', '.050"', '.063"', '.080"', '.090"', '.125"', '3/16"', '1/4"'];
const SIZES = ['4x8 sheet', '4x10 sheet', '5x10 sheet', '3x10 sheet', 'Coil', '20ft stick', '24ft stick', 'Remnant'];
const UNITS = ['sheet', 'ea', 'lf', 'sqft', 'lb', 'stick', 'in'];

/**
 * The bench form. Metal lines carry type, gauge and size; solder is measured in
 * inches because that is how it comes off the bar.
 */
function materialLogger({ work_order_id = null, job_id = null, label = '', isFab = true, onDone }) {
  const lines = [];
  const stockPromise = cachedApi('portal/materials');

  const shell = document.createElement('div');
  shell.className = 'sheet';
  shell.innerHTML = `
    <div class="sheet-inner">
      <div class="sheet-head">
        <h2>Materials used${label ? ` — ${esc(label)}` : ''}</h2>
        <button class="sheet-x" id="ml-x">×</button>
      </div>
      <div class="sheet-body">
        ${isFab ? `
        <div class="fld"><label class="fldlabel">Add metal</label>
          <div class="ml-row">
            <select id="ml-type"><option value="">Metal…</option>${METAL_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
            <select id="ml-gauge"><option value="">Gauge…</option>${GAUGES.map(g => `<option>${g}</option>`).join('')}</select>
          </div>
          <div class="ml-row" style="margin-top:8px">
            <select id="ml-size"><option value="">Size…</option>${SIZES.map(z => `<option>${z}</option>`).join('')}</select>
            <input id="ml-qty" type="number" step="any" inputmode="decimal" placeholder="How many">
          </div>
          <button type="button" class="ml-add" id="ml-add-metal">+ Add this metal</button>
        </div>` : ''}

        <div class="fld"><label class="fldlabel">Or pull from the rack <span style="font-weight:500;text-transform:none;letter-spacing:0">(deducts from stock)</span></label>
          <select id="ml-stock"><option value="">Pick from inventory…</option></select>
          <div class="ml-row" style="margin-top:8px">
            <input id="ml-stock-qty" type="number" step="any" inputmode="decimal" placeholder="How many">
            <button type="button" class="ml-add" id="ml-add-stock" style="margin:0">+ Add</button>
          </div>
        </div>

        <div class="fld solder-box">
          <label class="fldlabel">Solder used</label>
          <div class="ml-row">
            <select id="ml-solder-type"><option value="">Which solder…</option></select>
            <div class="inches"><input id="ml-solder" type="number" step="any" inputmode="decimal" placeholder="0"><span>inches</span></div>
          </div>
          <button type="button" class="ml-add" id="ml-add-solder">+ Add solder</button>
        </div>

        <div class="fld"><label class="fldlabel">Note <span style="font-weight:500;text-transform:none;letter-spacing:0">(optional)</span></label>
          <input id="ml-note" placeholder="e.g. bucks 1-8, scrapped one sheet"></div>

        <h3 style="margin:6px 0 8px;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mist)">To be logged</h3>
        <div id="ml-list"><div class="p-empty" style="padding:14px">Nothing added yet.</div></div>
      </div>
      <div class="sheet-foot">
        <button class="big-btn go" id="ml-save">Log It</button>
      </div>
    </div>`;
  document.body.appendChild(shell);

  const close = () => shell.remove();
  $('#ml-x', shell).onclick = close;
  shell.onclick = e => { if (e.target === shell) close(); };

  function renderLines() {
    const box = $('#ml-list', shell);
    box.innerHTML = lines.length ? lines.map((l, i) => `
      <div class="used ${esc(l.kind)}">
        <span class="uq">${esc(l.qty)}<small>${esc(l.unit)}</small></span>
        <div class="ud"><div class="un">${esc([l.metal_type, l.gauge, l.size].filter(Boolean).join(' · ') || l.description)}</div>
        <div class="us">${esc(l.description)}</div></div>
        <button class="used-x" data-rm="${i}">×</button>
      </div>`).join('') : '<div class="p-empty" style="padding:14px">Nothing added yet.</div>';
    box.onclick = e => { if (e.target.dataset.rm !== undefined) { lines.splice(+e.target.dataset.rm, 1); renderLines(); } };
  }

  stockPromise.then(stock => {
    const solder = stock.filter(m => /solder/i.test(m.category) || /solder/i.test(m.name));
    const rest = stock.filter(m => !solder.includes(m));
    $('#ml-stock', shell).innerHTML = '<option value="">Pick from inventory…</option>' +
      rest.map(m => `<option value="${m.id}">${esc(m.name)} — ${m.qty_on_hand} ${esc(m.unit)} on hand</option>`).join('');
    $('#ml-solder-type', shell).innerHTML = '<option value="">Which solder…</option>' +
      solder.map(m => `<option value="${m.id}" data-unit="${esc(m.unit)}">${esc(m.name)}</option>`).join('');

    $('#ml-add-stock', shell).onclick = () => {
      const sel = $('#ml-stock', shell);
      const m = rest.find(x => x.id === +sel.value);
      const qty = Number($('#ml-stock-qty', shell).value);
      if (!m) return msg('Pick an item first', 'err');
      if (!(qty > 0)) return msg('How many did you use?', 'err');
      lines.push({ kind: 'metal', material_id: m.id, description: m.name, qty, unit: m.unit, client_ref: newRef() });
      sel.value = ''; $('#ml-stock-qty', shell).value = '';
      renderLines();
    };
    $('#ml-add-solder', shell).onclick = () => {
      const sel = $('#ml-solder-type', shell);
      const m = solder.find(x => x.id === +sel.value);
      const inches = Number($('#ml-solder', shell).value);
      if (!(inches > 0)) return msg('How many inches of solder?', 'err');
      lines.push({ kind: 'solder', material_id: m ? m.id : null, description: m ? m.name : 'Solder',
        gauge: '', unit: m ? m.unit : 'in', qty: inches, client_ref: newRef() });
      $('#ml-solder', shell).value = ''; sel.value = '';
      renderLines();
    };
  });

  const addMetal = $('#ml-add-metal', shell);
  if (addMetal) addMetal.onclick = () => {
    const type = $('#ml-type', shell).value, gauge = $('#ml-gauge', shell).value;
    const size = $('#ml-size', shell).value, qty = Number($('#ml-qty', shell).value);
    if (!type) return msg('Which metal did you use?', 'err');
    if (!(qty > 0)) return msg('How many did you use?', 'err');
    lines.push({ kind: 'metal', metal_type: type, gauge, size, qty,
      unit: /sheet/i.test(size) ? 'sheet' : /stick/i.test(size) ? 'stick' : 'ea',
      description: [type, gauge, size].filter(Boolean).join(' '), client_ref: newRef() });
    $('#ml-qty', shell).value = '';
    renderLines();
  };

  $('#ml-save', shell).onclick = async () => {
    if (!lines.length) return msg('Add what you used first', 'err');
    const note = $('#ml-note', shell).value.trim();
    const payload = { work_order_id, job_id, lines: lines.map(l => ({ ...l, notes: note })) };
    if (!navigator.onLine) {
      enqueue('material_usage', payload);
      close(); msg('Saved on this phone — will sync when you have signal', 'ok');
      return onDone && onDone();
    }
    try {
      const r = await api('portal/usage', 'POST', payload);
      close(); msg(r.message, 'ok');
      (r.warnings || []).forEach(w => msg(w, 'err'));
      onDone && onDone();
    } catch (e) { msg(e.message, 'err'); }
  };
}

// ---------------------------------------------------------------- Job Card
async function pageCard() {
  const d = await cachedApi('portal/summary');
  let mine = [];
  try { mine = await api('portal/jobcards'); } catch { /* offline */ }
  const queued = loadQueue().filter(op => op.type === 'job_card');

  view.innerHTML = `
    <div class="pc">
      <h3>Submit A Job Card</h3>
      <div class="fld"><label class="fldlabel">Job</label>
        <select id="c-job"><option value="">No specific job / shop</option>
          ${d.jobs.map(j => `<option value="${j.id}" ${d.today[0] && d.today[0].job_id === j.id ? 'selected' : ''}>${esc(j.job_number)} — ${esc(j.title)}</option>`).join('')}</select></div>
      <div class="fld"><label class="fldlabel">Date</label><input id="c-date" type="date" value="${todayStr()}"></div>
      <div class="fld"><label class="fldlabel">Hours worked</label><input id="c-hours" type="number" step="0.25" inputmode="decimal" value="8"></div>
      <div class="fld">
        <label class="fldlabel">Work performed</label>
        <textarea id="c-work" placeholder="What did you get done today?"></textarea>
        <button type="button" class="dictate" id="c-work-mic">🎤 Dictate</button>
      </div>
      <div class="fld"><label class="fldlabel">Materials used</label>
        <input id="c-mats" placeholder="e.g. 40 studs, 6 sheets plywood"></div>
      <div class="fld">
        <label class="fldlabel">Problems / delays <span style="font-weight:500;text-transform:none;letter-spacing:0">(optional)</span></label>
        <textarea id="c-issues" placeholder="Damage, extra scope, missing material — anything the office should price as a change order" style="min-height:64px"></textarea>
        <button type="button" class="dictate" id="c-issues-mic">🎤 Dictate</button>
      </div>
      <div class="fld">
        <label class="fldlabel">Photos</label>
        <label class="photo-drop" for="c-photos">
          <span class="cam">📷</span>
          <span>Take or choose photos</span>
          <small>Before / after, damage, anything worth proving later</small>
        </label>
        <input id="c-photos" type="file" accept="image/*" capture="environment" multiple hidden>
        <div class="thumbs" id="c-thumbs"></div>
      </div>
      <button class="big-btn dark" id="c-save">Submit To Office</button>
    </div>

    <div class="pc">
      <h3>Your Recent Cards</h3>
      ${queued.map(op => `
        <div class="assign">
          <span class="jn shop">QUEUED</span>
          <div style="flex:1"><div class="t">${esc(String(op.payload.work_performed || '').slice(0, 90))}</div>
          <div class="s">${esc(op.payload.work_date || '')} · ${op.payload.hours || 0} hrs <span class="tag t-open" style="margin-left:4px">Waiting for signal</span></div></div>
        </div>`).join('')}
      ${mine.length ? mine.map(c => `
        <div class="assign">
          <span class="jn ${c.job_number ? '' : 'shop'}">${esc(c.job_number || 'SHOP')}</span>
          <div style="flex:1">
            <div class="t">${esc(c.work_performed.slice(0, 90))}${c.work_performed.length > 90 ? '…' : ''}</div>
            <div class="s">${esc(c.work_date)} · ${c.hours} hrs <span class="tag t-${esc(c.status)}" style="margin-left:4px">${esc(cap(c.status))}</span></div>
            ${c.photos && c.photos.length ? `<div class="thumbs">${c.photos.map(p => `<a href="/uploads/${esc(p.filename)}" target="_blank"><img src="/uploads/${esc(p.filename)}" alt=""></a>`).join('')}</div>` : ''}
          </div>
        </div>`).join('') : (queued.length ? '' : '<div class="p-empty">No job cards submitted yet.</div>')}
    </div>`;

  attachDictation($('#c-work-mic'), $('#c-work'));
  attachDictation($('#c-issues-mic'), $('#c-issues'));

  let picked = [];
  $('#c-photos').onchange = e => {
    picked = [...e.target.files];
    $('#c-thumbs').innerHTML = picked.map(f => `<div class="thumb-pending">${esc(f.name.slice(0, 14))}</div>`).join('');
    picked.forEach((f, i) => {
      const reader = new FileReader();
      reader.onload = ev => {
        const el = $$('#c-thumbs .thumb-pending')[i];
        if (el) el.outerHTML = `<img src="${ev.target.result}" alt="">`;
      };
      reader.readAsDataURL(f);
    });
  };

  $('#c-save').onclick = async () => {
    const work = $('#c-work').value.trim();
    if (!work) return msg('Tell us what work you performed', 'err');
    const payload = {
      job_id: $('#c-job').value ? Number($('#c-job').value) : null,
      work_date: $('#c-date').value, hours: Number($('#c-hours').value) || 0,
      work_performed: work, materials_used: $('#c-mats').value.trim(), issues: $('#c-issues').value.trim(),
    };
    if (!navigator.onLine) {
      enqueue('job_card', payload);
      msg(picked.length ? 'Card saved on this phone — photos need signal, add them when you are back online' : 'Card saved on this phone — will sync when you have signal', 'ok');
      return pageCard();
    }
    const btn = $('#c-save'); btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      const r = await api('portal/jobcards', 'POST', payload);
      if (picked.length && r.id) {
        btn.textContent = `Uploading ${picked.length} photo${picked.length === 1 ? '' : 's'}…`;
        try { await uploadPhotos(r.id, picked); } catch (e) { msg('Card saved, but photos failed: ' + e.message, 'err'); }
      }
      msg(r.message, 'ok');
      pageCard();
    } catch (e) {
      msg(e.message, 'err');
      btn.disabled = false; btn.textContent = 'Submit To Office';
    }
  };
}

// ---------------------------------------------------------------- router
const TABS = { home: pageHome, week: pageWeek, hours: pageHours, work: pageWork, card: pageCard };

async function route() {
  const [tab, param] = (location.hash.replace(/^#\//, '') || 'home').split('/');
  $$('.p-tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  view.innerHTML = '<div class="p-empty">Loading…</div>';
  try {
    if (tab === 'work' && param) await pageWorkDetail(param);
    else await (TABS[tab] || pageHome)();
  }
  catch (e) { view.innerHTML = `<div class="p-empty">⚠ ${esc(e.message)}<br><br>${navigator.onLine ? '' : 'You are offline — clock in and job cards still work from the Today tab.'}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

$('#p-logout').onclick = async () => {
  if (loadQueue().length && !confirm('You have entries that have not synced yet. Sign out anyway?')) return;
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async () => {
  try {
    me = await api('auth/me');
    localStorage.setItem('dts_me', JSON.stringify(me));
  } catch {
    const cached = localStorage.getItem('dts_me');
    if (!cached) return;
    me = JSON.parse(cached);   // offline: trust the cached identity for display only
  }
  $('#p-who').textContent = me.name;
  $('#p-role').textContent = me.employee_role || 'Crew Portal';
  renderQueueBadge();
  await drainQueue(true);
  route();
  setInterval(() => drainQueue(true), 60000);
})();
