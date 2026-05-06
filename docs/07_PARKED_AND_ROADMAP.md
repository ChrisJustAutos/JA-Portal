# JA Portal — Parked Items & Roadmap

What's not built yet, what's deferred, what decisions are pending. Updated 7 May 2026.

---

## 🔴 Security debt (re-raise)

### Supabase service_role key not rotated
`qtiscbvhlvdvafwtdtcd` service_role key was exposed in a 23 April 2026 curl session. Chris chose to leave it at the time. Rotation is ~10 min:
1. Generate new service role key in Supabase dashboard
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Vercel env (production + preview)
3. Update the same env var on the FreePBX host (used by sync.js / transcribe.js)
4. Redeploy
5. Confirm calls page still loads, stocktake API still works

**Worth re-raising every session until done.**

### Stripe live keys with low traffic exposure
Stripe is wired and live on the `/b2b/checkout` flow. Distributors aren't on the platform yet so transaction volume is low, but the secret keys and webhook endpoint are real. If the env ever leaks, the financial blast radius is non-zero. Worth confirming Vercel env access is locked down to admins only.

### MYOB OAuth refresh tokens — extended absences risk
Refresh tokens need regular use. The AP pipeline running daily keeps them alive, but a multi-week portal pause (e.g. extended Hawaii trip with no AP traffic) could let them lapse. Worth either (a) ensuring the cron continues to fire even if invoice volume drops to zero, or (b) adding a heartbeat that pings MYOB once daily regardless of traffic.

---

## 🟢 Recently shipped (moved from pending → live)

### MYOB direct OAuth — LIVE
Custom Node OAuth implementation in the portal. The Make.com OAuth experiment from April 2026 is dead; this replaced it. AP pipeline now writes full bills with line items via this path.

### AP pipeline — LIVE end-to-end
Supplier emails → Graph webhook → PDF parse → portal `/ap` review → MYOB push (header + lines) → Amanda approves in MYOB. Replaces the manual In Tray + line-item entry workflow. Saves Amanda hours per week.

### Mobile operations setup — LIVE (7 May 2026)
- GitHub MCP write access via `claude-github-mcp-connector` GitHub App installed on `ChrisJustAutos`
- Workshop laptop (Windows MSI) running OpenSSH + Tailscale + Claude Code
- Phone with Tailscale + Termius, SSH key auth
- Default workflow: push direct to `main` from chat sessions; SSH from phone for ad-hoc operations

### B2B portal admin surface — LIVE internally
`/admin/b2b/*` (catalogue, distributors, orders, settings) operational. Distributor-facing `/b2b/*` routes built and Stripe-wired but not yet rolled out to actual distributors.

---

## 🟡 Decisions pending

### B2B distributor rollout — when?
The B2B platform is technically ready (admin works, customer routes built, Stripe live). The pending decision is when to switch real distributors over from the current ordering process to the portal. Likely a phased rollout — pick one or two friendly distributors first, get feedback, expand. Not blocked by tech.

### Pipeline C — keep or kill?
Pipeline C ingests the nightly MD WIP report into a `wip_snapshot` lane in Supabase, reserved for a future "Today's Workshop" widget on the Overview page. The widget hasn't been built and may never be. Re-evaluate if not built by ~end of May.

### Customer 360 pop on inbound calls — build or skip?
Plan was: when an inbound call rings, pop a sidebar showing the caller's MYOB invoice history + recent jobs. MYOB via CData covers V1; MD scrape would be required for full job history. Pragmatic take: don't build MD scrape speculatively for this.

### Cin7 vs custom portal investment
Open question being evaluated by leadership. The portal already covers some of what Cin7 would do (especially with B2B + AP now live). Worth re-evaluating the Cin7 case in light of how much the portal has shipped recently.

### Brand name for Chris's side AI consulting business
Unresolved. Style preference: dropped-vowel misspelled-word (Flickr/Tumblr aesthetic with AI-tech feel). Next session should start from desired brand feeling rather than jumping to names.

