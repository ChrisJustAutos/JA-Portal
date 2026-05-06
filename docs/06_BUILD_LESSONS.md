# JA Portal — Build Lessons & Debugging Gotchas

Things that have bitten us. Read this when something is mysteriously broken — the answer is probably here. Updated 7 May 2026.

---

## Next.js / TypeScript

### The `.tsx` in `pages/api/` trap
A stray `.tsx` file in `pages/api/` crashes Next.js at module load. Generic 500 HTML page, no useful error. **First thing to check** if something just stopped working with no obvious cause.

### TypeScript target is ES5
Cannot spread typed arrays. `String.fromCharCode(...new Uint8Array(buf))` won't compile and would stack-overflow on a 10MB file anyway. Use `String.fromCharCode.apply(null, slice as any)` with a chunk loop.

### Vercel error fingerprinting
- Generic 500 HTML page → module-load crash (broken import, `.tsx` issue, syntax error)
- JSON error response → handler crash
- Empty response / timeout → Vercel function timeout
- Function logs in Vercel dashboard are the fastest path to the real error

### Don't run long jobs on Vercel
~30s is a soft ceiling. Anything Playwright-based or genuinely long goes to GitHub Actions via `repository_dispatch`.

### Build noise worth fixing eventually (post-Hawaii)
- Next.js 14.2.5 has a known security vulnerability (Anthropic-flagged 11 Dec 2025) — bump to latest 14.2.x patch when there's time
- `npm install` reports 4 vulnerabilities (1 critical) in dependencies — review before running `npm audit fix --force` because it can break things

---

## MYOB writes — direct OAuth pattern (the working path)

**The story:** CData MCP exposes `PurchaseBillItems` as read-only and was the bottleneck for AP automation for months. Rather than wait, the portal now has a direct MYOB OAuth implementation at `/api/myob/auth/connect` and `/api/myob/auth/callback`. This is the live path for all MYOB writes.

### Lessons from getting it working
- The Make.com HTTP module attempt at OAuth (April 2026) failed because Make's OAuth2 module doesn't handle MYOB's token endpoint cleanly. Direct Node fetch worked where Make didn't.
- Refresh tokens have a finite life. They need to be exercised by real traffic regularly. The AP pipeline running daily keeps them alive — but if the portal goes quiet (e.g. multi-week absence), the connection can lapse.
- MYOB API responses include nested company-file URLs that depend on the user's selected datafile. The connect flow has to handle the company-file selection step before tokens become useful for writes.
- Test endpoints (`/api/myob/test/datascopes`, `/api/myob/test/invoice`) exist for verifying the connection. Use them after any token-related change.

### What this unlocks
- Full bill creation: header + line items in one call
- Bill status updates
- Supplier card edits (was already working via CData UPDATE — direct OAuth gives an alternative path)

### When you'd still use CData
For reads where the tabular query model is convenient (distributor revenue, P&L summaries, account lookups). Don't use it for writes anymore.

---

## CData / MYOB — read-side gotchas

### CData cannot JOIN
Run queries separately, match in memory. The `rowsToObjects()` helper for unwrapping `{results:[{schema, rows}]}` is mandatory.

### `SaleInvoiceItems` has no Date column
To filter line items by date, query separately, then join to `SaleInvoices` via `SaleInvoiceId = ID` in JS/Python.

### MYOB date columns are TIMESTAMP
Comparing to a literal date string (`'2026-04-30'`) can give surprising results.

### MYOB P&L summary requires explicit dates
`[MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport]` requires explicit `StartDate`/`EndDate` in the WHERE clause.

### GST handling
MYOB stores `Total` inclusive. Ex-GST = `IF TaxCodeCode = 'GST' THEN Total / 1.1 ELSE Total`.

---

## Mechanics Desk

### Login: use `state:'detached'`, NOT `networkidle`
```ts
await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 30000 })
```

### Job report download
Browser navigation throws "Download is starting" with no actual download. Use cookie-based Node `fetch()` with `Referer: /auto_workshop/app` header.

### `GET /stocktakes` listing returns NO sheets
Only `GET /stocktakes/{id}` populates `stocktake_sheets`. Always re-fetch by ID before reading sheets.

### `POST /stocktakes` may return empty `stocktake_sheets`
Sheet 1 is created server-side but the response sometimes returns before it's queryable. Retry up to 5×1s after creation.

### Magic POST shape
```ts
POST /stocktake_sheets/{sheet_id}/new_item
{
  id: <sheet_id>,
  item: {
    stock_id, description, count, counted: true,
    quantity: <md_current_qty>,    // NOT auto-populated server-side
    allocated_quantity: 0
  }
}
```
**Always pass `currentQty` from the match step.**

---

## GitHub MCP write access — the install trap (added 7 May 2026)

Authorising the Claude GitHub MCP Connector via OAuth alone is **not enough** to grant write access. Authorise = "this app can identify me." Install = "this app can touch my repos." You need both.

### Symptoms
- Read works fine (`get_file_contents` returns content)
- All write operations 403 with `Resource not accessible by integration`
- GitHub OAuth screen shows generic "act on your behalf" permissions but no repo selection
- Disconnecting and reconnecting from Claude side doesn't help — it just re-uses the cached OAuth identity without prompting for installation

