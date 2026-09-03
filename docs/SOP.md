# JA Portal — Standard Operating Procedures

How to use the portal, task by task.

Compiled 20 August 2026; **last updated 2 September 2026**. Companion to `HANDOVER.md`, which covers how the system is *built*; this document covers how it is *used*. Where the two disagree, the code wins — tell Chris so both get fixed.

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

**Portal links open in the app, not a browser tab.** Click a portal link in Outlook, Slack or Teams on your computer and it lands in the installed portal app — in the window you already had open, rather than piling up new ones. Those desktop apps hand links to your default browser, and the browser passes anything that belongs to the portal straight to the app.

**One switch, once per computer.** The first portal link you click after installing may ask whether to open it in the app — say yes and it stops asking. If it never asks and links keep opening in a tab, turn it on directly: open the portal app, click the **⋮** menu in its title bar, and tick **Open supported links in this app** (Edge: `edge://apps` → the portal → same setting). Chrome moves this menu around between versions, so if you can't find it, ask Chris rather than assuming it's broken.

Two limits, neither fixable in the portal:

- **iPhone and iPad can't do this at all.** iOS always opens links in Safari, even with the portal on the home screen — an Apple restriction. Open the app from its icon and navigate from there.
- **Links tapped inside a phone app's own browser** (Slack or Gmail on a phone) may never reach Chrome, so they stay in that app's browser.

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

**What the statuses mean** (corrected 2 September 2026 — letters used to sit on **Queued** forever even after they had printed):

**The Letters screen is a worklist, not a history.** It shows only letters that still need something:

| Status | Meaning |
|---|---|
| **Queued** | Sent to the printer, not confirmed back yet. Should clear within minutes |
| **Failed** | Could not be produced — needs a look |

Everything settled **disappears from the list**: printed letters, skipped ones (deposits and non-job invoices), and the old write-offs. **An empty screen is the healthy state** — it means every letter has printed.

To see letters that HAVE printed, add `?all=1` to the page address.

**⚠ If letters start piling up on Queued again, the print PC is the first thing to check** — PORTAL-CENTRE in the comms room. A letter only moves to Printed when the printer confirms it, so a growing Queued list means the agent is not collecting jobs. Failed jobs can be re-queued (failed → pending).

The 368 that had built up since June were **already printed** — the portal simply never recorded it. Nothing was missed and nothing needed reprinting, apart from 30 from June/July that genuinely failed while the old laptop was off-network, which have been written off as too old.

A thank-you letter and envelope are queued automatically for every newly finalised MYOB invoice and printed on the Apeos in the comms room. Deposit-only invoices are skipped deliberately.

**Every row has Retry and Remove.** Retry re-queues it for printing; Remove takes it off the worklist without printing. Use Remove for anything too old to matter — nobody wants a thank-you letter for a job from June.

- Reprint one, compose one by hand, or edit the templates: **Workshop → Letters**.
- Nothing to do day to day — it runs hourly. If letters stop appearing, see §10.

### 3.2 Pre Pick — what parts we'll need

**Workshop → Pre Pick** shows the next 14 days of booked work against stock on hand, so you can order ahead instead of discovering a shortage on the day. It is refreshed from MechanicDesk several times each weekday.

### 3.3 Purchase orders and Stocktake (Portal) have been switched off

Both were removed from the Workshop menu on **1 September 2026** — neither was being used. Purchase orders are raised in MechanicDesk and MYOB as before.

**⚠ Stocktake (MD) is a different thing and is still here.** It counts against Mechanics Desk, is report-only, and lives at **Stocktake** in the main menu — not under Workshop. If someone says "stocktake is gone", that is the portal one they are looking at.

### 3.4 Counting stock

- **Stocktake (MD)** counts against Mechanics Desk and is report-only.

#### “On cars” — why the shelf is short, before you re-count it

Stocktake (MD) has an **On cars** panel above the uploads. It lists the parts already fitted to cars sitting in the
workshop on jobs that haven't been invoiced yet. Mechanics Desk still counts those parts as on-hand, so **your shelf
count will be short by exactly that much, and that is correct** — nothing is missing.

Read it before you start chasing a variance:

- **By part** — every part number with units on cars, MD's on-hand, and a **Should count** column: what the shelf
  ought to physically hold. Count against that number, not MD's on-hand. Click a row to see which cars.
- **By car** — each vehicle with parts on it, oldest first, and how many days it has been open. A car that has been
  sitting for months is usually a job somebody forgot to invoice; that is worth chasing on its own.
- **↻ Check Mechanics Desk** re-runs it (a couple of minutes). It also runs by itself early each weekday morning, so
  it is normally current before anyone starts counting.
- **⬇ Export CSV** downloads whatever you are looking at — the view you are on and anything you have typed in the
  search box. **By part** gives one row per part with the Should count column, ready to sit next to your count sheet
  in Excel. **By car** gives one row per part on each car, which is the sheet to carry around the shop when you are
  checking what is actually bolted to what. Both start with the date the check ran.

**Cars booked in for later are deliberately NOT counted**, even when their parts have already been picked — the car
isn't here, so those parts should still be on the shelf for you to find. If the panel says it's over a day old, or
warns that some days didn't load, press Check before you trust the numbers.

### 3.5 Stock transfer

**Stock Transfer** moves stock between JAWS and VPS, raising the paired invoice and bill and the matching MD purchase order.

---

## 4. Distributor orders (B2B)

### 4.1 What happens without you

When a distributor pays, the portal already: marks the order paid, empties their cart, writes the MYOB invoice to the cent, prints the pick list grouped by consignment, raises and emails supplier POs for drop-ship items, and posts to Slack.

So the order that lands in front of you is already invoiced into MYOB as a **sale order** and picked out on paper.

### 4.1a What distributors see for pricing

**Every price in the distributor portal is GST-inclusive** — catalogue, cart, freight options, order history and the order emails. If a distributor rings and quotes a figure at you, it already has GST in it.

Two deliberate exceptions: the **tax invoice** shows the ex-GST subtotal, the GST and the total, because that is what a tax invoice must show; and the **staff-side admin screens** (freight zones, dropship calibration, catalogue export) are ex-GST, because that is how costing is done. Those are labelled.

**⚠ If a distributor says a line is "a cent out", they are probably right, and it is not a bug in the cart.** Prices are stored **ex-GST**, and most of ours were set by taking a round inc-GST price and dividing by 1.1 — which does not divide evenly. The 20 L oil is stored at $163.64, and $163.64 × 1.1 is $180.004, not $180.00. One shows $180.00; two show $360.01, not $360.00. Only prices whose ex-GST cents end in 0 are immune, and **42 of our 50 priced items are not**.

Nothing is being overcharged at random — the line total is the honest GST on the real ex-GST price, and it is what MYOB will invoice. But the "each" figure is rounded per bottle and the line total is rounded once, so the two disagree by a cent or two on bigger quantities. Say that plainly to the distributor; don't adjust the invoice to match the multiplication. If you want a price to be exactly round including GST, it has to be set so the ex-GST cents end in 0 (e.g. $163.60 ex = $179.96 inc) — tell Chris rather than editing around it.

### 4.1aa Minimum order quantity

Some items only make sense sold in a minimum — a carton, a set of four, a length nobody wants one metre of. **Admin → B2B → Catalogue → open the item → Order limits → Min qty per order.**

Leave it blank for no minimum. Once set:

- The catalogue tile reads **"Minimum order 4"** and its button says **Add 4 to Cart** — a distributor lands on a valid quantity rather than discovering the rule at checkout.
- The cart stepper won't go below it. **Remove** still works, and always will — a minimum must never trap a line in someone's cart.
- It's enforced again when the cart is saved and once more at checkout, so a cart built before you set the minimum can't slip through.

**⚠ The minimum can't be higher than the max qty per order** — that combination makes the item impossible to order, and the portal refuses to save it. If a minimum is higher than what's currently in stock the tile says **"Need 4 — only 2 available"** instead of offering an Add button that would fail.

Both limits are in the catalogue CSV export/import as **Min Order QTY** and **Max Order QTY**, so a batch of items can be set in one go.

### 4.1b Changing quantities

The quantity box in the cart and on the catalogue tile is **typed as well as stepped** — click it, type `24`, press Enter. You no longer have to press **+** twenty-four times, and holding + no longer lags: presses are collected and written once you stop, about half a second later.

While a change is settling, the stepper fades very slightly and the line total dims. The dimmed figure is the **last confirmed** price, not the new one — it snaps to the real total a moment later. That is deliberate: volume-break pricing is worked out on the server, so the portal will not guess at a price it hasn't been given.

### 4.1bb Reading the Orders list: two columns, not one

The Orders list used to carry a single **Status** pill. It has been split into **Payment** and **Shipping** (25 August 2026), because an order has two separate stories - has the money arrived, and have the goods left - and one green "Paid" pill made a boxed-up order look like it had already gone.

| Payment | What it means |
|---|---|
| **Not paid** | Checkout was never finished. Not an order - see 4.1c. |
| **Paid** | Card payment, money is ours. |
| **Paid - bank, unsettled** | Bank Direct Debit accepted, funds still clearing (2-3 business days). |
| **Paid - PayTo, unconfirmed** | PayTo agreement accepted, not yet confirmed. |
| **Refunded** | Some or all has been refunded - the amount shows underneath. |

| Shipping | What it means |
|---|---|
| **No consignment** | Freight hasn't been booked in the portal yet. |
| **Pending consignment** | A consignment exists in MachShip but is **unmanifested** - no carrier has been told anything, no collection is booked, and the goods are still here. |
| **Booked for collection** | Manifested. The carrier has been told what is coming and a collection is booked. |
| **Shipped** | Despatched. |
| **Delivered** | Carrier reports it delivered. |
| **Consignment missing** | The consignment stopped answering in MachShip - see 4.2b. |

**⚠ "Book Shipment" does not book anything with the carrier.** It creates a *pending consignment* and prints the paperwork. **Ship Now** is what manifests it, and manifesting is what books the collection. The button was renamed from "Book Freight" on 1 September 2026 and the new name still promises more than it does — so the Shipping column deliberately reads **Pending consignment** until Ship Now has run. Trust the column, not the button.

**⚠ Amber in the Payment column means the money is not yet in the bank.** Both `becs` and `payto` mark an order paid the moment the mandate is accepted, and it stays amber until the funds settle. **Shipping an amber order is a credit decision** - Ship Now will warn you and make you approve it. That warning is the point, so read it rather than clicking through.

### 4.1bc Has the money actually cleared?

**Admin > B2B > Orders > open the order > Summary > "Check if payment cleared".**

Card and PayTo payments settle at checkout. **Bank Direct Debit (BECS) does not** - checkout only accepts the mandate, and the funds land 2-4 business days later. The order shows **Paid - bank, unsettled** until Stripe tells us the money arrived.