### Disclose side business to Just Autos leadership
Outstanding action before sending any outreach for the side AI consulting business. Not portal-related but worth noting since it sits in shared memory.

### Staging branch + verify-before-promote workflow
Currently push direct to `main` → Vercel deploys to production. Now that mobile ops is live, the risk of a phone-driven "fat finger" deploy is real. Worth setting up a `staging` branch (or using PR previews) and treating "deploy to staging, verify, promote to main" as the default mobile flow. Deferred until after Hawaii — would have eaten today's setup window.

---

## 🟢 Queued work (clear next milestones)

### Phase 3 — Call coaching pipeline
Triggered when phone analytics has enough volume to test against. Plan:
- Per-rep coaching → Slack DM to that rep
- Flagged calls → Slack DM to manager
- Purely internal — no writes to AC or Monday from coaching analysis
- Uses Claude API directly from the FreePBX host (or Vercel edge function)

### "Today's Workshop" widget on Overview page
Reads `wip_snapshot` lane. Depends on Pipeline C decision above.

### `/admin/health` page extension
Existing `ConnectionsTab.tsx` is a good foundation. Extend into a full deploy-verification page: smoke-tests every pipeline, every integration, key API routes. Mobile-friendly so it works as the verify-after-deploy surface from a phone.

### Audit findings batch (B1-B6)
18 audit findings from 30 Apr 2026, batched into 6 work units totalling ~15 hours. Includes:
- Standardising error handling across API routes
- Consistent permission gating
- Sentry / error tracking integration
- Automated test coverage for critical paths

### Next.js 14.2.5 security patch + dependency audit
4 npm vulnerabilities (1 critical) need review. Bump Next to latest 14.2.x. Don't run `npm audit fix --force` blindly — review each.

---

## 🔵 Known-but-deferred bugs

### Pipeline A
- **Old Zapier Zap not disabled.** Cosmetic. Disable when convenient.
- **AC orphan-contact bug on stage 38 transitions.** Cosmetic.
- **Backfill old tips not run.** Historical quotes from before Pipeline A went live don't have AC/Monday data populated.
- **James and Tyronne `contactAttempts` column IDs are placeholders.**
- **`monday-followup` integration has hardcoded column ID `numeric_mm12czp1`.**

### Stocktake
- **Already-pushed items with QTY=0 can't be retroactively fixed.** Cosmetic in MD UI; counts are what matters for finalisation.

### Phone analytics
- **Mono 8kHz audio causes merged diarization segments.** Dual-channel audio capture deferred.
- **Speaker heuristic is heuristic, not guaranteed.** Flag transcripts that look reversed.

---

## 🟣 Strategic ideas (not on the roadmap, just captured)

### Bulk MD stock catalogue cache
If MD ever exposes a "list all stock" endpoint, match phase could go from ~30s to ~5s.

### Combined match-then-push mode
Skip the dispatch round-trip between match and push by adding a `match-and-push` mode. Saves ~30-60s of GH Actions overhead. Requires trusting the matcher 100%.

### Forecast accuracy validation
Compare forecast lane data (from auto-pull) against actual revenue from MYOB at month-end.

### Quote-to-Sale conversion analytics
Pipeline A captures quotes. Match them against eventual sales in MYOB to compute per-rep conversion rates.

### Use the laptop+phone setup for proactive monitoring
The always-on laptop with Claude Code + SSH access opens up monitoring patterns that weren't practical before:
- Scheduled health checks that ping Slack on regression
- Remote ad-hoc CData queries from a phone for sales meetings
- Trigger MD pulls on demand without waiting for the cron

Worth thinking about what becomes possible now that "Claude has hands on the laptop" is part of the toolkit.

---

## How this doc gets maintained

When a session ships something significant, update the relevant section:
- Live → move from queued/parked to "Recently shipped" in this doc and update relevant pipeline entries elsewhere
- Decided → remove from "Decisions pending"
- Deferred → keep here with a date stamp
- Won't do → delete (don't keep clutter)

When a session ends with an unresolved item, add it to "Decisions pending" or "Parked items" with enough context that future-Chris (or future-Claude) can pick it up cold.
