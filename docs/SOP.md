# JA Portal — Standard Operating Procedures

How to use the portal, task by task.

Compiled 20 August 2026. Companion to `HANDOVER.md`, which covers how the system is *built*; this document covers how it is *used*. Where the two disagree, the code wins — tell Chris so both get fixed.

**Production:** `https://justautos.app`

**This document lives in the portal** at **Admin → Library** — read it there, or download the PDF to keep a copy. It is kept up to date as the portal changes, so the copy in the Library is always the current one; a PDF you saved months ago may not be.

---

## How to read this

Each procedure is written as a job you might need to do, in the order you would do it. Screens are named the way they appear in the portal. Anything marked **⚠** is a step where getting it wrong costs money, time, or a customer's confidence — those are worth reading even if you know the rest.

If you only ever read one section, read the one for your own role:

| You are | Start at |
|---|---|
| Parts / workshop support | §3 Workshop tooling |
| B2B / warehouse | §4 Distributor orders |
| Accounts payable | §5 Accounts Payable |
| Sales rep (quote channels) | §6 Quote channels |
| Manager / director | §8 Reports |
| Whoever is holding the pager | §10 When something looks wrong |

---

## 1. Getting in

### 1.1 Signing in

1. Go to `https://justautos.app`.
2. Sign in with your work email.
3. If you have two-factor turned on, enter the 6-digit code from your authenticator app.

You stay signed in across days — the portal quietly re-syncs your session in the background, so you should not be asked to log in each morning. If you land on a login page while already signed in, it will resume you automatically and send you where you were going.

**Lost your 2FA device:** an admin clears it from Settings → Users. There is no self-service reset, on purpose.

### 1.2 Turning on two-factor

Settings → your profile → enable two-factor, scan the QR with your authenticator, confirm with a code. It is opt-in per person. Anyone touching money (AP, B2B refunds, MYOB pushes) should have it on.

### 1.3 Install it as an app

The portal is installable. In Chrome or Edge, use the install icon in the address bar; on iPhone, Share → Add to Home Screen. You get a normal app icon, full screen, and push notifications.

### 1.4 Notifications

The bell in the top bar shows portal notifications; tabs show unread badges. Push notifications (the ones that arrive when the portal is closed) need to be allowed once per device when prompted.

### 1.5 The JA Assistant has been removed

The floating assistant button that used to sit in the bottom-right corner of every page is gone (21 August 2026). It was covering figures on the reports. Nothing else changed, and no data was deleted — if you want it back, ask Chris.

### 1.6 When a new version ships

A "new version — Reload" banner appears when the portal has been updated underneath you. Finish what you are typing, then reload. **⚠** Don't ignore it for days — you can end up submitting a form the server no longer expects.

### 1.7 Getting access to something you can't see

The portal hides what you don't have permission for, so a missing tab is normal, not a fault. Ask Chris; access is per-person, per-tab.

---

## 2. Finding your way around

- **Home** (`/home`) is the app launcher — every module you have access to, as tiles.
- The **top bar** carries your tabs: Workshop, Distributors, B2B Portal, AP Invoices, CRM, Phone Calls, Tasks, Projects, Messages, Reports, Agents, Stripe → MYOB, Settings. You will only see yours.
- **The workshop itself runs on Mechanics Desk**, not the portal — see §3 for the parts, letters and counting tools the portal does provide.

---

## 3. Workshop tooling

**The workshop runs on Mechanics Desk.** Bookings, job cards, customers, vehicles, quotes and invoicing all happen in MD — not in the portal. Nothing in this document changes that.

The portal's own Diary, Jobs, Customers, Vehicles, Quotes, Invoices, Comms, Orders, Inventory, Live Bins, Cash Count and Suppliers screens have been **switched off**, so nobody enters work into a system nobody reads. If you land on one from an old bookmark you'll get a short "not in use" notice. Clicking **Workshop** in the top bar now opens Pre Pick.

Six things remain, all on one tab strip:

| Tab | What it's for |
|---|---|
| **Letters** | Thank-you letters and envelopes |
| **Pre Pick** | What parts the next 14 days need |
| **Purchase Orders** | Ordering and receiving parts |
| **Stocktake (MD)** | Counting against Mechanics Desk |
| **Stocktake (Portal)** | Barcode counting in the portal |
| **Stock Transfer** | Moving stock JAWS ↔ VPS |

