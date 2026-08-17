# All Spec / DTS Command Center

Operations platform for a two-company group:

- **All Spec Sheetmetal** — the sheet metal and iron fabrication shop
- **Diverse Trade Services** — construction and installation

Two separate legal entities that work hand in hand: DTS wins the job and installs what All Spec builds. Each keeps its own books, numbering, branding, crew, stock and customers — and the group view shows both together with the work that flows between them netted out.

Quotes that price themselves off your own history, change orders customers sign online, invoicing and receivables, crew scheduling with capacity warnings, inventory, purchasing, shop work orders, a time clock, payroll, and subcontractor compliance — all of it per entity.

Three surfaces share one database:

| Surface | Who | What they get |
|---|---|---|
| **Command Center** (`/`) | Office / admin | Everything — pricing, costs, margins, billing, scheduling, payroll, reports, settings |
| **Crew Portal** (`/portal`) | Field employees | Mobile-first, **works with no signal**: clock in, schedule, hours, assigned work, job cards with photos and voice. **No pricing, costs or margins — ever** |
| **Customer links** (`/q/…`, `/co/…`, `/inv/…`) | Customers | Branded proposals, change orders and invoices they can read, print, and approve online. No login |

**Zero dependencies.** Node.js 22.5+ alone — built-in SQLite, a hand-rolled SMTP client and multipart parser, no `npm install`.

## Run it

```bash
node server.js
```

Open **http://localhost:3000**. The database is created and seeded with realistic demo data on first launch (`data/dts.db`; delete the `data/` folder to reset).

### Demo logins

| Username | Password | Sees |
|---|---|---|
| `mike` | `admin123` | **Both companies** — owner, can switch entities or view the group |
| `dtsoffice` | `admin123` | DTS books only |
| `asoffice` | `admin123` | All Spec books only |
| `carlos`, `jess`, `andre`, `kayla` | `crew123` | DTS crew portal |
| `sam`, `ruben`, `tess` | `crew123` | All Spec shop portal |

Change these before real use — **Users & Access** for other people, the avatar menu for your own.

## How the two companies work together

**Switching books.** The owner gets an entity switcher at the top of the sidebar: **Group**, **AS**, **DTS**. The whole console rebrands — All Spec blue, DTS amber — so you always know whose books you are in. Staff pinned to one entity never see the other, and the switcher cannot widen that: the pin wins over the cookie, enforced server-side.

**Separate everything.** Each entity has its own document numbering (`AS-WO-5121`, `DTS-J-2308`), its own customers, crew, stock, pricing defaults, terms, payment link, brand colour and cash position. All Spec sells to outside customers too — it is a real shop, not a cost centre.

**Sending work across.** On any DTS job, hit **⚒ Send to the shop**. That raises a work order on All Spec's books against the DTS job. What you enter as the price is the transfer price: it becomes All Spec's revenue and that job's cost. All Spec's shop sees it in their queue like any other ticket, with DTS listed as the customer.

**Billing it back.** When the shop finishes, **Bill it** on the Group View drafts an intercompany invoice from All Spec to DTS. Both entities end up with the paperwork a separate legal entity actually needs.

**Getting the group number right.** A DTS job carries the fabrication at what it was *charged*, not at All Spec's internal cost — otherwise DTS would look more profitable than it is and the shop's margin would vanish. At group level the intercompany revenue is eliminated, so group revenue is only what outside customers paid. When work has been delivered end to end, group profit equals the two entities added together; the Group View shows that walk line by line.

One thing to know: only intercompany work sitting inside a **completed** job is eliminated. Work still in the shop is on All Spec's books but not yet on DTS's, so netting it early would flatter the group by the margin on unfinished work.

## The parts that make you money

**AI quoting.** Describe the job the way you would say it out loud — "*Frame a 20x30 storage room. 120 2x4 studs 8ft. 14 sheets of 5/8 drywall. 2 pails interior paint. 24 hours framing and hanging*" — and the estimator drafts the line items. It pulls the quantity and unit out of each line, matches it against **your own** priced history and material list, and fills in what you charge for that item, with a note saying where the number came from and how many times you have quoted it. Hours callouts become labor, not material. Anything it has never seen comes back **blank on purpose**, with the question you need answered before the quote goes out.

This works with no API key and no internet — the local engine reads your catalog. Add a key under **Settings → AI Assistant** and the same grounding facts go to the model, which handles long messy scopes more cleanly and writes better line descriptions. Either way, **every price the model returns is re-checked against your catalog before you see it**: if we know what the thing costs, our number replaces theirs and the panel says so ("*The draft suggested $4.25 — your history won*"). A price it claims came from your history that matches nothing gets stripped to blank rather than trusted. A quoting tool that lets a model invent a unit price is a tool that loses money quietly.

Nothing is added to the quote until you check the lines and click. Labor hours, the tightened-up scope paragraph and each line are all individually opt-in.

**Ask about your numbers.** The **✦ Ask** button in the header opens an assistant that answers from a live snapshot of the entity you are currently in — job margins, AR aging, labor variance, low stock, who is on the clock, the cash flow weeks. "Which jobs are running below target margin?" gets an answer with the job numbers attached so you can check it. It is scoped exactly like the rest of the app: an All Spec user asking about margins sees All Spec. Needs an API key; quote drafting does not.

