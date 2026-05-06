# JA Portal — System Overview

Architecture and what each component does. Updated 7 May 2026.

---

## What the portal is

A Next.js application deployed to Vercel that surfaces MYOB JAWS + VPS data, runs an end-to-end AP automation pipeline, and houses an internal-only B2B distributor ordering surface. **Live and in daily use.**

Repo: `ChrisJustAutos/JA-Portal`
Hosting: Vercel (production), connected to `main` branch
Database: Supabase project `qtiscbvhlvdvafwtdtcd`

---

## The two business entities

- **JAWS** — Just Autos Wholesale, distribution arm holding stock, 14 distributors across Australia
- **VPS** — Vehicle Performance Solutions, the workshop entity, single Just Autos site, runs on Mechanics Desk

The portal pulls live data from both MYOB company files. AP automation writes back to whichever entity the supplier invoice belongs to.

---

## Live pages

- **`/distributors`** — distributor revenue dashboard pulling from MYOB JAWS via CData
- **`/calls`** — call list with audio playback and Deepgram transcripts, sourced from FreePBX CDR
- **`/ap`, `/ap/[id]`, `/ap/statement`** — AP automation surface: parsed invoices listed for review, drill-down with line items, statement reconciliation
- **`/admin/b2b`, `/admin/b2b/catalogue`, `/admin/b2b/distributors`, `/admin/b2b/orders`, `/admin/b2b/settings`** — internal admin for the B2B portal (distributor-facing UI not yet exposed)
- **`/b2b/*`** — distributor-facing B2B routes (login, catalogue, cart, checkout, orders) — built and Stripe-wired but not yet rolled out to distributors
- **`/admin/connections`** — integrations health dashboard
- **`/admin/groups`, `/admin/vin-codes`, `/admin/backfill`** — admin tooling for distributor groupings, VIN-to-model mapping, and historical data backfills
- **`/forecasting`** — monthly revenue forecast vs actual with target editor (admin)
- **`/sales`, `/dashboard`, `/overview`, `/reports`** — sales dashboards and reporting surfaces
- **`/stocktake`, `/stocktake/[id]`** — XLSX upload → match SKUs against MD → push counts to MD stocktake (admin/manager)
- **`/supplier-invoices`, `/supplier-invoices/[id]`** — supplier invoice browsing surface (read-side of AP)
- **`/job-reports`** — MD job report ingest + browse
- **`/jobs`, `/vehicle-sales`, `/todos`, `/settings`** — supporting surfaces
- Auth: per-user roles (admin/manager/staff/restricted) with `view:*` and `edit:*` permissions per area

---

## Backend pipelines (currently live)

Major pipelines, each documented in detail in `04_PIPELINES.md`:

1. **MYOB data via CData (read-side)** — CData MCP server provides read access to MYOB AccountRight tables for both JAWS and VPS. Used for reporting.
2. **MYOB direct OAuth (write-side)** — custom Node implementation in the portal (`/api/myob/auth/connect`, `/api/myob/auth/callback`). Bypasses the CData line-item write limitation. Used by the AP pipeline to push full bills with line items.
3. **AP pipeline (end-to-end)** — supplier emails → MS Graph webhook → PDF parse → portal `/ap` for review → MYOB push (header + line items) via direct OAuth. Replaced manual AP entry.
4. **Phone call analytics** — FreePBX CDR → systemd timer → Supabase → Deepgram transcription → `/calls` page.
5. **Pipeline A — Quote ingest** — MS Graph webhook on quote-sender mailboxes → Vercel API → ActiveCampaign + Monday.com Quote-Pending board with PDF attached.
6. **Pipeline B — Fetch Call Notes** — Monday.com button → webhook → portal API → pulls related calls/transcripts → posts AI-summary as Update on the quote item.
7. **Mechanics Desk auto-pull** — GitHub Actions cron runs Playwright every 2 hours during work hours to log into MD, download Job Report, ingest as forecast lane in Supabase. Plus nightly WIP report ingest via Graph webhook.
8. **Stocktake auto-fill** — XLSX uploaded by user → CSV parsed → SKUs matched to MD products → counts pushed to in-progress MD stocktake. Match and push run on GitHub Actions.
9. **B2B order ingest (admin-side, not yet customer-facing)** — Stripe webhook (`/api/b2b/stripe/webhook`) wired up. Distributor side not yet rolled out.

