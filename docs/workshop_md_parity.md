# Workshop (VPS) — MechanicDesk parity checklist

Tracks the portal-native workshop build vs MechanicDesk's feature set. Source:
MD public feature pages + the autodesk_pro Flutter prototype (which mirrored MD)
+ the data model exposed by the existing MD scraper. MYOB file = **VPS**.

Last refreshed: 2026-06-10 (post "finalise the workshop module" build-out).

Legend: ✅ built · 🟡 partial · ⬜ not built (deliberate) · ⛔ out of scope

| MD module | Portal | Notes / gaps |
|---|---|---|
| Booking diary | ✅ | day + week + month, tech lanes (data-driven from `workshop_technicians`), department tabs + tech pills, click-create, drag-move between lanes/days, **drag-resize**, split jobs (multi-segment), day notes, workload bars, ⏱ live-clock badge |
| Job card | ✅ | line items + inventory picker, status flow, job-type presets w/ checklists, vehicle history, MYOB invoice (Item or Service layout), payments by tender, SMS, print/email PDFs, **Files & photos**, **time clock (actual vs quoted hrs)**, **credit/refund panel**, service-due quick-set |
| Quotes | ✅ | builder + convert-to-job, print/email PDF, job-type presets |
| Invoicing / payments | ✅ | MYOB Sale Order/Invoice push (gated `myob_posting_enabled`), per-tender deposit accounts, in-portal payment capture, tax-invoice PDF/email, invoices board (imported MD + portal), **credit notes** (negative Sale/Invoice + optional CreditRefund) |
| Customers & vehicles | ✅ | MYOB-synced customers, customer detail w/ history, **Vehicles tab** (global rego/VIN/owner search, detail w/ history + files), photo/doc uploads, per-record SMS. Gap: external rego/VIN lookup API (disabled stub) |
| Inventory / stock | ✅ | MYOB-synced (qty/alert/reorder/price levels), inventory screen + low-stock filter, part picker. Gap: barcode label printing |
| Suppliers & POs | ✅ | Purchase Orders module: suppliers, draft/sent/received, low-stock auto-generation, MYOB bill push |
| Service scheduling / reminders | ✅ | next-service + rego due dates on vehicles (job-card quick-set, vehicle page), automated ClickSend SMS via the reminders cron (lead-days configurable), due-soon/overdue filters |
| Tasks | ✅ | board (to-do / in-progress / done), priority, assignee, due date |
| Stocktake | ✅ | **portal-native sessions** over `workshop_inventory` (snapshot, scanner-friendly count, variance, MYOB Inventory/Adjustment + re-sync). MD stocktake stays on its own tab until MD is cancelled |
| Reporting | ✅ | Workshop Reports tab: Daily sales (by tender), Received payments, WIP, Income summary (labour/parts split), Stock value/low-stock, Technician productivity; CSV export; gated `view:reports` |
| Time / timesheets | ✅ | clock-on/off per tech per job (`workshop_time_entries`), live timer, actual vs quoted hours, diary indicator |
| Activity / audit | ✅ | `workshop_activity` feed across bookings/quotes/payments/files/credits/stocktakes |
| Data migration from MD | ✅ | import wizard (`/imports`) + importers for customers/vehicles/inventory/job types/quotes/invoices, keyed on md ids |
| Point of sale | ⛔ | quick counter sale — deliberately out of scope (decided 2026-06-10) |
| Online booking | ⛔ | public booking widget — deliberately out of scope (decided 2026-06-10) |
| Multi-site | ⛔ | single workshop (VPS) — out of scope |

## Before MechanicDesk can be cancelled (operational, not code)

1. Run the final MD data import via `/imports` (customers/vehicles/inventory/job types/quotes/invoices).
2. Verify the first real MYOB invoice push from a job against the live VPS file (still untested live).
3. Flip `myob_posting_enabled` ON only after MD's MYOB sync is off (avoid double-posting).
4. Set the **inventory adjustment account** (Settings → MYOB accounts) and run one parallel portal stocktake against an MD stocktake to validate.
5. Set ClickSend creds + `sms_enabled` for automated booking/service-due reminders (if not already on).
6. Switch InventoryTabs: delete the MD stocktake tab, rename "Stocktake (Portal)" → "Stocktake".
7. Internal stock-transfer (JAWS↔VPS) currently enters/receives POs in MD — re-point it at the portal PO module at cutover.

## Known small gaps / follow-ups

- External rego/VIN lookup (NEVDIS or similar) — disabled stub on the vehicle page.
- Barcode label printing for parts.
- `Sale/CreditRefund` endpoint unverified against the VPS file — refunds fall back to local + manual MYOB settle if it rejects.
- Moving a booking doesn't reschedule its already-queued booking-reminder SMS.
- Diary week view has no drag-resize (day view only, by design).