That confirmation normally arrives on its own, from Stripe. If it goes missing - a dropped webhook, or one that fired mid-deploy - the order sits unsettled indefinitely: Ship Now keeps warning about credit risk and the payment is never receipted into MYOB. The button asks Stripe directly.

What you get back:

- **"has cleared - the order is now marked settled"** - money is ours. The order flips to settled and the customer payment is receipted into MYOB - against the tax invoice if one exists, otherwise against the sale order, where MYOB holds it as a deposit and carries it onto the invoice when the order is converted.
- **"is 'processing' - not cleared yet"** - the debit is genuinely still in flight. Nothing is changed. Normal for the first few days.
- **"has NOT cleared and will not"** - the debit failed or was cancelled. **Chase the distributor before shipping anything.**

Pressing it repeatedly is safe.

**⚠ It reports what Stripe says - it never marks something settled on its own.** If Stripe says not cleared, the answer is no, however long it has been.

**The same button also reads "Receipt payment in MYOB".** When an order's money has cleared but no customer payment was ever recorded in MYOB, the button changes to that and applying it is all it does - it doesn't re-ask Stripe, because the money is not in question. This is the repair for a payment that slipped past the automatic path. It is bounded by what the MYOB document actually still owes, so it can never pay twice or overpay; if someone already receipted it by hand it says so and posts nothing. It never appears on a **cancelled or refunded** order - a refund is a separate credit note in MYOB, so the original invoice can still look unpaid, and receipting it would hand over money we have already given back.

You should rarely see it: the portal now applies a cleared payment on its own, and a six-hourly check sweeps up anything the live notification missed and tells you it did. If you *do* see it on an order that cleared days ago, press it - that money is not in MYOB.

### 4.1ba Orders of $30,000 or more come to us first

From **2 September 2026**, any order reaching **$30,000 or more** — goods, GST and freight together — cannot be paid at checkout. It comes through unpaid and waits for us.

**What the distributor sees.** Once their cart reaches the limit a notice appears in the order summary: the order will be processed by hand, we will confirm freight and invoice them for **bank transfer**, and there is **no card surcharge**. *Check Out* becomes **Submit order for approval**. They are never asked for payment and nothing is charged; their cart empties and the order appears in their history straight away.

**What you do**, in order — the money arrives between steps 3 and 4:

1. **Spot it on the orders list.** It shows as **Needs approval** in the Payment column. That is not the same as *Not paid*: nobody abandoned a checkout, this one is waiting on us.
2. **Check it, then press Approve order.** Items, delivery address and freight. Approving releases it to the warehouse and writes the sale order into MYOB.
3. **Pick and pack as normal.** Book Shipment, pick slip, labels. Freight can be quoted and the paperwork printed while the transfer is arranged.
4. **Record the payment when the transfer lands** — **Mark paid**. That receipts it, raises any drop-ship purchase orders, and emails the distributor their confirmation.

**⚠ Do not despatch before the money is in.** An approved order can technically be shipped while unpaid — the portal will not stop you. On an order this size, wait for the transfer to clear and record it first.

**⚠ Approving is not the same as being paid.** It releases the order to the warehouse only. It does not receipt money, and it deliberately does **not** send purchase orders to suppliers — those wait until the payment is recorded, so we never commit a supplier on an unpaid order.

The $30,000 figure is a portal setting, not baked in. Chris can move it without a software update.

### 4.1c Orders that were never paid for

**A checkout that was started and abandoned no longer appears on the Orders page.**

The order row has to exist before the distributor is sent to Stripe - its id is the reference the payment session is keyed on - so someone who reaches the payment screen and backs out leaves a row behind. Those used to sit on the Orders page reading **Awaiting payment**, indistinguishable from a real order owing money. Weirys did exactly this on 25 August: B2B-2026-000051 showed $8,081.26 unpaid while the same cart went through 27 minutes later as B2B-2026-000052.

They are now hidden from the list and left out of its value total. Nothing is deleted - the **Checkout not finished** tile still counts them, and clicking it lists them. The status is also renamed from "Awaiting payment" to **Checkout not finished**, because that is what it means.

**Bank-transfer and PayTo orders are NOT affected.** Those are genuinely paid orders awaiting settlement; they show as **Paid** and stay on the list where you can see them. Only an unfinished Stripe checkout hides.

**⚠ Don't chase one for payment.** If a distributor tells you they were charged but the order looks unfinished, don't assume - check Stripe. The payment either completed (and there will be a second, paid order) or it didn't.

### 4.1d Reminders the portal sends distributors

Two automatic nudges go out on their own. You don't trigger either, but you should know they exist so a phone call about one doesn't surprise you.

| When | What they get |
|---|---|
| A cart untouched for **24 hours**, and again at **72 hours** | "You still have items in your cart." It says freight is quoted live at checkout and a quote from more than a day ago may have moved, and that prices and stock are confirmed at checkout rather than when items were added. Nothing is reserved. After the second one it stops. |
| A checkout started but **never paid**, 24 hours on | "Your order was never completed - nothing has been charged." |

**A cart untouched for more than a fortnight is left alone entirely.** At that point it isn't a live order, and a warning about 24-hour-old freight pricing reads oddly.

**⚠ The unfinished-checkout reminder deliberately keeps quiet when it isn't sure.** Before sending, the portal asks Stripe whether that payment actually went through, and skips if it did; it also skips when the same distributor paid for a later order, which is what usually happened - they went round again. That is why an abandoned checkout you can see on the Orders page may never get chased, and it is correct: telling someone to pay for something they have already paid for is worse than saying nothing.

The wording of both is yours to change at **Admin > B2B > Email templates**, alongside every other distributor email. You can also switch either off there.

### 4.1d When a drop-ship PO email says "email failed"

The PO itself is fine - it exists in MYOB. Only the email to the supplier didn't go, and **Re-send** on the order retries it.

The commonest cause is the supplier's **Email field on their MYOB card holding more than one address**, e.g. `sales@x.com; accounts@x.com`. Our mail provider needs one clean address per recipient and rejects the whole send otherwise. That is what stopped MPI AUTOMOTIVE's PO 00001382 on 25 August, having worked fine three weeks earlier - the address was never wrong, the field just had two in it.

Since 25 August the portal splits that field itself and mails every address in it, so multi-address cards work. If a send still fails, the error now **quotes what the card actually holds**, so you can see what to fix rather than guessing:

- **"isn't a usable address: …"** - the MYOB card has something that isn't an email. Fix the card, then Re-send.
- **"No email on the MYOB supplier card"** - genuinely blank. Add one, then Re-send.
- Anything else - the provider rejected it for another reason; tell Chris and quote the message.

**The PO number a supplier sees is our MYOB invoice number** (from 26 August 2026). A drop-ship PO raised against `JAWSB2B0060` is numbered `JAWSB2B0060` in MYOB and on the supplier's email, so when their invoice comes back quoting it, it points straight at the sale it belongs to. Previously MYOB assigned its own sequential number (`00001382`) which matched nothing on either side. Where one order drop-ships from **more than one supplier**, the second and later POs get `-2`, `-3` appended, because MYOB will not allow two purchases with the same number.

**orders@justautoswholesale.com is CC'd on every supplier PO email, raised or re-sent.** That copy is how you confirm it went - the portal sends through a provider, so nothing appears in a Sent folder. Until 26 August a **re-sent** PO went to the supplier alone: no copy for us and replies pointed at the wrong mailbox, so a successful re-send looked like nothing had happened. Both paths now use the identical envelope.

**⚠ Re-send does not re-raise the PO**, so it can't create a duplicate in MYOB. "Re-raise drop-ship PO" is the one that does - only use it if the PO itself is wrong.

### 4.1e-f Sales coaching in Slack: one section of one post

**Call coaching arrives inside the 5:15pm #sales-updates post** (§4.1e-h), not as a card for every call and no longer as its own message. `#sales-coaching` was posting 100-140 cards a day, which nobody could read; then the daily recap that replaced them was folded into the sales update, so there is **one post to read at the end of the day**.

The coaching part is a **finish-on-a-high note, not a debrief** (from 1 September 2026). It carries two things and nothing else:

| Section | What it is |
|---|---|
| **Top call of the day** | The best-scoring call, with a link to listen |
| **What went well** | Three to five things the team genuinely did well today |

**There is deliberately nothing corrective in it** — no list of what to work on, no per-advisor table, no average score, no "worst call". That was all in the first version and Chris removed it: the end of the day is for finishing on a high. **The Monday weekly coaching report still carries the corrective side**, and every call is still scored in full at **Calls**, so nothing has stopped being coached.

**Nothing has been lost from the coaching itself.** Every call is still recorded, transcribed, scored and coached — open **Calls** in the portal to read any of it in full, filter by advisor, or listen. Only the Slack delivery changed.

**#sales-coaching is not dead** — it still receives the **Monday weekly coaching report**, which is where the week's coaching lives. There is just nothing to watch there day to day.

**The coaching part covers 4:30pm yesterday to 4:30pm today** and the post says the span it covers. Monday's reaches back to Friday 4:30pm, so nothing is lost over the weekend. It is deliberately **not** the same period as the sales figures beside it: scoring a call takes about 20-25 minutes after the call ends, so a 4:55pm call could not be in a 5:15pm post. Cutting off at 4:30pm means **a late-afternoon call is coached in tomorrow's post rather than being skipped entirely** — which is what used to happen to one or two calls a day.

**⚠ A quiet span posts no coaching section at all.** If nothing was scored, that part is simply absent — deliberate, not a fault. The sales figures still post.

If you want the per-call cards back, that is a setting change rather than a rebuild - ask.

### 4.1e-g Payment surcharges end 1 October

**From 1 October 2026 no payment surcharge is charged on any method** - card, PayTo or bank direct debit. Distributors pay the order total and nothing else. This is scheduled, not manual: nobody has to switch it off on the day.

**It is a date, at Admin > B2B > Settings > Card Surcharge > "Stop charging surcharges from".** The percentage and fixed fee above it are deliberately left at their old values, so if the decision changes you clear the date and the previous surcharge returns exactly as it was - you do not have to remember what the rates were.

**⚠ It applies to ALL methods, despite the section being called "Card Surcharge".** If you only meant to stop the card fee, the bank-payment fee needs handling separately - ask before changing it.

The cart, the checkout screen and the invoice all read the same setting, so what a distributor is quoted is always what they are charged.

### 4.1e-h The 5:15pm sales update in Slack

Every weekday at **5:15pm** the portal posts the day's sales into **#sales-updates**: Just Autos bookings, distributor value, the combined total against the day's target, and who wrote the most. **On Friday it posts the week instead**, with a day-by-day line so you can see whether a good week was steady or one big day. Nothing posts on weekends.

**Below the figures, the same post carries the day's call coaching** (§4.1e-f) — top call, the themes coming up most often, a line per advisor, and one call worth reviewing. One post, everything in it. On Friday the sales figures are the whole **week** while the coaching is still just the one span since Thursday's post; the coaching heading names its span so the two cannot be confused.

