# JA Portal — External Integrations

How the portal talks to each external system, including auth model, key endpoints, and known quirks. Updated 7 May 2026.

---

## Mechanics Desk (workshop)

**Base:** `https://www.mechanicdesk.com.au`
**Workshop ID:** `5108`
**Auth model:** No public API. We log in via Playwright with `/auto_workshop/login` and harvest cookies + CSRF token.

### Login quirk
Use `page.waitForSelector('input[type="password"]', { state: 'detached' })` to detect successful login. **Do NOT** use `networkidle`.

### Endpoints we use
- `GET /auto_workshop/resource_search?query=X` — product search, used by stocktake match
- `GET /stocktakes` — listing endpoint, returns stocktakes WITHOUT `stocktake_sheets`. Always re-fetch detail.
- `GET /stocktakes/{id}` — full stocktake including sheets and items
- `POST /stocktakes` — create new. Retry up to 5×1s for `stocktake_sheets` to populate.
- `POST /stocktake_sheets/{sheet_id}/new_item` — magic POST for adding items, body shape documented in `06_BUILD_LESSONS.md`

### Job Report download
Browser navigation throws "Download is starting" with no actual file. Workaround: cookie-based Node `fetch()` with `Referer: /auto_workshop/app` header.

### What MD does NOT have
- No bulk stock export endpoint
- No PO data sync to MYOB
- No write API (no programmatic invoice/job creation)

---

## MYOB AccountRight — direct OAuth2 (write-side, LIVE)

**Auth:** Custom Node implementation in the portal at `/api/myob/auth/connect` and `/api/myob/auth/callback`. Tokens stored server-side and refreshed automatically.

**Status:** Live and used by the AP pipeline to push full bills with line items. Bypasses the CData line-item write limitation entirely. The Make.com OAuth attempt (April 2026) is dead; this is the surviving path.

### What works via direct OAuth
- INSERT `PurchaseBills` headers
- INSERT `PurchaseBillLines` (line items) — this is what unlocked end-to-end AP automation
- UPDATE `PurchaseBills` (line items, status)
- UPDATE `ContactSuppliers`
- Other AccountRight resources accessible via the standard MYOB API

### Token lifecycle
Refresh tokens have a finite lifespan and need to be exercised regularly. The AP pipeline running daily keeps them alive. **If the portal is quiet for an extended period (multi-week), the connection can die** — needs a fresh OAuth dance to restore. Worth monitoring before extended absences.

### Test endpoints
- `/api/myob/test/datascopes` — verify token + scope
- `/api/myob/test/invoice` — test bill creation flow

---

## MYOB AccountRight — via CData (read-side)

**Connections:** `MYOB_POWERBI_JAWS` and `MYOB_POWERBI_VPS`
**Auth:** CData MCP handles auth.

**Status:** Read-only by design now. All writes go via direct OAuth (above). Kept around for reporting because CData's tabular query model is convenient for distributor revenue calculations and other read-heavy work.

### Constraints (still apply for the read side)
- **No JOIN support** — query separately, match in memory
- `SaleInvoiceItems` has no Date column — filter by `AccountDisplayID` then join to `SaleInvoices` via `SaleInvoiceId = ID`
- MYOB date columns are TIMESTAMP — comparison to literal date strings can surprise you

### Key tables for reporting
- `SaleInvoiceItems`, `SaleInvoices` — distributor revenue
- `ProfitAndLossSummaryReport` — requires explicit `StartDate`/`EndDate` in WHERE
- `GeneralLedgerAccounts` — chart of accounts

### Old constraints — historical only (no longer apply)
The old "PurchaseBillItems is read-only" wall is no longer relevant — that constraint exists in CData, but the portal now writes via direct OAuth instead. Don't re-litigate this in future sessions.

---

## Supabase

**Project:** `qtiscbvhlvdvafwtdtcd`
**URL pattern:** `https://qtiscbvhlvdvafwtdtcd.supabase.co`

