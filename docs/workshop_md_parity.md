# Workshop (VPS) — MechanicDesk parity checklist

Tracks the portal-native workshop build vs MechanicDesk's feature set. Source:
MD public feature pages + the autodesk_pro Flutter prototype (which mirrored MD)
+ the data model exposed by the existing MD scraper. MYOB file = **VPS**.

Legend: ✅ built · 🟡 partial · ⬜ not yet

| MD module | Portal | Notes / gaps |
|---|---|---|
| Booking diary | 🟡 | day + week + tech lanes, click-create/move. Gaps: month view, drag-resize, colour-by-job-type, diary notes |
| Job card | ✅ | line items, status flow, vehicle history, MYOB invoice. Gaps: PO/Bills/COGS tabs, clock/timesheet, print/email |
| Quotes | ✅ | builder + convert-to-job. Gaps: email to customer, quote templates |
| Invoicing / payments | 🟡 | job → MYOB Service sale (Order default). Gaps: in-portal payment capture, PDF/email (MYOB holds debtors) |
| Customers & vehicles | ✅ | MYOB-synced customers + vehicles + service history. Gaps: photo/doc uploads, per-record SMS/email |
| Inventory / stock | 🟡 | synced from MYOB (qty/alert/reorder/on-order/price levels) + part picker + **inventory screen**. Gaps: barcode/labels, stock take in-portal |
| Suppliers & POs | ⬜ | supplier is a field on inventory. Gaps: PO generation (reuse b2b MYOB PO rails), Bills, Repco/Burson |
| Service scheduling / reminders | ⬜ | service/rego/WoF due dates + SMS/email reminders. **Needs an SMS provider** |
| Tasks | ✅ | board (to-do / in-progress / done), priority, assignee, due date |
| Point of sale | ⬜ | quick counter sale + barcode |
| Reporting | 🟡 | portal P&L/calls reports; workshop WIP/income/stock reports ⬜ |
| Multi-site | ⬜ | single workshop (VPS) |
| Accounting (MYOB/Xero) | ✅ | MYOB VPS: invoice push + customer/stock sync |

## Build order (remaining)
1. ✅ Inventory screen · ✅ Tasks  (batch 1)
2. Diary: notes on calendar, month view, drag-resize
3. Job card: Purchase Orders + Bills tabs (MYOB PO rails), COGS, print/email PDF
4. Service scheduling + reminders (SMS provider: ClickSend/MessageMedia — TBD)
5. Quote/invoice PDF + email
6. Reporting (WIP / income / stock), POS, multi-site — lower priority
