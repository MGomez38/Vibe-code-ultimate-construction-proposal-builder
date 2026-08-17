/**
 * Database layer — uses Node's built-in SQLite (node:sqlite), zero dependencies.
 * Creates schema on first run and seeds realistic demo data so every module
 * is populated out of the box. Data persists in data/dts.db.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dts.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------- schema
require('./lib/schema').create(db);

// ---------------------------------------------------------------- helpers
function iso(d) { return d.toISOString().replace('T', ' ').slice(0, 19); }
function daysAgo(n, h = 8, m = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return iso(d);
}
function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- seed
const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'seeded'`).get();
if (!seeded) {
  const tx = () => {
    const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    const defaults = {
      company_name: 'Diverse Trade Services',
      company_address: '4820 Industrial Parkway, Fairview',
      company_phone: '(555) 100-0000',
      company_email: 'office@diversetradeservices.net',
      company_website: 'diversetradeservices.net',
      default_labor_rate: '65',
      target_margin_pct: '30',
      default_tax_pct: '7.25',
      quote_terms: 'Prices valid for 30 days from the date of this proposal. 40% deposit due at contract signing, balance due on completion. Work performed during standard business hours unless otherwise noted. Any change in scope will be quoted as a written change order before work proceeds.',
      app_base_url: 'http://localhost:3000',
      mail_from: 'Diverse Trade Services <office@diversetradeservices.net>',
      smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_secure: '0',
      payment_link_url: '', payment_instructions: 'Checks payable to Diverse Trade Services. Reference the invoice number on your payment.',
      stripe_webhook_secret: '', cash_on_hand: '0',
    };
    for (const [k, v] of Object.entries(defaults)) setSetting.run(k, v);

    const insClient = db.prepare(`INSERT INTO clients (name, contact, phone, email, address) VALUES (?,?,?,?,?)`);
    const clients = [
      ['Summit Property Group', 'Dana Reyes', '555-201-3348', 'dana@summitpg.com', '4120 Commerce Blvd, Suite 210'],
      ['Ironwood Builders', 'Marcus Cole', '555-887-1290', 'mcole@ironwoodbuild.com', '77 Foundry Row'],
      ['Lakeside HOA', 'Priya Natarajan', '555-443-9021', 'board@lakesidehoa.org', '900 Lakeside Dr'],
      ['Redline Logistics', 'Tom Brannigan', '555-310-4477', 'tbrannigan@redlinelog.com', '2 Distribution Way'],
      ['City of Fairview', 'Angela Whitfield', '555-772-6103', 'awhitfield@fairview.gov', '1 Civic Center Plaza'],
    ];
    clients.forEach(c => insClient.run(...c));

    const insEmp = db.prepare(`INSERT INTO employees (name, role, phone, hourly_rate, pin) VALUES (?,?,?,?,?)`);
    const employees = [
      ['Mike Gomez', 'Owner / PM', '555-100-0001', 55, '1111'],
      ['Carlos Vega', 'Foreman', '555-100-0002', 42, '2222'],
      ['Jess Tran', 'Lead Carpenter', '555-100-0003', 38, '3333'],
      ['Andre Willis', 'Electrician', '555-100-0004', 45, '4444'],
      ['Sam Ortiz', 'Shop Fabricator', '555-100-0005', 34, '5555'],
      ['Kayla Burke', 'Apprentice', '555-100-0006', 24, '6666'],
    ];
    employees.forEach(e => insEmp.run(...e));

    const insMat = db.prepare(`INSERT INTO materials (sku, name, category, unit, qty_on_hand, reorder_point, unit_cost, sell_price, location, vendor) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const materials = [
      ['LUM-2X4-8', '2x4 Stud 8ft SPF', 'Lumber', 'ea', 240, 100, 3.85, 6.5, 'Rack A1', 'Fairview Lumber Co'],
      ['LUM-2X6-10', '2x6 #2 Pine 10ft', 'Lumber', 'ea', 88, 60, 7.2, 11.75, 'Rack A2', 'Fairview Lumber Co'],
      ['PLY-CDX-34', 'CDX Plywood 3/4" 4x8', 'Sheet Goods', 'sheet', 34, 25, 42.5, 68, 'Rack B1', 'Fairview Lumber Co'],
      ['DRY-58-4X8', 'Drywall 5/8" 4x8', 'Sheet Goods', 'sheet', 52, 40, 13.9, 22, 'Rack B3', 'BuildRight Supply'],
      ['CON-80LB', 'Concrete Mix 80lb', 'Concrete', 'bag', 96, 50, 6.15, 9.5, 'Yard Bay 2', 'BuildRight Supply'],
      ['REB-4-20', 'Rebar #4 20ft', 'Concrete', 'ea', 140, 80, 8.9, 14, 'Yard Bay 3', 'SteelServ'],
      ['ELC-12-2-250', 'Romex 12/2 250ft Roll', 'Electrical', 'roll', 9, 6, 118, 172, 'Cage C1', 'Volt Supply'],
      ['ELC-BRK-20A', '20A Breaker', 'Electrical', 'ea', 31, 20, 11.4, 19.5, 'Cage C2', 'Volt Supply'],
      ['PLB-PEX-12', 'PEX 1/2" 100ft', 'Plumbing', 'roll', 12, 8, 38, 61, 'Cage D1', 'FlowMaster'],
      ['FST-SCR-3', 'Deck Screws 3" 5lb', 'Fasteners', 'box', 44, 30, 21, 33, 'Shelf E2', 'BuildRight Supply'],
      ['PNT-INT-5G', 'Interior Paint 5gal', 'Finishes', 'pail', 14, 10, 92, 145, 'Shelf F1', 'ColorPro'],
      ['STL-ANG-2', 'Steel Angle 2x2x1/4 20ft', 'Steel', 'ea', 26, 15, 31.5, 52, 'Steel Rack 1', 'SteelServ'],
      ['STL-TUB-2', 'Steel Tube 2x2x11ga 24ft', 'Steel', 'ea', 4, 12, 44.8, 74, 'Steel Rack 2', 'SteelServ'],
      ['INS-R13', 'Insulation R-13 Roll', 'Insulation', 'roll', 18, 15, 54, 84, 'Rack B4', 'BuildRight Supply'],
    ];
    materials.forEach(m => insMat.run(...m));

    const insQuote = db.prepare(`INSERT INTO quotes (quote_number, client_id, title, description, items, labor_hours, labor_rate, markup_pct, tax_pct, status, valid_until, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insQuote.run('Q-1041', 1, 'Warehouse Mezzanine Framing', 'Frame and deck 1,200 sqft storage mezzanine.',
      JSON.stringify([
        { desc: 'Steel Tube 2x2x11ga 24ft', qty: 22, unit: 'ea', unit_cost: 44.8, unit_price: 74 },
        { desc: 'CDX Plywood 3/4" 4x8', qty: 38, unit: 'sheet', unit_cost: 42.5, unit_price: 68 },
        { desc: 'Deck Screws 3" 5lb', qty: 6, unit: 'box', unit_cost: 21, unit_price: 33 },
      ]), 120, 65, 10, 7.25, 'sent', dateStr(21), daysAgo(6));
    insQuote.run('Q-1042', 3, 'Clubhouse Deck Rebuild', 'Demo and rebuild 640 sqft composite deck with new railing.',
      JSON.stringify([
        { desc: 'Composite Decking 16ft', qty: 58, unit: 'ea', unit_cost: 41, unit_price: 62 },
        { desc: '2x6 #2 Pine 10ft (framing)', qty: 40, unit: 'ea', unit_cost: 7.2, unit_price: 11.75 },
        { desc: 'Railing Kit 8ft', qty: 11, unit: 'kit', unit_cost: 96, unit_price: 149 },
      ]), 96, 65, 12, 7.25, 'accepted', dateStr(14), daysAgo(12));
    insQuote.run('Q-1043', 4, 'Dock Door Bollards', 'Supply and set 8 concrete-filled bollards at dock doors.',
      JSON.stringify([
        { desc: 'Bollard 6" Sch40 8ft', qty: 8, unit: 'ea', unit_cost: 88, unit_price: 140 },
        { desc: 'Concrete Mix 80lb', qty: 24, unit: 'bag', unit_cost: 6.15, unit_price: 9.5 },
      ]), 20, 65, 15, 7.25, 'draft', dateStr(30), daysAgo(2));

    const insJob = db.prepare(`INSERT INTO jobs (job_number, client_id, quote_id, title, description, address, status, sold_price, start_date, foreman_id, created_at, completed_at, end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Active jobs
    insJob.run('J-2308', 2, null, 'Ironwood Office Buildout', 'Interior buildout: framing, drywall, paint, electrical rough-in for 3,800 sqft office.', '77 Foundry Row', 'in_progress', 48500, dateStr(-9), 2, daysAgo(10), null, '');
    insJob.run('J-2309', 3, 2, 'Clubhouse Deck Rebuild', 'Demo and rebuild 640 sqft composite deck with new railing.', '900 Lakeside Dr', 'in_progress', 14980, dateStr(-3), 3, daysAgo(4), null, '');
    insJob.run('J-2310', 5, null, 'Fairview Park Pavilion Repairs', 'Structural post replacement and new roof sheathing on park pavilion.', '1 Civic Center Plaza', 'planned', 9200, dateStr(4), 2, daysAgo(3), null, '');
    // Completed historical jobs
    insJob.run('J-2301', 1, null, 'Suite 210 Tenant Improvement', 'Full TI: demising walls, ceiling grid, doors and hardware.', '4120 Commerce Blvd', 'completed', 62400, dateStr(-88), 2, daysAgo(90), daysAgo(61), dateStr(-61));
    insJob.run('J-2304', 4, null, 'Warehouse Guard Rail Install', 'Install 240ft of safety guard rail in distribution warehouse.', '2 Distribution Way', 'completed', 18750, dateStr(-55), 3, daysAgo(58), daysAgo(47), dateStr(-47));

    const insJobMat = db.prepare(`INSERT INTO job_materials (job_id, material_id, description, qty, unit_cost) VALUES (?,?,?,?,?)`);
    insJobMat.run(1, 1, '2x4 Stud 8ft SPF', 160, 3.85);
    insJobMat.run(1, 4, 'Drywall 5/8" 4x8', 110, 13.9);
    insJobMat.run(1, 7, 'Romex 12/2 250ft Roll', 3, 118);
    insJobMat.run(2, 2, '2x6 #2 Pine 10ft', 40, 7.2);
    insJobMat.run(2, 10, 'Deck Screws 3" 5lb', 4, 21);
    insJobMat.run(4, null, 'Metal studs, drywall, ceiling grid & finishes package', 1, 24000);
    insJobMat.run(4, null, 'Electrical & data subcontract', 1, 6500);
    insJobMat.run(5, null, 'Guard rail sections & hardware', 240, 37);

    const insWO = db.prepare(`INSERT INTO work_orders (wo_number, job_id, client_id, title, description, wo_type, priority, status, assigned_to, due_date, items, labor_hours, labor_rate, sold_price, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Open shop work orders
    insWO.run('WO-5121', 1, 2, 'Fab 12 window bucks', 'Fabricate 12 steel window bucks per drawing A-301 for Ironwood buildout.', 'Fabrication', 'high', 'in_progress', 5, dateStr(2),
      JSON.stringify([{ desc: 'Steel Angle 2x2x1/4 20ft', qty: 9, unit_cost: 31.5, unit_price: 52 }]), 26, 65, 2400, daysAgo(5), null);
    insWO.run('WO-5122', 2, 3, 'Railing panel welding', 'Weld 11 railing panels for clubhouse deck; powder-coat black.', 'Fabrication', 'normal', 'open', 5, dateStr(6),
      JSON.stringify([{ desc: 'Railing Kit 8ft components', qty: 11, unit_cost: 96, unit_price: 149 }]), 30, 65, 3900, daysAgo(2), null);
    insWO.run('WO-5123', null, 4, 'Forklift cage repair', 'Straighten and reinforce damaged pallet cage from Redline warehouse.', 'Repair', 'rush', 'open', 5, dateStr(1),
      JSON.stringify([{ desc: 'Steel Tube 2x2x11ga 24ft', qty: 2, unit_cost: 44.8, unit_price: 74 }]), 8, 65, 950, daysAgo(1), null);
    // Historical / archived work orders (the searchable profit history)
    insWO.run('WO-5098', 4, 1, 'Suite 210 door frames', 'Fabricate and hang 9 HM door frames with hardware.', 'Shop', 'normal', 'archived', 5, dateStr(-70),
      JSON.stringify([{ desc: 'HM Door Frame 3070', qty: 9, unit_cost: 148, unit_price: 245 }, { desc: 'Commercial Lockset', qty: 9, unit_cost: 86, unit_price: 139 }]), 34, 60, 5800, daysAgo(78), daysAgo(66));
    insWO.run('WO-5104', 5, 4, 'Guard rail post fab', 'Cut, drill and paint 62 guard rail posts.', 'Fabrication', 'normal', 'archived', 5, dateStr(-52),
      JSON.stringify([{ desc: 'Steel Tube 2x2x11ga 24ft', qty: 18, unit_cost: 42, unit_price: 71 }, { desc: 'Base Plate 6x6x3/8', qty: 62, unit_cost: 9.8, unit_price: 17 }]), 41, 60, 4950, daysAgo(60), daysAgo(50));
    insWO.run('WO-5110', null, 3, 'Pool gate rebuild', 'Rebuild corroded pool gate, new hinges and latch, powder-coat.', 'Repair', 'normal', 'archived', 5, dateStr(-33),
      JSON.stringify([{ desc: 'Aluminum Tube 1.5" 24ft', qty: 4, unit_cost: 39, unit_price: 66 }, { desc: 'Self-closing Hinge Set', qty: 1, unit_cost: 74, unit_price: 120 }]), 12, 60, 1450, daysAgo(40), daysAgo(33));
    insWO.run('WO-5115', null, 5, 'Park bench frames (x6)', 'Fabricate 6 steel park bench frames for Fairview Parks Dept.', 'Fabrication', 'low', 'archived', 5, dateStr(-20),
      JSON.stringify([{ desc: 'Steel Angle 2x2x1/4 20ft', qty: 12, unit_cost: 31.5, unit_price: 52 }, { desc: 'Powder Coat (per frame)', qty: 6, unit_cost: 35, unit_price: 60 }]), 28, 60, 3100, daysAgo(30), daysAgo(21));

    const insPO = db.prepare(`INSERT INTO purchase_orders (po_number, vendor, status, items, job_id, expected_date, ordered_at, received_at, notes) VALUES (?,?,?,?,?,?,?,?,?)`);
    insPO.run('PO-3021', 'SteelServ', 'ordered',
      JSON.stringify([{ material_id: 13, desc: 'Steel Tube 2x2x11ga 24ft', qty: 30, unit_cost: 44.8 }]),
      null, dateStr(3), daysAgo(2), null, 'Restock for WO-5121/5122 + shop stock.');
    insPO.run('PO-3022', 'Volt Supply', 'ordered',
      JSON.stringify([{ material_id: 7, desc: 'Romex 12/2 250ft Roll', qty: 8, unit_cost: 116 }, { material_id: 8, desc: '20A Breaker', qty: 20, unit_cost: 11.1 }]),
      1, dateStr(2), daysAgo(1), null, 'Ironwood electrical rough-in.');
    insPO.run('PO-3018', 'Fairview Lumber Co', 'received',
      JSON.stringify([{ material_id: 3, desc: 'CDX Plywood 3/4" 4x8', qty: 40, unit_cost: 41.9 }]),
      null, dateStr(-6), daysAgo(9), daysAgo(5), '');

    const insSched = db.prepare(`INSERT INTO schedule (employee_id, job_id, date, shift, notes) VALUES (?,?,?,?,?)`);
    const weekday = (weekOffset, dayIndex) => {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weekOffset * 7 + dayIndex);
      return d.toISOString().slice(0, 10);
    };
    // this week — buildout and deck rebuild, comfortably staffed
    for (let d = 0; d < 5; d++) {
      insSched.run(2, 1, weekday(0, d), 'Full day', d === 0 ? 'Drywall inspection 9am' : '');
      insSched.run(3, 2, weekday(0, d), 'Full day', d === 0 ? 'Deck framing' : '');
      insSched.run(6, 2, weekday(0, d), 'Full day', 'Helper');
      insSched.run(5, null, weekday(0, d), 'Full day', d === 1 ? 'Shop — WO-5123 rush' : 'Shop — WO-5121');
    }
    insSched.run(4, 1, weekday(0, 1), 'AM', 'Rough-in inspection prep');
    // next week is oversold: the pavilion job was promised to crew already committed
    // to the buildout — exactly the situation the capacity warning exists to catch
    for (let d = 0; d < 5; d++) {
      insSched.run(1, 3, weekday(1, d), 'Full day', 'Pavilion supervision');
      insSched.run(2, 1, weekday(1, d), 'Full day', '');
      insSched.run(3, 1, weekday(1, d), 'Full day', '');
      insSched.run(4, 1, weekday(1, d), 'Full day', '');
      insSched.run(5, null, weekday(1, d), 'Full day', 'Shop');
      insSched.run(6, 2, weekday(1, d), 'Full day', '');
    }
    insSched.run(2, 3, weekday(1, 0), 'Full day', 'Pavilion post replacement');
    insSched.run(3, 3, weekday(1, 1), 'Full day', 'Pavilion roof sheathing');

    const insTime = db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, clock_out, notes) VALUES (?,?,?,?,?,?)`);
    // historical hours on completed jobs — real crews over real workdays, so
    // job costing, payroll and estimate-vs-actual all have something to chew on
    const punch = (emp, job, ago, startH, hours) => {
      const inT = daysAgo(ago, startH);
      const out = new Date(inT.replace(' ', 'T') + 'Z');
      out.setTime(out.getTime() + hours * 3600e3);
      insTime.run(emp, job, 'job', inT, iso(out), '');
    };
    const seedRun = (jobId, crew, startAgo, workdays) => {
      let placed = 0;
      for (let d = 0; placed < workdays && d < workdays * 2; d++) {
        const ago = startAgo - d;
        const dow = new Date(Date.now() - ago * 864e5).getDay();
        if (dow === 0 || dow === 6) continue;      // crews are off weekends
        for (const emp of crew) punch(emp, jobId, ago, 7, d % 5 === 4 ? 6.5 : 8);
        placed++;
      }
    };
    seedRun(4, [2, 3, 6], 87, 18);   // Suite 210 tenant improvement
    seedRun(5, [3, 6], 56, 9);       // warehouse guard rail install
    // recent hours on active jobs
    const recentEntries = [
      [2, 1, 3, 7, 9], [3, 1, 3, 7, 8.5], [2, 1, 2, 7, 9], [4, 1, 2, 8, 6],
      [3, 2, 2, 7, 8], [6, 2, 2, 7, 8], [3, 2, 1, 7, 8.5], [6, 2, 1, 7, 8],
      [5, null, 1, 7, 8],
    ];
    for (const [emp, job, ago, startH, hours] of recentEntries) {
      const inT = daysAgo(ago, startH);
      const out = new Date(inT.replace(' ', 'T') + 'Z');
      out.setTime(out.getTime() + hours * 3600e3);
      insTime.run(emp, job, job ? 'job' : 'shift', inT, iso(out), '');
    }

    // user accounts — one admin (owner) plus a crew login per field employee
    const insUser = db.prepare(`INSERT INTO users (username, password_hash, role, employee_id) VALUES (?,?,?,?)`);
    const { hashPassword } = require('./auth');
    const accounts = [
      ['mike', 'admin123', 'admin', 1],
      ['carlos', 'crew123', 'crew', 2],
      ['jess', 'crew123', 'crew', 3],
      ['andre', 'crew123', 'crew', 4],
      ['sam', 'crew123', 'crew', 5],
      ['kayla', 'crew123', 'crew', 6],
    ];
    accounts.forEach(([u, p, r, e]) => insUser.run(u, hashPassword(p), r, e));

    // a couple of submitted field job cards awaiting office approval
    const insCard = db.prepare(`INSERT INTO job_cards (job_id, employee_id, work_date, hours, work_performed, materials_used, issues, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
    insCard.run(1, 2, dateStr(-1), 9, 'Framed north and east demising walls, set door bucks for offices 3-6.', '48 studs, 2 boxes screws', '', 'submitted', daysAgo(1, 16));
    insCard.run(2, 3, dateStr(-1), 8.5, 'Demo of old deck complete, hauled debris. Started ledger and footings layout.', 'Dumpster pull #2', 'Two footings hit buried irrigation line — client notified, may need a change order.', 'submitted', daysAgo(1, 17));

    // trade classifications + estimated hours, so estimate-vs-actual has something to learn from
    const classify = db.prepare('UPDATE employees SET classification = ?, fringe_rate = ? WHERE id = ?');
    [[1, 'Supervisor', 0], [2, 'Carpenter Foreman', 12.4], [3, 'Carpenter', 12.4],
     [4, 'Electrician', 15.8], [5, 'Ironworker', 14.1], [6, 'Laborer', 9.7]]
      .forEach(([id, c, f]) => classify.run(c, f, id));
    // City of Fairview work is public — flag it for certified payroll
    db.prepare(`UPDATE jobs SET prevailing_wage = 1 WHERE client_id = 5`).run();
    // Estimated hours on open jobs are the bid numbers. On completed jobs they are
    // derived from what was actually clocked, so the demo shows a realistic pattern:
    // this company bids labor about 12% light.
    const estHours = db.prepare('UPDATE jobs SET est_labor_hours = ? WHERE id = ?');
    [[1, 340], [2, 96], [3, 80]].forEach(([id, h]) => estHours.run(h, id));
    for (const [id, overrun] of [[4, 1.14], [5, 1.09]]) {
      const actual = db.prepare(`SELECT COALESCE(SUM((julianday(clock_out) - julianday(clock_in)) * 24), 0) h
        FROM time_entries WHERE job_id = ? AND clock_out IS NOT NULL`).get(id).h;
      estHours.run(Math.round(actual / overrun), id);
    }

    const insSub = db.prepare(`INSERT INTO subcontractors (name, trade, contact, phone, email, license_number) VALUES (?,?,?,?,?,?)`);
    [['Copper Creek Plumbing', 'Plumbing', 'Ray Whitaker', '555-620-1180', 'ray@coppercreekplumbing.com', 'PL-44821'],
     ['Vertex Electrical', 'Electrical', 'Nina Alvarado', '555-771-3390', 'nina@vertexelec.com', 'EC-90244'],
     ['Bluepeak Roofing', 'Roofing', 'Owen Doyle', '555-448-2019', 'owen@bluepeakroof.com', 'RF-11208'],
     ['Granite State Concrete', 'Concrete / Flatwork', 'Hector Salas', '555-993-4471', 'hector@granitestateconcrete.com', 'CN-30177']]
      .forEach(s => insSub.run(...s));

    const insDoc = db.prepare(`INSERT INTO sub_documents (sub_id, doc_type, carrier, policy_number, issued_on, expires_on, notes) VALUES (?,?,?,?,?,?,?)`);
    insDoc.run(1, 'COI', 'Hartford', 'GL-8842190', dateStr(-300), dateStr(64), '');
    insDoc.run(1, 'W-9', '', '', dateStr(-300), '', 'On file');
    insDoc.run(2, 'COI', 'Travelers', 'GL-2214887', dateStr(-350), dateStr(12), 'Renewal requested — follow up');
    insDoc.run(3, 'COI', 'Liberty Mutual', 'GL-7781234', dateStr(-400), dateStr(-9), 'EXPIRED — do not schedule until renewed');
    insDoc.run(4, 'COI', 'Nationwide', 'GL-5590021', dateStr(-120), dateStr(240), '');
    insDoc.run(4, 'License', '', 'CN-30177', dateStr(-500), dateStr(180), '');

    db.prepare(`INSERT INTO job_subs (job_id, sub_id, scope, contract_amount) VALUES (?,?,?,?)`)
      .run(1, 2, 'Electrical rough-in and device trim, 3,800 sqft office', 11400);

    // an approved change order on the buildout, and one waiting on the client
    const insCO = db.prepare(`INSERT INTO change_orders (co_number, job_id, client_id, title, description, reason, items, labor_hours, labor_rate, markup_pct, tax_pct, schedule_days, status, responded_at, client_signature, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insCO.run('CO-1', 1, 2, 'Add two glass office fronts', 'Client elected to upgrade offices 3 and 4 to full-height glass fronts in lieu of drywall partitions.',
      'client request', JSON.stringify([{ desc: 'Glass office front system', qty: 2, unit: 'ea', unit_cost: 2850, unit_price: 4400 }]),
      24, 65, 10, 7.25, 4, 'approved', daysAgo(4, 14), 'Marcus Cole', daysAgo(6, 9));
    insCO.run('CO-2', 2, 3, 'Reroute irrigation line at footings', 'Two deck footings intersect an undocumented irrigation main. Cap, reroute and re-inspect before pour.',
      'unforeseen condition', JSON.stringify([{ desc: 'Irrigation reroute materials', qty: 1, unit: 'ls', unit_cost: 310, unit_price: 520 }]),
      10, 65, 10, 7.25, 2, 'sent', null, '', daysAgo(1, 15));

    const insInv = db.prepare(`INSERT INTO invoices (invoice_number, job_id, client_id, invoice_type, description, items, tax_pct, retainage_pct, status, issue_date, due_date, terms_days, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // Ironwood buildout — deposit paid, first progress bill outstanding
    insInv.run('INV-1001', 1, 2, 'deposit', 'Contract deposit — 40% at signing',
      JSON.stringify([{ desc: 'Deposit, 40% of contract', qty: 1, unit: 'ls', unit_price: 19400 }]), 0, 0, 'sent', dateStr(-9), dateStr(-9), 0, daysAgo(9, 10), daysAgo(9, 10));
    insInv.run('INV-1002', 1, 2, 'progress', 'Progress billing #1 — framing and rough-in complete (45%)',
      JSON.stringify([{ desc: 'Work completed to date, 45% of contract', qty: 1, unit: 'ls', unit_price: 21825 },
                      { desc: 'Approved CO-1 — glass office fronts', qty: 1, unit: 'ls', unit_price: 4400 }]), 0, 10, 'sent', dateStr(-38), dateStr(-8), 30, daysAgo(38, 11), daysAgo(38, 11));
    // Completed TI — paid in full
    insInv.run('INV-0994', 4, 1, 'final', 'Final billing — Suite 210 tenant improvement',
      JSON.stringify([{ desc: 'Contract balance', qty: 1, unit: 'ls', unit_price: 24960 }]), 0, 0, 'paid', dateStr(-60), dateStr(-30), 30, daysAgo(60, 10), daysAgo(60, 10));
    // Guard rail — overdue
    insInv.run('INV-0998', 5, 4, 'final', 'Final billing — warehouse guard rail install',
      JSON.stringify([{ desc: 'Contract total', qty: 1, unit: 'ls', unit_price: 18750 }]), 0, 0, 'sent', dateStr(-47), dateStr(-17), 30, daysAgo(47, 9), daysAgo(47, 9));

    const insPay = db.prepare(`INSERT INTO payments (invoice_id, amount, method, reference, received_on, notes) VALUES (?,?,?,?,?,?)`);
    insPay.run(1, 19400, 'check', '#48221', dateStr(-7), 'Deposit received');
    insPay.run(3, 24960, 'ach', 'ACH-99120', dateStr(-34), '');
    insPay.run(4, 9000, 'check', '#7742', dateStr(-20), 'Partial — balance promised end of month');

    db.prepare(`INSERT INTO settings (key, value) VALUES ('default_retainage_pct', '10')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('payment_terms_days', '30')`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('seeded', '1')`).run();
  };
  db.exec('BEGIN');
  try { tx(); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = db;