**The figures are orders WRITTEN, not money invoiced** - the same numbers as Reports > Sales Report, from the Monday boards. If the Slack post and the report ever disagree, that is a fault worth reporting; they read the same source.

**To change the targets:** Settings > Integrations. There are two, per day: `SALES_TARGET_JA_PER_DAY` (Just Autos bookings, $60,000) and `SALES_TARGET_DIST_PER_DAY` (distributors, $50,000) - $110,000 combined. The post shows each against its own target and then the total. Friday's figures are those numbers times the weekdays covered. No deploy needed; it takes effect on the next post.

**To move the channel:** Settings > Integrations > `SALES_UPDATE_SLACK_CHANNEL`.

**To check it before 5:15, or send it early:** open `/api/admin/sales-update-preview` in the browser - it returns exactly what would be posted, along with the figures, and sends nothing. Add `?mode=weekly` to see the Friday version on any day.

**⚠ If the post doesn't appear**, the usual cause is the bot not being in the channel. It retries every hour until 9:15pm, and only marks the day done once Slack has accepted it, so a brief outage does not cost the day.

**⚠ If the figures are there but the coaching section is missing**, the figures are still correct. The coaching is built to drop rather than hold up the numbers; the reason shows as `coaching.reason` on `/api/admin/sales-update-preview`.

### 4.1e-i The Friday tune-job chase

Every Friday morning the portal emails each distributor the tune jobs still waiting on customer details, then emails Matt a recap of who was chased, who wasn't, and what is outstanding.

**If the recap doesn't arrive on Friday, it is not lost.** Since 31 August the run retries on any hour through Saturday and Sunday, and stops once it has been done for that week. Before that it fired in a single pass, and one missed pass cost the whole week - which is what happened on 28 August: 237 jobs went unchased and nobody knew until Matt mentioned it.

**If it still hasn't gone by Sunday** - or you want it sent early - open **Admin > B2B > Tune Jobs** and press **Send reminders now**. That sends both halves: the distributor chasers and Matt's recap. The reply tells you how many were chased and whether the recap went. Pressing it twice in a week is safe: a distributor already chased in the last 6.5 days is skipped.

**⚠ A missed week is not chased on Monday.** From Monday the window is closed and it waits for the next Friday, deliberately - so nobody gets a "weekly" chase on the wrong day without someone choosing it. If a week was missed, use the button.

### 4.1e Tune jobs: reading the filters

**Admin > B2B > Tune Jobs.** Two filters, and they now cross-cut properly (26 August 2026). Pick a distributor and the status tabs count **that distributor's** jobs; pick a status and the distributor list counts jobs **in that status**. Until now the tabs always counted every job in the system, so selecting Penrith still read "187 awaiting details" while the table below showed only theirs.

**A status tab with nothing in it is hidden.** It comes straight back the moment a job lands in that status. That is deliberate rather than deleting the statuses: **Unmatched** and **Submitted** are empty today but both are real -

- **Unmatched** - a receipt arrived whose company name matched no distributor. It has never happened, but if the matcher ever misses, this is where the job waits.
- **Submitted** - the distributor has filled the details in and the job is queued for MechanicDesk. It passes through in seconds, so you will normally never see it. **If jobs start piling up here, the MD sync worker has stopped** - that is exactly when you need the tab, so it must not be deleted for being empty in good times.

### 4.1f Tune-job reminders: who gets what, and when

**Distributors are chased every Friday, about 8:20am Brisbane.** One email per distributor listing their own outstanding jobs, plus a portal push. A job is only included once it is past the 3-day visibility delay, so nobody is chased for a tune they cannot see yet, and a distributor is only emailed once a week.

**Matt gets a recap immediately afterwards** (added 26 August 2026) - one email covering **every** distributor with jobs outstanding: how many, how old the oldest is, what it is worth, and whether they were actually chased. Distributors who received nothing are called out at the bottom in amber.

**⚠ A reminder only goes to a distributor with at least one portal login.** That gate is deliberate - nothing emails a distributor who has never used the portal - but it means a distributor who never signs in never gets chased and never appears to be a problem. That is why the recap lists them separately: they are the ones needing a phone call, not another email.

**To run it early:** Admin > B2B > Tune Jobs > **Send reminders now**. That fires the distributor reminders and the recap to Matt, exactly as Friday would.

### 4.1h Distributors with more than one store

Some distributors run several branches under **one entity** - same ABN, bank account, MYOB card and trade pricing - and just need the goods sent to whichever branch ordered them. That is now one account with several **delivery sites**, not two accounts (26 August 2026).

**To add a site:** Admin > B2B > Distributors > open the distributor > **Delivery sites** > *Add a delivery site*. Give it a name the distributor will recognise ("Rockingham", "Head office"), the address, and a **postcode - freight is priced on it**. Add the branch's own contact name and phone if you have them; that is who the carrier rings, not head office.

**What the distributor sees:** a **Deliver to** dropdown at the top of the freight section in their cart. It only appears when they have more than one site, so nothing changes for single-site distributors. Changing it **re-quotes freight to that postcode** and clears any rate they had already picked, because the old rate was for the old destination.

Every distributor's existing address was brought across as their **default** site, so nothing changed for anyone until a second one is added.

**⚠ Sites are staff-managed, not self-serve.** Where a distributor's goods may be sent is a credit and fraud decision - their portal only ever picks from the list you set. If a distributor asks for a new delivery address, add it here.

**To change a site**, press **Edit** on it, adjust any field and **Save changes**. Editing the address a distributor has already ordered to is safe: past orders keep the address they were actually shipped to, so nothing reprints differently. Changing the **postcode** of a site changes what freight quotes at, including for carts already open on it.

**Removing a site** stops it being selectable but keeps history: past orders keep the address they were actually shipped to, printed on their pick list, labels and tax invoice. You cannot remove the default while other sites exist - make another site the default first.

### 4.1i Stock Wall and Suppliers have been switched off

Both came off the B2B menu on **26 August 2026**.

- **Stock Wall** — the Slack parts bot answers stock questions now, and **Stock Order** covers reordering.
- **Suppliers** — the read-only supplier logins were never taken up; no supplier account was ever created. Drop-ship POs reach suppliers by email instead. The supplier sign-in page is closed too, since nobody was administering it.

If you land on one from an old bookmark you get a short "not in use" notice explaining why, on the same URL. **Nothing was deleted** — the screens and their data are still there, off the menu. Ask Chris if you need either back.

### 4.2 Pick, pack and despatch

**⚠ This changed on 20 August 2026.** Booking freight and despatching are now two separate steps. Booking no longer sends anything to the carrier and no longer raises the tax invoice.

1. **Admin → B2B → Orders**, open the order.
2. Check the **packing plan** (**Boxes and consignments** on the order). The portal cartonises automatically, picking the smallest standard box each item fits - which is often not the box the warehouse actually reaches for, and the box's dimensions are what MachShip prices and the carrier bills.
   - **Change a box:** use the **ships in** dropdown on any consignment to move it into a different standard box, or to "Own packaging" for an item that travels in its own carton.
   - **Merge consignments:** tick two or more, choose the shared box, **Combine** - e.g. oil and a sump together to save a consignment.
   - **Reset** returns the whole order to automatic packing.
   - **Pallets can't be re-boxed or merged** - their tickbox and dropdown are disabled. A pallet is not a box: change **pack mode**, or change the pallet itself in Settings → Freight packaging.

   Every change saves against the order, and freight booking and the pick list both use it verbatim, so what MachShip charges is what the warehouse packs. Reprint the pick list after changing anything.

   **Where it is:** inside the **Shipping** card, as a collapsed link - click **Boxes and consignments** to open it. Until 25 August 2026 that link was hidden entirely once freight was booked, and never appeared at all on orders using static or satchel freight, which is why it may look new.

   **On a palletised order the plan has two levels (new 27 August 2026).** Each pallet lists **the boxes stacked on it**, and each box lists what goes in it. Pack it in that order: fill the boxes first, then load the boxes onto the deck. The printed pick list shows the same two levels - **BOX 1**, **BOX 2** and so on underneath each pallet - so tick items off box by box. Before this the sheet listed a pallet and then every product in the order in one flat list, which told you nothing about what went in which box.

   **A mix of pallets and cartons on one order is normal.** Since 27 August 2026 the quote compares packing it all on pallets against palletising only the bulky items and sending the boxes as parcels, and takes whichever the carrier prices cheaper. So an order can legitimately show, say, one pallet and sixteen cartons. **Do not "fix" it** - that is the plan the distributor was charged for and the one the carrier is expecting.

   **Pallet loads may look unevenly filled.** One pallet stacked high and another barely used is usually the cheapest arrangement, because a part-used layer costs the same height as a full one. The system does try to even them out and only leaves them lopsided when levelling would cost more.

   **Long items still go ON the pallet.** A 1650 mm exhaust lies flat on an 1800 × 1200 deck, and that is where the plan puts it - Hunter Mechanical's three exhausts all ride on pallet 1. The system tries every orientation before giving up on a pallet.

   **Only something that fits no deck at all ships beside the pallets** - a 2.4 m bar, say, which overhangs every pallet you have. It then appears as its own consignment next to them rather than being pretended onto one, which is correct: the carrier is expecting it as a separate item. If you see this on an order where you would expect the item to fit, check that the pallet it needs is still switched **on** in Settings → Freight packaging: switch off the 1800 × 1200 and a 1650 mm exhaust has nowhere to go but its own consignment.

   **You can still change the boxes after booking, until the order is manifested.** A booked consignment exists in MachShip, but nothing has reached the carrier and no label is in anyone's hands - so re-boxing then is normal packing work. Change the boxes, press **Re-book freight**, then reprint the pick list and labels. Once the order has been manifested by **Ship Now** the boxes are fixed and the panel goes read-only: the carrier has been told exactly what is coming.
3. **Book Shipment.** This creates the MachShip consignment and prints the pick slip, consignment note and labels. The consignment sits **Unmanifested** — the carrier does not know about it yet.
4. Pick and pack the order against the paperwork.
**Managers can despatch, from 3 September 2026.** Book Shipment, Ship Now, Print label, Manual book and Refresh from MachShip were admin-only, which meant a manager saw the buttons and got *"Forbidden — insufficient permissions"* when pressing them. Managers and admins can now do all five. **Refunds, approving a large order, Mark as paid and deleting an order are still admin only** — and those buttons no longer appear at all for a manager, rather than failing when pressed. Shipping an unsettled direct debit is still a credit decision: Ship Now warns whoever presses it, manager or admin.

5. **Ship Now.** This is the step that actually despatches: it manifests the consignment with the carrier, converts the MYOB order into a tax invoice, receipts the payment against it, prints the A4 tax invoice and emails the distributor their tracking.

**The portal chases you if an order sits.** A paid order that hasn't shipped after **2 days** posts to Slack and rings the bell for admins and managers, and does it once more at **5 days**. The message says what state it is in - no freight booked, booked but not shipped, manifested but not marked shipped, or waiting on a named drop-ship supplier - so you can tell at a glance whether it is actually yours to chase. Ship the order (or cancel it) and the nudging stops.