### Key tables
- `calls`, `transcripts` — phone analytics
- `stocktake_uploads` — XLSX upload metadata + parsed_rows + match_results + status
- `jobs` — MD job report ingest (forecast lane + wip_snapshot lane via `lane` column)
- `quote_events` — Pipeline B audit log
- `ap_invoices`, `ap_invoice_lines`, `ap_line_rules` — AP pipeline data
- `b2b_catalogue`, `b2b_orders`, `b2b_users`, `b2b_distributors` — B2B portal data
- `user_profiles` — auth/role data
- `service_tokens` — for GH Actions to authenticate against the portal API

### Auth
- Service role key used by Vercel API routes server-side (in env)
- Anon key used by browser-side queries (rare — most reads go through API routes)
- Service tokens (table-based) used by GH Actions workers — `X-Service-Token` header validated against `service_tokens` with scope check

### ⚠ Security debt
**Supabase service_role key for `qtiscbvhlvdvafwtdtcd` was exposed in a 23 April 2026 curl session and has not been rotated.** Worth re-raising — rotation is ~10 min of work.

---

## ActiveCampaign

**Base:** `justautosmechanical.activehosted.com`
**Auth:** API key in env (`AC_API_KEY` and `AC_API_URL`)

### Stages used by the portal
- Stage 38 = Quote Sent (Pipeline A target)

### User ID → name mapping
- 9 = James Wilson
- 13 = Tyronne Wright
- 15 = Graham Roy
- 16 = Kaleb Rowe
- 19 = Marcel De Paula
- 20 = Dom Simpson

### Known issues
- Orphan-contact bug on stage 38 transitions (Pipeline A) — never resolved, cosmetic
- Phone-only-contacts mode is enabled (relevant if creating contacts via API)

---

## Monday.com

**Workspace:** Just Autos
**Auth:** API token in env

### Quote Channel boards (Pipeline A target, Pipeline B trigger source)
- Dom: 5025942308
- Kaleb: 5025942316
- Graham: 5026840169
- James: 5025942292
- Tyronne: 5025942288

### Webhooks
- Each board has a "Fetch Call Notes" button column → webhook to `/api/monday/fetch-call-notes`
- Quote-Pending board receives new items from Pipeline A via API

### Known issues
- `monday-followup` integration has hardcoded column ID `numeric_mm12czp1` — should look up per board
- James and Tyronne `contactAttempts` column IDs are placeholders

---

## Microsoft Graph (Outlook)

**Auth:** OAuth2 app, refresh token + access token rotation in Vercel
**Renewal:** Cron job every 6 hours renews mailbox subscriptions

### Webhook endpoints
- `/api/webhooks/graph-mail` — sales rep mailboxes (Pipeline A — quote ingest)
- `/api/webhooks/graph-jobreport-mail` — chris@ inbox for nightly MD WIP report
- AP supplier-invoice intake also routes through Graph webhooks

### Mailboxes subscribed
chris@, james@, tyronne@, graham@, kaleb@, marcel@, dom@ — plus AP intake mailbox(es)

---

## Deepgram

**Model:** `nova-2-phonecall`
**Language:** `en-AU`
**Settings:** `utt_split=0.5`
**Auth:** API key in env on the FreePBX host

### Speaker heuristic
`speaker 0 = Agent` — agents greet/initiate. Mono 8kHz audio causes merged diarization segments.

---

## Stripe

**Auth:** API keys in env (live keys for the B2B checkout flow)
**Status:** Wired and processing payments on `/b2b/checkout` flow. Distributor side not yet rolled out, so transaction volume is currently low/internal.

### Webhook
- `/api/b2b/stripe/webhook` — receives Stripe events, used to advance B2B order state

### Risk note
Stripe is live and processing real payments. Even though distributor-facing routes aren't rolled out yet, the secret keys and webhook endpoint are real. Treat env vars accordingly.

