# MechanicDesk screenshots — for the Workshop ↔ MYOB integration

Drop screenshots in **this folder** (`docs/md-screenshots/`), then tell me the
filenames (or just say "added them"). I'll read each image and use it to
replicate MD's sales / parts / payment behaviour into the portal + MYOB (VPS).

PNG or JPG is fine. Name them anything; a hint in the name helps
(e.g. `invoice-with-parts.png`, `take-payment-dialog.png`).

## Most useful shots (rough priority)

**Sales / invoice**
- A completed job converted to an invoice, showing the line items — ideally a
  mix of **parts, labour, sublet, and fees** so I can see how each is treated.
- How GST shows per line (GST vs GST-free).
- Any invoice header/footer fields that matter (PO number, notes, terms).

**Parts**
- Adding a part to a job from stock (the part picker), showing buy/sell price,
  markup, GST, and whether on-hand qty / stock is affected.
- A part that's **not** in stock / a one-off / special order, if you handle those.

**Payments**
- The **"Take payment" dialog** — every payment type you use
  (cash, EFTPOS/card, direct deposit/EFT, cheque, on-account, etc.).
- A **part payment / deposit** on a job (and where the balance shows).
- A **split payment** (e.g. part card, part cash) if you do them.
- An **on-account / charge-to-account** customer sale, if you have account customers.

**Money flow (helps map to MYOB accounts)**
- Anything showing which ledger/account a sale, part, or payment lands in.
- End-of-day / banking / reconciliation screen if MD has one.

**Anything else** you think defines how the workshop bills and gets paid —
over-share rather than under-share.
