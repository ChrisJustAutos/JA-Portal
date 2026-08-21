# JA Portal — Full Handover Document

How the portal is built, where it runs, every connection it has (and how to set up or change them), and operating procedures for every module.

Compiled 20 August 2026 from the live codebase. Supersedes `03_SYSTEM_OVERVIEW.md` / `05_INTEGRATIONS.md` (May 2026) where they conflict.

---

## 1. What the portal is

An internal management platform for **Just Autos**, covering two MYOB business entities:

- **JAWS** — Just Autos Wholesale (distribution arm, holds stock, ~14 distributors across Australia)
- **VPS** — Vehicle Performance Solutions (the workshop entity; runs on **Mechanics Desk**, which remains the system of record — see §7.2)

It is one Next.js application that contains: a **staff portal** (dashboards, workshop management, CRM, AP automation, calls coaching, reporting), a **distributor-facing B2B portal** (catalogue, checkout, orders, tune jobs, training) that went live in July 2026, a **supplier portal** (read-only stock wall), and a large fleet of **background automation** (23 Vercel crons, 16 GitHub Actions workflows, and several on-premise agents).

| | |
|---|---|
| Production URL | `https://justautos.app` |
| Repo | `ChrisJustAutos/JA-Portal`, branch `main` |
| Hosting | Vercel (auto-deploys every push to `main`) |
| Database | Supabase project `qtiscbvhlvdvafwtdtcd` (`https://qtiscbvhlvdvafwtdtcd.supabase.co`) |
| Framework | Next.js 14.2.5, **pages router**, TypeScript, React 18 |
| Key packages | `@supabase/supabase-js`, `@anthropic-ai/sdk` (mostly raw fetch is used), `exceljs`/`xlsx`, `@react-pdf/renderer`, `pdf-lib`, `leaflet`, `reactflow`, `sip.js`, `web-push`, `playwright` (dev, for GH Actions workers) |

### People

| Person | Role |
|---|---|
| Chris Russell | Operations Manager — portal owner/direction |
| Nat | Accountant — chart of accounts, MYOB reconciliation sign-off |
| Matt Ashley | Technical — MYOB API, integrations |
| Matt H | Operations / Sales |
| Amanda | Accounts Payable — works in `/ap` daily |
| Laura | Director |
| Ryan | Receives the Monday 7am Weekly Sales Recap email |

---

## 2. Architecture at a glance

```
                          ┌────────────────────────────────────────┐
                          │  Vercel (Next.js app, justautos.app)   │
   Staff browsers ───────▶│  pages/        UI (111 routes)         │
   Distributor browsers ─▶│  pages/api/    ~all business logic     │
   Suppliers ────────────▶│  23 crons (vercel.json)                │
                          └───────┬──────────────────┬─────────────┘
                                  │                  │ repository_dispatch
                                  ▼                  ▼
                     ┌───────────────────┐   ┌──────────────────────────┐
                     │ Supabase          │   │ GitHub Actions           │
                     │ Postgres + Auth   │   │ Playwright workers that  │
                     │ + Storage +       │   │ scrape/drive Mechanics   │
                     │ Realtime (bus)    │   │ Desk (no API exists)     │
                     └──▲────▲────▲──────┘   └──────────────────────────┘
                        │    │    │  (service-role key / Realtime)
        ┌───────────────┘    │    └───────────────┐
        │                    │                    │
┌───────┴────────┐  ┌────────┴────────┐  ┌────────┴───────────┐
│ FreePBX box    │  │ Workshop PC     │  │ ESP32 scale nodes  │
│ ja-cdr-sync    │  │ label-print-    │  │ POST /api/scales/  │
│ ja-transcribe  │  │ agent (Realtime │  │ ingest             │
│ ja-ami-monitor │  │ consumer)       │  │ (x-device-key)     │
│ ja-freightbay  │  └─────────────────┘  └────────────────────┘
└────────────────┘
```

External SaaS the Vercel app talks to directly: **MYOB AccountRight** (both entities, direct OAuth), **Xero** (migration target, foundation live), **Stripe** (B2B standalone account + JAWS read-only accounts), **Microsoft Graph** (mailbox webhooks + mail), **Resend** (email), **ClickSend** (SMS), **Slack** (bot + webhooks), **Monday.com**, **ActiveCampaign** (being replaced by CRM module), **MachShip** (freight), **Anthropic API** (18 LLM call sites), **Deepgram** (indirectly — runs on the PBX host), **Google Places** / **Nominatim** (geocoding).

### Design conventions (must-follow)

- **API routes are `.ts`, never `.tsx`** — a `.tsx` in `pages/api/` crashes module load (generic 500 HTML).
- **Shared UI kit is mandatory**: `lib/ui/theme` tokens (`T` — CSS variables; use `alpha()`, never alpha-suffixed tokens) + `components/ui` + Feedback hooks. No `alert()`/`confirm()` browser dialogs. The B2B portal has its own separate "Alloy" kit at `components/b2b/ui.tsx` (one accent, ≥12px type, 44px touch targets).
- **Server Supabase clients** are constructed inline per route with the service-role key (module-level memo `_sb`). There is deliberately no shared server client module — follow the local pattern.
- **Long work (>~30s) never runs on Vercel** — anything browser-based or slow goes to GitHub Actions (dispatch pattern) or is chunked.
- **PostgREST embeds on workshop tables must use the `!customer_id` hint** (e.g. `workshop_customers!customer_id(...)`) or the query 500s on ambiguous relationships.
- **`b2b_distributor_users` is not unique per email/auth_user_id** (multi-site memberships) — never `maybeSingle()` on it.
- An **update notifier** compares the client bundle against `/api/version` and shows a "new version — Reload" banner after each deploy.

---

## 3. Environments, deployment & dev workflow

### Deploy

1. Commit to `main` and **push** (convention: always push immediately after committing — never leave local-only commits).
2. Vercel builds and deploys production automatically. There is **no staging branch**; PR preview URLs exist if wanted.
3. Function logs: Vercel dashboard → Deployments → deploy → Functions tab.

Error fingerprints: generic 500 HTML page = module-load crash (bad import / `.tsx` in api/ / syntax error); JSON error = handler crash; empty response/timeout = function `maxDuration` exceeded (per-route overrides live in `vercel.json` → `functions`).

### Database migrations (SOP)

- Migrations live in `migrations/NNN_description.sql` (196 files, `002`–`195`; note `148` and `153` are each duplicated — sequence is a convention, not a key. Next number: **196**).
- There is **no migration runner**. The procedure is: write the SQL file in `migrations/`, apply it to the live DB via the **Supabase MCP `apply_migration`** tool (project `qtiscbvhlvdvafwtdtcd`) **before** pushing code that depends on it, then commit both.
- The repo file is the source-of-truth record; the MCP apply is what actually changes the DB.

### Local dev

`npm run dev` with a `.env.local` carrying at minimum the Supabase URL/keys. Most features hit live external services, so local dev is mainly for UI work; be careful with anything that writes to MYOB/Stripe.

### Remote/mobile ops

A workshop MSI laptop runs OpenSSH + Tailscale + Claude Code; Chris's phone (Tailscale + Termius) can SSH in from anywhere. This is also the **only interactive route to the FreePBX box** (Tailscale IP `100.82.97.46`).

---

## 4. Auth & access model

Four separate authentication schemes coexist. They never overlap.

### 4.1 Staff portal

- Supabase Auth session, cookie `ja-portal-access-token`; identity in `user_profiles`. Opt-in TOTP 2FA (server-side enforced).
- **Six roles** (`lib/permissions.ts` is the source of truth): `admin`, `manager`, `sales`, `workshop`, `accountant`, `viewer`. (`lib/auth.ts` has a stale 5-role type missing `workshop` — known drift.)
- Roles map to `view:*` / `edit:*` / `admin:*` permission strings via `ROLE_PERMISSIONS`. Pages gate with `requirePageAuth(ctx, 'permission')`; API routes with `withAuth(permission, handler)` / `requireAdmin`.
- Two per-user allowlists narrow further: `user_profiles.visible_tabs` (which nav tabs/apps a user sees) and `visible_report_tabs` (which Reports sub-tabs).
- **User management**: `/settings?tab=users` — invite (Supabase invite email → `/reset-password?welcome=1`), change role, deactivate, delete. Audit log at `/settings?tab=audit`.
- Session persistence: `SessionKeeper` silently re-syncs cookies from localStorage (never on auth pages) and login pages silently resume valid sessions; deep links use `?next=`.

### 4.2 Distributor (B2B) portal

- Separate cookies `ja-b2b-access-token` / `ja-b2b-refresh-token`; identity in `b2b_distributor_users`. Gate: `requireB2BPageAuth`.
- Login = email+password with optional TOTP; also magic-link and signed invite tokens (`/b2b/welcome?t=…` — scanner-proof: opening does nothing, only the human submitting the set-password form activates).
- Users are `owner` or `member` per distributor; one auth user can belong to **multiple distributors** (account switcher, `ja-b2b-dist` cookie).
- Admin **preview mode**: signed `b2b_preview` token from the admin side renders the portal as a distributor with all non-GET requests blocked.
- `checkoutEnabled` per distributor = browse-only kill switch.