**⚠ "Mark as shipped" is not the same thing.** It only records that the goods went out - it raises no consignment and does no MYOB work, so there is **no tax invoice**. That is deliberate, and it is the right button for an order that left another way. But if you use it on an order that should be invoiced, someone has to convert the sale order to an invoice in MYOB by hand. The customer's payment lands in MYOB either way.

**⚠ Ship the run in one action, not one order at a time.** MachShip books a carrier *pickup* when you manifest, so shipping ten orders individually raises ten pickup requests. Select the whole run and ship it once.

**If nothing is reaching the carrier**, the usual answer is that Book Shipment was pressed but Ship Now was not.

**Ship Now asks when the carrier should collect.** From 1 September 2026, pressing **Ship now** opens a window instead of a plain yes/no. It offers:

- **Carrier's next available pickup** (preselected) — exactly what Ship Now always did. MachShip books its next window, rolling to the next business day if today's cut-off has passed. Press *Ship now* and nothing changes from before.
- **Choose a time** — a date and time in Brisbane, sent to the carrier as-is. If they refuse it (TNT collects from Burnside until 2:00pm) you get their reason back.

The separate "Set pickup time..." link is gone — it is one step now. **The window is also the confirmation**, so what it says will happen (manifest, tax invoice, email the distributor) is the last thing you see before it runs.

**⚠ The bulk Ship now on the orders list has no time picker** — it still books the carrier's next available window for the whole run. Use the order page if a particular run needs a set collection time.

**An order stays at its current status when you book it.** Until 25 August 2026, Book Shipment (then called Book Freight) marked the order **shipped** straight away - a leftover from before the two steps were split - so orders sitting on the bench read as shipped, both on the orders list and in the distributor's own portal. Booking now only records the carrier; **Ship Now** is what marks it shipped, which is what it always should have been.

### 4.1f2 Supplier replies: acknowledged vs dispatched

A supplier's reply to a drop-ship PO is one of three things, and the portal now tells them apart (26 August 2026):

| Reply | What it means | What the portal does |
|---|---|---|
| **Acknowledged** | "All in stock, we'll get it out today." Accepted, but nothing has left. | Records the expected dispatch date, emails it to the distributor, posts to Slack. **Nothing is billed or invoiced.** Keeps watching for the dispatch email. |
| **Dispatched** | It has actually shipped - their invoice, consignment number or freight details come with it. | Bills the PO in MYOB, converts our sale order to a tax invoice, receipts the payment, notifies the distributor. |
| **Neither** | Backorder, decline, a question, noise. | Logged and ignored. |

**⚠ This is why "will ship today" no longer triggers invoicing.** Until 26 August both of the first two counted as confirmation, so a stock acknowledgement billed the PO and raised the distributor's tax invoice days before the goods moved. A future or same-day promise to ship is **acknowledged**, not dispatched - "will ship today" is not "has shipped".

If in doubt the classifier chooses the safer option: acknowledged over dispatched, and neither over both.

**You can still force it.** If you know an order has shipped and no dispatch email is coming, press **"Supplier confirmed - bill PO + invoice"** on the order.

### 4.1g When a drop-ship "receive" fails