**Estimating that learns.** Every quote line you have ever sent, every work order you have ever built, and every material in stock is searchable from inside the quote builder — with what you charged, the range, and when you last used it. One click drops it in at your historical price. Meanwhile the system watches your labor estimates against the clock: the seeded demo company bids about 11% light, so a 60-hour estimate gets flagged as *"on past jobs that would land closer to 66.6 hours — roughly $429 of labor you have not billed for."* Similar past jobs and their real margins show up next to it, before you send anything.

**Change orders.** Priced like a quote, emailed to the customer, approved online with a typed signature. An approval automatically raises the job's contract value, extends the end date by the change order's schedule days, and flows into profit — so scope creep stops eating your margin silently. When a crew member flags a problem in a field job card, Insights nags you until it is either priced as a change order or dismissed.

**Invoicing and receivables.** Deposit, progress and final invoices with retainage held back and released at closeout. "Bill a job by % complete" reads the contract value (including approved change orders), subtracts what you have already billed, and drafts the difference. Record payments, watch the aging buckets, and get told which invoices need a phone call rather than another emailed copy.

**Customers can pay online.** Paste a payment link (Stripe, Square, PayPal — whatever you use) in Settings and a **Pay online** button appears on every unpaid invoice. Add your Stripe webhook signing secret and point the processor at `/api/webhooks/stripe`, and payments record themselves against the right invoice — signature-verified, timestamp-checked, and de-duplicated so a replayed webhook can't double-credit anyone.

**Cash flow forecast.** Thirteen weeks of projected balance built from commitments already in the system: unpaid invoices at their due dates (overdue counted in week one), crew hours already on the schedule at their pay rates, and purchase orders in transit. It names the week you run short and what is driving it, and tells you how much delivered-but-unbilled work you could invoice to cover it.

**Quotes and change orders are frozen when sent.** The customer's link always shows the document they were actually sent, even if the office edits the record afterwards — and their signature is recorded against that specific revision. Edited-since-sent is flagged in the office list, and re-sending cuts a new revision rather than quietly rewriting history.

## The parts that keep the field working

**The shop build sheet.** The office attaches drawings, sketches and reference photos (JPG, PNG or PDF) to a work order. The shop opens it on their phone under **My Work** and gets the whole packet: what they're building, the cut and material list, and every plan full-screen with a tap. The shop queue shows all open tickets, not just the ones assigned to them, so a bench hand can pick up the next job — but only the assignee can close it out. Quantities are there; costs and prices are not, and never leave the server for that screen.

