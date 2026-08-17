/**
 * Demo data for the group: two legal entities that work hand in hand.
 *
 *   All Spec Sheetmetal (AS)  — the fabrication shop. Builds steel and sheet
 *                               metal, both for DTS and for outside customers.
 *   Diverse Trade Services (DTS) — construction and installation. Wins the job,
 *                               installs what All Spec builds.
 *
 * The interesting case is the middle: DTS wins a buildout, raises fab work to
 * All Spec, All Spec builds and invoices DTS, DTS installs and invoices the
 * customer. That single flow is revenue for All Spec, cost for DTS, and only
 * the customer's money is real at group level.
 */
'use strict';

const { hashPassword } = require('../auth');

const iso = d => d.toISOString().replace('T', ' ').slice(0, 19);
function daysAgo(n, h = 8, m = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return iso(d);
}
function dateStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function weekday(weekOffset, dayIndex) {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + weekOffset * 7 + dayIndex);
  return d.toISOString().slice(0, 10);
}

module.exports = function seed(db) {
  // ---------------------------------------------------------------- entities
  const insCompany = db.prepare(`INSERT INTO companies
    (code, name, legal_name, kind, tagline, address, phone, email, website, license_number, accent,
     default_labor_rate, target_margin_pct, default_tax_pct, default_retainage_pct, payment_terms_days,
     quote_terms, payment_instructions, mail_from, cash_on_hand)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const AS = insCompany.run('AS', 'All Spec Sheetmetal', 'All Spec Sheetmetal LLC', 'fabrication',
    'Sheet Metal & Iron Fabrication', '1180 Foundry Road, Bay 4, Fairview', '(555) 100-0140',
    'shop@allspecsheetmetal.com', 'allspecsheetmetal.com', 'FAB-22841', '#3b7dd8',
    72, 35, 7.25, 0, 30,
    'Shop drawings to be approved before fabrication begins. Prices assume material costs at time of quote; steel pricing subject to mill increases. Fabrication only — field installation quoted separately.',
    'Checks payable to All Spec Sheetmetal LLC. Reference the invoice number on your payment.',
    'All Spec Sheetmetal <shop@allspecsheetmetal.com>', 41000).lastInsertRowid;

  const DTS = insCompany.run('DTS', 'Diverse Trade Services', 'Diverse Trade Services LLC', 'construction',
    'General Construction & Installation', '4820 Industrial Parkway, Fairview', '(555) 100-0000',
    'office@diversetradeservices.net', 'diversetradeservices.net', 'GC-118420', '#f5a524',
    65, 30, 7.25, 10, 30,
    'Prices valid for 30 days from the date of this proposal. 40% deposit due at contract signing, balance due on completion. Work performed during standard business hours unless otherwise noted. Any change in scope will be quoted as a written change order before work proceeds.',
    'Checks payable to Diverse Trade Services LLC. Reference the invoice number on your payment.',
    'Diverse Trade Services <office@diversetradeservices.net>', 63000).lastInsertRowid;

  // system-wide settings — these are not per entity
  const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  for (const [k, v] of Object.entries({
    group_name: 'All Spec / DTS Group',
    app_base_url: 'http://localhost:3000',
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', smtp_secure: '0',
    stripe_webhook_secret: '',
  })) setSetting.run(k, v);

  // ---------------------------------------------------------------- clients
  const insClient = db.prepare(`INSERT INTO clients (company_id, name, contact, phone, email, address, is_internal, notes) VALUES (?,?,?,?,?,?,?,?)`);

  // each entity carries the other on its books as a customer — that is what
  // makes intercompany billing real rather than a spreadsheet note
  const dtsAsClientOfAS = insClient.run(AS, 'Diverse Trade Services LLC', 'Mike Gomez', '(555) 100-0000',
    'office@diversetradeservices.net', '4820 Industrial Parkway, Fairview', 1, 'Sister company — intercompany fabrication work').lastInsertRowid;
  const asAsClientOfDTS = insClient.run(DTS, 'All Spec Sheetmetal LLC', 'Sam Ortiz', '(555) 100-0140',
    'shop@allspecsheetmetal.com', '1180 Foundry Road, Bay 4, Fairview', 1, 'Sister company — our fabrication shop').lastInsertRowid;
  db.prepare('UPDATE companies SET sister_client_id = ? WHERE id = ?').run(dtsAsClientOfAS, AS);
  db.prepare('UPDATE companies SET sister_client_id = ? WHERE id = ?').run(asAsClientOfDTS, DTS);

  // DTS customers
  const summit = insClient.run(DTS, 'Summit Property Group', 'Dana Reyes', '555-201-3348', 'dana@summitpg.com', '4120 Commerce Blvd, Suite 210', 0, '').lastInsertRowid;
  const ironwood = insClient.run(DTS, 'Ironwood Builders', 'Marcus Cole', '555-887-1290', 'mcole@ironwoodbuild.com', '77 Foundry Row', 0, '').lastInsertRowid;
  const lakeside = insClient.run(DTS, 'Lakeside HOA', 'Priya Natarajan', '555-443-9021', 'board@lakesidehoa.org', '900 Lakeside Dr', 0, '').lastInsertRowid;
  const redline = insClient.run(DTS, 'Redline Logistics', 'Tom Brannigan', '555-310-4477', 'tbrannigan@redlinelog.com', '2 Distribution Way', 0, '').lastInsertRowid;
  const fairview = insClient.run(DTS, 'City of Fairview', 'Angela Whitfield', '555-772-6103', 'awhitfield@fairview.gov', '1 Civic Center Plaza', 0, '').lastInsertRowid;

  // All Spec's own customers — the shop sells outside the group too
  const meridian = insClient.run(AS, 'Meridian Mechanical', 'Dale Hutchins', '555-664-2210', 'dale@meridianmech.com', '640 Trade Center Dr', 0, 'Ductwork and plenum fabrication').lastInsertRowid;
  const harborGlass = insClient.run(AS, 'Harbor Glass & Glazing', 'Renata Voss', '555-889-4412', 'renata@harborglass.com', '19 Pier Street', 0, '').lastInsertRowid;
  const kestrel = insClient.run(AS, 'Kestrel Restaurant Group', 'Ana Delgado', '555-330-7781', 'ana@kestrelrg.com', '88 Market Street', 0, 'Stainless kitchen fabrication').lastInsertRowid;

  // ---------------------------------------------------------------- people
  const insEmp = db.prepare(`INSERT INTO employees (company_id, name, role, phone, hourly_rate, pin, classification, fringe_rate) VALUES (?,?,?,?,?,?,?,?)`);
  const mike = insEmp.run(DTS, 'Mike Gomez', 'Owner / PM', '555-100-0001', 55, '1111', 'Supervisor', 0).lastInsertRowid;
  const carlos = insEmp.run(DTS, 'Carlos Vega', 'Foreman', '555-100-0002', 42, '2222', 'Carpenter Foreman', 12.4).lastInsertRowid;
  const jess = insEmp.run(DTS, 'Jess Tran', 'Lead Carpenter', '555-100-0003', 38, '3333', 'Carpenter', 12.4).lastInsertRowid;
  const andre = insEmp.run(DTS, 'Andre Willis', 'Electrician', '555-100-0004', 45, '4444', 'Electrician', 15.8).lastInsertRowid;
  const kayla = insEmp.run(DTS, 'Kayla Burke', 'Apprentice', '555-100-0006', 24, '6666', 'Laborer', 9.7).lastInsertRowid;
  // the shop
  const sam = insEmp.run(AS, 'Sam Ortiz', 'Shop Foreman', '555-100-0005', 38, '5555', 'Ironworker', 14.1).lastInsertRowid;
  const ruben = insEmp.run(AS, 'Ruben Diaz', 'Sheet Metal Fabricator', '555-100-0007', 34, '7777', 'Sheet Metal Worker', 13.6).lastInsertRowid;
  const tess = insEmp.run(AS, 'Tess Nakamura', 'Welder / Fitter', '555-100-0008', 36, '8888', 'Welder', 13.6).lastInsertRowid;

  // ---------------------------------------------------------------- inventory
  const insMat = db.prepare(`INSERT INTO materials (company_id, sku, name, category, unit, qty_on_hand, reorder_point, unit_cost, sell_price, location, vendor, sheet_width_in, sheet_length_in) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const SHEET = { 'SHT-GAL-16': [48, 120], 'SHT-GAL-20': [48, 120], 'SHT-SS-304': [48, 120],
    'SHT-ALU-063': [48, 120], 'PLY-CDX-34': [48, 96], 'DRY-58-4X8': [48, 96] };
  const withSheet = (co, m) => insMat.run(co, ...m, ...(SHEET[m[0]] || [0, 0]));
  // All Spec — steel and sheet metal
  const asStock = [
    ['STL-ANG-2', 'Steel Angle 2x2x1/4 20ft', 'Structural Steel', 'ea', 26, 15, 31.5, 52, 'Steel Rack 1', 'SteelServ'],
    ['STL-TUB-2', 'Steel Tube 2x2x11ga 24ft', 'Structural Steel', 'ea', 4, 12, 44.8, 74, 'Steel Rack 2', 'SteelServ'],
    ['STL-CHN-6', 'Steel Channel C6x8.2 20ft', 'Structural Steel', 'ea', 11, 8, 96, 158, 'Steel Rack 3', 'SteelServ'],
    ['SHT-GAL-16', 'Galvanized Sheet 16ga 4x10', 'Sheet Metal', 'sheet', 42, 25, 68, 112, 'Sheet Bay A', 'MetalSource'],
    ['SHT-GAL-20', 'Galvanized Sheet 20ga 4x10', 'Sheet Metal', 'sheet', 61, 30, 41, 69, 'Sheet Bay A', 'MetalSource'],
    ['SHT-SS-304', 'Stainless 304 #4 16ga 4x10', 'Sheet Metal', 'sheet', 9, 8, 214, 340, 'Sheet Bay B', 'MetalSource'],
    ['SHT-ALU-063', 'Aluminum 5052 .063 4x10', 'Sheet Metal', 'sheet', 17, 12, 96, 158, 'Sheet Bay B', 'MetalSource'],
    ['WLD-ER70-35', 'ER70S-6 Wire .035 33lb', 'Consumables', 'spool', 6, 4, 78, 118, 'Weld Cage', 'Airgas'],
    ['WLD-GAS-75', 'C25 Shielding Gas 125cf', 'Consumables', 'cyl', 5, 3, 62, 95, 'Weld Cage', 'Airgas'],
    // solder is tracked by the inch, the way the bench actually measures it
    ['SOL-5050-18', 'Solder 50/50 Bar 1/8" (per inch)', 'Solder', 'in', 5400, 1200, 0.42, 0.85, 'Bench Rack', 'MetalSource'],
    ['SOL-9505-18', 'Solder 95/5 Lead-free (per inch)', 'Solder', 'in', 2600, 800, 0.61, 1.15, 'Bench Rack', 'MetalSource'],
    ['SOL-FLUX-16', 'Soldering Flux 16oz', 'Solder', 'bottle', 9, 4, 14.5, 26, 'Bench Rack', 'MetalSource'],
    ['FIN-POW-BLK', 'Powder Coat Black (per sqft)', 'Finishes', 'sqft', 900, 300, 1.1, 2.4, 'Finish Room', 'ColorPro'],
    ['HDW-ANC-38', 'Wedge Anchor 3/8x3', 'Hardware', 'ea', 240, 150, 1.15, 2.4, 'Bin H2', 'FastenAll'],
  ];
  const asMat = {};
  asStock.forEach(m => { asMat[m[0]] = withSheet(AS, m).lastInsertRowid; });

  // DTS — construction materials
  const dtsStock = [
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
    ['INS-R13', 'Insulation R-13 Roll', 'Insulation', 'roll', 18, 15, 54, 84, 'Rack B4', 'BuildRight Supply'],
  ];
  const dtsMat = {};
  dtsStock.forEach(m => { dtsMat[m[0]] = withSheet(DTS, m).lastInsertRowid; });

  // ---------------------------------------------------------------- DTS quotes
  const insQuote = db.prepare(`INSERT INTO quotes (company_id, quote_number, client_id, title, description, items, labor_hours, labor_rate, markup_pct, tax_pct, status, valid_until, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insQuote.run(DTS, 'DTS-Q-1041', summit, 'Warehouse Mezzanine — Supply & Install',
    'Frame, deck and install 1,200 sqft storage mezzanine. Structural steel fabricated by All Spec Sheetmetal.',
    JSON.stringify([
      { desc: 'Mezzanine steel package (fabricated)', qty: 1, unit: 'ls', unit_cost: 14800, unit_price: 21500 },
      { desc: 'CDX Plywood 3/4" 4x8 decking', qty: 38, unit: 'sheet', unit_cost: 42.5, unit_price: 68 },
      { desc: 'Deck Screws 3" 5lb', qty: 6, unit: 'box', unit_cost: 21, unit_price: 33 },
    ]), 120, 65, 10, 7.25, 'sent', dateStr(21), daysAgo(6));
  insQuote.run(DTS, 'DTS-Q-1042', lakeside, 'Clubhouse Deck Rebuild',
    'Demo and rebuild 640 sqft composite deck with new railing. Railing fabricated by All Spec.',
    JSON.stringify([
      { desc: 'Composite Decking 16ft', qty: 58, unit: 'ea', unit_cost: 41, unit_price: 62 },
      { desc: '2x6 #2 Pine 10ft (framing)', qty: 40, unit: 'ea', unit_cost: 7.2, unit_price: 11.75 },
      { desc: 'Steel railing package (fabricated)', qty: 1, unit: 'ls', unit_cost: 3900, unit_price: 6200 },
    ]), 96, 65, 12, 7.25, 'accepted', dateStr(14), daysAgo(12));
  insQuote.run(DTS, 'DTS-Q-1043', redline, 'Dock Door Bollards',
    'Supply and set 8 concrete-filled bollards at dock doors.',
    JSON.stringify([
      { desc: 'Bollard 6" Sch40 8ft (fabricated)', qty: 8, unit: 'ea', unit_cost: 88, unit_price: 140 },
      { desc: 'Concrete Mix 80lb', qty: 24, unit: 'bag', unit_cost: 6.15, unit_price: 9.5 },
    ]), 20, 65, 15, 7.25, 'draft', dateStr(30), daysAgo(2));

  // All Spec quotes its own outside customers
  insQuote.run(AS, 'AS-Q-2210', kestrel, 'Stainless Prep Line — 3 Stations',
    'Fabricate three 304 stainless prep stations with undershelf and marine edge, per kitchen layout K-2.',
    JSON.stringify([
      { desc: 'Stainless 304 #4 16ga 4x10', qty: 9, unit: 'sheet', unit_cost: 214, unit_price: 340 },
      { desc: 'Stainless tube legs & bracing', qty: 3, unit: 'set', unit_cost: 180, unit_price: 300 },
    ]), 62, 72, 12, 7.25, 'sent', dateStr(18), daysAgo(4));
  insQuote.run(AS, 'AS-Q-2211', meridian, 'Rooftop Plenum Boxes (x6)',
    'Fabricate six insulated plenum boxes, 20ga galvanized, per mechanical schedule M-4.',
    JSON.stringify([
      { desc: 'Galvanized Sheet 20ga 4x10', qty: 22, unit: 'sheet', unit_cost: 41, unit_price: 69 },
      { desc: 'Duct liner & sealant', qty: 6, unit: 'set', unit_cost: 48, unit_price: 88 },
    ]), 40, 72, 12, 7.25, 'accepted', dateStr(9), daysAgo(20));

  // ---------------------------------------------------------------- jobs
  const insJob = db.prepare(`INSERT INTO jobs (company_id, job_number, client_id, quote_id, title, description, address, status, sold_price, start_date, end_date, foreman_id, prevailing_wage, est_labor_hours, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // DTS — construction/install
  const jIronwood = insJob.run(DTS, 'DTS-J-2308', ironwood, null, 'Ironwood Office Buildout',
    'Interior buildout: framing, drywall, paint, electrical rough-in for 3,800 sqft office. Steel window bucks and stair rail fabricated by All Spec.',
    '77 Foundry Row', 'in_progress', 48500, dateStr(-9), '', carlos, 0, 340, daysAgo(10), null).lastInsertRowid;
  const jDeck = insJob.run(DTS, 'DTS-J-2309', lakeside, 2, 'Clubhouse Deck Rebuild',
    'Demo and rebuild 640 sqft composite deck with new railing.', '900 Lakeside Dr', 'in_progress', 14980, dateStr(-3), '', jess, 0, 96, daysAgo(4), null).lastInsertRowid;
  const jPavilion = insJob.run(DTS, 'DTS-J-2310', fairview, null, 'Fairview Park Pavilion Repairs',
    'Structural post replacement and new roof sheathing on park pavilion.', '1 Civic Center Plaza', 'planned', 9200, dateStr(4), '', carlos, 1, 80, daysAgo(3), null).lastInsertRowid;
  const jSuite210 = insJob.run(DTS, 'DTS-J-2301', summit, null, 'Suite 210 Tenant Improvement',
    'Full TI: demising walls, ceiling grid, doors and hardware.', '4120 Commerce Blvd', 'completed', 62400, dateStr(-88), dateStr(-61), carlos, 0, 0, daysAgo(90), daysAgo(61)).lastInsertRowid;
  const jGuardRail = insJob.run(DTS, 'DTS-J-2304', redline, null, 'Warehouse Guard Rail Install',
    'Install 240ft of safety guard rail in distribution warehouse. Rail fabricated by All Spec.', '2 Distribution Way', 'completed', 18750, dateStr(-55), dateStr(-47), jess, 0, 0, daysAgo(58), daysAgo(47)).lastInsertRowid;
  // All Spec — shop jobs for outside customers
  const jPlenum = insJob.run(AS, 'AS-J-4102', meridian, 5, 'Meridian Rooftop Plenums',
    'Six insulated plenum boxes, 20ga galvanized, per schedule M-4.', 'Shop', 'in_progress', 6180, dateStr(-6), '', sam, 0, 40, daysAgo(8), null).lastInsertRowid;
  const jStorefront = insJob.run(AS, 'AS-J-4098', harborGlass, null, 'Storefront Sill Flashing Package',
    'Brake-formed aluminum sill flashing, 340 lineal feet, mill finish.', 'Shop', 'completed', 8940, dateStr(-40), dateStr(-31), sam, 0, 0, daysAgo(44), daysAgo(31)).lastInsertRowid;

  // ---------------------------------------------------------------- job materials
  const insJobMat = db.prepare(`INSERT INTO job_materials (job_id, material_id, description, qty, unit_cost) VALUES (?,?,?,?,?)`);
  insJobMat.run(jIronwood, dtsMat['LUM-2X4-8'], '2x4 Stud 8ft SPF', 160, 3.85);
  insJobMat.run(jIronwood, dtsMat['DRY-58-4X8'], 'Drywall 5/8" 4x8', 110, 13.9);
  insJobMat.run(jIronwood, dtsMat['ELC-12-2-250'], 'Romex 12/2 250ft Roll', 3, 118);
  insJobMat.run(jDeck, dtsMat['LUM-2X6-10'], '2x6 #2 Pine 10ft', 40, 7.2);
  insJobMat.run(jDeck, dtsMat['FST-SCR-3'], 'Deck Screws 3" 5lb', 4, 21);
  insJobMat.run(jSuite210, null, 'Metal studs, drywall, ceiling grid & finishes package', 1, 24000);
  insJobMat.run(jSuite210, null, 'Electrical & data subcontract', 1, 6500);
  insJobMat.run(jGuardRail, null, 'Anchors, grout and install consumables', 1, 1180);
  insJobMat.run(jPlenum, asMat['SHT-GAL-20'], 'Galvanized Sheet 20ga 4x10', 22, 41);
  insJobMat.run(jStorefront, asMat['SHT-ALU-063'], 'Aluminum 5052 .063 4x10', 14, 96);

  // ---------------------------------------------------------------- work orders
  const insWO = db.prepare(`INSERT INTO work_orders (company_id, wo_number, job_id, client_id, title, description, wo_type, priority, status, assigned_to, due_date, items, labor_hours, labor_rate, sold_price, origin_job_id, origin_company_id, notes, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // ---- INTERCOMPANY: DTS raised these to All Spec against DTS jobs ----
  const woBucks = insWO.run(AS, 'AS-WO-5121', null, dtsAsClientOfAS, 'Fab 12 window bucks — Ironwood',
    'Fabricate 12 steel window bucks per drawing A-301. Prime only, DTS installs.',
    'Fabrication', 'high', 'in_progress', sam, dateStr(2),
    JSON.stringify([{ desc: 'Steel Angle 2x2x1/4 20ft', qty: 9, unit: 'ea', unit_cost: 31.5, unit_price: 52 }]),
    26, 72, 3400, jIronwood, DTS, 'Raised by DTS against DTS-J-2308', daysAgo(5), null).lastInsertRowid;

  const woRail = insWO.run(AS, 'AS-WO-5122', null, dtsAsClientOfAS, 'Railing panels — Lakeside clubhouse',
    'Weld 11 railing panels for clubhouse deck, powder-coat black. DTS sets them.',
    'Fabrication', 'normal', 'open', tess, dateStr(6),
    JSON.stringify([
      { desc: 'Steel Tube 2x2x11ga 24ft', qty: 8, unit: 'ea', unit_cost: 44.8, unit_price: 74 },
      { desc: 'Powder Coat Black (per sqft)', qty: 260, unit: 'sqft', unit_cost: 1.1, unit_price: 2.4 },
    ]), 30, 72, 6200, jDeck, DTS, 'Raised by DTS against DTS-J-2309', daysAgo(2), null).lastInsertRowid;

  // ---- All Spec's own outside work ----
  insWO.run(AS, 'AS-WO-5123', null, redline, 'Forklift cage repair',
    'Straighten and reinforce damaged pallet cage from Redline warehouse.', 'Repair', 'rush', 'open', sam, dateStr(1),
    JSON.stringify([{ desc: 'Steel Tube 2x2x11ga 24ft', qty: 2, unit: 'ea', unit_cost: 44.8, unit_price: 74 }]),
    8, 72, 950, null, null, '', daysAgo(1), null);
  insWO.run(AS, 'AS-WO-5124', jPlenum, meridian, 'Plenum boxes 1–3',
    'Brake and seam first three plenum boxes, 20ga galvanized, insulate and label.', 'Fabrication', 'normal', 'in_progress', ruben, dateStr(3),
    JSON.stringify([{ desc: 'Galvanized Sheet 20ga 4x10', qty: 11, unit: 'sheet', unit_cost: 41, unit_price: 69 }]),
    20, 72, 3090, null, null, '', daysAgo(4), null);

  // ---- historical shop work ----
  const woGuardRail = insWO.run(AS, 'AS-WO-5104', null, dtsAsClientOfAS, 'Guard rail sections — Redline',
    'Cut, drill, weld and paint 240ft of guard rail in 12ft sections.', 'Fabrication', 'normal', 'archived', sam, dateStr(-52),
    JSON.stringify([
      { desc: 'Steel Tube 2x2x11ga 24ft', qty: 18, unit: 'ea', unit_cost: 42, unit_price: 71 },
      { desc: 'Base Plate 6x6x3/8', qty: 62, unit: 'ea', unit_cost: 9.8, unit_price: 17 },
    ]), 41, 68, 9800, jGuardRail, DTS, 'Raised by DTS against DTS-J-2304', daysAgo(60), daysAgo(50)).lastInsertRowid;
  const woDoors = insWO.run(AS, 'AS-WO-5098', null, dtsAsClientOfAS, 'Suite 210 hollow metal frames',
    'Fabricate and prime 9 HM door frames with hardware prep.', 'Shop', 'normal', 'archived', sam, dateStr(-70),
    JSON.stringify([
      { desc: 'HM Door Frame 3070', qty: 9, unit: 'ea', unit_cost: 148, unit_price: 245 },
      { desc: 'Commercial Lockset', qty: 9, unit: 'ea', unit_cost: 86, unit_price: 139 },
    ]), 34, 68, 6400, jSuite210, DTS, 'Raised by DTS against DTS-J-2301', daysAgo(78), daysAgo(66)).lastInsertRowid;
  insWO.run(AS, 'AS-WO-5115', jStorefront, harborGlass, 'Sill flashing run — Harbor Glass',
    'Brake-form 340lf aluminum sill flashing, mill finish, crate for delivery.', 'Fabrication', 'low', 'archived', ruben, dateStr(-33),
    JSON.stringify([{ desc: 'Aluminum 5052 .063 4x10', qty: 14, unit: 'sheet', unit_cost: 96, unit_price: 158 }]),
    36, 68, 8940, null, null, '', daysAgo(44), daysAgo(31));

  // ---------------------------------------------------------------- shop consumption
  const insUse = db.prepare(`INSERT INTO material_usage
    (company_id, work_order_id, job_id, employee_id, kind, material_id, metal_type, gauge, size, description, qty, unit, unit_cost, notes, logged_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // Sam on the window bucks
  insUse.run(AS, woBucks, null, sam, 'metal', asMat['STL-ANG-2'], 'Cold Rolled Steel', '1/4"', '2x2x20ft angle',
    'Steel Angle 2x2x1/4 20ft', 6, 'ea', 31.5, 'Bucks 1-8', daysAgo(3, 14));
  insUse.run(AS, woBucks, null, sam, 'metal', asMat['SHT-GAL-16'], 'Galvanized', '16 ga', '4x10 sheet',
    'Galvanized Sheet 16ga 4x10', 2, 'sheet', 68, 'Closure plates', daysAgo(2, 11));
  insUse.run(AS, woBucks, null, sam, 'solder', asMat['SOL-5050-18'], '', '1/8"', 'bar',
    'Solder 50/50 Bar 1/8"', 96, 'in', 0.42, 'Seam sealing', daysAgo(2, 11));
  // Ruben on the plenum boxes
  insUse.run(AS, null, jPlenum, ruben, 'metal', asMat['SHT-GAL-20'], 'Galvanized', '20 ga', '4x10 sheet',
    'Galvanized Sheet 20ga 4x10', 8, 'sheet', 41, 'Boxes 1 and 2', daysAgo(1, 15));
  insUse.run(AS, null, jPlenum, ruben, 'solder', asMat['SOL-9505-18'], '', '1/8"', 'lead-free',
    'Solder 95/5 Lead-free', 144, 'in', 0.61, 'Corner seams, boxes 1-2', daysAgo(1, 15));
  insUse.run(AS, null, jPlenum, ruben, 'consumable', asMat['SOL-FLUX-16'], '', '', '16oz',
    'Soldering Flux 16oz', 1, 'bottle', 14.5, '', daysAgo(1, 15));

  const insRem = db.prepare(`INSERT INTO remnants (company_id, material_id, tag, metal_type, gauge, width_in, length_in, area_sqft, unit_cost, location, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insRem.run(AS, asMat['SHT-GAL-16'], 'R-1042', 'Galvanized', '16 ga', 24, 120, 20, 0.142, 'Drop Rack A', sam, daysAgo(4, 13));
  insRem.run(AS, asMat['SHT-SS-304'], 'R-1043', 'Stainless 304', '16 ga', 18, 96, 12, 0.446, 'Drop Rack B', tess, daysAgo(2, 10));
  insRem.run(AS, asMat['SHT-ALU-063'], 'R-1044', 'Aluminum', '.063"', 30, 48, 10, 0.2, 'Drop Rack A', ruben, daysAgo(1, 9));

  // ---------------------------------------------------------------- change orders
  const insCO = db.prepare(`INSERT INTO change_orders (company_id, co_number, job_id, client_id, title, description, reason, items, labor_hours, labor_rate, markup_pct, tax_pct, schedule_days, status, responded_at, client_signature, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insCO.run(DTS, 'DTS-CO-1', jIronwood, ironwood, 'Add two glass office fronts',
    'Client elected to upgrade offices 3 and 4 to full-height glass fronts in lieu of drywall partitions.',
    'client request', JSON.stringify([{ desc: 'Glass office front system', qty: 2, unit: 'ea', unit_cost: 2850, unit_price: 4400 }]),
    24, 65, 10, 7.25, 4, 'approved', daysAgo(4, 14), 'Marcus Cole', daysAgo(6, 9));
  insCO.run(DTS, 'DTS-CO-2', jDeck, lakeside, 'Reroute irrigation line at footings',
    'Two deck footings intersect an undocumented irrigation main. Cap, reroute and re-inspect before pour.',
    'unforeseen condition', JSON.stringify([{ desc: 'Irrigation reroute materials', qty: 1, unit: 'ls', unit_cost: 310, unit_price: 520 }]),
    10, 65, 10, 7.25, 2, 'sent', null, '', daysAgo(1, 15));

  // ---------------------------------------------------------------- invoices
  const insInv = db.prepare(`INSERT INTO invoices (company_id, invoice_number, job_id, client_id, invoice_type, description, items, tax_pct, retainage_pct, status, issue_date, due_date, terms_days, sent_at, intercompany, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // DTS → its customers
  insInv.run(DTS, 'DTS-INV-1001', jIronwood, ironwood, 'deposit', 'Contract deposit — 40% at signing',
    JSON.stringify([{ desc: 'Deposit, 40% of contract', qty: 1, unit: 'ls', unit_price: 19400 }]), 0, 0, 'sent', dateStr(-9), dateStr(-9), 0, daysAgo(9, 10), 0, daysAgo(9, 10));
  insInv.run(DTS, 'DTS-INV-1002', jIronwood, ironwood, 'progress', 'Progress billing #1 — framing and rough-in complete (45%)',
    JSON.stringify([{ desc: 'Work completed to date, 45% of contract', qty: 1, unit: 'ls', unit_price: 21825 },
                    { desc: 'Approved CO-1 — glass office fronts', qty: 1, unit: 'ls', unit_price: 4400 }]), 0, 10, 'sent', dateStr(-38), dateStr(-8), 30, daysAgo(38, 11), 0, daysAgo(38, 11));
  insInv.run(DTS, 'DTS-INV-0994', jSuite210, summit, 'final', 'Final billing — Suite 210 tenant improvement',
    JSON.stringify([{ desc: 'Contract balance', qty: 1, unit: 'ls', unit_price: 24960 }]), 0, 0, 'paid', dateStr(-60), dateStr(-30), 30, daysAgo(60, 10), 0, daysAgo(60, 10));
  insInv.run(DTS, 'DTS-INV-0998', jGuardRail, redline, 'final', 'Final billing — warehouse guard rail install',
    JSON.stringify([{ desc: 'Contract total', qty: 1, unit: 'ls', unit_price: 18750 }]), 0, 0, 'sent', dateStr(-47), dateStr(-17), 30, daysAgo(47, 9), 0, daysAgo(47, 9));

  // All Spec → DTS (intercompany) and → outside customers
  const invDoors = insInv.run(AS, 'AS-INV-3301', null, dtsAsClientOfAS, 'final', 'Fabrication — Suite 210 hollow metal frames (AS-WO-5098)',
    JSON.stringify([{ desc: 'HM door frame package, fabricated and primed', qty: 1, unit: 'ls', unit_price: 6400 }]), 0, 0, 'paid', dateStr(-66), dateStr(-36), 30, daysAgo(66, 10), 1, daysAgo(66, 10)).lastInsertRowid;
  const invGuard = insInv.run(AS, 'AS-INV-3318', null, dtsAsClientOfAS, 'final', 'Fabrication — guard rail sections, Redline (AS-WO-5104)',
    JSON.stringify([{ desc: 'Guard rail, 240lf fabricated in 12ft sections', qty: 1, unit: 'ls', unit_price: 9800 }]), 0, 0, 'paid', dateStr(-50), dateStr(-20), 30, daysAgo(50, 10), 1, daysAgo(50, 10)).lastInsertRowid;
  const invFlash = insInv.run(AS, 'AS-INV-3330', jStorefront, harborGlass, 'final', 'Sill flashing package, 340lf',
    JSON.stringify([{ desc: 'Aluminum sill flashing, brake-formed', qty: 340, unit: 'lf', unit_price: 26.3 }]), 7.25, 0, 'sent', dateStr(-31), dateStr(-1), 30, daysAgo(31, 10), 0, daysAgo(31, 10)).lastInsertRowid;

  db.prepare('UPDATE work_orders SET billed_invoice_id = ? WHERE id = ?').run(invDoors, woDoors);
  db.prepare('UPDATE work_orders SET billed_invoice_id = ? WHERE id = ?').run(invGuard, woGuardRail);

  const insPay = db.prepare(`INSERT INTO payments (invoice_id, amount, method, reference, received_on, notes) VALUES (?,?,?,?,?,?)`);
  insPay.run(1, 19400, 'check', '#48221', dateStr(-7), 'Deposit received');
  insPay.run(3, 24960, 'ach', 'ACH-99120', dateStr(-34), '');
  insPay.run(4, 9000, 'check', '#7742', dateStr(-20), 'Partial — balance promised end of month');
  insPay.run(invDoors, 6400, 'ach', 'IC-TRANSFER-0088', dateStr(-40), 'Intercompany transfer from DTS');
  insPay.run(invGuard, 9800, 'ach', 'IC-TRANSFER-0091', dateStr(-24), 'Intercompany transfer from DTS');

  // ---------------------------------------------------------------- purchasing
  const insPO = db.prepare(`INSERT INTO purchase_orders (company_id, po_number, vendor, status, items, job_id, expected_date, ordered_at, received_at, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insPO.run(AS, 'AS-PO-3021', 'SteelServ', 'ordered',
    JSON.stringify([{ material_id: asMat['STL-TUB-2'], desc: 'Steel Tube 2x2x11ga 24ft', qty: 30, unit_cost: 44.8 }]),
    null, dateStr(3), daysAgo(2), null, 'Restock for AS-WO-5121/5122 plus shop stock.');
  insPO.run(AS, 'AS-PO-3024', 'MetalSource', 'ordered',
    JSON.stringify([{ material_id: asMat['SHT-SS-304'], desc: 'Stainless 304 #4 16ga 4x10', qty: 12, unit_cost: 209 }]),
    null, dateStr(5), daysAgo(1), null, 'Kestrel prep line — pending quote acceptance.');
  insPO.run(DTS, 'DTS-PO-3022', 'Volt Supply', 'ordered',
    JSON.stringify([{ material_id: dtsMat['ELC-12-2-250'], desc: 'Romex 12/2 250ft Roll', qty: 8, unit_cost: 116 },
                    { material_id: dtsMat['ELC-BRK-20A'], desc: '20A Breaker', qty: 20, unit_cost: 11.1 }]),
    jIronwood, dateStr(2), daysAgo(1), null, 'Ironwood electrical rough-in.');
  insPO.run(DTS, 'DTS-PO-3018', 'Fairview Lumber Co', 'received',
    JSON.stringify([{ material_id: dtsMat['PLY-CDX-34'], desc: 'CDX Plywood 3/4" 4x8', qty: 40, unit_cost: 41.9 }]),
    null, dateStr(-6), daysAgo(9), daysAgo(5), '');

  // ---------------------------------------------------------------- schedule
  const insSched = db.prepare(`INSERT INTO schedule (employee_id, job_id, date, shift, notes) VALUES (?,?,?,?,?)`);
  for (let d = 0; d < 5; d++) {
    insSched.run(carlos, jIronwood, weekday(0, d), 'Full day', d === 0 ? 'Drywall inspection 9am' : '');
    insSched.run(jess, jDeck, weekday(0, d), 'Full day', d === 0 ? 'Deck framing' : '');
    insSched.run(kayla, jDeck, weekday(0, d), 'Full day', 'Helper');
    insSched.run(sam, null, weekday(0, d), 'Full day', d === 1 ? 'Shop — AS-WO-5123 rush' : 'Shop — AS-WO-5121');
    insSched.run(ruben, jPlenum, weekday(0, d), 'Full day', 'Plenum boxes');
    insSched.run(tess, null, weekday(0, d), 'Full day', 'Shop — railing panels');
  }
  insSched.run(andre, jIronwood, weekday(0, 1), 'AM', 'Rough-in inspection prep');
  // next week is oversold on the DTS side
  for (let d = 0; d < 5; d++) {
    insSched.run(mike, jPavilion, weekday(1, d), 'Full day', 'Pavilion supervision');
    insSched.run(carlos, jIronwood, weekday(1, d), 'Full day', '');
    insSched.run(jess, jIronwood, weekday(1, d), 'Full day', '');
    insSched.run(andre, jIronwood, weekday(1, d), 'Full day', '');
    insSched.run(kayla, jDeck, weekday(1, d), 'Full day', '');
    insSched.run(sam, null, weekday(1, d), 'Full day', 'Shop');
  }
  insSched.run(carlos, jPavilion, weekday(1, 0), 'Full day', 'Pavilion post replacement');
  insSched.run(jess, jPavilion, weekday(1, 1), 'Full day', 'Pavilion roof sheathing');

  // ---------------------------------------------------------------- time
  const insTime = db.prepare(`INSERT INTO time_entries (employee_id, job_id, entry_type, clock_in, clock_out, notes) VALUES (?,?,?,?,?,?)`);
  const punch = (emp, job, ago, startH, hours) => {
    const inT = daysAgo(ago, startH);
    const out = new Date(inT.replace(' ', 'T') + 'Z');
    out.setTime(out.getTime() + hours * 3600e3);
    insTime.run(emp, job, job ? 'job' : 'shift', inT, iso(out), '');
  };
  const seedRun = (jobId, crew, startAgo, workdays) => {
    let placed = 0;
    for (let d = 0; placed < workdays && d < workdays * 2; d++) {
      const ago = startAgo - d;
      const dow = new Date(Date.now() - ago * 864e5).getDay();
      if (dow === 0 || dow === 6) continue;
      for (const emp of crew) punch(emp, jobId, ago, 7, d % 5 === 4 ? 6.5 : 8);
      placed++;
    }
  };
  seedRun(jSuite210, [carlos, jess, kayla], 87, 18);
  seedRun(jGuardRail, [jess, kayla], 56, 9);
  seedRun(jStorefront, [ruben], 43, 8);
  // this week
  for (const [emp, job, ago, hrs] of [
    [carlos, jIronwood, 3, 9], [jess, jIronwood, 3, 8.5], [carlos, jIronwood, 2, 9], [andre, jIronwood, 2, 6],
    [jess, jDeck, 2, 8], [kayla, jDeck, 2, 8], [jess, jDeck, 1, 8.5], [kayla, jDeck, 1, 8],
    [sam, null, 1, 8], [ruben, jPlenum, 1, 8], [tess, null, 1, 7.5], [ruben, jPlenum, 2, 8],
  ]) punch(emp, job, ago, 7, hrs);

  // set estimates on completed jobs from what was actually clocked, so the
  // estimator has a realistic "we bid labor light" pattern to learn from
  const estHours = db.prepare('UPDATE jobs SET est_labor_hours = ? WHERE id = ?');
  for (const [id, overrun] of [[jSuite210, 1.14], [jGuardRail, 1.09], [jStorefront, 1.07]]) {
    const actual = db.prepare(`SELECT COALESCE(SUM((julianday(clock_out) - julianday(clock_in)) * 24), 0) h
      FROM time_entries WHERE job_id = ? AND clock_out IS NOT NULL`).get(id).h;
    estHours.run(Math.round(actual / overrun), id);
  }

  // ---------------------------------------------------------------- users
  const insUser = db.prepare(`INSERT INTO users (username, password_hash, role, employee_id, company_id) VALUES (?,?,?,?,?)`);
  insUser.run('mike', hashPassword('admin123'), 'admin', mike, null);        // owner — sees the whole group
  insUser.run('dtsoffice', hashPassword('admin123'), 'admin', null, DTS);    // DTS office only
  insUser.run('asoffice', hashPassword('admin123'), 'admin', null, AS);      // All Spec office only
  insUser.run('carlos', hashPassword('crew123'), 'crew', carlos, DTS);
  insUser.run('jess', hashPassword('crew123'), 'crew', jess, DTS);
  insUser.run('andre', hashPassword('crew123'), 'crew', andre, DTS);
  insUser.run('kayla', hashPassword('crew123'), 'crew', kayla, DTS);
  insUser.run('sam', hashPassword('crew123'), 'crew', sam, AS);
  insUser.run('ruben', hashPassword('crew123'), 'crew', ruben, AS);
  insUser.run('tess', hashPassword('crew123'), 'crew', tess, AS);

  // ---------------------------------------------------------------- field reports
  const insCard = db.prepare(`INSERT INTO job_cards (job_id, employee_id, work_date, hours, work_performed, materials_used, issues, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  insCard.run(jIronwood, carlos, dateStr(-1), 9, 'Framed north and east demising walls, set door bucks for offices 3-6.', '48 studs, 2 boxes screws', '', 'submitted', daysAgo(1, 16));
  insCard.run(jDeck, jess, dateStr(-1), 8.5, 'Demo of old deck complete, hauled debris. Started ledger and footings layout.', 'Dumpster pull #2',
    'Two footings hit buried irrigation line — client notified, may need a change order.', 'submitted', daysAgo(1, 17));
  insCard.run(jPlenum, ruben, dateStr(-1), 8, 'Broke and seamed boxes 1 and 2, insulated box 1. Box 3 laid out.', '8 sheets 20ga galv', '', 'submitted', daysAgo(1, 16));

  // ---------------------------------------------------------------- subs
  const insSub = db.prepare(`INSERT INTO subcontractors (company_id, name, trade, contact, phone, email, license_number) VALUES (?,?,?,?,?,?,?)`);
  const subs = [
    [DTS, 'Copper Creek Plumbing', 'Plumbing', 'Ray Whitaker', '555-620-1180', 'ray@coppercreekplumbing.com', 'PL-44821'],
    [DTS, 'Vertex Electrical', 'Electrical', 'Nina Alvarado', '555-771-3390', 'nina@vertexelec.com', 'EC-90244'],
    [DTS, 'Bluepeak Roofing', 'Roofing', 'Owen Doyle', '555-448-2019', 'owen@bluepeakroof.com', 'RF-11208'],
    [AS, 'Precision Powder Coating', 'Finishing', 'Luis Ferrara', '555-902-3315', 'luis@precisionpowder.com', ''],
    [AS, 'Tri-State Galvanizing', 'Hot-dip Galvanizing', 'Bev Oyelaran', '555-217-8890', 'bev@tristategalv.com', ''],
  ];
  const subIds = subs.map(s => insSub.run(...s).lastInsertRowid);

  const insDoc = db.prepare(`INSERT INTO sub_documents (sub_id, doc_type, carrier, policy_number, issued_on, expires_on, notes) VALUES (?,?,?,?,?,?,?)`);
  insDoc.run(subIds[0], 'COI', 'Hartford', 'GL-8842190', dateStr(-300), dateStr(64), '');
  insDoc.run(subIds[0], 'W-9', '', '', dateStr(-300), '', 'On file');
  insDoc.run(subIds[1], 'COI', 'Travelers', 'GL-2214887', dateStr(-350), dateStr(12), 'Renewal requested — follow up');
  insDoc.run(subIds[2], 'COI', 'Liberty Mutual', 'GL-7781234', dateStr(-400), dateStr(-9), 'EXPIRED — do not schedule until renewed');
  insDoc.run(subIds[3], 'COI', 'Nationwide', 'GL-5590021', dateStr(-120), dateStr(240), '');
  insDoc.run(subIds[4], 'COI', 'Chubb', 'GL-3320114', dateStr(-200), dateStr(150), '');

  db.prepare(`INSERT INTO job_subs (job_id, sub_id, scope, contract_amount) VALUES (?,?,?,?)`)
    .run(jIronwood, subIds[1], 'Electrical rough-in and device trim, 3,800 sqft office', 11400);
  db.prepare(`INSERT INTO job_subs (job_id, sub_id, scope, contract_amount) VALUES (?,?,?,?)`)
    .run(jPlenum, subIds[3], 'Powder coat plenum access doors', 640);

  loadShopPriceBook(db, AS);

  setSetting.run('seeded', '2');
};

/**
 * The shop's real price book, decoded out of the estimating workbook and
 * shipped with the app. Nobody should have to import a spreadsheet before
 * they can quote a duct — the numbers are already here.
 */
function loadShopPriceBook(db, companyId) {
  let book;
  try { book = require('./pricebook-allspec.json'); } catch { return; }

  const ins = db.prepare(`INSERT INTO materials (company_id, name, category, unit, unit_cost, sell_price, vendor, priced_on, qty_on_hand, reorder_point)
    VALUES (?,?,?,?,?,?,?,?,0,0)`);
  const have = new Set(db.prepare('SELECT lower(name) n FROM materials WHERE company_id = ?').all(companyId).map(r => r.n));
  for (const m of book.materials || []) {
    if (have.has(m.name.toLowerCase())) continue;
    ins.run(companyId, m.name, m.category || 'Sheet Metal', m.unit || 'sheet', m.cost, m.price, m.vendor || '', m.priced_on || '');
  }
  if (book.duct) {
    db.prepare('INSERT INTO fab_models (company_id, kind, params) VALUES (?,?,?)')
      .run(companyId, 'duct', JSON.stringify(book.duct));
  }
  for (const f of book.fittings || []) {
    db.prepare('INSERT INTO fab_models (company_id, kind, params) VALUES (?,?,?)')
      .run(companyId, 'fitting', JSON.stringify(f));
  }
}