When a supplier confirms a drop-ship, the portal does three things in order: **bill the PO** in MYOB (which receives the stock into that supplier's DS location), **convert the sale order to a tax invoice** (which consumes that stock), then **receipt the payment**.

**The order matters.** If the bill fails, the invoice conversion cannot succeed - the stock it needs is exactly what the bill receives. Until 26 August it was attempted anyway, and MYOB rejected it with `Inventory_InsufficientStockMultipleLocation`: an alarming inventory error that says nothing about the real cause. B2B-2026-000052 hit exactly that.

Now the conversion is **skipped** when a PO is unbilled, and the order timeline says so plainly. What you will see on the order page:

- **`dropship_po_bill_failed`** - the real problem, naming the PO, the supplier and MYOB's reason. Bill failures used to leave no trace at all.
- **`convert_invoice` skipped** - with which POs are outstanding.

**What to do:** fix the reason the bill failed (usually the supplier or item is not linked in MYOB, or the DS location is missing), then press **"Supplier confirmed - bill PO + invoice"** on the order to re-run the whole chain. It is safe to press again: the bill, the invoice and the payment each have their own idempotency check, and a PO already billed by hand in MYOB is adopted rather than billed twice.

**⚠ The Slack alert now carries the reason.** It used to say only "hit a snag - check the order page".

### 4.2 Prices bill to the cent

**A line is charged at exactly the advertised GST-inclusive price times the quantity.** An airbox listed at $1495 less 20% is **$1196.00**, and five of them are **$5980.00** — not $5979.99.

That stray cent was real and is fixed (1 September 2026). Prices are held ex-GST, and $1196.00 inc is $1087.2727... ex, which cannot be stored exactly — so multiplying the rounded ex price by the quantity came up a cent short, and by more on bigger quantities. **It affected most of the catalogue** (72 of 83 taxable items), not one product. The portal now rounds the inc price once and works the GST backwards out of it, so the cart, the Stripe charge, the MYOB invoice and the emailed invoice all show the same figure.

**Orders placed before that date keep the figures they were charged** — they are not restated, and re-sending one to MYOB reproduces exactly what it always did.

**⚠ If a price still looks a cent out, say so rather than adjusting it by hand** — a hand edit in MYOB puts the invoice out of step with what Stripe actually charged.

### 4.2a Matching an order to its MYOB invoice

**For orders from `JAWSB2B0100` onward there is nothing to match — the portal order number IS the MYOB number.** An order placed in the distributor portal is numbered `JAWSB2B0100`, and that same number is on the MYOB sale order, the MYOB tax invoice, the supplier drop-ship PO, and everything the distributor and accounts quote. No translating, no looking an order up to find "the other number".

Before this (31 August 2026) two separate numbers ran and drifted apart — order `B2B-2026-000057` was `JAWSB2B0065` in MYOB, `B2B-2026-000050` was `JAWSB2B0059` — 6 to 9 out and never by a fixed amount, so the only way to get from one to the other was to open the order.

**Orders placed before the change still have two numbers.** They keep their `B2B-2026-0000NN` portal number and their separate `JAWSB2B00NN` MYOB number. That is not a fault and is not being tidied up; the admin order page shows both.

**⚠ Gaps in the MYOB number series are normal now — do not read a gap as a missing invoice.** The number is reserved the moment a distributor reaches checkout, **before any money moves**. An order abandoned at the payment screen, or cancelled later, burns its number and no MYOB document is ever created under it. So the MYOB sale numbers will have holes: `JAWSB2B0100`, `0101`, `0104`… with 0102 and 0103 simply never used. This is inherent to having one number instead of two — the alternative is the drift above. To see what happened to a gap, search the number in Admin → B2B → Orders: the abandoned or cancelled order is still there with its status. There is also a **one-off gap between `JAWSB2B0065` and `JAWSB2B0100`**, which marks the changeover.

**Internal stock transfers changed format from transfer 25.** JAWS ↔ VPS transfers used to take a number from the same pool as B2B sales (`JAWSB2B0016` … `JAWSB2B0064`) — which is what caused the drift. They now read **`JAWSTFR0001`, `JAWSTFR0002`, …** The 24 already in MYOB keep the numbers they were filed under, so when reconciling intercompany transfers both formats appear in the register.

**⚠ The MYOB invoice number fields on Admin → B2B → Settings no longer set new order numbers.** They govern only the fallback used for pre-change orders. The section is labelled "fallback only" for that reason — editing it will look like it changes numbering and will not.

**Admin → B2B → Orders → open the order.** The **Summary** card leads with the **MYOB invoice** number — `JAWSB2B0100` — above the customer PO, with the date it was invoiced beneath it. That is the number MYOB, accounts and the distributor all quote, so when someone rings about "Cutlers JAWSB2B0100" you can match it without hunting.

On an order where the distributor did not enter their own PO, MYOB's "Purchase Order No." box now repeats the document number. It has always fallen back to the portal order number — which is now the same thing. Harmless.

Until the invoice is written it reads **"Not written to MYOB yet"** in amber. **If a write fails, the reason appears in red across the foot of the Summary card**, with the attempt count and a *Retry MYOB write* button for admins. There is no separate MYOB card any more — the company file is always JAWS, and the order number, the invoiced date and every write attempt are in the Summary and the Timeline already.

The **Timeline** is a pop-up, opened from **Timeline (N)** beside the distributor name at the top of the page. It lists **every** event, newest last — a busy order (drop-ship POs, freight polls, a refund) runs to dozens, and a dialog has the room for them where the page did not.

**The order page was condensed on 3 September 2026**, to fit on one screen without scrolling:

- **Summary runs across the top in three groups** — the invoice, the money, the dates — and the totals moved into the bottom of the Items card, under the money column they add up. The groups stay in the same three places on every order, so *Placed* is where you last saw it even when the order has no *Paid* or *Shipped* row yet.
- **Ship to is inside the Shipping panel**, under the actions and above the carrier — where the order is going and how it is getting there are one panel now, not two half-empty cards. (On a view-only login, which never gets the Shipping panel, the address stays a card of its own on the left.)
- **Items has the full width of the page**, which is what Summary and Ship to were taking half of.
- **The Stripe and MYOB cards are gone.** Both repeated what the Summary and the Timeline already say. What they uniquely held was kept: **Open in Stripe →** is now a link under the Payment row, and a failed MYOB write shows its reason under the MYOB invoice row.
- **Everything you can do to an order is in the Shipping panel**, in one order: where it is up to, then **one blue button for the thing to do next**, then *More actions…*, then the standing tools in an even two-column grid — Refresh, Manual book, Print label, Print pick list.
- **There is only ever one blue button.** On an order with freight booked it is **Ship now**, and *Mark as shipped* moves into *More actions…* — the two read as the same instruction, but only Ship now manifests the consignment, raises the tax invoice and emails the distributor. Use *Mark as shipped* only for freight booked outside the portal. Where there is no consignment yet the button is **Book Shipment**, or **Approve order** on a large order waiting for release, and otherwise it is the status step itself.
- The undo, **Refund…**, **Cancel order…** and **Delete order** are under *More actions…*. Each still asks for confirmation, so choosing one from the list does not do anything on its own.
- **The Timeline is a pop-up now**, opened from **Timeline (N)** beside the distributor name at the top of the page. It is the full history, every event, rather than the most recent three — it just is not taking up the page when you are not reading it.
- **The tracking number is the link** — click `EYA000002111` to open the carrier's tracking page. There is no separate *Open tracking page →* row.
- **Boxes and consignments** stays folded until you open it, the consignment number, freight status and last poll time sit behind **Consignment details** (the ETA stays out where you can see it), and **Method** only appears separately from **Carrier** when the two actually differ.

Nothing was removed but duplication; every figure is still on the page.

### 4.2b "Consignment Missing" on a shipped order

If the freight panel says **Consignment Missing**, the consignment MachShip gave us has stopped answering — nearly always because someone deleted and re-created it in MachShip, which issues a new internal id while the shipment carries on under the same carrier tracking number.

The portal now recovers from this by itself. When the id stops resolving it looks the consignment up again by the **carrier tracking number** (the number on the label, e.g. `EYA000002055`), then by the order reference, and if it finds a single unambiguous match it adopts the new id and resumes tracking. Parked orders are retried every **6 hours**, so an order that stuck earlier can come back on its own — it is no longer a dead end.

**What to do:** press **Refresh** in the Shipping panel to try immediately rather than waiting for the retry. If it still can't find it, the consignment genuinely isn't there under that tracking number and the message will say so — mark the order delivered manually when it lands.

**⚠ "Awaiting despatch — not manifested" on an order that has clearly shipped.** If a consignment is manifested outside the portal — someone despatching it from MachShip directly — the portal never gets a manifest id, and until 25 August it went on offering **Ship now** on freight the carrier had already delivered. Pressing it would have re-manifested the shipment and raised the tax invoice a **second time**. The portal now reads the carrier's own status instead: anything past "unmanifested" counts as gone, and both the button and the action behind it are withdrawn. If you ever see Ship now on an order that is plainly on a truck, don't press it — tell Chris.

**⚠** It matches on the tracking number, not the `MS…` consignment number. A re-created consignment gets a new `MS…` number, so that one is no help — and if two consignments share a tracking number the portal deliberately refuses to guess rather than risk attaching your order to someone else's shipment.

### 4.2z Which carriers can be offered

**Some carriers cannot take loose boxes.** Hi-Trans is pallets-only, so from 31 August it is simply not offered when an order has any loose cartons in the plan - it will not appear in the freight options at all, and it cannot be picked by accident. Before this every carrier MachShip returned was offered, and the cart pre-selects the cheapest, so it could have been chosen without anyone deciding to.

**If a carrier needs restricting or stopping**, it is a data change, not a rebuild - ask. Each rule is either "pallets only" or "never offer".

**⚠ If a quote comes back saying every carrier is excluded by a rule**, that is the rule working, not a fault - the order's packing has loose items and the only carriers available cannot take them. Palletise it, or ask for the rule to be relaxed.

**Still to come:** splitting one order across two carriers - the pallet with one, the loose boxes with another - is not built yet. Today an order goes entirely to one carrier on one consignment.

### 4.3 Freight problems

| Symptom | What to do |
|---|---|
| Consignment shows `consignment_missing` | It vanished at MachShip's end. Rebook from the order page. |
| Booking blocked on an unsettled BECS payment | Deliberate — the money hasn't cleared. If you accept the risk, the Book button offers "Book anyway"; the decision is stamped on the order timeline. |
| "Settled, but the MYOB payment failed" | The message now names the document it tried (type, number, status, customer, balance) - read it. `CustomerMismatch` on a document whose customer looks right usually means the sale order was already converted; the portal handles that itself now, so report it if you still see it. |
| Bank payment cleared, but it isn't in MYOB | Open the order and press **Receipt payment in MYOB** (Summary, where "Check if payment cleared" normally sits). Safe to press twice. It should be rare — the six-hourly check applies these on its own and notifies you when it has. |
| Rates look wrong | Admin → B2B → Settings → freight zones / carriers / packaging. Drop-ship rates have their own calibration panel. |

### 4.3aa Freight prices are live carrier rates only

From **2 September 2026** there is **no manual freight pricing**. The portal quotes live carrier rates or it says it cannot quote.

It used to fall back to hand-typed postcode rates whenever the live quote failed — which is the worst moment to be guessing, and there was nothing on screen to say the price was months old rather than real. Now an unavailable quote reads as exactly that, and the office prices the job.

**⚠ Settings → Drop-ship Zones is not a pricing screen.** Those zones exist to price **drop-ship** items, which ship direct from the supplier and can never be quoted live. The prices themselves live on each product: **Catalogue → the item → Drop-ship freight**. Deleting a zone removes a column from every drop-ship product's price grid — it is not the same as deleting a rate.

### 4.3a Pallet options (Admin → B2B → Settings → Freight packaging)

You can configure **as many pallets as you actually ship on**, not just one. Each has a name, a deck size, the tallest stack you will build on it, and a max weight. Add a *Half pallet* alongside the standard one and the system will use whichever suits the order.

**How it picks (corrected 27 August 2026).** The order is **boxed first**, then those boxes are stacked onto pallets. Whichever pallet ships the order in the **fewest units** wins; if two do it in the same number, the **smaller deck** wins, because that is normally the cheaper freight.

A pallet is now filled by **weight *and* by space**, and it is only offered if the boxes physically fit on its deck. That matters: until this change the system only counted weight, so a bulky-but-light order was declared as one pallet it could never have fitted on, and a deck too short for the goods could be chosen because it was the smaller of two on the same weight limit. A real Hunter Mechanical cart - 289 kg, 2.3 m³, with 1650 mm exhausts - was being quoted as **one 1100×1100 pallet**; it is now two 1800×1200 pallets, which is what it actually takes.

**The tallest stack you enter is a ceiling, not the quote.** Freight is quoted on the height the goods **actually** stack to, plus the pallet base - so a half-empty pallet is priced as a half-empty pallet. Until 27 August 2026 every pallet was declared at its full height, which overcharged the distributor on any order that did not fill the deck: Hunter Mechanical's second pallet was being declared at 1500 mm for a 450 mm stack, and now reads 600 mm.

**⚠ Get the max weight right.** The weight you enter is taken literally. Enter 400 kg and the system will happily load 400 kg onto one pallet - check that both the carrier and your forklift will take it.

**Palletise over (kg)** sits underneath the list and is deliberately separate. It decides whether an order goes on pallets *at all* instead of boxes, which is a decision about the whole order rather than about any one pallet — so it is set once. An order containing an item marked as pallet-packaging always palletises, whatever it weighs.

**⚠** Deleting or switching off every pallet means orders ship in cartons no matter how heavy they are. The list warns you when it is empty.

### 4.3d Getting a distributor onto the app

Distributors can install the wholesale portal as a proper app - own icon, own window, no browser tabs - on a phone, tablet or computer. There is nothing in the App Store or Google Play; the site installs itself.

**Send them the PDF:** Admin → Library → *Installing the Just Autos Wholesale app*. It is written for them, so it can be forwarded as-is.

**The one thing that goes wrong:** they must be on a **`/b2b`** web address when they install - send them to `justautos.app/b2b/login`. Installing from `justautos.app` on its own gives them the **staff** app, which they cannot sign in to. If someone ends up locked out of an app they just installed, that is almost always why: delete the icon, install again from the `/b2b` address.

**On an iPhone it must be Safari.** Chrome on an iPhone cannot install it. Notifications on iPhone also only work once the app is on the home screen - not from Safari - and need iOS 16.4 or later.

### 4.3c Freight markup bands (Admin → B2B → Settings → Freight Pricing)

**New 27 August 2026.** The markup added to the carrier's price is no longer one number for every job. It is now a set of bands, and they came from Chris:

| What the carrier charges us (ex GST) | Markup |
|---|---|
| up to $500 | 20% |
| over $500 to $1,000 | 10% |
| over $1,000 | 5% |

**The band is picked by OUR cost, not the price the distributor pays.** MachShip quotes us $480, that is the first band, 20% is added, the distributor sees $576.

**The upper limit is inclusive.** $500.00 exactly is in the 20% band; $500.01 is in the 10% band.

**⚠ The bands are steps, not a sliding scale — and that has a sharp edge.** A $500.00 carrier price earns us $100. A $500.01 one earns $50. So a slightly dearer consignment can cost the distributor *less* overall. This is deliberate, but it means the boundaries are worth knowing when you are near one: if a quote comes back just over $500 or just over $1,000, sending it a different way (see the packing options in 4.3b) may cross a boundary and change the total more than you would expect.

**Editing them.** Each row is a band; *Up to $* is its top and blanking it makes it the open-ended top band (there can only be one). Add or delete bands freely. **Fallback markup** underneath is only used if there are no bands at all, or if a price somehow falls outside every band — it is a safety net, not the normal path.

This applies to **live carrier quotes only**. Postcode-zone rates, flat-rate satchels and drop-ship freight all carry a price you set directly, so there is no markup to band.

### 4.3b Freight quote (Admin → B2B → Freight quote)

**New 27 August 2026.** A calculator: add products, type a suburb and postcode, press **Quote freight**, get live MachShip rates. No order is created and nothing is saved - use it freely for "what would this cost to send to X". It replaces having to open the test-order builder just to see a price.

Pick a distributor to prefill their address (you can still edit it, so quoting a one-off delivery is fine). **Pack as** is normally left on *Auto*.

**Each price can be expanded to show what it was priced on** - press *Show the N consignments*. You get every pallet and carton, and for a pallet, the boxes on its deck and what goes in each. If a number looks wrong, that is where the answer is.

**Auto now prices more than one packing and takes the cheapest.** The same order can go out as two pallets, as one pallet with the neat boxes travelling as parcels, or as all parcels - and which is cheapest is genuinely not predictable: fewer, bigger units means less declared cube but more handling per item. Each carrier is shown at its own cheapest packing, and the packing named under the rate is the one that would be booked and printed. Hunter Mechanical's cart, for scale: 2 pallets = 4.47 m³, one pallet plus 16 parcels = 3.68 m³, 36 parcels = 2.47 m³.

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

**The catalogue now pulls from MYOB every hour** (from 1 September 2026 — it used to refresh only when someone pressed **Sync**). The Sync button still works and is still worth pressing if you have just changed something in MYOB and want it immediately.

What the hourly pull changes, and what it leaves alone:

| Refreshed from MYOB every hour | Never touched — the portal owns it |
|---|---|
| SKU, name, **RRP**, GST status, **cost price** | **Trade price** (what distributors pay), visibility, description, category, images |

**A price rise in MYOB now moves the trade price with it** — as long as the item has a **discount %** set. That is the whole point of the % field: you are telling the portal *"this item is 20% off RRP"*, not *"this item costs $1196"*, so when the RRP changes the trade price follows and your margin holds.

Each item is in one of two states, shown on the item under **Pricing**:

| State | What it means |
|---|---|
| **Tracks RRP — 20% off** | The price is worked out from RRP every hour. A MYOB price change flows straight through. |
| **Pinned (set by hand)** | The price stays exactly where you typed it. An RRP change does **not** move it. |

**Typing a price into Trade price pins the item. Typing a number into Discount % makes it track.** That is deliberate — if a typed price kept tracking, the next hourly sync would overwrite what you just typed.

**Three items are currently pinned and need a decision:** `H-M04-00`, `JA-STUB` and `TGFK - 1VDT`. Their prices sit a cent or two off a clean percentage — they look like prices that already drifted before this was fixed — so they were deliberately left alone rather than rounded to a guess. Set a % on each and they will start tracking.

**⚠ 19 items are priced at 0% off — distributors pay full RRP.** That is what a brand-new item is seeded at when nobody has priced it yet. Worth reviewing whether that is intended.

**⚠ Clearing a cost in MYOB does not clear it here.** A blank or zero cost is ignored and the previous figure stays, so cost price can look right when MYOB no longer holds one.

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

**Accounts is Jarred (Financial Manager) with Danielle assisting**, from September 2026.

### 5.1a The same bill in both companies

**2 September 2026.** A JMACX invoice was paid **twice** — once in JAWS, where it was sitting as a purchase order, and again in Just Autos after JMACX sent a second copy to the wrong inbox. Nothing on our side could have caught it.

Before an invoice is entered, the portal now searches **both company files** — bills *and* purchase orders — for the same invoice already being there. If it finds one:

- The card says **"possible double-up across companies"** and names the document it found, in which company, with its date and amount.
- **There is no Approve button.** This is the one flag you cannot vouch for from the card, because the evidence is in the other company's file, which is not in front of you. Check both files, and if the invoice is genuinely new, enter it by hand and mark the card with **Entered manually?**.
- The same applies when the check **could not finish** (MYOB unreachable). "We didn't find one" and "we couldn't look" are not the same thing, and neither gets a button.

### 5.1b An invoice billed to the other company

If a bill is addressed to one company and arrives in the other's inbox, the portal reads who it is billed to off the document itself and acts on that, not on which mailbox it landed in.

- The card carries a 🔀 line: *"Invoiced to Just Autos Wholesale but arrived in the accounts@justautosmechanical.com.au inbox"*, and says which signal decided it.
- **The email is forwarded to the right company's accounts inbox**, once per email however many invoices are attached.
- **For Just Autos Wholesale, nothing is entered.** Wholesale invoices are only ever entered from the **"Portal Invoices"** folder, because the wholesale inbox also carries invoices against open purchase orders and stock receival that must not be posted automatically. The forwarded email says so. If the invoice should be paid by Wholesale, **drag it into that folder** and the portal enters it from there with all the usual checks. If it belongs to a purchase order or a stock receival, handle it as you normally would and leave it out of the folder.
- The inbox it came *from* gets a short Slack note saying where it went, so it does not simply vanish.

**⚠ An invoice that just says "Just Autos" is not routed anywhere.** That is the trading name both companies answer to, so guessing would be a coin toss — it stays in the inbox it arrived in and the cross-company check above is what protects it.

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

Suspected double-ups are marked with ♻ and posted to Slack rather than entered twice. Check the original before dismissing. Double-ups **across the two companies** are §5.1a — those get no Approve button at all.

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

**Phone Calls** lists every call with audio and transcript, plus coaching analysis scored against a rubric for that call type. A team coaching summary posts to Slack on Monday mornings, and the day's coaching is folded into the 5:15pm sales update (§4.1e-h).

**Changed 1 September 2026.** The Sentiment, Coaching, Words & Objections and Conversion tabs were removed. **Selecting an advisor on the left now filters the panel** — total calls, inbound, outbound, talk time — which it had never actually done before, so if you tried it in the past and nothing happened, that was a fault rather than you.

**Missed-call notifications during a live ring-group call were fixed on 1 September 2026.** You could get a “missed call” alert for a call somebody was in the middle of answering. If you still see one, note the time and tell Chris — the bell corrects itself when the call ends, but it should not appear at all.

Supervisors with permission can **Listen**, **Whisper** (only the rep hears you) or **Barge** (join the call) live.

Click-to-dial is available where enabled.

---

## 8. Reports

### 8.0 The tabs changed on 2 September 2026

Reports went from nine tabs to seven.

- **The first tab, "Reports", is gone.** It was the auto-generated AI report builder. The old address still works — it takes you to the Sales Report.
- **Workshop Map and Distributor Map are now one tab called "Maps".** Everything the Distributor Map showed you is on the **Quotes Map** inside it — see §8.6. An old Distributor Map link will land you in the right place.

Nothing else moved, and nobody lost access to anything they had.

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

**Comparing financial years.** The FY buttons top-right pick the year you're looking at; the **vs** buttons beside them add up to three more years to compare against. Comparison years only appear on Conversion, By State and Vehicle Trend — two years of dots on a map can't be read, so the maps stay on one year. On Vehicle Trend a comparison year draws as a dashed white line: the total of whichever vehicles you've selected, one line per year.

**Comparing vehicle types.** The **Compare** row on Vehicle Trend starts on *All types*. Pick any combination of vehicles to narrow it to those, and **vs others** then adds everything you didn't pick as a single grey dotted line — so "70 and 300 against everything else" is one click.

**Counting distributor tunes as jobs (Conversion).** A distributor tune reaches us as an invoice with the car's VIN in the PO field, so each unique VIN in a month is one more job. **Include distributor jobs** on the Conversion tab folds those into booked jobs, and the conversion % moves with them. It is **off by default**, and the reason matters: those jobs never had a workshop quote, so with it on the percentage reads higher than the workshop's own performance. Use it to see total work done; leave it off to judge the workshop's quoting. The by-vehicle table gains an *of which dist.* column so you can always see what the toggle did.

The toggle is greyed out when a state is selected — a distributor invoice carries no postcode, so those jobs can't honestly be put in one state. Clear the state filter to use it.

**Reading Conversion as a chart.** The **Table / Chart** switch turns both conversion tables into bars — one bar per vehicle for the year, and grouped bars per month. Same numbers, and with distributor jobs on, their share of each bar is hatched.

**Using Vehicle Trend:** pick the financial year, and you get one line per vehicle series across the twelve months. Click a month and it redraws day by day for that month. Switch the measure between Jobs, Quotes, Job $ and Quoted $. Clicking a vehicle highlights its line rather than hiding the others, so you keep the comparison.

**⚠** Vehicle Trend counts **every** invoice and quote, while the map tabs show one dot per customer per month. Its totals are legitimately higher — they are not disagreeing with each other, they are counting different things.

**Exporting the list behind one dot (CSV).** On the Jobs Map and Quotes Map, click a location bubble and the popup now has a **⬇ CSV** button in its header. It downloads every customer behind that dot as a spreadsheet — date, month, customer, vehicle series, job type (jobs) or won/not-won (quotes), the **MechanicDesk invoice or quote number**, amount inc GST, suburb, postcode and state. The popup itself only lists the 40 largest; the CSV has the lot, and says so when there are more.

The export honours whatever the screen is showing — month strip, vehicle chips and state pill — so filter first, then click the dot. The file names itself after the tab, FY and location (`workshop-quotes-FY2026-buderim-4556.csv`).

**⚠ One row per customer per month, not one row per quote.** These are the map's dots, so a customer who was quoted three times in a month appears once, at the largest quote, and a customer with three invoices in a month appears once at their combined spend with the largest invoice's number. It is a call list, not an accounting extract — for every individual record use the Vehicle Trend tab or MechanicDesk itself.

**Export PDF** (top right, next to the FY buttons) downloads the whole financial year **month by month** — jobs, revenue, quotes, quoted value, quotes won and conversion for each month, then quotes/jobs/quote-value broken down by vehicle series per month, conversion by vehicle, a state split and the top locations by revenue. It serves the same cached pull the screen shows, so it comes back in about a second and never triggers a MechanicDesk sync.

**The month strip does not change the PDF** — the export is always the full year, because month-by-month is the point of it. The **vehicle** and **state** filters *do* carry through, and the file is named accordingly (`workshop-map-FY2026-70-qld.pdf`). Filter to one vehicle or state and the booking-deposit figures drop out, because deposits carry neither a vehicle nor a postcode.

**⚠ Revenue columns cover mapped records only.** A job that never geocoded has no location and no amount in the payload, so it is missing from every revenue figure — but it *is* in the job and quote counts. The PDF states the coverage on its last page (e.g. 1,300 of 1,333 job records). Don't reconcile these revenue totals against MYOB.

### 8.6 Distributor Map

Quotes near each distributor against bookings they actually confirmed — the "are they converting the leads we send them" view.

**Just Autos is on the map too** (added 25 August 2026) — our own workshop at Burnside, as a pin and radius like any distributor, so you can see the demand sitting around us. Its pin is white and slightly larger so it doesn't read as a distributor.

**⚠ It carries quotes only — there is no "booked" figure for it, and that is deliberate, not a gap.** The Monday board is distributor bookings and Just Autos isn't on it, and our own jobs live in Mechanics Desk on a different footing (a distributor's bookings count wherever the customer is; ours would only count near the workshop). Comparing the two would be comparing different things, so the booked and capture columns show **—** rather than 0. For the same reason Just Autos is left out of the **All distributors** totals and out of the weekly sales recap — pick its pill to see it on its own.

