# JA Portal — Workshop Map & Conversion (live build handoff)

Build a live version of the FY workshop dashboard currently prototyped as a static file.
**Visual + behavioural acceptance target:** `JA_FY2026_Workshop_Dashboard.html` (the static build). The live version should look and behave the same, but read from live data instead of two manual `.xls` exports.

**Attached reference files**
- `vehicleClassification.ts` — the core business logic (classification, noise rules, dedup, geocode, conversion helpers). Port/import this as-is; do **not** re-derive the rules.
- `au-states.min.geojson` — simplified AU state polygons for the map base (land fill + outlines). Ship as a static asset.

---

## 1. What it is

A single page with three tabs, sharing one map + a month strip + a vehicle filter:

1. **Jobs Map** — booked workshop jobs (from invoices), pins per postcode, coloured by vehicle, sized by revenue.
2. **Quotes Map** — quotes issued, same treatment, sized by quoted $.
3. **Conversion** — quotes vs booked jobs per vehicle per month (independent counts), summary cards + by-vehicle table + month grid.

Everything is per-month (AU FY, Jul→Jun) and filterable by vehicle type.

---

## 2. Data sources & ingest

The prototype was built from two Mechanics Desk exports (Workshop ID **5108**):
- **Invoices export** — sheets: `Invoices Summary`, `Invoice Items`, `Invoice Payment`, `Credit Notes`.
- **Quotes export** — sheets: `Quotes`, `Quote Items` … `Quote Items 6` (paginated line items).

MD has **no open API** (confirmed), so this is Playwright-scraped like the existing WIP pull.

**Pipeline: pull ALL invoices and ALL quotes from Mechanics Desk, once daily.**
- A dedicated **daily** GitHub Actions cron (run off-peak, e.g. early AM AEST) — **separate** from the existing 2 h WIP snapshot job; don't piggyback on it.
- Each run drives Playwright to export the **full Invoices report** and the **full Quotes report** for Workshop 5108 (complete dataset, not incremental), downloads the `.xls` files, and parses every sheet.
- **Full refresh with idempotent upsert** keyed on `invoice_number` / `quote_number`. Because it re-pulls everything daily it self-heals: invoices getting finalised, quote **status changes** (delivered → job created), late edits, and back-dated records all reconcile without drift. Old rows that vanish from MD can be soft-flagged rather than hard-deleted.
- Do **classification + geocoding at ingest** and persist the computed fields (`vehicle_group`, `inferred`, `is_noise`, `lat/lng`, `locality`, `month`, quote `won`) so the read API is a cheap `SELECT`.
- Store a `synced_at` timestamp + row counts per run; surface last-sync + count on the dashboard so a failed/partial scrape is obvious. Log to Vercel/Actions output for debugging.

> The `.xls` files are the old binary (CDFV2) format — parse with a lib that reads legacy `.xls` (e.g. `xlsx`/SheetJS in Node, `xlrd` in Python). Dates are `DD/MM/YYYY`. Quote line items span **6 sheets** (`Quote Items` … `Quote Items 6`) — concatenate them all before joining to quotes.

### Fields required from each export

**Invoices Summary**: `Invoice Number`, `Customer ID`, `Customer Name`, `Customer Suburb`, `Customer State`, `Customer Postcode`, `Vehicle ID`, `Vehicle Registration Number`, `First Job Type`, `Description`, `Issue Date` (DD/MM/YYYY), `Total Amount`.
**Invoice Items** (join on `Invoice Number`): `Description`, `Details`, `Stock Name`, `Stock Number`, `Vehicle Make`, `Vehicle Model`.
**Quotes**: `Quote Number`, `Date` (DD/MM/YYYY), `Total Amount`, `Vehicle Make`, `Vehicle Model`, `Customer ID`, `Customer Name`, `Suburb`, `State`, `Postcode`, `Status`.
**Quote Items** (concat all 6 sheets, join on `Quote Number`): `Description`, `Details`, `Stock Name`, `Stock Number`, `Category`, `Vehicle Registration Number`.

> Per-invoice / per-quote **itemsText** = space-joined `Description + Details + Stock Name + Stock Number (+ Category)` across that record's line items. This is what the classifier scans when the job type has no chassis code.

