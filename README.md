# DTS Command Center

All-in-one construction operations platform for **Diverse Trade Services** — quotes you can email straight to customers, crew scheduling, material inventory, purchasing, shop work orders, a time clock, and a searchable profit archive.

Two separate experiences share one database:

| Surface | Who | What they get |
|---|---|---|
| **Command Center** (`/`) | Office / admin | Everything — pricing, costs, margins, scheduling, purchasing, reports, settings |
| **Crew Portal** (`/portal`) | Field employees | Mobile-first: clock in/out, their schedule, their hours, assigned work, job cards. **No pricing, costs or margins — ever** |
| **Public proposal** (`/q/<token>`) | Customers | A branded proposal page they can read, print, and approve or decline online. No login |

**Zero dependencies.** Runs on Node.js 22.5+ alone — built-in SQLite, a hand-rolled SMTP client, no `npm install`.

## Run it

```bash
node server.js
```

Open **http://localhost:3000** — you'll land on the sign-in page. The database is created and seeded with realistic demo data on first launch (`data/dts.db`; delete that folder to reset).

### Demo logins

| Username | Password | Lands in |
|---|---|---|
| `mike` | `admin123` | Command Center (admin) |
| `carlos`, `jess`, `andre`, `sam`, `kayla` | `crew123` | Crew Portal |

Change these before real use — **Users & Access** for other people's logins, the avatar menu (top right) for your own password.

## Emailing quotes

Open **Quotes → ✉ Email** on any quote. You get a pre-written message, an editable subject, and the full itemized proposal attached automatically along with a secure approval link.

When the customer clicks **Approve This Proposal**, the quote flips to *accepted* in your Command Center instantly, with their typed signature recorded. From there, **Won → Job** turns it into a job card and a shop work order in one click.

**Before it can actually send**, fill in **Settings → Email Delivery** with your mail provider's SMTP details (for Gmail/Google Workspace: `smtp.gmail.com`, port 587, STARTTLS, using an [app password](https://support.google.com/accounts/answer/185833) — not your normal password). Also set *Public site address* to the address customers can reach, so approval links point somewhere real.

Until SMTP is configured, sending writes a **full preview of the email to `data/outbox/`** and links it from the Sent Proposals list, so you can see exactly what a customer would receive without sending anything.

## What's inside

| Module | What it does |
|---|---|
| **Dashboard** | Live KPIs, a 6-month revenue vs. profit chart, today's crew, and budget-burn bars on every in-progress job. |
| **Time Clock** | Shop-tablet kiosk with per-employee PINs. Crew clock straight onto a job; hours and labor cost land on that job card. |
| **Crew Schedule** | Week grid — click **+** to assign anyone to a job or shop time, click an assignment to remove it. |
| **Quotes** | Line-item estimates with labor, markup and tax; pull items from inventory at your sell prices; email to the customer; one-click convert to job + work order. |
| **Jobs** | Sold price vs. real cost as it happens — materials (auto-deducted from inventory), labor from the time clock, and linked shop work — with live profit and margin. |
| **Work Orders** | Shop/fabrication queue with priorities, due dates, assignments, and per-item cost/price. |
| **Field Job Cards** | Daily reports crew submit from their phones — hours, work performed, materials used, and problems flagged for the office to approve. |
| **Inventory** | SKUs, locations, vendors, on-hand quantities, reorder points, low-stock warnings. |
| **Purchasing** | POs with suggested reorder quantities; receiving adds stock and refreshes unit costs. |
| **Archive & Profit Search** | Search every past job, work order and quote — including line items — and see sold price, cost, profit and margin. |
| **Reports** | Revenue and margin by client, crew hours and utilization, biggest material spend, and job profitability ranked by margin. |
| **AI Insights** | Flags jobs under target margin, low stock with usage-based order suggestions, overdue work orders, stale quotes to chase, unreviewed job cards, win rate and top clients. |
| **Users & Access** | Create logins, set admin vs. crew, link them to employee records, disable people who leave — plus an activity log of who did what. |
| **Settings** | Company details, pricing defaults, proposal terms, and email delivery. |

## Security notes

- Passwords are hashed with scrypt and a per-user salt; sessions are random 256-bit tokens in HttpOnly, SameSite cookies, expiring after 14 days.
- Role checks are enforced **server-side**, not just in the UI — a crew login gets `403` on every admin endpoint, and the portal's material lookup omits cost and price columns entirely.
- Changing someone's password (or deleting them) invalidates their existing sessions.
- The last active admin can't be demoted, disabled or deleted.
- Customer proposal links carry a 144-bit random token and expose only that one quote.
- **Put this behind HTTPS before exposing it to the internet** — session cookies and SMTP credentials should never cross a plain HTTP connection. A reverse proxy (Caddy, nginx, Cloudflare Tunnel) is the easiest way.

## Tech notes

- **Backend:** plain Node.js (`node:http`, `node:sqlite`, `node:crypto`, `node:tls`). REST API under `/api`.
- **Frontend:** hand-built SPAs, no framework and no build step.
- **Email:** `mailer.js` is a from-scratch SMTP client — implicit TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN, MIME multipart.
- **Data:** SQLite at `data/dts.db` (WAL mode). Back it up by copying that file.
- `PORT=8080 node server.js` to change the port.