At 50, 100 and 150 km our area can't overlap anyone's, because the nearest distributor is about 390 km away. At **250 km** it starts to overlap the nearest distributor's area, and a quote closer to us counts to us instead of them — so a distributor's number can look lower at 250 km than it did before.

**The background map changed on 31 August 2026** and looks slightly different on both this and the Workshop Map. Our old map supplier started demanding a paid key and stamped **"API KEY REQUIRED"** diagonally across every map until we moved. Nothing was wrong at our end and no figures were affected - it was only the background picture. There is now a small "Tiles © Esri" credit in the bottom corner, which the new supplier requires. If you ever see writing across the map again, say so - it means the same thing has happened to the new one.

**Export PDF** (top right of the controls row) downloads every month of the financial year for every distributor: a combined month-by-month table, an FY table per distributor ranked by quotes in their area, quotes / bookings / booking-value matrices with a column per month, and then a small month-by-month table for each distributor on its own — that last section is the one to take into a distributor conversation.

The **radius** you have selected carries into the PDF and into its filename (`distributor-map-FY2026-100km.pdf`), because the radius decides which quotes count as being in whose area. Unlike the Workshop Map export this one recomputes against Monday live, so give it a few seconds.

**⚠ Capture rate is geography, not a tracked hand-off.** "Quotes" are our own workshop quotes that happen to fall within the radius of a distributor; "Bookings" are confirmed rows on the Monday Distributor - Booking board. A low capture rate means quotes near them that they didn't book — it does **not** mean a specific quote was sent to them and lost. A distributor whose Monday label doesn't match a distributor record by name shows zero bookings; "Hunter Mechanical" deliberately stays unmatched because it matches both branches.

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

**What arrives without you doing anything.** At **7:30am on the 2nd of each month** the portal emails the month-just-ended stock report for JAWS to Chris and Morgan. **The email carries the last six months of sales**, both per SKU against stock on hand (the *Stock position* table — over or under stocked, at a glance) and as a company-file total per month, so the trend is in the email itself and not only behind a link. The full version lives at **Reports → Stock EOM**, where you can also pick an earlier month or press **Rebuild from MYOB** if something looks stale.