### Postcode → lat/lng dataset
Seed a `au_postcodes` table from the Matthew Proctor open dataset
(`github.com/matthewproctor/australianpostcodes`, CC-licensed): columns `postcode, locality, state, lat, long`.
Build two lookups at ingest:
- `postcodeMap`: 4-digit postcode → mean(lat,lng) across its localities.
- `suburbMap`: UPPER(locality) → mean(lat,lng) (fallback when postcode is blank).
Geocode coverage on the prototype was ~97% (jobs) / ~92% (quotes).

---

## 3. Suggested data model (Supabase / Postgres)

```
md_invoices(         invoice_number PK, customer_id, customer_name,
                     suburb, state, postcode, vehicle_id, rego,
                     first_job_type, description, items_text,
                     issue_date, total_amount,
                     -- computed at ingest:
                     vehicle_group, inferred bool, is_noise bool,
                     lat, lng, locality, month )   -- month = 'YYYY-MM'
md_quotes(           quote_number PK, customer_id, customer_name,
                     suburb, state, postcode, rego,
                     vehicle_model, description, items_text,
                     quote_date, total_amount, status, won bool,
                     -- computed:
                     vehicle_group, inferred bool,
                     lat, lng, locality, month )
au_postcodes(        postcode, locality, state, lat, long )
```
Index `(month, vehicle_group)` on both fact tables.

---

## 4. Business logic (authoritative — use `vehicleClassification.ts`)

