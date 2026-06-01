# JA Label Print Agent

Auto-prints B2B freight labels to the workshop **DYMO LabelWriter 4XL**.

When freight is booked in the portal (admin "Book via MachShip", the email
Book-Freight action, or a test order), the portal stores the MachShip label PDF
and inserts a row into `label_print_jobs`. This agent — running on the workshop
PC the DYMO is attached to — picks the job up over Supabase Realtime, downloads
the label, and prints it. It also drains any pending jobs on startup, so labels
queued while it was offline still print.

This is the same "local agent + Supabase as the bus" pattern as the FreePBX
monitors. It is NOT deployed to Vercel — it runs on the workshop machine.

## Requirements
- Windows PC with the **DYMO LabelWriter 4XL** installed (4×6" media).
- **Node.js 18+**.
- The Supabase **service-role key** (Project → Settings → API).

## Install
```bat
cd agents\label-print-agent
npm install
copy .env.example .env
:: edit .env — paste the service-role key and confirm the printer name
```
Find the exact printer name:
```bat
node -e "require('pdf-to-printer').getPrinters().then(p=>console.log(p.map(x=>x.name)))"
```

## Run
```bat
npm start
```
Book a test order's freight in the portal → a label should print within a few
seconds. Watch the console for `✓ printed`.

## Run as a Windows service (so it survives reboots)
Use [NSSM](https://nssm.cc/):
```bat
nssm install JALabelPrint "C:\Program Files\nodejs\node.exe" "C:\path\to\agents\label-print-agent\index.js"
nssm set JALabelPrint AppDirectory "C:\path\to\agents\label-print-agent"
nssm set JALabelPrint AppEnvironmentExtra ^
  SUPABASE_URL=https://qtiscbvhlvdvafwtdtcd.supabase.co ^
  SUPABASE_SERVICE_ROLE_KEY=... ^
  DYMO_PRINTER_NAME="DYMO LabelWriter 4XL"
nssm start JALabelPrint
```
(or just load the `.env` and run under `pm2`.)

## Network DYMO (raw port 9100)

If the DYMO is a network unit (e.g. `DYMOLW5XL30234cE.local`, port 9100) it is
independent of any one PC — run this agent on whichever machine is reliably on
(e.g. the front-desk inbox PC), it doesn't have to be the machine the printer
"belongs" to.

DYMO can't be fed a PDF straight over 9100 (that raw stream is a Zebra/ZPL
thing) — it must be rendered by the DYMO driver. So on the agent's PC:
1. Install the **DYMO LabelWriter 5XL** driver (DYMO Connect).
2. Add Printer → **Add using TCP/IP** → Hostname `DYMOLW5XL30234cE.local`,
   **Raw**, **port 9100** → pick the DYMO 5XL driver → name it.
3. Set default paper to 4×6 and print a Windows test page.
4. Put that printer's exact name in `DYMO_PRINTER_NAME`.

The agent then prints the PDF through the driver, which sends it to the printer
over the network — no dependency on any other PC.

## Run on several PCs (no single machine has to be on)

You can install this agent on **every** front-of-house PC. They all watch the
same queue, but the claim is atomic, so **exactly one** prints each label — no
duplicates. Whichever PCs are on at the time share the work; if one is off the
others cover; if all are off, labels queue and print when any PC comes back on.
A job left half-done by a PC that crashed mid-print is auto-reclaimed after
`STALE_PRINTING_MS` (default 2 min) and retried by another PC.

Per PC: add the network DYMO (TCP/IP 9100, below), install + run the agent with
its own `.env` (`DYMO_PRINTER_NAME` = the printer's name on that PC). Keep the
service-role key in each local `.env` only (not on a synced/shared drive).

## Tuning the print
`pdf-to-printer` prints via the bundled SumatraPDF. If labels come out scaled
wrong, change `PRINT_SCALE` in `.env`:
- `fit` (default) — scale the 4×6 PDF to the label.
- `noscale` — print 1:1 (use if MachShip already gives an exactly-4×6 PDF).
Set the DYMO's default paper to **4″ × 6″** in Windows printer preferences.

## Statuses (`label_print_jobs.status`)
`pending` → `printing` → `done` | `failed` (after `MAX_ATTEMPTS`). Re-queue a
failed job by setting its status back to `pending`.