### Fix
1. Go to `https://github.com/apps/claude-github-mcp-connector`
2. Click Install
3. Choose the account (e.g. `ChrisJustAutos`)
4. Select repository access — pick **Only select repositories** and add JA-Portal explicitly
5. Confirm

The OAuth callback after install may show a JSON error like `{"type":"error","error":{"type":"invalid_request_error","message":"state: Field required"}}` — **the install still succeeded**, the error is cosmetic (state param wasn't preserved because you didn't initiate from Claude). Verify in GitHub Settings → Integrations → Applications → Installed GitHub Apps.

---

## GitHub Actions

### Playwright npm package must match container image version
`mcr.microsoft.com/playwright:v1.59.1-noble` works only if `package.json` has `"playwright": "1.59.1"` (exact, no `^`).

### Don't `actions/setup-node` inside a container
The container already has Node 20.

### Don't `npx playwright install --with-deps` inside a container
Chromium and OS deps are already there.

---

## Vercel deploys

### GitHub MCP push works now (as of 7 May 2026)
Previously `push_files` and `create_or_update_file` 403'd for the `ChrisJustAutos` account. Resolved by installing the Claude GitHub MCP Connector as a GitHub App on the account (see above). Default workflow is now: push directly to `main` from chat sessions.

### Vercel auto-deploys from `main`
Push to `main` → Vercel rebuilds → deploys to production. No staging branch yet.

### Function logs are the truth
Console logs show in Vercel dashboard under Deployments → Functions tab.

---

## Windows / SSH (added 7 May 2026)

### `Add-WindowsCapability` for OpenSSH Server can hang indefinitely
On a slow workshop connection, the Windows feature install for `OpenSSH.Server~~~~0.0.1.0` ran for 10+ minutes with no progress.

### Reliable fallback: install OpenSSH from GitHub release
```powershell
Invoke-WebRequest -Uri "https://github.com/PowerShell/Win32-OpenSSH/releases/download/v9.5.0.0p1-Beta/OpenSSH-Win64.zip" -OutFile "$env:TEMP\OpenSSH-Win64.zip"
Expand-Archive -Path "$env:TEMP\OpenSSH-Win64.zip" -DestinationPath "C:\Program Files\OpenSSH" -Force
& "C:\Program Files\OpenSSH\OpenSSH-Win64\install-sshd.ps1"
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH SSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

This bypasses Windows Update entirely. Took 30 seconds vs the failing 10+ minute Windows feature install.

### Admin user keys go in a different place
For users in the Administrators group, Windows OpenSSH does NOT use `C:\Users\<user>\.ssh\authorized_keys`. It uses `C:\ProgramData\ssh\administrators_authorized_keys`.

Permissions must be locked down:
```powershell
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /grant "Administrators:F"
icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /grant "SYSTEM:F"
```

If perms are loose, sshd silently rejects the key and falls back to password auth — confusing because there's no error in the client, just "permission denied."

### `npm` blocked by PowerShell execution policy on fresh Windows
Default is `Restricted`. Fix:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### winget installs need a fresh shell to pick up PATH
After `winget install <thing>`, close PowerShell and open a new window before running the new command. Otherwise PATH isn't updated for the running session.

### Microsoft account passwords don't always work for SSH password auth
If Windows is signed in via Microsoft account, password SSH login can fail with "permission denied" even with the correct password. Use SSH key auth instead — more secure and avoids the issue entirely.

---

## API design

### Service token vs user session
- API routes that GH Actions calls use `validateServiceToken(req, scope)` — `X-Service-Token` header against `service_tokens` table
- API routes that the UI calls use `getCurrentUser(req)` + `roleHasPermission(user.role, permission)`
- Some routes accept either — always try user first, fall back to service token

### Permission system
`lib/permissions.ts` maps roles (admin/manager/staff/restricted) to permissions (`view:stocktakes`, `edit:stocktakes`, etc).

---

## Stocktake-specific

### Always retry on transient errors
Network errors and HTTP 429/5xx warrant retry. We have `isThrottleError()` and `isTransientError()` helpers in the worker.

### Adaptive concurrency
On 429/5xx, halve `activeConcurrency` (floor 1). Configured via env vars `STOCKTAKE_MATCH_CONCURRENCY` (default 5) and `STOCKTAKE_PUSH_CONCURRENCY` (default 3).

### Stuck row detection (UI)
If a row sits in `matching` or `pushing` for > 5 minutes, the UI surfaces a Delete button. Constant `STUCK_THRESHOLD_MIN = 5` lives in three files.

---

## Webhooks (MS Graph + Monday)

### Subscription renewal
MS Graph subscriptions expire — we have a cron job every 6 hours doing this for the subscribed mailboxes.

### Monday webhooks fire on button column changes
Use a `button` column, not a status column. The webhook payload includes `pulseId`.

---

## When to ask vs assume

If a single fact is missing (column ID, board ID, exact stage number), ask one targeted question rather than guessing.
If general approach is missing (should this be parallel? should we retry?), make a sensible default and note it inline so it's easy to override.