**Logging what the shop actually used.** On any build sheet the bench hits **+ Log Materials Used** and records what came off the rack: metal type (galvanized, stainless, aluminum, CRS, copper…), gauge (26 ga through 1/4", plus decimal for aluminum), sheet size, and how many. Solder is entered **in inches**, the way it comes off the bar. Anything picked from inventory deducts from stock and warns if the quantity is bigger than what was on the rack. Once the bench logs something it supersedes the planned items when costing the ticket, so the estimate and the reality never get added together. **Shop Consumption** in the office rolls it up by metal and gauge, by sheet size, and by inches of solder.

**Drops go back on the rack, not in the bin.** Sheet stock carries its real size (a 4x10 is 48" × 120"). When the bench pulls a full sheet and cuts it down, they enter the finished piece — 24" × 120", say — and the drop is worked out live before they save: the leftover 24" × 120", 20 sqft, 100% of the sheet used or saved. Saving racks it with a tag, a location and a carried value, deducts the sheet from stock, and puts the drop on the **use a drop already on the rack** list for the next job. Slivers below the usable threshold are counted as scrap rather than racked as phantom stock, and the geometry handles corner cuts (two drops), rotation when a piece only fits sideways, and runs across several sheets.

**One-tap job switching.** A foreman hopping between jobs all day does not want a dropdown. The Today screen shows his jobs as tiles — scheduled work first, then whatever he has been on lately, topped up with the rest of the live jobs — and one tap switches him, closing the old punch and opening the new one. Live hours-per-job for the day sit underneath, with a punch-by-punch timeline under **My Hours**. Tapped the wrong tile? **Undo last** removes the stray punch and puts him back on the previous job, for twenty minutes after the fact.

**Photos and voice from the job site.** Crew attach photos to any job card — the browser downscales them before upload so they go through on bad signal — and can dictate the work performed and problem notes instead of typing with gloves on. Photos appear on the job card in the office and on the job's detail page.

**Works with no signal.** The portal is an installable PWA. In a basement with no bars, clock-ins, clock-outs and job cards save to the phone and sync automatically the moment signal returns, keeping the real timestamps. Replayed entries are de-duplicated server-side, so a flaky connection never double-punches anyone.

## The parts that keep you out of trouble

**Capacity-aware scheduling.** The dashboard shows committed versus available crew hours for the next three weeks and flags any week you have oversold, plus the exact people who are double-booked and on which days — before they show up at the wrong site.

**Subcontractor compliance.** Certificates of insurance, W-9s and licenses with expiry dates. Expired or missing COIs raise a red banner and a high-priority insight, because your policy will not cover work by an uninsured sub.

**Payroll and certified payroll.** Hours, overtime past 40 in a week at 1.5×, and gross pay straight from the time clock, exportable as CSV. For public work, a WH-347 style certified payroll report per job per week with day-by-day hours, classification, fringe and total package.

## Everything else

Dashboard KPIs and a six-month revenue/profit chart · crew schedule grid · PIN kiosk time clock · material inventory with reorder points · purchase orders that receive into stock · shop work order queue · field job card review · archive and profit search across every job, work order, quote and change order · reports on client margin, crew utilization and material spend · client and employee directories · users, roles and an activity log.

**AI Insights** ties it together: jobs under target margin, jobs running over their labor estimate, overdue receivables, unsigned change orders, field issues with no change order raised, expiring insurance, overcommitted weeks, low stock with usage-based order quantities, stale quotes, unreviewed job cards, win rate and top clients — sorted by how much they should worry you.

## Emailing customers

**Quotes → ✉ Email**, **Change Orders → ✉ Send**, **Invoices → ✉**. Each sends a branded document with a secure link the customer can open on any device. Quotes and change orders can be approved right there; approvals land in your console instantly with a signature.

Before anything actually sends, fill in **Settings → Email Delivery** with your provider's SMTP details (Gmail/Workspace: `smtp.gmail.com`, port 587, STARTTLS, using an [app password](https://support.google.com/accounts/answer/185833)). Set *Public site address* to an address customers can reach so links work from outside your office.

Until SMTP is configured, sending writes a **full preview of the email to `data/outbox/`** and links it from Sent Proposals — so you can see exactly what a customer would receive without sending anything.

## Your data

**Backups run themselves.** A consistent snapshot (SQLite `VACUUM INTO`, safe on a live database) is written on startup and once a day, keeping the newest 14. Settings lists them with download links.

**To restore:** stop the server, replace `data/dts.db` with a downloaded snapshot, start it again.

**To get everything out:** Settings → *Export everything (JSON)* dumps all 22 tables, or grab any single table as CSV. Password hashes and SMTP/webhook secrets are stripped from exports.

Everything lives under `data/` — the database, uploaded photos, backups, and the email outbox. Copy that folder and you have the whole company.

## Tests

```bash
npm test
```

77 tests over `lib/finance.js`, `lib/scope.js`, `lib/nesting.js` and `lib/ai.js` — the modules every invoice, job margin, paycheck and entity boundary goes through. They cover markup/tax compounding order, retainage withheld after tax, contract value moving with approved (not pending) change orders, labor variance, invoice roll-ups, and the edge cases that quietly produce wrong numbers: malformed line-item JSON, division by zero on unpriced work, open punches with no clock-out, and half-cent rounding. The intercompany suite pins down the transfer-price rule, the group elimination, and that a pinned user's cookie can never widen their access.

The AI suite guards the two things in the estimator that cost real money when they break quietly: reading a quantity out of a sentence (`120 2x4 studs 8ft` is 120 studs, not 8), and letting a price onto a quote that did not come from your catalog. It pins the near-miss rejection too — "spiral duct" must not match "duct liner & sealant" on the shared word *duct*, because quoting the wrong item is worse than quoting nothing.

## Security notes

- Passwords hashed with scrypt and a per-user salt; sessions are random 256-bit tokens in HttpOnly, SameSite cookies, expiring after 14 days.
- Role checks are enforced **server-side**. A crew login gets `403` on every admin endpoint, and the portal's material lookup omits cost and price columns entirely.
- Crew can only attach photos to their own job cards and only update work orders assigned to them.
- Changing a password (or deleting a user) invalidates that user's existing sessions. The last active admin cannot be demoted, disabled or deleted.
- Customer document links carry a 144-bit random token and expose exactly one document.
- Uploads are restricted to images and PDFs, capped at 12 MB, and stored outside the web root — served only to signed-in users.
- **Put this behind HTTPS before exposing it to the internet.** Session cookies and SMTP credentials should never cross plain HTTP. A reverse proxy (Caddy, nginx, Cloudflare Tunnel) is the easiest way.

## Tech notes

- **Backend:** plain Node.js (`node:http`, `node:sqlite`, `node:crypto`, `node:tls`). REST API under `/api`.
- **Frontend:** hand-built SPAs, no framework and no build step.
- **Email:** `mailer.js` is a from-scratch SMTP client — implicit TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN, MIME multipart.
- **Uploads:** `lib/uploads.js` is a from-scratch `multipart/form-data` parser.
- **Money:** every financial calculation lives in `lib/finance.js`, so a job's profit means the same thing on the dashboard, in reports, and on an invoice.
- **Voice dictation** uses the browser's built-in speech recognition — available in Chrome, Edge and Safari; the button hides itself elsewhere. Nothing is sent to a third party by this app.
- **Data:** SQLite at `data/dts.db` (WAL mode), uploads in `data/uploads/`. Back up by copying the `data/` folder.
- `PORT=8080 node server.js` to change the port.