**Choosing how far back to look.** Under the buttons is a **Sales history** row: presets for 3, 6, 12 and 24 months, or two month boxes for an exact range. It sets the period every average on the report is worked out over — average sales per month, months of cover, and whether sales are growing or falling. It defaults to the 12 months ending with the month you're reading, and 36 months is as far back as it will go.

Change it, then press **Apply window** — the report rebuilds on the new period (it has to; the old figures were worked out over a different one). The *Sales by month* table shows the period month by month, so a run of rising or falling months is visible at a glance, and the **Growth over the window** tile compares the back half of the period against the front half.

**Two different "cover" numbers, on purpose.** *Cover (days)* is based on the last 90 days only — it reacts fast. *Months cover* is on-hand at the window average — it's steadier. When they disagree the SKU is seasonal or has just changed pace, and that gap is worth looking at rather than ignoring.

**On-hand shows in most tables now**, and it is the quantity **as at the moment the report was generated** (shown at the top). MYOB can only ever tell us today's quantity, so on an older month the stock figures are today's, while the sales figures are that month's.

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
| **Stock position** | **Six months of sales, month by month, against what is on the shelf now.** Over 6 months of cover reads *Overstocked*, under 1 month *Short*, and a SKU that hasn't sold in six months says *No sales*. Anything to act on is listed first | **The over/under-stocking answer.** The monthly columns are there so you can see *why*: four steady months then nothing is a different problem from one big month and five quiet ones |
| **Reorder suggestions** | **Only SKUs on the Stock Order sheet** — kit components that aren't sold separately are deliberately left out. Flagged when below the MYOB alert level, or under 60 days cover on something that moves. Quantity targets 90 days and respects MOQ; cost uses last price paid | This is the month's buy list. If something you order isn't listed, add it to the Stock Order sheet — the report only suggests what's on there, and it tells you how many off-sheet items it skipped |
| Sold while out of stock | Demand you couldn't fill on the spot | Raise the alert level on those SKUs |
| Sold below cost | Selling price ex GST is under average cost | Fix the price, or find out why it was discounted |
| **Cost creep** | Last paid is more than 10% above average cost — the buy price moved and the sell price probably didn't | The price-review list. Quietly the most valuable table in the report |
| Overstock | More than a year of cover at current run rate | Money you could get back |

**Two things to know before quoting any of it**

- **The on-hand figures are read when the report runs, not at midnight on the last day of the month.** MYOB can't give a historical quantity. The 2nd-of-the-month timing keeps the gap small, and the report prints the exact read time on its face.
- **Everything is measured as at the end of the reported month.** Sales made after it don't count, so re-running an old month always gives the same answer. The **Sold since** column on the slow-mover and never-sold lists shows what has moved *since* the month closed — so a part that looks like dead capital but has a number in that column is selling again, and can be left alone.
- **Margin is indicative, not the P&L.** It's units multiplied by *current* average cost, because invoice lines don't carry the cost of sale. It ranks SKUs honestly and finds leakage — but don't reconcile it to the accounts and don't expect it to match the year-end figures.

**Who can see it.** Admins and managers with stock access. It carries costs, margins and supplier pricing, so a reports-only login can't open it — that's deliberate, not a bug.

---

**Avg/mo is measured from a SKU's first selling month, not the whole window** (26 August 2026). A line that has only been out a month is no longer averaged across months it did not exist in. JA-VD300-1BB sold 7 in July on a six-month window: it read **1.17 a month** and now reads **7.00**, a six-fold difference on the number reorder decisions lean on.

Where the window is shortened the report says so beside the figure — **"(from 2026-07, no earlier sales)"** on screen and in the email, a **\*** with a footnote in the PDF — so you can see at a glance which averages rest on one month rather than six.

**Growth is left blank for those lines**, not shown as a big percentage. There is no earlier period to compare against, and "up 100%" against months a product did not exist in is noise.

The **Units** column in Top movers and Margin earners is now labelled **Sold units**, which is what it always was.

**⚠ Old reports keep their old figures until rebuilt.** The screen, the PDF and the email all serve the stored snapshot, so July's report still shows 1.17 for that SKU. Press **Rebuild from MYOB** on any month you want recalculated the new way.

### 8.10 Weekly Marketing Report

Emailed to Murph at 07:00 Monday from **2 September 2026**. Four sections: enquiries by channel (last week against the week before), demand with no distributor nearby, what people are asking for by vehicle, and where the enquiries come from.

**⚠ Only the enquiry table is weekly.** Everything else is financial-year-to-date, and the email says so on itself. The underlying quote data carries a month, not a day, so a genuinely weekly figure for those sections is not available — do not read them as "last week".

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
| An AP email produced TWO Slack cards that disagree | Fixed 1 September 2026 — an "own document"/quote card used to be followed by a "nothing entered" card calling the same document unreadable | If you see it again, send the pair to Chris; the second card is the wrong one |
| A supplier STATEMENT was treated as an invoice | Fixed 1 September 2026 — the guard only looked for the word "statement", so a file named `Stmt_...` slipped through and was flagged as a bill | Statements are now recognised by name *or* by reading the document. If one still gets flagged, don't approve it — send it to Chris |
| MYOB B2B invoice numbers skip one or more values | An order was abandoned at checkout or cancelled — it reserved the number and never produced a document | Nothing to fix. Search the number in Admin → B2B → Orders to confirm which order it was |
| An AP card has **no Approve & post button** | Deliberate, from 2 September 2026 — the invoice may already be entered in the *other* company, or the check could not finish | Check both company files. If it is genuinely new, enter it by hand and press **Entered manually?**. Do not look for a way around the missing button |
| A wholesale invoice was forwarded but nothing was entered | Deliberate — Just Autos Wholesale invoices are only entered from the **"Portal Invoices"** folder | If it should be paid by Wholesale, drag the email into that folder. If it belongs to a purchase order or stock receival, handle it as normal and leave it out |
| The cart says freight cannot be quoted | From 2 September 2026 there is no hand-typed fallback — the carrier did not return a rate | Quote it from the office. Check MachShip on Admin → Connections if it keeps happening |
| A distributor will not delete | They still have orders, tune jobs, training attempts or tune aliases — deleting would take that history with it | The message names what is holding it. Switch **Active** off instead: they keep their records and disappear from the ordering side |
| A cancelled order will not delete | It touched something real — a MYOB document, a payment, a refund, booked freight, or a supplier PO | The message says which. Only an order that never became anything can be deleted; the rest stay cancelled |
| The date picker will not open a calendar | Fixed 2 September 2026 — on the dark theme the calendar icon was being drawn almost invisibly | Click anywhere in the date field now, not just the icon |
| Order page shows a MYOB write error mentioning a duplicate number | The document was already created in MYOB on an earlier attempt; the retry reused the same number | Find the document in MYOB by that number, confirm it is right, and have it linked to the order rather than posting a second one |
| A drop-ship supplier PO arrived numbered `00001382` instead of ours | MYOB rejected our number (usually a duplicate) and fell back to its own sequence | Quote the MYOB PO number to the supplier for that one PO, and check whether two POs on the order ended up with the same number |
| 5:15pm post has sales figures but no coaching section | Nothing scored in the 4:30→4:30 window, or the coaching build failed | `coaching.reason` on `/api/admin/sales-update-preview`. The figures are unaffected by design |
| A late-afternoon call isn't in tonight's coaching | Expected — the coaching window closes at 4:30pm | It appears in tomorrow's post, and is already scored on **Calls** |
| A coaching note argues about who was on the call, or names someone not on staff | The transcription misheard the advisor's name (D/T and K/C are the common ones — "Dom" comes through as "Tom") | The attribution itself is taken from the advisor's own extension and is normally right. Tell Chris the call and the wrong name so the alias can be added to the roster |
| Nothing at all in #sales-updates after 5:15pm | The sales-update cron, or the bot isn't in the channel | Vercel logs for `/api/cron/sales-update`; it retries hourly to 9:15pm |
| Dashboard figures look stale | Overnight cache refresh | The 02:00 refresh cron, then the health page |
| Workshop map or vehicle trend looks out of date | The nightly MD pull | Reports → Workshop Map shows "synced"; "Pull from MechanicDesk now" forces it (~2–4 min) |
| A pallet quote looks far too cheap for the size of the order, or the goods clearly won't fit the pallet on the plan | Before 27 Aug 2026 pallets were counted by weight alone and chosen without checking the goods fit the deck | Fixed — the order is boxed first and pallets are filled by weight *and* space. If it still looks wrong, check the pallet's deck size and **max weight** in Settings → Freight packaging (§4.3a): the weight you enter is taken literally. |
| An item shows as its own consignment next to the pallets | It won't sit on the deck in any orientation, so it isn't pretended onto one | Correct behaviour, not a fault — pack and label it as the separate item the carrier is expecting. |
| A drop-ship order never turned into an invoice, and the distributor got no tracking | The supplier's confirmation reached us but something failed downstream (usually MYOB) | Fixed 28 Aug 2026 - it now retries three times and the supplier's dispatch email relays the tracking number to the distributor automatically. On an order from BEFORE that date, use **Supplier confirmed - bill PO + invoice** on the order page |
| A distributor says they never got tracking | Ship Now hasn't been pressed | §4.2 |
| Ship Now fails with *"The booking time has passed for all services on the specified collection date (477)"* | MachShip offered the collection time as the warehouse's 5pm **closing** time — a window with no length in it — and the carrier refuses that whatever the hour | Fixed 3 Sept 2026: an unusable time is replaced with the next hour today, or 9am on the next business day once the 2pm cut-off has passed. Press **Ship now** again |
| A shipping button says *Forbidden — insufficient permissions* | Before 3 Sept 2026 despatch was admin-only while the buttons showed for managers too | Fixed — managers can book and despatch. If it still happens, the login is on a narrower role than Manager (§9b) |
| Refund / Approve order / Delete order / Retry MYOB write / Raise drop-ship PO aren't on the order page | Those are admin-only, and as of 3 Sept 2026 they are hidden rather than shown-then-refused | Working as intended. Ask an admin, or have your role changed |
| An AP invoice never arrived | Supplier sent a link, not an attachment | §5 — link-only emails are invisible |
| A sales call is on the wrong advisor, or on nobody | Since 31 Aug 2026 calls are attributed from the handset that answered. If someone answers at another person's desk, only a clear self-introduction on the recording moves it | Check the extension is right in Admin → Users. Calls from BEFORE 31 Aug were hot-desked and are attributed from the recording only - those are not re-attributed and should not be |
| A supplier emailed an invoice, the email is sitting in accounts@, but it never appeared in MYOB or as a card | Until 28 Aug 2026 a PDF the reader choked on was filed as "not an invoice" - no card, no reason, and never looked at again | Fixed: it now retries three times and then posts a **red card** naming the file and the reason. If it happens on an OLDER email, **forward it to accounts@ again** - a forward is a new email, so it gets a fresh run |
| A red card says *Couldn't read an attachment* | The PDF could not be parsed after three tries - corrupt, password-protected, or an image with no text | Enter that one by hand. If the supplier can resend a normal PDF, forwarding it in re-runs it automatically |
| A Red Energy bill flags instead of posting, saying the amount was corrected | Deliberate. Their total is before the solar feed-in credit; the portal reads the printed *amount due* and posts that instead | Check the figure against the bill and approve. It flags every time on purpose for now - tell Chris once you are happy it is right and it can post on its own |
| An AP Slack card is still orange but the bill *is* in MYOB | Somebody entered it by hand; the automation has no way of knowing | Press **🔍 Entered manually?** on the card — it finds the bill, links it and turns the card green (§5.2) |
| A weekly email report shows a count that is clearly too low — or zero | A report query that has outgrown the database's 1000-row response cap and is silently dropping the rest | Don't assume the underlying data is missing — check the live screen (Reports → Workshop Map, Reports → Sales Report) for the same period first. If the screen is right and the email is wrong, it's the report, not the workshop. Tell Chris. |
| Someone approved leave and the person says they got nothing | Either the item wasn't on the application path (a note keyed into a payroll group — §9a), or the portal has no address for them | Settings → Leave Notifications: the item will be under "Waiting on an email address" if it's an address problem. If it isn't listed at all, the decision was made on a note rather than an application. |
| Ryan gets "no email address for …" notices | The applicant's name isn't in the staff directory and the item has no Email Address | Add either one (§9a) — the email then sends itself; nobody needs to re-approve. You only get that notice once per application. |
| Stock EOM figures look stale or wrong | The report shows a stored snapshot, so it's frozen at whatever time it was generated | Reports → Stock EOM → **Rebuild from MYOB**. If the on-hand looks off by a few days' trading, that's expected — see §8.9 |
| Dead stock drops sharply between two months | Months before September 2026 counted never-sold kit parts as dead stock; from 25 Aug 2026 they're excluded | Not a data loss — the old month is on the old basis. Reports → Stock EOM → pick that month → **Rebuild from MYOB** restates it so the two compare like for like |
| The month-end stock email didn't arrive on the 2nd | Either the MYOB connection or the recipient list | Admin → Connections for MYOB health, then Reports → Stock EOM → **Email this report** to send it by hand |
| The Slack parts bot says it can't find a part you know is in stock | The 30-minute stock sync was interrupted part-way and cached only some of the catalogue | Fixed 2026-08-27 — the sync now refuses to save a partial catalogue and keeps the last good one instead. If it happens again the bot's numbers will be *stale* rather than missing, so check when it last synced and tell Chris. Don't re-count the shelf over it. |
| A stocktake row shows a **negative** system QTY (e.g. −1) when the part is really at zero | A part committed or sold against stock that hasn't arrived yet. Until 28 Aug 2026 that read through to the count sheet, painting the row red for a discrepancy that isn't real | Fixed — the system QTY is never negative now; it shows 0, and the variance goes with it. On a count sheet from **before** that date, press **Refresh system quantities** (or Run Match) and the red rows clear. Note the QTY inside MechanicDesk's own stocktake keeps the old figure until the count is pushed again |
| A stocktake count is short and nobody can explain it | Parts fitted to cars on jobs that haven't been invoiced — MD still counts them as on-hand | Stocktake (MD) → the **On cars** panel. Use its **Should count** column as the target, not MD's on-hand. If it's stale, press **Check Mechanics Desk** first |
| Conversion % suddenly looks much better than you expected | **Include distributor jobs** is switched on — those jobs never had a workshop quote | Reports → Workshop Map → Conversion. Switch it off to see the workshop's own conversion; the *of which dist.* column shows what it was adding |
| **Ship now** fails with "CompanyId is required" | The portal could not work out which MachShip account owns the consignment | Fixed 2026-08-27 — it now reads that from the order itself. If it ever returns, the message will name what to do: set the fallback in Admin → B2B → Settings, or re-book the freight. **Do not keep pressing Ship now** — each attempt is a fresh manifest attempt |
| Someone can't see a tab | Permissions, working as designed | Ask Chris |