---

## GitHub Actions

**Repo:** `ChrisJustAutos/JA-Portal`
**Branch:** `main`

### Workflows
- `.github/workflows/mechanicdesk-stocktake.yml` — match/push triggered by `repository_dispatch`
- `.github/workflows/mechanicdesk-pull.yml` — scheduled cron (5× daily AEST work hours)

### Container
Both run inside `mcr.microsoft.com/playwright:v1.59.1-noble` so Chromium and OS deps are pre-installed. **Do NOT** add `actions/setup-node` or `playwright install` steps.

### Required secrets
- `MECHANICDESK_WORKSHOP_ID`, `MECHANICDESK_USERNAME`, `MECHANICDESK_PASSWORD`
- `JA_PORTAL_BASE_URL`, `JA_PORTAL_API_KEY`
- `SLACK_WEBHOOK_URL`

### Important caveat
**`playwright` must be in `package.json` devDependencies** at the EXACT version matching the container image (`1.59.1`).

---

## Slack

**Auth:** Webhook URLs per channel, in env

### Webhooks in use
- Stocktake worker notifications
- MD auto-pull notifications (failure only)

### Future planned use
- Phase 3 call coaching DMs

---

## Vercel

**Project:** JA-Portal
**Branch:** `main` (auto-deploys on push)
**Function logs:** dashboard → Deployments → specific deploy → Functions tab

### Error fingerprinting
- Generic 500 HTML page → module-load crash (broken import, `.tsx` in `pages/api/`, syntax error)
- JSON error response → handler crash
- Empty response / timeout → Vercel function timeout

### Long-running work
**Don't run anything > ~30s on Vercel.** Anything browser-based or genuinely long goes to GitHub Actions.

---

## CData MCP (special call-out)

Used inside Claude conversations rather than from the portal directly. Worth knowing:

- **Always call `getInstructions(driverName)` before any other CData tool**
- For MYOB read-side: connection name `MYOB_POWERBI_JAWS` or `MYOB_POWERBI_VPS`
- Catalog matches connection name, schema is `MYOB`
- Date columns are TIMESTAMP — comparing to a literal date string can give surprising results

For MYOB writes — don't go through CData. Use the portal's direct OAuth endpoints instead (`/api/myob/*`).

---

## GitHub MCP (added 7 May 2026)

The Claude GitHub MCP Connector is now installed on the `ChrisJustAutos` account with write access to the JA-Portal repo. This means commits can be pushed directly from chat sessions without going through `/mnt/user-data/outputs/` and GitHub Desktop.

### Setup gotcha that bit us
The connector requires **two** authorisation steps that aren't obvious:
1. **OAuth Authorize** — grants identity (default first install)
2. **GitHub App Install** — grants repo access

Just doing step 1 leaves you stuck on read-only with 403 on writes. Step 2 was missed initially and required visiting `https://github.com/apps/claude-github-mcp-connector` to install. Document this so future setups don't repeat the same hour.

---

## Tailscale + Termius (added 7 May 2026)

The workshop laptop runs OpenSSH server + Tailscale + Claude Code. Phone runs Tailscale + Termius. SSH key auth (no password). Both devices on the same private Tailscale network — laptop is reachable from anywhere with internet, no public port exposure.

**Workflow:** Phone Termius → SSH to laptop → `claude` → Claude Code on the laptop drives the repo, runs commands, pushes commits.

**Windows OpenSSH gotcha:** the `Add-WindowsCapability` install can hang for 10+ minutes on slow connections. Fallback path is downloading the OpenSSH Win64 release zip directly from GitHub and running `install-sshd.ps1` — much more reliable.

**Admin user keys** live at `C:\ProgramData\ssh\administrators_authorized_keys`, NOT `C:\Users\<user>\.ssh\authorized_keys`. Permissions must be tight (Administrators + SYSTEM only) or sshd refuses to use the file.
