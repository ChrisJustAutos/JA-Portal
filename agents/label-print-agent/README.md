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

## Tuning the print
`pdf-to-printer` prints via the bundled SumatraPDF. If labels come out scaled
wrong, change `PRINT_SCALE` in `.env`:
- `fit` (default) — scale the 4×6 PDF to the label.
- `noscale` — print 1:1 (use if MachShip already gives an exactly-4×6 PDF).
Set the DYMO's default paper to **4″ × 6″** in Windows printer preferences.

## Statuses (`label_print_jobs.status`)
`pending` → `printing` → `done` | `failed` (after `MAX_ATTEMPTS`). Re-queue a
failed job by setting its status back to `pending`.