### 3.1 Customer letters

A thank-you letter and envelope are queued automatically for every newly finalised MYOB invoice and printed on the Apeos in the comms room. Deposit-only invoices are skipped deliberately.

- Reprint one, compose one by hand, or edit the templates: **Workshop → Letters**.
- Nothing to do day to day — it runs hourly. If letters stop appearing, see §10.

### 3.2 Pre Pick — what parts we'll need

**Workshop → Pre Pick** shows the next 14 days of booked work against stock on hand, so you can order ahead instead of discovering a shortage on the day. It is refreshed from MechanicDesk several times each weekday.

### 3.3 Purchase orders

**Workshop → Purchase Orders** — draft → sent → received, then push the bill to MYOB.

### 3.4 Counting stock

- **Stocktake (Portal)** — create a session, scan barcodes to count, review **Variance**, then **Apply**.
  **⚠ Counted rows are sacred.** If a count looks wrong, investigate before applying — applying writes the variance away.
- **Stocktake (MD)** counts against Mechanics Desk instead, and is report-only.

### 3.5 Stock transfer

**Stock Transfer** moves stock between JAWS and VPS, raising the paired invoice and bill and the matching MD purchase order.

---

## 4. Distributor orders (B2B)

### 4.1 What happens without you

When a distributor pays, the portal already: marks the order paid, empties their cart, writes the MYOB invoice to the cent, prints the pick list grouped by consignment, raises and emails supplier POs for drop-ship items, and posts to Slack.

So the order that lands in front of you is already invoiced into MYOB as a **sale order** and picked out on paper.

### 4.2 Pick, pack and despatch

**⚠ This changed on 20 August 2026.** Booking freight and despatching are now two separate steps. Booking no longer sends anything to the carrier and no longer raises the tax invoice.

1. **Admin → B2B → Orders**, open the order.
2. Check the **packing plan**. The portal cartonises automatically. If two consignments should really travel as one box (oil and a sump, say), tick them and **Combine**, then pick the shared box. Reset returns to automatic packing.
   **⚠** The plan locks once a consignment exists — combine before you book.
3. **Book Freight.** This creates the MachShip consignment and prints the pick slip, consignment note and labels. The consignment sits **Unmanifested** — the carrier does not know about it yet.
4. Pick and pack the order against the paperwork.
5. **Ship Now.** This is the step that actually despatches: it manifests the consignment with the carrier, converts the MYOB order into a tax invoice, receipts the payment against it, prints the A4 tax invoice and emails the distributor their tracking.

**⚠ Ship the run in one action, not one order at a time.** MachShip books a carrier *pickup* when you manifest, so shipping ten orders individually raises ten pickup requests. Select the whole run and ship it once.

**If nothing is reaching the carrier**, the usual answer is that Book Freight was pressed but Ship Now was not.

### 4.3 Freight problems

| Symptom | What to do |
|---|---|
| Consignment shows `consignment_missing` | It vanished at MachShip's end. Rebook from the order page. |
| Booking blocked on an unsettled BECS payment | Deliberate — the money hasn't cleared. If you accept the risk, the Book button offers "Book anyway"; the decision is stamped on the order timeline. |
| Rates look wrong | Admin → B2B → Settings → freight zones / carriers / packaging. Drop-ship rates have their own calibration panel. |

### 4.4 Drop-ship orders

Items we don't hold are ordered from the supplier automatically at payment. When the supplier replies to that PO email, the portal reads the reply and does the rest: bills the PO, flips the sale order to an invoice, receipts payment, passes the ETA to the distributor and posts to `#jaws-orders`.

You only step in if the supplier replies with something unexpected, or replies with a link instead of an attachment — **⚠** link-only emails are invisible to the automation.

### 4.5 Refund a distributor

1. Admin → B2B → Orders → open the order → **Refund**.
2. **Items mode** — tick the lines and quantities being returned (just the airbox, say). The amount is worked out server-side from the exact prices charged, and the portal will not let the same units be refunded twice.
3. **Amount mode** — for freight or the card surcharge.
4. Confirm. A credit note is mirrored into MYOB automatically.

### 4.6 Onboard a distributor

1. Admin → B2B → Distributors → **Add**. Start typing the business name — it matches live MYOB customers, so the card is linked from the start.
2. Open the new distributor → **Invite users**. They receive a magic-link welcome email.
3. The distributor's owner adds the rest of their own team.