### 4.3 Supplier portal

Separate again: `b2b_supplier_users`, `requireSupplierPageAuth`, single read-only page (`/b2b/supplier`).

### 4.4 Machine auth

- **Service tokens** (`lib/service-auth.ts`): SHA-256 hashed rows in `service_tokens`, presented as `X-Service-Token` header (deliberately not `Authorization` to avoid clashing with Supabase JWTs). Scoped (`stocktake:write`, `calls:monitor`, `ap:admin`, `reports:read`, `upload:job-report`). Used by GitHub Actions workers and the PBX AMI agent. Managed via `/api/admin/service-tokens`.
- **Signed capability tokens** in URLs for login-less pages: `/tune-jobs?token=` (distributor-scoped weekly reminder), `/order-action` (admin Book Freight email button).
- **Device keys**: ESP32 scale modules authenticate to `/api/scales/ingest` with `x-device-key` matched to `scale_devices`.
- **MCP tokens**: `jap_…` personal tokens (hashed in `mcp_tokens`) or OAuth 2.1 for the read-only Claude connector at `/api/mcp`.
- **Cron auth**: `Authorization: Bearer $CRON_SECRET` (some handlers also accept the `vercel-cron` user-agent, and some accept a logged-in staffer with the right permission for manual runs).

---

## 5. Connections & integrations

### 5.1 Where credentials live (read this first)

`lib/integration-config.ts` implements a **DB-first resolver**: `getIntegration(key)` = `integration_settings` DB row → env var of same name → `''`. Values cache in-process for 30s. **Always use this resolver, not `process.env`, for the managed keys.**

| Integration | Stored where | Change without redeploy? |
|---|---|---|
| ClickSend, Resend, CRM intake token, **Xero app creds**, accounting provider switch | `integration_settings` DB (env fallback) | **Yes** — Settings → Connections → Integrations; live in ~30s |
| MYOB app creds, Graph, Monday, ActiveCampaign, Stripe, Slack, Anthropic, VAPID, Supabase, GitHub dispatch | Vercel env vars only | No — edit env + redeploy |
| MYOB / Xero **OAuth tokens** | `myob_connections` / `xero_connections` tables | Yes — re-run connect flow |
| MachShip token | `b2b_freight_carrier_connections.credentials` JSONB | Yes — Admin B2B → Settings |
| Service tokens / MCP tokens / scale device keys | `service_tokens` / `mcp_tokens` / `scale_devices` | Yes — respective admin UIs |

Admin surfaces:
- **Settings → Connections** (`/settings?tab=connections`) — three sub-tabs: **Integrations** (edit DB-managed credentials, test SMS/email, rotate CRM intake token, Xero connect), **Health** (live status board), **MYOB Connection** (connect/select company files).
- **`/admin/connections`** — standalone auto-refreshing health page (⚠ no SSR auth gate — relies on API-level gating).

### 5.2 MYOB AccountRight (primary accounting — both entities)

- **Code**: `lib/myob.ts` (OAuth + `myobFetch`), `lib/myob-reporting.ts` (replaced CData 2026-07-14 — reporting **must fetch all 4 invoice types**), plus per-module writers (`ap-myob-bill`, `b2b-myob-invoice`, `workshop-myob-invoice`, `stripe-myob-sync`, …).
- **App creds (env only)**: `MYOB_CLIENT_ID`, `MYOB_CLIENT_SECRET`, `MYOB_REDIRECT_URI`, `MYOB_SCOPE`.
- **Tokens**: `myob_connections` table, one row per label `JAWS` / `VPS`. Access ~20 min (auto-refresh), refresh ~1 year but **must be exercised regularly** — a multi-week quiet spell can kill the connection.
- **Connect / re-auth SOP**: Settings → Connections → MYOB Connection → Connect (or `GET /api/myob/auth/connect?label=JAWS|VPS`) → consent → pick company file → if the file is in legacy auth mode, set company-file username/password. Test with `/api/myob/test/invoice?label=VPS`.
- **Gotchas** (hard-won, in code comments):
  - Two company-file auth modes — SSO (bearer only) vs legacy (`x-myobapi-cftoken`); header only sent when `company_file_username` is set.
  - **Never page with bare `$top`/`$skip`** — no stable ordering, rows get skipped. Follow `NextPageLink`, page size 400.
  - Every call is logged to `myob_api_log`; the insert is `await`ed in `finally` (fire-and-forget logs were killed on timeout).
  - **`IsTaxInclusive` matters for cent-exact invoices** — B2B invoices are pushed inc-GST with checkout-exact line pricing.
  - No P&L endpoint exists in AccountRight (the old CData P&L panels were retired).

### 5.3 Xero (migration target — foundation live 2026-08-05)

- **Code**: `lib/xero.ts`, `lib/accounting/xero-adapter.ts`; provider switch in `lib/accounting-provider.ts`.
- **App creds (DB-managed)**: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI` — editable in the Integrations tab.
- **Setup SOP**: create a Web App at developer.xero.com with the redirect URI shown on the card → paste ID/secret → Save → "Connect Xero" (`/api/xero/auth/start`) → one consent covers both orgs → map tenants to `VPS`/`JAWS` via `/api/xero/connections` PATCH → ping to verify.
- **Provider switch**: `accountingProvider(entity, module?)` resolves `ACCOUNTING_PROVIDER_{ENTITY}_{MODULE}` → `ACCOUNTING_PROVIDER_{ENTITY}` → default `'myob'`. Entity-wide keys are in the Integrations UI; per-module overrides (AP, STATEMENTS, LETTERS, WORKSHOP, INVENTORY, B2B, REPORTING, STRIPE, BANK) are env-only. After cutover MYOB stays connected read-only for history.
- **Critical gotcha**: **Xero refresh tokens are single-use and rotate on every refresh** — the new token must be persisted or the connection dies. Refresh is serialised in-process; a cross-instance race shows as `invalid_grant` and self-heals next run. Granular scopes only (bills live under `accounting.invoices`); every call needs the `Xero-tenant-id` header.

### 5.4 Stripe

- **B2B checkout (standalone account `acct_1TrRkZ…`, LIVE keys)**: `lib/stripe.ts` (raw fetch, no SDK). Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Webhook `POST /api/b2b/stripe/webhook` (event `checkout.session.completed`; `bodyParser: false` is required for signature verification — do not remove). Idempotent; if the MYOB writeback fails it still 200s and parks the error on `b2b_orders.myob_write_error` for manual retry from the admin order page. Payment methods live: **card (with surcharge), PayTo, BECS direct debit** (BECS settles later — a settle gate + `/api/cron/b2b-payment-check` confirm before fulfilment milestones).
- **JAWS reconciliation accounts (read-only)**: `lib/stripe-multi.ts`, env `STRIPE_SECRET_KEY_JAWS_JMACX`, `STRIPE_SECRET_KEY_JAWS_ET`, labels registered in `STRIPE_ACCOUNT_LABELS`. Used by `/stripe-myob` push tool and payout reconciliation.

### 5.5 Microsoft Graph (mail)

- **Auth**: app-only client credentials. Env: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` (+ webhook URLs and ~15 mailbox-assignment vars — see `lib/microsoft-graph.ts` and §22 of the integrations inventory). Azure app needs **Mail.Read, Mail.ReadWrite, Mail.Send with admin consent** (Mail.Send 403 until granted — this bit us).
- **Webhooks**: `/api/webhooks/graph-mail` (Pipeline A — quote PDFs from rep mailboxes), `/api/webhooks/graph-jobreport-mail` (nightly MD WIP report).
- **Subscription lifecycle SOP**: subscriptions max out at ~70.5h. The cron `/api/cron/renew-graph-subscriptions` (every 6h) extends anything within 24h of expiry. **Recreating a dead/failed subscription is NOT automated** — re-run `POST /api/admin/setup-graph-subscriptions?key=$GRAPH_ADMIN_SETUP_SECRET` (idempotent).
- **Adding a rep mailbox** touches three places: `lib/agents.ts` (owner map), `MAILBOX_FOR_NAME` in `pages/api/cron/health-check.ts`, and re-running the setup endpoint.
- Inbox-driven pipelines that *poll* Graph rather than subscribe: AP inbox pull, AP auto-entry, AP statement watch, tune-jobs receipt scan, drop-ship confirmations, letter watch.

### 5.6 Email (Resend) & SMS (ClickSend)

- **Resend** (`lib/email.ts`): DB-managed keys `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_CAMPAIGN_FROM`, `RESEND_REPLY_TO`, `RESEND_WEBHOOK_SECRET`. If unset, **silently falls back to Graph sendMail**. Delivery/open/bounce webhook: `/api/crm/resend-webhook?key=…`. Per-staff Reply-To comes from `user_profiles.reply_to_email`.
- **ClickSend** (`lib/clicksend.ts`): DB-managed `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY`, `CLICKSEND_FROM`. Returns `clicksend_not_configured` harmlessly until set. Test buttons for both live in the Integrations tab.