**Never work around a missing Approve button on an AP card.** It is missing because the same invoice may already be entered in the other company. That is how a bill gets paid twice, and it has happened.

**An order of $30,000 or more is not paid when you approve it.** Approving releases it to the warehouse. Wait for the bank transfer and record it before anything leaves.

**Deactivate, don't delete.** A distributor who has ever traded cannot be deleted, and should not be — switching Active off keeps their history and takes them off the ordering side.

**A quoted freight price is now always a real carrier rate.** If the portal says it cannot quote, quote it from the office — do not go looking for the old zone rates, they no longer price anything.

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
| Who gets the Monday marketing report | Settings → Integrations → `marketing_report_recipients` (comma-separated) |

**Settings tiles removed on 2 September 2026**: Workshop, Imports, Backfill, Audit Log and Data Imports — none were being used. The **default date range** setting went too: it saved your choice and nothing in the portal ever read it, so it was a control that did nothing rather than one that was broken.

---

### Distributors on the Maps (2 September 2026)

**Quotes Map → Show areas.** Puts every distributor on the map with a circle around them, and tells you how much of our quoting falls inside somebody's patch. Pick the radius — 50, 100, 150 or 200 km — and you get two lines:

- the totals: how many quotes (and how much) fall **inside** an area versus **outside** one;
- then one pill per distributor with their own count. Click a pill to fly to them; click **Outside every area** to see the quotes in nobody's territory, which are usually the interesting ones.

Where two circles overlap, the **nearer** distributor takes the quote, so nothing is counted twice. Our own workshop is on the map too and competes the same way — otherwise every Sunshine Coast quote would look like it belonged to whichever distributor happened to be closest.

The counts follow whatever month, vehicle and state filters you have set, so the numbers always describe the dots on screen.

**Jobs Map → Show tunes.** Puts each distributor on the map with the tunes they carried out, broken down by model. Those pins are **square and outlined**, not round like the customer dots — a distributor pin is work counted against their premises, not demand at that address, and one pin can carry 130 jobs.

**⚠ One car is one job.** A car tuned twice in the year counts once. The card shows the job count with a quiet line underneath saying how many were return visits.

**Conversion → Just Autos / Distributors / Both.** Three tabs where there used to be a tick box:

- **Just Autos** — the workshop on its own. This is the tab to judge the workshop on.
- **Both** — combined, broken out underneath so you can see which half is which.
- **Distributors** — their jobs by model, converted against the Just Autos quotes within the radius you choose.

**⚠ A combined conversion % flatters the workshop**, because distributor tunes never had a workshop quote behind them. And a distributor's own conversion is measured against *our* quotes near them, which is the only denominator that exists — read it as how busy their territory is, not as how well they close. Over 100% is real: it means they tuned more cars than we quoted near them, off their own customers.

### What a quote figure on the Workshop Map means

**One entry per customer per month, valued at the AVERAGE of that customer's quotes that month** (from 1 September 2026 — it used to show the highest).

The workshop re-quotes the same job all the time — a revision, a changed spec, a follow-up — so counting every quote would make the quote count and the conversion rate meaningless. Grouping by customer and month fixes that; averaging stops one large revision setting the value.

- A customer quoted **three times in March** appears **once**, at the average of the three.
- The same customer quoted again **in June** appears **again** — it is per month, not per year.
- Where a figure is an average, the map popup shows **avg ×N** beside it, and the CSV export has a **Quotes averaged** column.

**Expect totals about 6% lower than before**, which is the change in method, not a drop in quoting. Around a quarter of customer-months have more than one quote.

**Quotes with no address still count in the totals.** A quote we cannot place on the map is still a quote, so it is included in **Quoted (inc GST)** and in **All AU** — it just gets no dot and is not counted as a Location. Before 1 September 2026 those quotes were left out of the totals entirely, which understated quoted value by roughly 8%.

**Most "unknown" quotes have no address at all** — three quarters of them have neither suburb nor postcode, so there is nothing to place. The rest are now recovered where possible: misspellings, a postcode typed in the suburb box, and regions like "Gold Coast" or "Sunshine Coast" (pinned at the centre of that region). A quote that only says a state, or an overseas address, is deliberately left unplaced — a dot in the middle of Victoria would be misleading. **If you want fewer unknowns, the fix is putting suburbs on customers in Mechanics Desk.**

**⚠ The map updates overnight.** The figures rebuild in the 3:30am run, so a change made today shows tomorrow.

### Restricting someone to just a few screens

**Hiding tabs is not the same as removing access.** The tab list controls what a person SEES in the menu; their **role** controls what they can actually open. Someone left on Admin or Manager can still reach any page by typing its address, however few tabs they have.

So when someone should only see part of the portal:

1. **Set the role first.** *Marketing / reports only* is the narrowest — reports and nothing else. Use it for external people (agencies, contractors).
2. **Then narrow the reports list** to the specific reports they need.

Kate Sheridan is set up this way: role *Marketing / reports only*, reports limited to **Workshop Map** and **Distributor Map**. Signing in takes her straight to the Workshop Map.

**⚠ If you are unsure whether someone's role is too wide, ask before widening it.** It is easy to give an external login far more than intended, because the menu makes it look narrow.

## Appendix — the golden rules

1. **Book Shipment prepares. Ship Now despatches.** Nothing goes to the carrier and no tax invoice exists until Ship Now — whatever the button is called.
2. **Ship a despatch run in one action** — one manifest, one pickup.
3. **"Sales" in the weekly recap means orders, not turnover.**
4. **A never-quoted lead is not a lost quote.**
5. **Counted stocktake rows are sacred** — investigate before applying a variance.
6. **Check “On cars” before chasing a stocktake variance** — parts fitted to cars in the shop are still on MD's books. A short shelf is usually the answer, not a problem.
7. **Boxes first, then the deck.** On a palletised order pack each box from the pick list, then load the boxes onto the pallet — and a pallet's max weight in Settings is taken literally, so only enter what the carrier and the forklift will really take.
8. **The workshop runs on Mechanics Desk** — the portal handles parts, letters, counting and reporting around it.
9. **Credentials change in the portal**, not in environment variables.
10. **Reload when the new-version banner appears.**
11. **Leave is approved on the application, not on a note.** Pressing Approved on an item in Leave Applications emails the applicant; a line typed into a payroll group emails nobody.
12. **Check “Entered manually?” before approving an AP flag card** — approving one that was already keyed in by hand posts the bill twice.
13. **The B2B portal order number IS the MYOB invoice number.** Never renumber one of those documents in MYOB by hand — the payment, the drop-ship PO and the tax invoice all key off the number the portal reserved.
14. **Gaps in the MYOB B2B number series are normal.** An abandoned or cancelled order burns a number. Search it in Admin → B2B → Orders before treating a gap as a missing invoice.
15. **One post at 5:15pm has the lot** — sales figures and the day's call coaching, in #sales-updates.