One person can belong to more than one distributor and switch between them in the portal.

### 4.7 Catalogue and pricing

Admin → B2B → Catalogue. Prices and visibility are editable inline; the drawer has the full record. Bundles ("includes") ship inside the parent's box, which affects freight, so check the packing plan after changing one.

### 4.8 Training

Admin → B2B → Training. Assign a course to a whole distributor or to named people — courses are invisible until assigned. You can generate a course from an uploaded PDF. Preview plays the real course without recording an attempt.

### 4.9 Test the whole pipeline safely

Admin → B2B → **Test Order** runs a real order end to end against a distributor you choose. Use it after any change to pricing, freight or the pipeline.

---

## 5. Accounts Payable

### 5.1 The daily run

1. **AP Invoices.** New supplier bills arrive by email and are read automatically — supplier, invoice number, date, totals, line items, GST.
2. Work the queue. Each invoice is either posted to MYOB automatically or **flagged** for you.
3. Open a flagged one to see why. Common reasons: the totals don't add up, the supplier isn't recognised, or the period is locked.
4. Fix and post, or reject.

**⚠ Locked-period invoices are never silently re-dated.** They flag, and you decide.

### 5.2 The Slack flag card — what the buttons do

Every invoice the automation won't post itself lands as an orange card in the AP Slack channel, with the reason and a link to the PDF. The buttons:

| Button | What it does |
|---|---|
| **View invoice** | Opens the PDF (the link lasts 7 days). |
| **✅ Approve & post to MYOB** | You are vouching for whatever was flagged. Posts the bill straight away and files the email to Read /Printed. |
| **➕ Create supplier** | Only on "supplier not matched" cards. Reads the vendor's details off the invoice and threads them for you to check *before* any MYOB card is created. |
| **🔍 Entered manually?** | Asks MYOB whether someone has already keyed this invoice in by hand. Only looks — it never posts anything. |

**Press "Entered manually?" before you touch an older card.** Most flagged invoices get typed into MYOB by whoever is doing the accounts that day, and the Slack card then sits there looking outstanding forever. If the bill is there, the card turns green — **"✅ Posted manually"** — the MYOB bill is linked to it, the email is filed away, and the automation stops chasing it.

If nothing exact turns up but MYOB holds a bill for the **same supplier at the same amount** (a hand entry often keys the invoice number differently), those come back in the thread with a **🔗 Link bill #…** button. Check it really is the same invoice before linking. If nothing matches at all it says so and leaves the card alone — the invoice still needs entering.

**Never press Approve & post on a card you haven't checked for a manual entry.** That is how the same bill ends up in MYOB twice.

### 5.3 Duplicates

Suspected double-ups are marked with ♻ and posted to Slack rather than entered twice. Check the original before dismissing.

### 5.4 Supplier statements

**AP → Statement.** Upload or let the watcher read the statement PDF; it reconciles against MYOB and hunts down what's missing. Capricorn statements are **report-only** — do not post from them.

### 5.5 Suppliers that behave differently

Some suppliers are on allowlists — consolidated billing, or pay-on-proforma. If a supplier's invoices keep flagging for a reason that is actually normal for them, that is an allowlist change, not a per-invoice fix. Ask Chris.

---

## 6. Quote channels (sales reps)

Each rep has a Monday board. The portal feeds it and reports on it; the day-to-day happens in Monday.

### 6.1 The follow-up cadence

A quote goes out and the clock starts. You get three touches — at **3 days**, **7 days** and **14 days**.

1. The item appears in **Quote - Follow Up** when it's due.
2. Make the call.
3. Set the status:
   - **Follow Up Done** — you spoke to them. The item hides itself and comes back at the next interval.
   - **RLMNA** (rang, left message, no answer) — counts as an attempt.
   - **Quote Won** / **Quote Lost** — done either way.
4. After the third follow-up, the owner is notified: it now has to be Won or Lost. Don't leave it drifting.

### 6.2 What RLMNA does

| Where the item is | After how many RLMNA clicks | What happens |
|---|---|---|
| Quote - Lead RLMNA (never quoted) | 5 | Status → Quote Not Issued, moved to Quote - Not issued |
| Quote - Follow up RLMNA (quoted) | 3 | Status → Quote Lost, moved to Quote - Lost |