### 5.7 Slack

- **Incoming webhooks** (one env URL per channel): `SLACK_WEBHOOK_URL` plus `SLACK_WEBHOOK_{JAWS_PAYMENTS,VPS_PAYMENTS,JAWS_PAYOUTS,AP_VPS}` and per-tenant B2B order webhook in `b2b_settings`.
- **Bot** (`lib/slack-bot/*`): env `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_ALLOWED_CHANNEL_IDS`, `SLACK_PARTS_ONLY_CHANNEL_IDS` (parts-only channels get exactly one stock-availability answer per top-level message, no thread replies, no clarifying questions), `SLACK_PARTS_CONTACT`. Single endpoint `POST /api/slack/ask` handles events, mentions, `/ask`, and interactive buttons; HMAC verified; acks in <3s then continues via `waitUntil`.
- The parts bot answers from `md_stock_cache`, refreshed every 30 min by the `md-stock-sync` GitHub Action.

**What we post where.** Slack is the business's alerting surface — most automation reports into it rather than email, so a dead webhook is a silent failure. The channels built so far:

| Channel | What lands there | Source |
|---|---|---|
| `#jaws-orders` | B2B distributor orders, drop-ship PO confirmations and ETAs | `lib/b2b-order-pipeline.ts`, drop-ship confirm cron |
| `#jaws-payments` / `#vps-payments` | Payments received, per entity | `SLACK_WEBHOOK_{JAWS,VPS}_PAYMENTS` |
| `#jaws-invoices` / `#vps-invoices` | Invoice events per entity | webhook |
| `#sales-coaching` | Per-call coaching cards, plus the weekly team coaching summary (Mon 07:00) | PBX `slack-poster.js` |
| `#customer-feedback-negative` | Calls flagged as a poor customer experience, with the fault theme. Matt's standing ask is the top-10 recurring faults off this channel. **The automation that posts here is currently switched OFF** (`CALL_CONCERNS_ENABLED`). | calls analysis |
| `#customer-feedback-positive` | The same in reverse — calls that went well | calls analysis |
| `#parts-room` | Parts Office camera motion, nights and weekends only | `ja-partsroom` on the PBX box |
| Freight bay | Intrusion bursts from the freight-bay NVR (snapshot sequence) | `ja-freightbay` on the PBX box — Slack-only since 2026-07-15 |
| AP channel (`SLACK_WEBHOOK_AP_VPS`) | Supplier-invoice exceptions and suspected double-ups (♻) | AP auto-entry |
| `#ja-portal-queries` | Ask-the-portal bot conversations | `lib/slack-bot/*` |

**⚠** Webhook URLs are per-channel env vars. If a channel goes quiet, check the env var before assuming the feature broke — a rotated or deleted webhook fails silently.

### 5.8 Monday.com & ActiveCampaign (legacy CRM pair — being replaced by the CRM module)

- **Monday** (`lib/monday-followup.ts` is the shared GraphQL client): env `MONDAY_API_TOKEN`, `MONDAY_BUTTON_SECRET`. Five rep quote boards (Dom 5025942308, Kaleb 5025942316, Graham 5026840169, James 5025942292, Tyronne 5025942288). Pipeline A is match-only (never creates items). Button callback: `/api/monday/fetch-call-notes?key=…`.
- **Quote-channel automations (rebuilt 2026-08-19/20)**: a 3/7/14-day follow-up cadence driven by an `FU Stage` column (1→2→3; "Follow Up Done" advances the stage, resets Contact Attempts, hides the item in Quote - Pending and re-surfaces it when the date arrives). RLMNA counts attempts: **5 tries in Quote - Lead RLMNA → Quote Not Issued**, **3 tries in Quote - Follow up RLMNA → Quote Lost**. After the third follow-up the owner is notified that the decision must be Won or Lost.
  - **Two landmines, both fixed 2026-08-20, worth knowing if the boards misbehave again.** (1) Graham's legacy `RLMNA - Step 1` had no group condition and his `Follow up RLMNA - Step 1` incremented the counter twice, so one RLMNA click added +3 attempts and lost the quote on the first click; rebuilt as new-builder workflows 1940255686 / 1940255690 with the move ordered *before* the increment. (2) The Follow-Up-Done handlers are gated on `FU Stage is exactly 1/2/3`, so a **blank** FU Stage makes the click do nothing at all, silently — 132 items (mostly the On Hold cohort the migration skipped) were backfilled to stage 1.
  - **MCP cannot delete or deactivate Monday automations** (`USER_UNAUTHORIZED`, even for the account owner — the connector lacks the scope). The workaround is always: create a corrected version, add the bad one to a manual delete list. `create_automation` is also **nondeterministic** — always re-dump with `list_automations` and check the block config; phrase status triggers as "changes to X (from any previous status)" or it will set the from-status to the same label and the workflow can never fire.
  - **End of cadence (2026-08-20).** After the third follow-up the item deliberately does NOT move — it stays in Quote - Follow Up awaiting a Won/Lost decision. Two changes made that legible: a **"Decision Required"** status label the stage-3 handler now sets (workflows 1940257758 Ka / 1940257760 Ty / 1940257765 Ja / 1940257773 Do / 1940257784 Gr), so the row visibly differs from a transient "Follow Up Done"; and the **Owner** column is now stamped by Pipeline A (`REP_BOARDS[].mondayUserId`). **⚠ Owner was blank on every item on every board**, so the existing "notify the Owner" automation had been reporting success while notifying nobody — ten of Kaleb's quotes sat at the decision point from mid-June. Historical items were backfilled 2026-08-20 out of hours: **704 active quotes** across the five boards (Tyronne 84, James 188, Kaleb 294, Dom 169, Graham ~111) — scoped to Quote - Pending, Follow Up, Follow up RLMNA and On Hold only. Won, Lost, Not issued and the pre-quote Lead groups were deliberately left blank. Verified: zero blank Owners remain in those 20 groups.
  - **⚠ Never bulk-write to these boards while a rep is working in one.** The item state can change between your read and your write — this bit on 2026-08-20: ten items were read at stage 3, Kaleb reset them to stage 1 and re-ran them seconds later, and the write landed on the new state and had to be undone.
- **ActiveCampaign** (`lib/activecampaign.ts`): env `ACTIVECAMPAIGN_API_URL`, `ACTIVECAMPAIGN_API_KEY`, owner map etc. **Landmine documented in code: `filters[phone]` is a partial match and matches everything on an empty query** — every match must be re-verified by exact digit comparison (this mis-attributed a contact to 26 customers in production once).

### 5.9 MachShip (B2B freight)