---

## Infrastructure

**Vercel** — Next.js production deployment, function logs visible in dashboard
**Supabase** (`qtiscbvhlvdvafwtdtcd`) — Postgres tables for calls, transcripts, stocktake_uploads, jobs, quote_events, AP invoices, AP line rules, B2B catalogue/orders/users, etc.
**GitHub Actions** — long-running browser jobs (anything Playwright-based) inside `mcr.microsoft.com/playwright:v1.59.1-noble`
**FreePBX host** — runs `sync.js` (CDR → Supabase) and `transcribe.js` (Supabase → Deepgram) on systemd timers
**Mechanics Desk** — `mechanicdesk.com.au`, no open API, accessed via Playwright login
**MS Graph** — webhook subscriptions on multiple mailboxes (sales reps + supplier-invoice intake), renewed every 6 hours via cron
**MYOB AccountRight** — direct OAuth2 from the portal (custom implementation), plus CData read access in parallel
**Stripe** — payment processing for B2B checkout flow (built, internal-only)

---

## Mobile / remote operations setup (added 7 May 2026)

The portal is operable end-to-end from a phone via:

- **Workshop laptop** (Windows, MSI) running OpenSSH server + Tailscale + Claude Code
- **Phone** with Tailscale + Termius (SSH client) joined to the same Tailscale network
- **GitHub MCP write access** authorised on the `ChrisJustAutos` account (the Claude GitHub App is installed on JA-Portal repo)
- **Direct GitHub MCP push** from chat sessions — code changes can be committed to `main` from within Claude conversations without the laptop loop

This means: code changes can be pushed from this chat directly. Operational tasks that need real shell access (live logs, ad-hoc queries, restarting stuck workers) go via SSH-from-phone → Claude Code on the laptop.

Default workflow for Claude commits: push directly to `main`. No staging branch yet.

---

## Top-level repo structure

```
JA-Portal/
├── pages/                    # Next.js routes
│   ├── api/                  # API handlers (.ts only — never .tsx)
│   │   ├── ap/               # AP pipeline endpoints
│   │   ├── b2b/              # B2B catalogue, orders, cart, Stripe webhook
│   │   ├── myob/             # Direct MYOB OAuth + writes
│   │   ├── stocktake/
│   │   ├── jobs/
│   │   ├── calls/
│   │   ├── monday/
│   │   ├── graph/
│   │   ├── webhooks/
│   │   ├── cron/
│   │   └── auth/
│   ├── ap/                   # AP review UI
│   ├── admin/                # Admin surfaces (b2b, groups, vin-codes, backfill, connections)
│   ├── b2b/                  # Distributor-facing B2B (internal-only currently)
│   ├── stocktake/            # Stocktake UI
│   ├── calls/                # Call analytics UI
│   ├── distributors/         # Distributor dashboard
│   ├── forecasting/          # Forecast UI
│   ├── sales/, dashboard/, overview/, reports/
│   ├── supplier-invoices/    # Supplier invoice browse
│   └── job-reports/, jobs/, vehicle-sales/, todos/, settings/
├── lib/                      # Shared business logic
├── components/               # React components
├── scripts/                  # GH Actions workers
├── migrations/               # DB migrations
├── .github/workflows/        # GH Actions YAML
└── package.json
```

---

## People

| Person | Role | What they own/decide |
|---|---|---|
| Chris | Operations Manager | Portal direction (this is the user) |
| Nat | Accountant | Chart of accounts, MYOB reconciliation sign-off |
| Matt Ashley | Technical | MYOB API, integrations |
| Matt H | Operations / Sales | Operational workflows, sales process |
| Amanda | AP | Accounts payable workflows (now reviews on `/ap` instead of MYOB In Tray) |
| Laura | Director | Director-level decisions |
| Kate Sheridan | Devote Digital | Digital marketing |

---

## What's NOT the portal

These come up in adjacent conversations but are scoped separately:

- **AutoOS / AutoDesk Pro** — Flutter desktop app, on hold. Components being delivered piecemeal as portal features instead.
- **Cin7 migration for JAWS/VPS** — separate planning track. Portal investment evaluated against Cin7 spend, not as part of it.
- **Mechanics Desk product roadmap** — no API. Portal integrates by scraping via Playwright.
- **Side AI consulting business** — Chris's separate venture, not Just Autos work.