A never-quoted lead is **not** a lost quote — that's why the two paths end differently.

### 6.3 If the board misbehaves

Two faults were found and fixed on 20 August 2026. If you see either shape again, say so immediately rather than working around it:

- **A quote goes to Lost on the first RLMNA click.** Means the attempt counter is being incremented more than once per click.
- **"Follow Up Done" appears to do nothing** — status set, item doesn't move. Means that item's **FU Stage** field is blank; the automations only match stages 1, 2 and 3.

---

## 7. Phone calls and coaching

**Phone Calls** lists every call with audio and transcript, plus coaching analysis scored against a rubric for that call type. Tabs cover sentiment, coaching, word usage and conversion. A team coaching summary posts to Slack on Monday mornings.

Supervisors with permission can **Listen**, **Whisper** (only the rep hears you) or **Barge** (join the call) live.

Click-to-dial is available where enabled.

---

## 8. Reports

### 8.1 Weekly Sales Recap

**Reports → Sales Report.** Emails Ryan automatically at 07:00 Monday.

**⚠** "Sales" here means **orders taken**, not turnover. It counts orders from the Monday boards and Mechanics Desk. Don't reconcile it against the P&L and expect a match.

### 8.2 Management Dashboard

**Reports → Management Dashboard.** The JAWS weekly Excel, live from MYOB. KPI tiles are clickable for history, and charts can be expanded. The cache is warmed at 05:30, so early-morning figures are quick.

### 8.3 Sales Dashboard

**Reports → Sales Dashboard.** Three views, switched at the top of the page.

**Management** (opens here) — sales orders against target, three ways: **per month** (last 18 months), **per salesperson** (this month), and **per day** (last 30 days). Each chart carries its target as a dashed line, and each bar is labelled with its total, so you never have to judge it by height alone. Underneath sit the **Cancelled orders** and **Postponed orders** totals.

Things worth knowing here:

- **The per-salesperson chart is this month only.** The target is a monthly one per person, so comparing a longer period against it would be meaningless.
- **Cancelled and postponed are whole-of-board totals**, not filtered to your date range, matching the Monday dashboard. They are **not** part of any sales figure — cancelled and postponed work isn't money in.
- **Staff parts owing is not built yet** — it shows a dash. There's no board of that name, so we need to know which board and filter it comes from.
- **Targets can be changed without a code change.** Ask Chris; they are settings, currently $1,000,000 a month, $300,000 per salesperson a month, and $50,000 a day.

**Figures** — the sales money: **daily, monthly, per salesperson, and totals**.

Pick the period with the **From / To** date boxes, or use a preset (30d, 3m, 6m, YTD, 12m, 24m). Pick a **Salesperson** to narrow everything to one person — or just click their row in the By-salesperson table, and click again to clear it.

Tiles show the total for the range, this month to date, this year to date, the average trading day, and the best single day and month. Underneath: a bar per day for the last 30/60/90 days, a monthly chart split into workshop orders and distributor bookings, a **By salesperson** table with each person's share, and workshop orders broken down by sale type (Normal Booking, Upsell, Additional Maintenance).

Two things to read correctly:

- **Every calendar day is plotted**, so weekends and quiet days appear as gaps. That is deliberate — closing them up would make the week look busier than it was.
- **The average is per trading day**, counting only days that actually had a sale. Dividing by every calendar day would roughly halve it and flatter nothing.
- **Where an order names two people it counts to the first one.** That keeps each person's numbers adding up to the total. Orders with nobody set show as **Unassigned** — they are never dropped, so if that row is large it means the people column isn't being filled in.
- **The By-salesperson table always shows everyone**, even when you have filtered to one person, so you can compare without clearing the filter.

**Pipeline** — the quote pipeline across the five rep quote channels: what is open, at what stage, with whom, and what converted.

**⚠ Neither view is turnover.** Both count orders and bookings **taken**. Invoiced turnover is on Reports → Forecast, and the two will never agree — that is expected, not a fault. Cancelled and deleted orders are left out, as are distributor bookings still sitting in pending or postponed.

What is on the Pipeline view:

- **Open pipeline by stage** — Lead, Lead RLMNA, Follow Up, Follow up RLMNA, Pending, On Hold. Always current, whatever the window is set to.
- **Won vs lost by month**, over the window you pick (3, 6, 12 or 24 months).
- **By rep**, with win rate.
- **How long open quotes have been sitting** — the 90+ day bucket is the one worth acting on.