### 4.1 Vehicle classification
Chassis codes → series, decision order (highest-trust first):
1. Chassis in **First Job Type** (authoritative, per-job).
2. Chassis in **Vehicle Model** field.
3. Model text says **Prado / Hilux**.
4. **Vehicle ID** → series backfill (mode of that vehicle's explicitly-coded invoices).
5. **Dominant** chassis in description + line items (count hits, highest wins).
6. **Rego** → series backfill.
7. `CLUTCH` / `1300NM` / `1600NM` on a LandCruiser → **70 Series** (manual-clutch tell).
8. LandCruiser but unresolved → `LCNA`; unknown → `OTH`.

Chassis map: `FJA300→300`; `VDJ200/UZJ200→200`; `VDJ7x/GDJ7x→70`; `GDJ150/GRJ150/KDJ150/GDJ250→PRADO`; `GUN12[56]/KUN2[56]→HILUX`. Tie-break priority **70 > 200 > 300 > PRADO > HILUX** (this is the fix for the historical "VDJ79 multimap counted as 200" bug — see §7 validation).

Build `vehicleIdMap` / `regoMap` from the **invoice** set (`buildIdSeriesMaps`) and reuse them to backfill **quotes** whose vehicle also appears in invoices.

### 4.2 Noise exclusion (JOBS only)
Drop an invoice from "clear jobs" if any: deposit / booking fee, diagnostic, remote-support dongle, toll / courtesy car, `$0`, or customer name starts with `JUST AUTOS` (internal/staff/wholesale). Quotes are **not** noise-filtered.

### 4.3 Dedup — **1 per (customer, month), keep largest**
Apply to **both** jobs and quotes so conversion is like-for-like. Group by `(customer_id, month)`, keep the highest `total_amount` row.

### 4.4 Conversion
Per vehicle per month: `quotes` = deduped quote count, `jobs` = deduped clean-job count, `conv% = jobs / quotes`. **Counted independently — they do not link** (a quote may convert in a later month; the FY column is the reliable read). Quote `Status`-based "won" is stored for reference only; do **not** use it for conversion (bookings frequently aren't linked back to the quote, so it under-reports).

---

## 5. Read API

Prefer one endpoint returning the combined structure the front-end already expects
(mirror the static build's JSON):

```
GET /api/workshop/map   →  {
  months: [{k:'2025-07', label:'Jul 25'}, …],
  cats:   VEHICLE_CATS,
  jobs:   { points:[{la,ln,pc,l,m,g,c,a,x?}], meta:{customers,mapped,clean_total,inferred} },
  quotes: { points:[{la,ln,pc,l,m,g,c,a,w}],  meta:{total_quotes,mapped,total_value} },
  conv:   { qcount:{g:[12]}, qval:{g:[12]}, jcount:{g:[12]} }
}
```
Point keys are intentionally short (payload size): `la`/`ln` lat/lng, `pc` postcode, `l` locality label, `m` month index 0–11, `g` vehicle group, `c` customer, `a` amount, `x` inferred flag (jobs), `w` won flag (quotes). Only ship geocoded rows as points; keep the ungeocoded count in `meta`.

> Portal gotcha (from prior build): files under `/pages/api/` must be `.ts` only. Vercel function logs are the fastest way to debug ingest/query. Note: invoices for this feature come from the **daily MD scrape** (§2), **not** MYOB/CData — keep it single-sourced so quotes and jobs stay on the same basis and reconcile against each other.

---

## 6. Front-end spec

Stack: React + Leaflet (or react-leaflet). Reproduce the static build:

- **Layout**: header (title + tab bar) → stat row (map tabs only) → month strip → vehicle chip strip → map / conversion view.
- **Tabs**: `Jobs Map` (default) · `Quotes Map` · `Conversion`. Map tabs share month + vehicle state; stat row relabels (Revenue/Jobs vs Quoted/Quotes).
- **Map base**: CartoDB `dark_all` tiles **plus** the embedded `au-states.min.geojson` (land fill `#172230`, outline `#4a6076`) so the country/states render even if tiles are blocked. State labels (WA/NT/SA/QLD/NSW/VIC/TAS), capital-city dots, and a mint "Sunshine Coast" home marker. Use Leaflet `divIcon` with `className:''` for labels (default `leaflet-div-icon` adds an unwanted white box — force `background:transparent;border:0`).
- **Markers**: circleMarkers per postcode, radius by value (`jobs: sqrt(t)/18`, `quotes: sqrt(t)/95`, clamped), colour = dominant vehicle group at that location (or the selected filter's colour). Popups: location + postcode, headline value + count (+ won for quotes), per-vehicle split, top rows (customer, amount, inferred `≈` / won `✓`).
- **Vehicle chips** double as legend + live per-month numbers, and filter the map.
- **Conversion view**: 4 summary cards (quotes, booked jobs, overall conv%, total quoted) + by-vehicle FY table + month×vehicle conv% grid (cell = `jobs/quotes`, colour-scaled).

### Brand tokens (Just Autos "Dark & Rugged")
```
--bg #0B0E13  --panel #121821  --panel2 #19212D  --line #243040
--blue #11ADE6 (electric)  --mint #47FFCF  --amber #FFB454
--txt #E6EDF3  --muted #7A8696
Fonts: Barlow Condensed (Black Italic display) · Space Mono (data/numerals) · Barlow (body)
Vehicle colours: 70 #FFB454 · 200 #11ADE6 · 300 #47FFCF · Hilux #B388FF · Prado #FF6FB5 · LCNA #8aa0b8 · Other #6b7a8d
```

---

## 7. Validation / acceptance checks

- **No chassis mismatch**: 0 invoices/quotes where the First-Job-Type chassis ≠ assigned group (esp. no `VDJ79` under `200`). This is the regression that prompted the rewrite — assert it in a test.
- Reproduce prototype FY numbers (1-per-customer-per-month basis):
  - Jobs: ~1,300 clean jobs, ~$8.7M. Quotes: ~12,850, ~$157M.
  - Conversion by vehicle ≈ 70:11% · 200:10% · 300:9% · Hilux:8% · Prado:6% (overall ~9%).
- LandCruiser `LCNA` should be tiny (~1–2% of quotes/jobs).

---

## 8. Known caveats to preserve (don't "fix" silently)
- Conversion counts are **independent** (quote month ≠ booking month). Show the FY column as the headline; month cells are indicative.
- Quote **values are gross** and inflated by multi-option / full-build quotes — avg quote ≫ avg booked job. If a value-based conversion is wanted, add it as a separate toggle, don't replace count-based.
- ~3–8% of records are ungeocoded (blank/odd address). Keep them in totals, off the map, and surface the count.

---

## 9. Nice-to-haves (backlog, not required for parity)
- Value-based conversion toggle (quoted $ vs booked $).
- Overlay both quote + job pins on one map for visual comparison.
- Product/service breakdown (Multimap vs Easy Lock vs clutch vs DPF/exhaust vs airbox) as a second filter dimension — the line-item `Category`/`Stock` fields support it.
- Rep/salesperson dimension (Invoices Summary has Salesperson).

---

## 10. Unrelated bug found during this work
The portal MCP `get_quotes` currently errors: *"more than one relationship was found for 'workshop_quotes' and 'workshop_customers'"*. The quotes→customers embed is ambiguous — disambiguate the FK in that Supabase query (specify which relationship to use). Also 100-row capped with no date filter, so not suitable for bulk pulls regardless.
