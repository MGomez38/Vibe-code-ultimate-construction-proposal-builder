# DTS Command Center

All-in-one construction operations platform for **Diverse Trade Services** — quotes, crew scheduling, material inventory, purchasing, shop work orders, a crew time clock, and a searchable profit archive, in one professional web app.

**Zero dependencies.** Runs on Node.js 22.5+ alone (uses Node's built-in SQLite). No `npm install` needed.

## Run it

```bash
node server.js
```

Open **http://localhost:3000**. The database is created and seeded with realistic demo data on first launch (stored in `data/dts.db` — delete that file to reset to a fresh seed).

## What's inside

| Module | What it does |
|---|---|
| **Dashboard** | Live KPIs — active jobs, crew on the clock, outstanding quote value, low stock — plus a 6-month revenue vs. profit chart, today's crew, and budget-burn bars on every in-progress job. |
| **Time Clock** | Kiosk-style clock in/out with per-employee PINs. Crew can clock straight onto a job — hours and labor cost land on that job card automatically. Live "on the clock" board and daily timesheets. |
| **Crew Schedule** | Week-at-a-glance grid. Click **+** to assign anyone to a job (or shop time), click an assignment to remove it. Today's column is highlighted; browse past and future weeks. |
| **Quotes** | Line-item estimates with labor, markup, and tax. Pull items straight from inventory at your sell prices. One click converts a won quote into a job card **and** cuts a matching shop work order. |
| **Job Cards** | Every job tracks sold price vs. real cost — materials logged (auto-deducted from inventory), labor from the time clock, and linked shop work — with live profit and margin. |
| **Work Orders** | Shop/fabrication queue with priorities, due dates, assignments, and per-item cost/price. Completed WOs flow into the profit archive. |
| **Inventory** | Materials with SKUs, locations, vendors, on-hand quantities and reorder points. Low-stock warnings throughout. |
| **Purchasing** | Purchase orders with suggested reorder quantities. Receiving a PO adds stock into inventory and refreshes unit costs. |
| **Archive & Profit Search** | Search every past job, work order, and quote — including individual line items — and see what you sold it for, what it cost, and the profit/margin. |
| **AI Insights** | Automatic flags: jobs running under target margin, low stock with usage-based order suggestions, overdue work orders, stale quotes to chase, win rate, and top clients. |
| **Clients & Team** | Customer directory and employee roster with roles, rates, and time-clock PINs. |

## Demo logins for the time clock

Employees punch in with their PIN (Team page shows all of them). Seeded examples:

| Employee | PIN |
|---|---|
| Mike Gomez (Owner/PM) | 1111 |
| Carlos Vega (Foreman) | 2222 |
| Sam Ortiz (Shop) | 5555 |

## Tech notes

- **Backend:** plain Node.js (`node:http`) + built-in `node:sqlite`. REST API under `/api`.
- **Frontend:** hand-built single-page app (no framework, no build step) served from `public/`.
- **Data:** SQLite file at `data/dts.db` (WAL mode). Back it up by copying that file.
- Set a different port with `PORT=8080 node server.js`.