Two things to know when reading it:

- **Quotes count against the channel they sit on**, not the Owner column. Owner is only filled in on currently-active quotes, so it cannot carry history.
- **If a board has a group that isn't a standard pipeline stage** (Kaleb's "Farm Fest" group, for example), those quotes are still counted, and called out in a box at the bottom so the totals always add up to what the boards show.

"Quote - Not issued" is left out of every figure.

### 8.4 Forecast

**Reports → Forecast.** Turnover month by month, this year against last, for the workshop (VPS) and wholesale (JAWS) sides. Switch between Combined, Workshop and Wholesale with the buttons top-right. Managers and admins only.

It reads the Monday **Forecasting** board live, so whatever the board says is what you see — if a month looks wrong, fix it on the board and reload.

Two things to read correctly:

- **The headline compares completed months only.** The current month is still running and is shown separately, so the year-on-year figure is like-for-like rather than flattered or penalised by a part-month.
- **Months that haven't started yet show orders already booked, not turnover.** They appear as outlined bars and are left out of the headline. A small bar for a future month is normal — it is the bookings taken so far, not a forecast of a bad month.

The change percentages are worked out from the turnover figures themselves, not the "% Increase/Decrease" column on the board, which is only filled in on some rows.

### 8.5 Workshop Map & Conversion

**Reports → Workshop Map.** Fed by the nightly Mechanics Desk pull. Five tabs:

| Tab | What it answers |
|---|---|
| Jobs Map | Where our booked work comes from |
| Quotes Map | Where we're quoting |
| Conversion | Quotes vs booked jobs, by vehicle and month |
| By State | State-level revenue and win rates |
| **Vehicle Trend** | How each vehicle series is trending over time |

**Using Vehicle Trend:** pick the financial year, and you get one line per vehicle series across the twelve months. Click a month and it redraws day by day for that month. Switch the measure between Jobs, Quotes, Job $ and Quoted $. Clicking a vehicle highlights its line rather than hiding the others, so you keep the comparison.

**⚠** Vehicle Trend counts **every** invoice and quote, while the map tabs show one dot per customer per month. Its totals are legitimately higher — they are not disagreeing with each other, they are counting different things.

### 8.6 Distributor Map

Quotes near each distributor against bookings they actually confirmed — the "are they converting the leads we send them" view.

### 8.7 Distributors report — grouping

**Distributors** (top bar). Under the tab strip there are two controls, and they now apply to **every tab**, not just the Summary:

- **Group by** — `type` (Distributors / Sundry) or `region` (National / International).
- **Showing** — `All`, or one section of whichever dimension you picked.

**⚠ This changed on 21 August 2026, and some numbers will look different from what you remember.** Each tab used to have its own idea of what was included: Distributor Sales and Detailed Sales quietly counted Sundry customers, Parts : Tunes left them out, and the tab labelled "National Total" actually showed everything — International and Sundry as well. Now every tab shows exactly what the Group by / Showing controls say, so the tabs agree with each other and with the Summary.

Reading it:

- On **All**, every tab includes everything and the Summary breaks it into its sections — that is the honest overall picture.
- Pick a section and the whole report narrows to it, headings included. The old "National ..." headings now name what you are actually looking at.
- **Sundry is always its own section**, under either grouping. A Sundry customer is never counted inside National or International, so the sections always add up.
- Switching Group by resets Showing to All, because a "Distributors" filter means nothing once you are grouping by region.
- **Parts : Tunes still leaves Sundry out on All**, as agreed in July — but if you explicitly pick Sundry it will show it, rather than looking empty.

**A dashed line separates the groups** on the bar charts, so you can see where Distributors end and Sundry begins at a glance.

**Charts show every customer; the totals are printed underneath.** Each chart has a bar or slice per customer, and beneath it a line of figures: each group's total, then **All combined** on the right. That way the customer bars stay readable — a bar for the total would tower over everything else and flatten the rest. The Summary table ends the same way, with an "All combined — TOTAL" row under the group subtotals.

**A bar can point the wrong way, and that can be correct.** If a category shows as negative it means credits outweighed sales for it in the period — CP Performance's Parts is the current example. The chart is telling you the truth; it isn't a fault.