- **Code**: `lib/b2b-machship.ts` + `lib/b2b-freight-carriers.ts` (provider registry — Shippit/Starshipit/AusPost/Sendle slots exist but only MachShip is implemented).
- **Credential**: NOT env — `b2b_freight_carrier_connections` row `provider='machship'`, JSONB `api_token`, header `token:` (not Bearer). Change it in Admin B2B → Settings; effective next call.
- Base `https://live.machship.com` (no sandbox host — test vs live is a property of the token's MachShip user). **Manifesting needs `companyId`, obtained via a consignment GET.** Booking runs with `maxDuration: 120`; consignments that die at MachShip park as `consignment_missing`; `/api/cron/b2b-freight-poll` refreshes status/ETA every 30 min.

### 5.10 Phones: FreePBX + Deepgram + live monitoring

The portal never calls Asterisk or Deepgram directly — an on-PBX host (CentOS 7, Tailscale `100.82.97.46`) runs four workers and **Supabase is the bus**:

| PBX worker | What it does |
|---|---|
| `ja-cdr-sync` (`sync.js`) | CDR → Supabase `calls` every 5 min (service-role key). Includes park-pickup CDR fix (2026-08-07) and the 6-hour late-arrival lookback (2026-08-21, below). |
| `ja-transcribe` (`transcribe.js`) | New calls → Deepgram (`nova-2-phonecall`, `en-AU`) → `call_transcripts`. Deepgram key lives on the PBX host. |
| `ja-ami-monitor` | Live channel snapshots → `POST /api/calls/live/agent/snapshot` (~2s, `X-Service-Token` scope `calls:monitor`); drains `call_monitor_events` for Listen/Whisper/Barge and click-to-dial originate. |
| `ja-freightbay` / `ja-partsroom` | Hikvision NVR intrusion events → Slack snapshot bursts + Yealink ring. **Node 16 only** (glibc). Doesn't touch the portal API. |

**Call coaching and notes — what this actually gives the business.** This is the biggest piece of bespoke work on the phone system, so it is worth stating plainly what it produces:

1. **Every call is recorded and transcribed** — `ja-cdr-sync` lands the CDR, `ja-transcribe` sends the audio to Deepgram (`nova-2-phonecall`, `en-AU`) and stores the transcript. Nothing is manual.
2. **Every call is scored against a rubric for its type** — a sales enquiry, a service booking, a parts call and a pass-off are judged on different things, so the rubrics are per call type (`call_type_rubrics`, editable at Settings → Call Coaching).
3. **Coaching is attributed to the advisor who actually handled it**, identified from the transcript rather than the extension — that is what makes the leaderboard trustworthy when calls get transferred or picked up from park.
4. **Coaching cards post to `#sales-coaching`** per call, and a **team summary posts Monday 07:00**.
5. **Call notes flow back to the quote boards** — the "Fetch Call Notes" button on a Monday item calls `/api/monday/fetch-call-notes`, which pulls that customer's call history and notes onto the item, so a rep picking up a follow-up can see what was last said without hunting for the recording.
6. **Sentiment / objections / conversion** are surfaced on `/calls` as tabs, and calls scoring below 40 are flagged for attention.

**The CDR lookback — why it is 6 hours and must stay generous.** Asterisk stamps a CDR row with the call's **start** time but does not write the row until the channel hangs up. A long call therefore arrives *behind* the sync watermark. `sync.js` reads `WHERE calldate > (watermark − CDR_LOOKBACK_MINUTES)`; while that lookback was 30 minutes, **every call longer than about 30 minutes was silently lost or truncated** — the row appeared in MySQL after the watermark had already moved past its start time, so no run ever saw it. Symptom: the portal held no call longer than 38:37 in seven weeks, and a 61:20 call answered by Dom on 204 (2026-08-20 16:16, caller 0428673886) was absent entirely. Fixed 2026-08-21 by raising the lookback to **360 minutes** (`CDR_LOOKBACK_MINUTES`, env-overridable). Re-reading is cheap (~26 rows a run) and safe — the upsert is `on_conflict=linkedid` and the payload carries only CDR-derived columns, so transcripts, recording URLs and coaching analysis on existing rows are never overwritten. **Do not lower it below the longest call the phones can carry.**

**Backfilling history.** `BACKFILL_FROM` + `BACKFILL_TO` (PBX local time) make a hand-run read exactly that window, leave `sync_state` untouched and skip the recording-upload phase, so it never disturbs the 5-minute timer:

```bash
BACKFILL_FROM='2026-08-20T16:11:00' BACKFILL_TO='2026-08-20T16:21:00' \
  /usr/local/bin/node20 /opt/ja-cdr-sync/sync.js
```

Keep the window tight. A wide one re-upserts every call inside it, and `trg_rescue_missed_call` fires on `UPDATE OF disposition` — which deletes *unread* "Missed call" notifications for the same caller within ±4 hours of each answered call. There are routinely a couple of thousand unread ones, so a mass re-upsert would quietly clear a slice of them. (`trg_notify_missed_call` is safe: it only fires for calls under 2 hours old.) Note the box's default `node` is v8 and cannot parse the file — the service runs `/usr/local/bin/node20`.

**Recordings are transcoded to MP3 before upload.** Asterisk records 8 kHz mono WAV at roughly 1 MB per minute, so length translated straight into megabytes and long calls hit the storage ceiling — a 61-minute call was 58 MB and was rejected outright, leaving it with no audio, no transcript and no coaching card. Since 2026-08-21 `sync.js` runs the file through `ffmpeg` (`-ac 1 -ar 16000 -c:a libmp3lame -b:a 32k`) and uploads the MP3 instead: **~75% smaller** (58 MB → 14.7 MB), which puts even a multi-hour call comfortably inside the bucket's 100 MB limit. Knobs: `RECORDING_TRANSCODE=0` disables it, `RECORDING_MP3_BITRATE` (default `32k`), `FFMPEG_BIN`, `TRANSCODE_TMP_DIR`, `TRANSCODE_TIMEOUT_MS`.

Details that matter if you touch this:

- **The WAV on disk is never modified** — Asterisk owns it and it stays the source of truth. Only the uploaded copy is compressed, and a failed or empty transcode falls back to uploading the original WAV, so this can never cost a recording.
- **`recording_file` stays `.wav` while `recording_url` becomes `.mp3`.** They deliberately differ. Anything deciding a content type or a download name must read `recording_url` — that is the object that exists. `transcribe.js` derives the Deepgram content type from it, and both `lib/calls-weekly-report.ts` and `/api/calls/[id]/recording-url` were corrected to do the same.
- Old `.wav` objects stay exactly as they are and still play; the portal's `<audio>` element and Deepgram both handle either format.
- `transcribe.js` falls back to inserting the transcript **without `raw_response`** if the full insert fails. That column holds the entire Deepgram document with word-level timings (~940 kB on a 61-minute call) and nothing reads it, so a statement timeout on the payload must not cost the transcript — which is exactly what happened on the first 61-minute call before the fallback existed.

Analysis runs on the PBX (`/opt/ja-cdr-sync/analyse.js` + `slack-poster.js`); the portal's `/api/cron/calls-analyse` equivalent is **gated off by default** (`CALLS_ANALYSIS_ENABLED`) and must stay off while the PBX loop runs — both running means double-scoring and double-posting. Browser softphone (SIP.js over WSS) config is env `NEXT_PUBLIC_FREEPBX_WSS_URL` etc.; TURN needed on mobile networks.

### 5.11 Anthropic / Claude API

Env `ANTHROPIC_API_KEY`; raw fetch to `/v1/messages`. 18 call sites: AP extraction & statement parsing, quote PDF extraction, call analysis/coaching/concerns/weekly report, follow-up summaries, workshop-map weekly narrative, B2B drop-ship confirmation reading, training-course generation, tune-job receipt extraction, report narratives, sales-recap flags, Slack bot, portal chat. Most models overridable per-feature via env (`*_MODEL` vars).

### 5.12 Everything else

- **Web Push**: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (watch for whitespace in env values — known gotcha); dormant no-op when unset.
- **MCP connector**: portal is a read-only MCP server at `/api/mcp` (personal `jap_` tokens from Settings, or OAuth 2.1 with dynamic client registration).
- **Google Places** (`NEXT_PUBLIC_GOOGLE_PLACES_API_KEY`, client-exposed — must be referrer-restricted) for workshop address autocomplete; **Nominatim** (keyless, throttled ~1 rps) geocodes tune-job addresses; an offline AU postcode dataset powers the workshop map.
- **GitHub dispatch**: `GH_DISPATCH_TOKEN` (`actions:write`) lets portal routes fire `repository_dispatch` events to run MD workers on demand.
- **Website lead intake**: `POST /api/crm/intake` guarded by `x-crm-token` = DB-managed `CRM_INTAKE_TOKEN` (rotate from the Integrations tab).
- **CData MCP**: decommissioned 2026-07-14. `lib/cdata.ts` is dead code; health check hardcoded green/deprecated.
- **Base URL sprawl**: seven overlapping env vars (`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_PORTAL_URL`, `PORTAL_PUBLIC_URL`, `APP_BASE_URL`, `JA_PORTAL_BASE_URL`, `B2B_PUBLIC_BASE_URL`) — keep them consistent; mismatches silently break OAuth redirects and email links.

---

## 6. Scheduled automation

### 6.1 Vercel crons (23 — `vercel.json`; schedules are UTC; Brisbane = UTC+10)

| Cron | Brisbane time | Purpose |
|---|---|---|
| `/api/distributors/refresh-cache` | 02:00 daily | Warm `distributors_cache` (FY figures + last 13 months) |
| `/api/cron/sync-followups` | every 5 min | Call follow-ups → Claude summary → AC contact + Monday push (`FOLLOWUP_SYNC_ENABLED` kill switch) |
| `/api/cron/calls-analyse` | every 5 min | Portal-side call coaching sweep — **off by default** (`CALLS_ANALYSIS_ENABLED`); PBX box currently does this |
| `/api/cron/calls-weekly-report` | Mon 07:00 | Weekly coaching narrative → `#sales-coaching` |
| `/api/cron/workshop-map-weekly` | Mon 07:10 | Quotes/jobs geography report → email Matt (cc Ryan, Chris) |
| `/api/cron/renew-graph-subscriptions` | every 6 h | Extend Graph mailbox subscriptions expiring <24h |
| `/api/cron/health-check` | every 5 min | The 21 integration health checks → `integration_health` |
| `/api/cron/b2b-freight-poll` | every 30 min | MachShip status/ETA poll on open consignments |
| `/api/cron/workshop-reminders` | every 15 min | Queue + send service/rego reminder SMS (respects `sms_enabled`) |
| `/api/cron/notifications-sweep` | every 15 min | Bell notifications for Monday-side events (new leads, new to-dos) |
| `/api/cron/b2b-payment-check` | every 6 h | Confirm BECS settlement in MYOB → mark `payment_settled_at` |
| `/api/cron/crm-automations` | every 5 min | CRM automation flow engine |
| `/api/cron/task-automations` | every 5 min | Tasks automation flow engine |
| `/api/cron/crm-campaigns` | every 5 min | Campaign scheduler + Resend queue drain + call linkage |
| `/api/cron/ap-statement-watch` | every 10 min | Supplier statements → reconcile vs MYOB → digest email (report-only) |
| `/api/cron/ap-auto-entry` | every 15 min | VPS inbox → fact-check → auto-post clean invoices to MYOB (`AP_AUTO_ENTRY_ENABLED`) |
| `/api/cron/overnight-leads-snapshot` (+morning variant) | every 30 min / 5 min 06–08 | Snapshot Monday lead groups for the sales recap |
| `/api/cron/letter-watch` | hourly | New finalised MYOB VPS invoices → thank-you letter + envelope print jobs (deposit-only invoices vetoed) |
| `/api/cron/agents` | every 15 min | Monitoring agents framework (`lib/agent-framework`) |
| `/api/cron/tune-jobs` | hourly :20 | Scan inbox for Stripe tune receipts; Monday-morning reminders/escalations |
| `/api/cron/b2b-dropship-confirm` | every 15 min | Supplier confirmation emails → full drop-ship receiving flow |
| `/api/cron/mgmt-dashboard-warm` | 05:30 daily | Pre-compute Management Dashboard MYOB bundles |

⚠ Two handlers exist but are **not scheduled** (headers claim otherwise): `bank-payments-slack.ts` (7am payment digests) and `slack-cleanup.ts` (parts-bot TTL deletes). Manual-invoke only until added to `vercel.json`.

### 6.2 GitHub Actions (Mechanics Desk workers — 16 workflows)

MD has no API; these Playwright workers log in with `MECHANICDESK_{WORKSHOP_ID,USERNAME,PASSWORD}` secrets and talk back to the portal with `X-Service-Token: $JA_PORTAL_API_KEY`. All install Chromium at run time (`setup-node@v5` + `npx playwright install chromium` — the old "run in the MCR container" note in `05_INTEGRATIONS.md` is obsolete). **`playwright` in devDependencies must match the installed version (1.59.1).** MD allows a single session per employee — concurrency groups prevent workers evicting each other.

| Workflow | Schedule (Brisbane) / trigger | Job |
|---|---|---|
| `mechanicdesk-pull` | 08/10/12/14/16:00 | MD WIP report → forecast ingest |
| `md-stock-sync` | every 30 min, 06:00–19:30 Mon–Sat | Full MD stock catalogue → `md_stock_cache` (Slack parts bot) |
| `md-workshop-map` | 03:30 nightly | Full invoices/quotes/customers pull → workshop map (FY2025 was a one-time backfill; nightly FROM = 2025-07-01) |
| `mechanicdesk-prepick` | 06/11/15:00 weekdays | Diary-job parts demand → Pre Pick snapshot |
| `sales-recap` | Mon 07:00 full+email; ~7 intraday MD refreshes | Weekly Sales Recap (Monday boards + MD scrape → email Ryan) |
| `md-customer-import` | 02:00 nightly | Monday quote-channel leads → MD customers (MD can't search phones) |
| `tune-jobs-md` | 02:30 nightly | Submitted tune jobs → MD customer + vehicle + note |
| `mechanicdesk-stocktake` | `repository_dispatch` | Stocktake match / push / recheck / refresh / push-missing |
| `md-purchase-order` | `repository_dispatch` | Raise MD PO after a JAWS→VPS stock transfer |
| 7 × `probe-md-*` / `fix-md-customer-names` | manual | Endpoint recon probes and one-off repairs |

### 6.3 The print centre (comms room)

**PORTAL-CENTRE** is a dedicated always-on Lenovo ThinkCentre in the comms room whose only job is printing. It exists because the print agent used to run on Chris's MSI laptop, which meant **every letter, invoice and label silently stopped whenever the laptop was closed or off the network** — with no error anywhere, because the queue simply stopped draining. Built and verified 2026-08-20.

| | |
|---|---|
| Host | Lenovo ThinkCentre, comms room, always on (no lid, no sleep) |
| Reachable | Tailscale `100.72.189.95` — RDP in for maintenance; it is Entra-joined, so sign in with the work account |
| Runs | `agents/label-print-agent/` on Node 22, started by Autologon + Startup shortcut, headless |
| Queue | `label_print_jobs` in Supabase, consumed over Realtime with a 30s poll as fallback |
| Job kinds | `label` (DYMO 4XL), `invoice`, `letter`, `envelope` (Apeos) — all four verified end to end |
| Runbook | `docs/print-centre-thinkcentre-setup.md` — build, headless operation, the comms-room move sequence, RDP, and a health-check script |

**Operating notes**

- The agent **never restarts on deploy** — it is not part of the Vercel app. A new print kind must not require an agent change; add it as a queue row shape the agent already understands.
- A stuck queue drains on agent restart, so restarting the agent is the first fix. Failed jobs are re-queued by flipping `failed` → `pending`.
- **⚠ Never trust the Apeos `(Copy 1)` printer-name suffix.** Windows appends it when a printer is re-added, and printing to the wrong name fails silently or prints to the wrong device — check the real name.
- Printer enumeration must never take the heartbeat down (fixed 2026-08-20) — if the agent looks dead but the box is up, check the heartbeat before rebuilding anything.
- DYMO troubles: the health-check script has label-printer diagnostics and a `-FixDymoPort` switch.

### 6.4 On-premise agents

| Agent | Where | Notes |
|---|---|---|
| `label-print-agent` (`agents/label-print-agent/`) | **PORTAL-CENTRE** — see §6.3 | Consumes `label_print_jobs` via Supabase Realtime (30s poll fallback). Kinds: `label` (DYMO 4XL), `invoice`, `letter`, `envelope` (Epson). **Never restarts on deploy** — new print kinds must not require agent changes. Runs via Startup shortcut → `run-agent-hidden.vbs` or NSSM. Node 22, Autologon, reachable on Tailscale `100.72.189.95`; built 2026-08-20, runbook `docs/print-centre-thinkcentre-setup.md`. Previously ran on Chris's MSI laptop and failed silently whenever it was off-network — that is what the dedicated box fixes. **Never trust the Apeos `(Copy 1)` printer-name suffix.** |
| PBX workers | FreePBX box | See §5.10. systemd units; Node 16 for the camera bridges. |
| ESP32 scale nodes | Workshop bins / cash-count rig | Firmware `hardware/ja-scale-node/`; raw HX711 counts to `/api/scales/ingest`; all calibration server-side. |

---

## 7. Modules & SOPs

Full route-by-route inventory: 113 page routes (426 API routes). Staff nav is the `/home` app launcher (role- and `visible_tabs`-filtered). Below, per module: what it is + how to operate it.

### 7.1 Dashboards (`/dashboard`, `/overview`, `/home`)

Section-based management dashboard (JAWS+VPS merged, entity filter pills) and a drag/resize custom dashboard builder with per-user saved layouts. **SOP**: nothing operational — data flows from MYOB reporting caches; if figures look stale, check the 02:00 `distributors/refresh-cache` cron and the health page.

### 7.2 Workshop tooling (Mechanics Desk stays the system of record)

**Mechanics Desk is the workshop system.** The diary, job cards, customers, vehicles, quotes and invoicing all happen in MD, and there is **no migration in progress** (decision 2026-08-20). The portal does not run the workshop.

What the portal *does* provide around MD, all of it in daily use:

| Surface | What it does | Fed by |
|---|---|---|
| **Letters** (`/workshop/letters`) | Hourly `letter-watch` cron queues a thank-you letter + envelope for each newly finalised MYOB invoice and prints them on the Apeos. Deposit-only invoices are vetoed by a positive 1-1230 line. Reprint / compose / edit templates here. | MYOB (not MD) |
| **Pre Pick** (`/workshop/prepick`) | 14-day parts demand vs stock on hand. | `mechanicdesk-prepick` Playwright worker |
| **Purchase Orders** (`/workshop/purchase-orders`) | PO draft → sent → received, with a bill push to MYOB. | Portal + MYOB |
| **Stocktake (MD)** (`/stocktake`) | Count sheet reconciled against MechanicDesk. | MD workers |
| **Stocktake (Portal)** (`/workshop/stocktake`) | Barcode session → count → Variance → Apply. | Portal |
| **Stock Transfer** (`/admin/b2b/stock-transfer`) | JAWS↔VPS paired invoice + bill, plus the MD PO. | Portal + MYOB + MD |

**The parked sections are switched off in the UI** (2026-08-20). `lib/workshop-sections.js` is the single source of truth for which sections are on; the tab strip reads it, and `next.config.js` reads the same list to rewrite the parked routes to a "not in use" notice.

- Off: Diary, Jobs, Customers, Vehicles, Quotes, Invoices, Comms, Workshop Reports (plus their `/workshop/{job,customer,vehicle,quote,invoice}/[id]` detail routes), and — second wave, same day — Orders, Inventory, Live Bins, Cash Count, Suppliers. 18 routes in total.
- On: the six in the table above.
- **The nav is now a single flat strip.** `components/InventoryTabs.tsx` (the old Inventory second level) was deleted once Inventory/Live Bins/Cash Count/Suppliers/Orders came off — there was almost nothing left to wrap — and its survivors were promoted to the top strip.
- The Workshop app tile opens `/workshop/prepick`.
- Parked routes **rewrite**, not redirect — the URL stays, so an old `/diary` bookmark still reads `/diary` and explains itself. The rewrites are in `beforeFiles`; an array return or `afterFiles` is evaluated *after* the filesystem and the real page would render instead.
- `?preview=1` on a parked route skips the rewrite and loads the real page — an escape hatch for anyone reviving the build.
- **To switch a section back on: flip `active` to true in `lib/workshop-sections.js`.** Nothing else. `docs/workshop_md_parity.md` still holds the parity and cutover detail.

**⚠** Because MD stays, the **9 scheduled MechanicDesk scrapers remain a live production dependency** (§6.2), not a temporary bridge. Treat them accordingly — an MD password change or UI change breaks real reporting.

### 7.3 B2B — distributor portal (`/b2b/*`)

Distributor experience: Shop → Cart (PO number required, ≤20 chars — MYOB limit) → Stripe Checkout (card+surcharge / PayTo / BECS) → Orders (status timeline + freight tracking) → Jobs (tune receipts to fill in) → Resources → Training → Team → Settings. Design language: the Alloy kit (`components/b2b/ui.tsx`) — distributor portal refreshed 2026-08-12, staff admin brought onto the same kit 2026-08-20.

**What happens automatically on payment** (`lib/b2b-order-pipeline.ts`): order → paid; cart cleared; MYOB invoice written cent-exact inc-GST; consignment-first pick list printed; for drop-ship items a supplier PO is created and emailed; Slack notification; freight bookable via MachShip (admin button or login-less email link). **The tax invoice is NOT raised at booking** — see Freight & despatch below.

**SOPs**
- **Onboard a distributor**: Admin → B2B → Distributors → Add (live MYOB customer typeahead links the card) → open the distributor → Invite users (magic-link / welcome token email). Owners manage their own team after that.
- **Over-limit orders**: quantities above `over_limit_qty` route to a quote-or-dropship flow instead of straight checkout.
- **Bundles**: "includes" children ship inside the parent's box (affects freight cartonization).
- **Refunds**: admin order page → Refund modal → **Items mode** (pick lines + quantities; amount derived server-side from checkout-exact pricing; `refunded_qty` prevents double refunds) or amount modes (covers freight/surcharge). Mirrored to MYOB as a credit note with negative item lines (Xero path posts on B2B_SALES).
- **Drop-ship receiving**: supplier replies to the PO email → `b2b-dropship-confirm` cron reads it → auto-bills the PO, flips the sale order to invoice, receipts payment, relays ETA to the distributor, posts to `#jaws-orders`. Manual MYOB conversions are adopted rather than duplicated.
- **Freight & despatch (changed 2026-08-20 — read this)**: booking and despatch are now two separate steps.
  - **Book Freight** only *prepares*: it creates the MachShip consignment (left **Unmanifested**) and prints the pick slip + consignment note/labels so the order can be picked and packed. Nothing reaches the carrier at this point and no tax invoice is raised.
  - **Ship Now** (`lib/b2b-ship-now.ts`) is what actually despatches: manifests the consignment, converts the MYOB Sale.Order → Sale.Invoice, receipts the payment against it, prints the A4 tax invoice, emails/pushes the distributor and stamps `shipped_at`.
  - Bulk despatch is deliberately **one manifest, not N** — MachShip's manifest call also books a carrier pickup window, so manifesting ten consignments individually would raise ten pickup requests. Select the run and ship it in one action.
  - This reverses the 2026-08-06 behaviour where booking manifested immediately. If nothing is reaching the carrier, the likely answer is simply that nobody has pressed Ship Now.
  - Rates: per-zone + flat-rate satchels (weight-gated; satchel rows may need seeding) + drop-ship per-zone rates; calibration panel at Admin → B2B → Dropship Calibration. If a consignment goes missing at MachShip it parks as `consignment_missing` — rebook from the order page.
- **Tune jobs**: Stripe receipt lands in the accounts inbox → hourly cron extracts it → distributor fills customer/vehicle at `/b2b/jobs` (or the login-less weekly reminder link) → nightly GH Action creates the MD customer/vehicle/note; Monday item + thank-you letter follow. One job per VIN. Staff-side management (aliases, retries, dismiss) at Admin → B2B → Tune Jobs.
- **Training**: Admin → B2B → Training → assign per distributor or per user (assignment-gated). Courses can be generated from an uploaded PDF (LLM pipeline). Edit quiz answers at `.../training/[slug]/answers`; preview renders the real player without recording attempts.
- **Testing safely**: Admin → B2B → Test Order exercises the full real pipeline against a chosen distributor.

### 7.4 B2B — staff admin (`/admin/b2b/*`)

Dashboard · Catalogue (inline price/visibility edits + drawer) · Stock Order (reorder forecasting, replaces the JAWS Excel) · JAWS Stocktake (count-sheet vs MYOB on-hand, **report-only**) · Stock Wall (saved on-hand tile views; also what suppliers see) · Stock Transfer (JAWS↔VPS paired invoice+bill + MD PO) · Distributors · Suppliers (logins) · Orders · Tune Jobs · Resources (sectioned doc library, signed uploads) · Training · Settings (Stripe status, freight carriers/zones/packaging, sender address, email templates).

### 7.5 Accounts Payable (`/ap`, `/ap/[id]`, `/ap/statement`)

Supplier emails → Graph inbox pull → Claude extraction → triage list.

**Daily SOP (Amanda)**: `/ap` → Pull from Inbox if needed → review each invoice (`/ap/[id]`: PDF preview, line editor with account suggestions, MD job link, supplier presets) → Approve (pushes header + lines to the right MYOB entity) or Reject. Green-triage rows support bulk approve.

**Automation**: `ap-auto-entry` cron (VPS, gated by `AP_AUTO_ENTRY_ENABLED`) posts clean invoices automatically and Slacks a breakdown; supplier allowlists control consolidated and pay-on-proforma handling; duplicates get a ♻️ Slack and are filed to Read/Printed; **locked-period invoices are flagged, never auto-redated**; supplier matching is suffix-blind; link-only emails (no PDF attached) are invisible to the pipeline. `ap-statement-watch` cron reconciles statement PDFs against MYOB and emails a digest (report-only; Capricorn statements are report-only by policy). Manual statement recon UI: `/ap/statement`.

### 7.6 CRM (`/crm/*`)

Pipeline kanban, contacts (+timeline), campaigns (Resend), React Flow automations. Replaces Monday quote boards + ActiveCampaign + Zapier — **manual cutover steps are recorded in the project memory/notes; AC + Monday remain live in parallel until cutover**. Website leads arrive via `/api/crm/intake` (token-guarded). Three crons drive automations/campaigns/call-linkage every 5 min.

### 7.7 Calls (`/calls`)

CDR list with audio, transcripts, coaching analysis (per-call-type rubrics), Sentiment/Coaching/Words/Conversion tabs, live Listen/Whisper/Barge (needs `monitor:calls`), click-to-dial (`use:phone`, `NEXT_PUBLIC_CLICK_TO_DIAL=1`). Coaching attribution keys on the transcript-identified effective advisor. Weekly coaching report posts to Slack Monday 07:00. **Negative-call (concerns) automation is fully built but switched OFF** — `CALL_CONCERNS_ENABLED=true` resumes it.

**SOP if calls stop appearing**: check Connections page (`freepbx_cdr_sync` freshness) → SSH to the PBX via Tailscale → check `ja-cdr-sync` systemd timer. Transcripts stale → `ja-transcribe`. Live monitor "not configured" → `ja-ami-monitor` hasn't pushed a snapshot in >20s.

### 7.8 Reports (`/reports/*`)

Builder (6 PDF report types — Workshop Performance was removed 2026-08-20; it reported over the portal workshop tables, which stay empty while MechanicDesk is the system of record) · Sales Report (live Weekly Sales Recap; **"sales" = orders taken from Monday boards + MD, not turnover**; auto-emails Ryan Mon 07:00) · Management Dashboard (JAWS weekly Excel replica from live MYOB; config-driven charts; clickable KPI history; cache warmed 05:30) · Workshop Map (nightly MD pull; `lib/workshop-map` classification is authoritative; FY picker; five tabs — Jobs Map, Quotes Map, Conversion, By State, **Vehicle Trend**: one line per vehicle series, All FY = monthly buckets, pick a month = daily buckets, measures Jobs/Quotes/Job $/Quoted $. The trend counts every invoice and quote, so its totals run higher than the map tabs, which show one dot per customer per month) · Distributor Map (quotes near each distributor vs confirmed Monday bookings) · **Sales Dashboard** (daily/monthly/total sales taken, plus a quote-pipeline view — see below) · **Forecast** (admin+manager; portal rebuild of the Monday "Forecast Dashboard - Includes JAWS" — see below). Per-user report-tab allowlists control who sees what.

**Sales Dashboard** (`/reports/sales-dashboard`, added 2026-08-21). The portal rebuild of the Monday **"Sales Dashboard"** (2079976). `view:reports`, same as the Sales Report. **Three** views behind the one tab, each fetching only when first opened — this is also where the Monday **"Management Dashboard"** (321206) was rebuilt, per Chris 2026-08-21:

**1. Management (default)** — the Monday Management Dashboard, widget for widget: sales orders vs target **per month** (last 18), **per salesperson** (current month) and **per day** (last 30), plus the **Cancelled** and **Postponed** order totals.

Each chart keeps its own period because each target is stated per that period — the giveaway was that the five reps on Monday's P/P chart sum to roughly ONE month's total, so it is a monthly per-person target, not a running one.

- **Targets** resolve DB-first through `lib/integration-config`: `SALES_TARGET_PER_MONTH` / `SALES_TARGET_PER_PERSON` / `SALES_TARGET_PER_DAY`, defaulting to the values read off Monday's target lines (**$1,000,000 / $300,000 / $50,000**). Changeable without a deploy.
- **Cancelled and Postponed are whole-board GROUP totals with no date filter**, and the group is the authority, not the status column — the Postponed group holds rows whose status says "Done" or "Not Done" and they still count. Verified to the cent on 2026-08-21: the 12 rows in "Postponed Orders" sum to **$73,804.45**, exactly what the Monday widget shows. `?exceptions=1` on the API opts into this extra pull; only this view needs it. "Cancelled Orders - Previous Years" is a separate group, **excluded by default** — `SALES_EXCEPTIONS_INCLUDE_PREV_YEARS=1` folds it in.
- These exception totals are **excluded from every sales figure** — cancelled and postponed work is not revenue. They sit alongside as what was lost and what is parked.
- **"Staff Parts Owing" is NOT built.** There is no board of that name (the dashboard names 9 connected boards), so it must be a filtered view on one of them; the tile renders as “—” with a note rather than inventing a number. Reads $0 in Monday today.
- Per-salesperson excludes **Unassigned** so the rep comparison isn't distorted by rows with nobody set; those are reported on the Figures view instead.

**2. Figures** — what the Monday dashboard actually tracks: **daily, monthly and per-salesperson sales taken over any date range**. `lib/sales-figures-monday.ts` + `GET /api/reports/sales-figures?start=&end=&months=&days=&person=`. An explicit `start`/`end` wins over `months`; a backwards range is swapped rather than returning nothing. Built **on `fetchOrders` / `fetchDistBookings` from `lib/sales-recap-monday`** rather than re-pulling the boards, so the definition of “a sale” lives in ONE place — those already drop the dead statuses (Deleted / Canceled / Cancelled) and the Distributor-Booking groups that don't count (Booking - Pending, Postponed…). Change it there and both this and the Weekly Sales Recap follow. Daily fills every calendar day so quiet days and weekends read as gaps rather than closing up the axis; the average is per **trading day** (days with at least one sale), because dividing by calendar days quietly halves it. Best day and best month are period-wide, not limited to the daily window. Month/year-to-date return 0 when the range ends before today, rather than looking like a fault.

**Salesperson attribution.** The people column — "Created By" on Orders, "Person" on Distributor - Booking, both id `person` — was added to `ORD`/`DB` and to `OrderRow`/`DistRow` in `lib/sales-recap-monday` for this (additive; the Weekly Sales Recap and Distributor Map ignore it). A row can name **several** people; it counts against the **first** only, so the per-person rows still add up to the period total — counting a shared row against everyone named would inflate the total and make the table irreconcilable with the headline. Rows with nobody set group as **Unassigned** rather than being dropped. `?person=` scopes the tiles, charts and sale-type split; the per-salesperson table always covers the whole range so you can still see everyone while filtered.

**3. Pipeline** — the quote pipeline across the five rep Quote Channel boards. `lib/sales-dashboard-monday.ts` + `GET /api/reports/sales-dashboard?months=3|6|12|24`. Open pipeline by stage, won/lost by month, a per-rep table with win rate, and an ageing breakdown.

**Sales taken ≠ turnover.** Both views count orders/bookings *placed*, the same meaning the Sales Report uses; invoiced turnover is Reports → Forecast. The two will not agree and are not meant to.

Three things the Pipeline view has to get right:

- **Group ids drift per board — resolve by TITLE, never by id.** Only the five original template groups (`topics`, `group_title`, `new_group__1`, `new_group`, `new_group860`) are shared across the boards. "Lead RLMNA", "Follow up RLMNA", "On Hold" and "Not issued" were added after the fork and every board has its own ids — Kaleb's On Hold is `group_mm12crrx`, Dom's is `group_mm12q0j0`. **The `GROUPS` map in `lib/monday-followup` holds one board's ids and is correct for the shared five only — do not reuse it for cross-board reporting.**
- **Rep comes from the board, not the Owner column.** The Owner backfill of 2026-08-20 covered the ~704 *active* quotes; historical Won/Lost items have an empty Owner, so board-as-rep is the only attribution that carries history.
- **Open is defined by exclusion** — everything that is not Won, Lost or Not issued. That way a group nobody mentioned still appears instead of vanishing: Kaleb has a "Farm Fest 2026 booked in Jobs" group, which is counted in the pipeline *and* listed separately on the page so the totals can always be reconciled to the boards.

The columns it reads *are* shared across all five boards (verified 2026-08-21): `numeric_mkzcbhz2` Quote Value (titled "Value" on James's board, same id), `date4`, `status`, `person`. The ones that drift — Distributor, Qualifying Stage, Contact Attempts, FU Stage, Quote No — are not read. Monday does the group and date filtering server-side, so the ~6,500 items across the boards cost one group-resolve plus two queries per board.

**Forecast** (`/reports/forecast`, added 2026-08-21). The portal rebuild of the Monday **"Forecast Dashboard - Includes JAWS"** (dashboard 349826), which sits on the Monday **"Forecasting"** board `1842188200`. `lib/forecast-monday.ts` pulls the board live on every load — 24 items, one Monday query, nothing cached or stored — and `GET /api/reports/forecast` serves month × entity × year turnover. Admin + manager only, same as the Management Dashboard.

Three things about that board that the parser has to defend against, all confirmed against live data:

- **Item names are unreliable, so the month always comes from the GROUP.** The December group contains an item titled "November Job Report - JAWS", March's is "Mach Job Report" (typo), and August's and September's are simply "JAWS". Reading the month from the title silently misfiles rows.
- **The board's "% Increase/Decrease" column is sparse and inconsistent** (populated on a handful of JAWS rows). It is carried through for reference, but every percentage the report displays is computed from the turnover figures.
- **Months after the current one hold orders already booked, not turnover earned.** They are drawn outlined rather than filled and excluded from the year-on-year headline — summing them against a full prior year would understate the business badly. Only completed months (`lastCompleteMonthIndex`) feed the totals.

Entity is `JAWS` when the item name mentions JAWS, `VPS` otherwise; blanks stay `null` rather than collapsing to `$0`, so "no data" never reads as "no turnover". The year-on-year chart deliberately shows **two** series, not three: three years of one hue fail the normal-vision colour-separation floor (ΔE 14 — indistinguishable even with full colour vision), so 2024 lives in the table beneath. Series colours are CSS variables with separately validated light and dark steps; note that CSS-var colours do not resolve in SVG presentation *attributes*, so every fill goes through `style={{}}`.

**Where the reports get their data** (audited 2026-08-20 when the workshop module was parked — nothing else needed reworking):

| Source | Sections |
|---|---|
| MYOB (`lib/myob-reporting`) | KPI summary, P&L, top customers, receivables/payables aging, stock summary/reorder/dead, distributor ranking, pipeline, 6-month trends |
| Monday boards | Sales funnel, rep scorecards, quote aging, monthly conversion trend, combined pipeline |
| MechanicDesk facts (`md_invoices` / `md_quotes`) | Workshop Map, incl. Vehicle Trend |
| `calls` + `call_analysis` | All six Call Analytics sections |
| `crm_*` | Lead pipeline, campaign performance |
| `b2b_*` | B2B sales |

None of them read the portal's workshop tables — that was only ever Workshop Performance, now removed.

### 7.9 Tasks & Projects (`/tasks`, `/projects`, `/todos`)

Tasks: Monday-style board/list + React Flow automations (5-min cron). Projects: force-directed web of the six Monday "Hidden To Do" boards with comment posting back to Monday. To-Dos: manager scorecards over the same boards.

### 7.10 Messaging (`/messages`) & Notifications

Portal-native channels/DMs (Slack replacement for internal chat; WhatsApp/Messenger/IG phases not built). Notification bell + badges with 8 emitters; Web Push for staff and distributors (PWA installable).

### 7.11 Agents (`/agents`)

Monitoring-agent inbox (`lib/agent-framework` — not `lib/agents`, which is Pipeline A's mailbox map). Agents run every 15 min via cron; findings are triaged Dismiss / Mark done.

### 7.12 Stocktake — Mechanics Desk (`/stocktake`)

Upload count XLSX → Run Match (dispatches GH Action; includes coverage check) → review variance → Push to MD. Counted rows are sacred (row_number bug fixed 2026-07-30). MD is single-session — a stocktake run can 401 if someone logs into MD as the same employee mid-run (known, deferred).

### 7.13 Stripe→MYOB (`/stripe-myob`)

Lists Stripe invoices per account label and pushes them to MYOB as Professional Invoice + Customer Payment pairs; payout reconciliation endpoints support the JAWS accounts.

### 7.14 Sales/analysis surfaces

`/distributors` (group-aware revenue reporting; groups managed at `/admin/groups`), `/sales`, `/stock` (⚠ no SSR gate), `/forecasting` (MD job report forecast; `/jobs` redirects here), `/vehicle-sales` (platform classification cache from VPS invoices), `/job-reports` (MD job report ingest for PO→job matching).

### 7.15 Settings (`/settings`)

Tile launcher: General · Connections (Integrations / Health / MYOB) · Distributor Report config · VIN Codes · Users · Audit log · Profile · Claude connector (MCP tokens) · Service tokens · **Library**.

### 7.16 Library (`/admin/library`)

This document and the SOP, served inside the portal — readable on screen with a contents rail, and downloadable as PDF. Registry: `lib/library-docs.ts` (one row per document). Gated on `admin:settings`.

- `docs/*.md` is the **source of truth**; the reader renders it live server-side (`marked`), so editing the markdown updates the on-screen copy at the next deploy.
- `docs/*.pdf` is a **generated artifact** — regenerate with `scripts/render-doc-pdf.js` (marked + Playwright; needs `npx playwright install chromium` once) and commit it. It goes stale silently otherwise.
- **⚠ The PDFs are deliberately not in `public/`.** This document names where every credential lives, the Supabase project id, the Tailscale addresses and the open security gaps; anything under `public/` is served to the internet to anyone holding the URL, with no sign-in. Downloads go through `/api/admin/library/[slug]`, which is auth-gated.
- **⚠ `next.config.js` → `outputFileTracingIncludes` must list `docs/**` for the three Library routes.** The paths are built at runtime so Next's tracer can't see them; without it the files are pruned from the serverless bundle and 404 in production while working perfectly in dev.
- **Illustrated documents.** Screenshots live in `docs/img/` and are referenced relatively (`![alt](img/foo.png)`). The renderer writes its print page to a temp file beside the markdown and loads it as a real `file://` URL — a `setContent()` page has an `about:blank` origin and silently renders file images blank. `DOC_DATE` overrides the cover's compiled date. Portal screenshots are produced from the real components (a throwaway page under `pages/` rendering the page component with mock props, driven by Playwright) — no live data is needed and none is captured.
- **⚠ The in-app reader does not rewrite relative image paths**, so an illustrated document renders its pictures in the PDF but shows broken images on screen. `docs/library-access-sop.md` (how to find these documents, with screenshots) is therefore **deliberately not registered** in `lib/library-docs.ts` — it is handed out as a PDF. Registering it needs an auth-gated `/api/admin/library/img/[file]` route plus a `renderer.image` rewrite in `pages/admin/library/[slug].tsx`.

**SOP**: see `CLAUDE.md` §1 — every change to the portal updates these documents as part of the same work.

---

## 8. Monitoring & troubleshooting

1. **First stop**: `/admin/connections` (or Settings → Connections → Health). 21 checks across accounting / workshop / comms / crm / phone / infra, written every 5 min by the health cron. Manual force: `curl -H "Authorization: Bearer $CRON_SECRET" https://justautos.app/api/cron/health-check?force=1`.
2. **Freshness-based checks** (PBX CDR sync, transcribe, Deepgram, MD pulls) go red when data stops arriving — the fix is on the source host/worker, not the portal.
3. **Graph mailbox rows red** → renewal cron failed or the subscription died: re-run `setup-graph-subscriptions` (idempotent).
4. **MYOB rows red** → token lapsed: re-run the connect flow (Settings → MYOB Connection). Remember refresh tokens die if unused for weeks.
5. **GH Actions rows red** → check the Actions tab on the repo; MD workers upload failure artifacts and Slack on failure.
6. **A B2B order paid but no MYOB invoice** → `b2b_orders.myob_write_error`; fix cause, retry from the admin order page. Stripe webhook itself is idempotent.
7. **Prints not coming out** → the workshop PC agent: check the tray/NSSM service; it drains pending jobs on startup, so restarting it usually clears the backlog.

---

## 9. Known risks, debt & outstanding items (as of 2026-08-20)

**Security**
- Supabase `service_role` key was exposed in an April 2026 session and **has never been rotated**. Rotation must update: Vercel env, the FreePBX host workers, the workshop print agent `.env`, and GitHub Actions secrets — all hold it.
- Repo working tree contains `agents/label-print-agent/.env` and `hardware/ja-scale-node/secrets.h` — verify both are gitignored and never committed with live values.
- `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` is client-exposed — must stay referrer-restricted.
- Three pages lack SSR auth gates (`/stock`, `/imports`, `/admin/connections`) — API-level gating covers data but the pages render.

**Consistency / drift**
- `lib/auth.ts` role type is missing `workshop` (use `lib/permissions.ts`).
- Migrations `148` and `153` are duplicated numbers; latest applied is `196_md_vehicle_trend`, so next is `197`.
- `bank-payments-slack` and `slack-cleanup` cron handlers exist but aren't scheduled in `vercel.json`.
- Seven overlapping base-URL env vars.
- The Library reader can't display images (no rewrite of relative `img/` paths, no auth-gated image route), so `docs/library-access-sop.md` sits in `docs/` as a PDF-only document rather than on the Library shelf — see §7.16.
- Older docs (`03`, `05`, `07`) predate the CData decommission, B2B rollout and Xero foundation, and still describe the workshop migration as active — trust this document and the code.

**Operational**
- MYOB and Xero OAuth tokens need periodic exercise; Xero refresh tokens are single-use (rotation is handled, but never hand-edit the row).
- The FreePBX box is CentOS 7 — camera bridges pinned to Node 16; the whole host is a single point of failure for calls, coaching, and camera alerts. `sip-loss-monitor.sh` may still be running there from the phone-dropout investigation (upstream/FreedomBroadband was the cause) — clean up when resolved.
- **Queued-then-parked calls report their longest single leg, not the whole conversation.** `classifyCall` picks the longest-billsec `Dial`/`Park` leg with a `dstchannel`; on a queue call the leg carrying the true total has `lastapp='Queue'` and is excluded. Two known cases: 2026-07-20 09:30 shows 14:33 on Kaleb against a real ~30:19, and 2026-08-10 14:50 shows 25:16 on Tyronne against ~32:55. Both duration *and* advisor attribution are affected, so correcting it would move historical coaching numbers — deliberately left alone.
- **MechanicDesk is staying** (decision 2026-08-20) — the replacement build is paused, so the 9 scheduled MD scrapers are a permanent production dependency rather than a temporary bridge. The portal's workshop module is built but unused; `docs/workshop_md_parity.md` keeps the cutover checklist if it is ever revived.
- Parked/off: negative-call automation (`CALL_CONCERNS_ENABLED`), portal-side calls analysis cron, Places key on New Booking quick-add (key unset), first real JAWS→VPS stock transfer pending, Live Bins hardware untested in production, live call monitoring WSS keep-alive retest pending.
- MYOB→Xero migration: foundation only — adapter waves per module still to come; both entities eventually move.

---

## 10. Key file index

| Area | Files |
|---|---|
| Auth/permissions | `lib/permissions.ts`, `lib/authServer.ts`, `lib/auth.ts`, `lib/b2bAuthServer.ts`, `lib/b2bSupplierAuth.ts`, `lib/service-auth.ts` |
| Credential resolver | `lib/integration-config.ts`, `pages/api/admin/integrations.ts`, `components/settings/IntegrationsTab.tsx` |
| Accounting | `lib/myob.ts`, `lib/myob-reporting.ts`, `lib/xero.ts`, `lib/accounting-provider.ts`, `lib/accounting/*` |
| B2B pipeline | `lib/b2b-order-pipeline.ts`, `lib/b2b-payment.ts`, `lib/b2b-myob-invoice.ts`, `lib/b2b-machship.ts`, `lib/b2b-freight-*.ts`, `lib/b2b-dropship-*.ts`, `lib/b2b-tune-jobs.ts` |
| AP | `lib/ap-extraction.ts`, `lib/ap-auto-entry.ts`, `lib/ap-statement-watch.ts`, `lib/ap-myob-bill.ts` |
| Workshop tooling | `pages/workshop/letters`, `.../prepick`, `.../purchase-orders`, `.../stocktake`, `lib/workshop-*.ts`. Paused replacement build: rest of `pages/workshop/*` + `docs/workshop_md_parity.md` |
| Calls | `lib/live-calls.ts`, `lib/calls-analysis.ts`, `lib/softphone.ts`, `docs/pbx_click_to_dial_worker.md` |
| Mail | `lib/microsoft-graph.ts`, `lib/email.ts`, `lib/agents.ts` (mailbox→owner map) |
| Health | `pages/api/cron/health-check.ts`, `pages/admin/connections.tsx` |
| Workers | `.github/workflows/*`, `scripts/*`, `agents/label-print-agent/`, `agents/ja-freightbay/`, `hardware/ja-scale-node/` |
| Config | `vercel.json` (crons + maxDurations), `migrations/` |