If a customer is landing in the wrong section, fix their membership at **Admin → Groups**; the report follows it immediately.

### 8.8 Build a PDF report

**Reports → Builder.** Choose from six report types — Distributor Performance, Stock Health, Call Analytics, CRM Pipeline, Campaign Performance, B2B Sales — then the period, which entities (JAWS, VPS or both) and which sections. Add AI commentary if you want the numbers narrated. Generate, then download the PDF.

---

## 8.9 Stock EOM — the month-end stock report (JAWS)

**What arrives without you doing anything.** At **7:30am on the 2nd of each month** the portal emails the month-just-ended stock report for JAWS to Chris and Morgan. The full version lives at **Reports → Stock EOM**, where you can also pick an earlier month or press **Rebuild from MYOB** if something looks stale.

**To keep a copy or send it on, press *Export PDF*.** It downloads the whole report — every figure and list on the screen — as a PDF named for the month (`jaws-stock-2026-07.pdf`), ready to file or email to the accountant. It exports what is on screen, so if you want the very latest numbers press **Rebuild from MYOB** first.

This is not the same as **Stock & Inventory** (`/stock`), which shows *today* on rolling 30/90-day windows. The month-end report is a frozen snapshot, and it's the only place you can see stock movement **month against month** — MYOB itself only ever tells you today's quantity, so the comparison exists purely because the portal saves each month.

**The numbers at the top:** stock on hand · sales for the month (ex GST) · gross margin · stock turn and days of inventory · dead stock (nothing sold in 90 days) · **slow movers — capital at risk** · overstock (more than a year of cover) · reorder suggested · never sold (excluded). Each shows the movement against last month once there are two months of history.

**Stock that has never sold is left out of the "not moving" figures.** On the JAWS item list a part that has never been invoiced is nearly always a kit component that is never sold on its own — the intake pipe *only*, the two intake gaskets, the cutting jigs. Counting those as dead capital was noise: they were $47.6k of July's $114.7k of "dead stock" and there was nothing anyone could do about them. They're still reported, as their own line marked **excluded**, so the money is visible — they just no longer distort dead stock, ageing or the slow-mover list.

**The lists, and what to actually do with them**

| List | What it's telling you | Action |
|---|---|---|
| Top movers (units) and Biggest margin earners | What shifted, and what paid. These are usually *different* SKUs | Keep the margin list stocked first |
| Where the money is sitting | Held value grouped by how recently it last sold, over the stock that has sold at least once | Anything in **over a year** is a clearance or write-down conversation |
| **Slow movers** | **Where the capital is stuck — ranked by *capital at risk*, meaning the value held beyond 90 days of that SKU's own selling rate.** A SKU is listed if nothing sold in the 90 days to month end, *or* it still sells but holds over 180 days of cover with more than $2,000 past that mark | **This is the list to work first.** A SKU can be selling every week and still be the worst offender: in July the three biggest were all steady sellers carrying a year of stock — $67k, $67k and $60k tied up. Buy less of them next time, or clear the excess |
| **Reorder suggestions** | **Only SKUs on the Stock Order sheet** — kit components that aren't sold separately are deliberately left out. Flagged when below the MYOB alert level, or under 60 days cover on something that moves. Quantity targets 90 days and respects MOQ; cost uses last price paid | This is the month's buy list. If something you order isn't listed, add it to the Stock Order sheet — the report only suggests what's on there, and it tells you how many off-sheet items it skipped |
| Sold while out of stock | Demand you couldn't fill on the spot | Raise the alert level on those SKUs |
| Sold below cost | Selling price ex GST is under average cost | Fix the price, or find out why it was discounted |
| **Cost creep** | Last paid is more than 10% above average cost — the buy price moved and the sell price probably didn't | The price-review list. Quietly the most valuable table in the report |
| Overstock | More than a year of cover at current run rate | Money you could get back |
| Suppliers | Where stock value and reorder spend concentrate | Leverage on your two or three biggest |
| Data to tidy up | Negative on-hand, stock with no cost, stock with no sell price | Record problems, not stock problems — each one distorts every figure above |

**Two things to know before quoting any of it**

- **The on-hand figures are read when the report runs, not at midnight on the last day of the month.** MYOB can't give a historical quantity. The 2nd-of-the-month timing keeps the gap small, and the report prints the exact read time on its face.
- **Everything is measured as at the end of the reported month.** Sales made after it don't count, so re-running an old month always gives the same answer. The **Sold since** column on the slow-mover and never-sold lists shows what has moved *since* the month closed — so a part that looks like dead capital but has a number in that column is selling again, and can be left alone.
- **Margin is indicative, not the P&L.** It's units multiplied by *current* average cost, because invoice lines don't carry the cost of sale. It ranks SKUs honestly and finds leakage — but don't reconcile it to the accounts and don't expect it to match the year-end figures.

**Who can see it.** Admins and managers with stock access. It carries costs, margins and supplier pricing, so a reports-only login can't open it — that's deliberate, not a bug.

---

## 9. Tasks, projects and messages

- **Tasks** — board and list views, with automations you draw as a flow diagram.
- **Projects** — the Monday "Hidden To Do" boards as a linked web; comments post back to Monday.
- **Messages** — internal chat, channels and DMs.

---

## 9a. Leave applications — the applicant is emailed automatically

Staff apply for leave on the Monday **Payroll & Leave Applications** board (the Leave Request form drops the application into the **Leave Applications** group). Since 24 August 2026, **setting the Leave Approved column to Approved or Denied emails the applicant** — a plain, friendly note with the leave type, dates and total days. Ryan is copied on every one and is the reply-to, so replies land with HR.

**For managers approving leave**

- Approve or decline in the **Leave Applications** group as you always have. The email goes out within 15 minutes. You don't need to send anything yourself, and you don't need to tell the portal.
- **⚠ Notes you key straight into the payroll groups are never emailed.** *"Kaleb left at 11am"*, *"Public Holiday"*, *"Easter Monday – all staff"* and the export row all sit on this board marked Approved, and none of them mail anybody. Only an item that was in **Leave Applications** and had Approved (or Denied) pressed on it counts. If you want someone told, decide it on their application, not on a note.
- Changing your mind is fine: flipping an item from Approved to Denied (or back) counts as a new decision and sends the matching email once.
- **Declines are sent too.** The wording asks the person not to take the leave and to speak with their manager — so if you decline something you've already discussed face-to-face, expect them to receive that note as well.

**When the portal doesn't know someone's email address**

Applications submitted through the form carry an address. Rows a manager types by hand usually don't, so the portal falls back to a staff directory — and if it still can't work out an address, **it emails Ryan once** with the applicant's name and does nothing else.

To fix one (either way works, and the email then goes out at the next 15-minute run — **don't re-approve anything**):

1. fill in the **Email Address** column on the Monday item, or
2. add the name to **Settings → Leave Notifications → Staff directory**, exactly as it's typed on the board.

**Settings → Leave Notifications** (admins) also holds: the on/off switch, the HR address that's copied and replied to, everything waiting on an address, the last 100 decisions with who was emailed, and two buttons — **Dry run** (works out who *would* be emailed and sends nothing — use this after editing the directory) and **Run now**.

Two deliberate refusals worth knowing about, because they look like faults:

- A **misspelt company address** on the item (there's a live row reading `justaustos…`) is **not** used — that mail would bounce into a void while everyone believed the person had been told. It goes to the unresolved list instead.
- A name the portal can't pin to one person — a bare *"Matt"* (Huddy, Smith or Karger?), or a row naming several people — is **left unresolved rather than guessed**.

---

## 10. When something looks wrong

Work down this table before escalating. Most of these are a stalled worker, not lost data.

| Symptom | Most likely cause | Check |
|---|---|---|
| Letters or labels stop printing | The print PC is off, asleep, or off the network | PORTAL-CENTRE in the comms room. Failed jobs can be re-queued (failed → pending). |
| A label prints to the wrong printer | The Apeos `(Copy 1)` name suffix | **⚠** Never trust that suffix — check the real printer name. |
| Calls stop appearing | The PBX sync worker | Admin → Connections, look at `freepbx_cdr_sync` freshness |
| Transcripts stale but calls fine | The transcription worker | Same page; then the PBX box |
| **One** long call missing, everything else fine | Not a sync outage — the CDR row arrives only when the call hangs up, so very long calls can land behind the sync window | Note the caller's number and roughly when they rang, and give both to whoever maintains the PBX — the call can be backfilled from the phone system. Connections will look healthy, so don't chase it there |
| Live monitor says "not configured" | Monitor hasn't reported in >20s | Same page |
| Dashboard figures look stale | Overnight cache refresh | The 02:00 refresh cron, then the health page |
| Workshop map or vehicle trend looks out of date | The nightly MD pull | Reports → Workshop Map shows "synced"; "Pull from MechanicDesk now" forces it (~2–4 min) |
| A distributor says they never got tracking | Ship Now hasn't been pressed | §4.2 |
| An AP invoice never arrived | Supplier sent a link, not an attachment | §5 — link-only emails are invisible |
| An AP Slack card is still orange but the bill *is* in MYOB | Somebody entered it by hand; the automation has no way of knowing | Press **🔍 Entered manually?** on the card — it finds the bill, links it and turns the card green (§5.2) |
| A weekly email report shows a count that is clearly too low — or zero | A report query that has outgrown the database's 1000-row response cap and is silently dropping the rest | Don't assume the underlying data is missing — check the live screen (Reports → Workshop Map, Reports → Sales Report) for the same period first. If the screen is right and the email is wrong, it's the report, not the workshop. Tell Chris. |
| Someone approved leave and the person says they got nothing | Either the item wasn't on the application path (a note keyed into a payroll group — §9a), or the portal has no address for them | Settings → Leave Notifications: the item will be under "Waiting on an email address" if it's an address problem. If it isn't listed at all, the decision was made on a note rather than an application. |
| Ryan gets "no email address for …" notices | The applicant's name isn't in the staff directory and the item has no Email Address | Add either one (§9a) — the email then sends itself; nobody needs to re-approve. You only get that notice once per application. |
| Stock EOM figures look stale or wrong | The report shows a stored snapshot, so it's frozen at whatever time it was generated | Reports → Stock EOM → **Rebuild from MYOB**. If the on-hand looks off by a few days' trading, that's expected — see §8.9 |
| Dead stock drops sharply between two months | Months before September 2026 counted never-sold kit parts as dead stock; from 25 Aug 2026 they're excluded | Not a data loss — the old month is on the old basis. Reports → Stock EOM → pick that month → **Rebuild from MYOB** restates it so the two compare like for like |
| The month-end stock email didn't arrive on the 2nd | Either the MYOB connection or the recipient list | Admin → Connections for MYOB health, then Reports → Stock EOM → **Email this report** to send it by hand |
| Someone can't see a tab | Permissions, working as designed | Ask Chris |

**Where to look first, always:** Admin → Connections. It shows every integration and when it last succeeded.

---

## 11. Housekeeping (admins)

| Task | Where |
|---|---|
| Read or download this document and the handover | **Admin → Library** (`/admin/library`) — Settings → Library tile, or your name → Settings → Library |
| Show someone how to get to the Library | Send them `docs/library-access-sop.pdf` — an illustrated one-pager with screenshots of every step (kept in the repo, not on the Library shelf) |
| Add a person, set their role and tabs | Settings → Users |
| Clear someone's 2FA | Settings → Users |
| Change an integration's credentials | Admin → Connections / Settings → Integrations — **⚠** always here, never by editing environment variables directly |
| Check every integration's health | Admin → Connections |
| Per-person reply-to address on outgoing mail | Settings → Users |
| Leave approval emails — switch, HR address, staff directory, who was emailed | Settings → Leave Notifications (§9a) |
| Who gets the month-end stock email | Settings → Integrations → `JAWS_EOM_EMAIL_TO` (comma-separated) |

---

## Appendix — the golden rules

1. **Book Freight prepares. Ship Now despatches.** Nothing goes to the carrier and no tax invoice exists until Ship Now.
2. **Ship a despatch run in one action** — one manifest, one pickup.
3. **"Sales" in the weekly recap means orders, not turnover.**
4. **A never-quoted lead is not a lost quote.**
5. **Counted stocktake rows are sacred** — investigate before applying a variance.
6. **The workshop runs on Mechanics Desk** — the portal handles parts, letters, counting and reporting around it.
7. **Credentials change in the portal**, not in environment variables.
8. **Reload when the new-version banner appears.**
9. **Leave is approved on the application, not on a note.** Pressing Approved on an item in Leave Applications emails the applicant; a line typed into a payroll group emails nobody.
10. **Check “Entered manually?” before approving an AP flag card** — approving one that was already keyed in by hand posts the bill twice.
