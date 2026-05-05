// pages/api/cron/health-check.ts
//
// Health check worker for the Connections page (full coverage — 21 checks).
//
// Triggered by Vercel Cron every 5 minutes (see vercel.json). Each row in
// integration_health has its own check_interval_min — checks are skipped
// if last_check_at is still within that interval.
//
// Manual invocation:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check?force=1
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check?only=monday,supabase
//
// Status mapping per check:
//   green   — endpoint healthy / data fresh / no anomalies
//   yellow  — connected but degraded (config issue, soon-to-expire, etc)
//   red     — actually broken (auth failure, missing config, stale heartbeat)
//
// Coverage:
//   Direct API checks:    myob_jaws, myob_vps, supabase, monday,
//                         activecampaign, gh_actions_md_pull,
//                         gh_actions_stocktake
//   Subscription state:   graph_mailbox_*  (×7), graph_renewal_cron
//   Heartbeat from data:  freepbx_cdr_sync, freepbx_transcribe, deepgram,
//                         mechanics_desk
//   Config-only:          slack_webhooks
//   Self-evident:         vercel, cdata_mcp (deprecated)

import { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from '../../../lib/myob'
import { listActiveSubscriptions, StoredSubscription } from '../../../lib/microsoft-graph'

// ── Types ───────────────────────────────────────────────────────────────
type Status = 'green' | 'yellow' | 'red'

interface CheckResult {
  status: Status
  error?: string
  metadata?: Record<string, any>
}

interface CheckRecord extends CheckResult {
  name: string
  ranAt: string
}

// ── Supabase ────────────────────────────────────────────────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Per-invocation cache ────────────────────────────────────────────────
// Multiple checks (graph_mailbox_*, graph_renewal_cron) all need the same
// Graph subscription list. Cache it once per cron invocation. Reset at the
// top of handler() so warm-restart Vercel functions don't see stale data.
let _subsCache: Map<string, StoredSubscription> | null = null
async function getSubsMap(): Promise<Map<string, StoredSubscription>> {
  if (_subsCache) return _subsCache
  const subs = await listActiveSubscriptions()
  _subsCache = new Map(subs.map(s => [s.mailbox.toLowerCase(), s]))
  return _subsCache
}

// ── Helpers ─────────────────────────────────────────────────────────────
function freshnessStatus(
  lastSeen: Date | string | null,
  thresholds: { greenMaxMs: number; yellowMaxMs: number },
): Status {
  if (!lastSeen) return 'red'
  const ageMs = Date.now() - new Date(lastSeen).getTime()
  if (ageMs <= thresholds.greenMaxMs) return 'green'
  if (ageMs <= thresholds.yellowMaxMs) return 'yellow'
  return 'red'
}

function ageString(ms: number): string {
  if (ms < 0) return 'in future'
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

// integration_health.name → mailbox email. Hardcoded since the row name
// doesn't include the full domain. Keep in lockstep with whatever
// setup-graph-subscriptions creates.
const MAILBOX_FOR_NAME: Record<string, string> = {
  graph_mailbox_chris:   'chris@justautosmechanical.com.au',
  graph_mailbox_dom:     'dom@justautosmechanical.com.au',
  graph_mailbox_graham:  'graham@justautosmechanical.com.au',
  graph_mailbox_james:   'james@justautosmechanical.com.au',
  graph_mailbox_kaleb:   'kaleb@justautosmechanical.com.au',
  graph_mailbox_tyronne: 'tyronne@justautosmechanical.com.au',
}

// ════════════════════════════════════════════════════════════════════════
// CHECKS
// ════════════════════════════════════════════════════════════════════════

// ── MYOB ────────────────────────────────────────────────────────────────
async function checkMyob(label: 'JAWS' | 'VPS'): Promise<CheckResult> {
  try {
    const conn = await getConnection(label)
    if (!conn) return { status: 'red', error: 'Not connected — reconnect in Settings → MYOB Connection' }
    if (!conn.company_file_id) return { status: 'yellow', error: 'Connected but no company file selected' }

    const start = Date.now()
    const { status, data } = await myobFetch(
      conn.id,
      `/accountright/${conn.company_file_id}/Sale/Invoice`,
      { query: { '$top': 1, '$count': 'true' } }
    )
    const latencyMs = Date.now() - start

    if (status === 200) {
      const invoiceCount = typeof data === 'object' && data?.Count != null ? Number(data.Count) : null
      return {
        status: 'green',
        metadata: { companyFile: conn.company_file_name, companyFileId: conn.company_file_id, invoiceCount, latencyMs },
      }
    }
    if (status === 401) return { status: 'red', error: 'Token rejected (401) — likely needs reconnect' }
    if (status === 403) return { status: 'red', error: 'Forbidden (403) — scope may be missing' }
    const errMsg = typeof data === 'object' && data?.Errors?.[0]?.Message
      ? String(data.Errors[0].Message).slice(0, 200) : `HTTP ${status}`
    return { status: 'red', error: errMsg, metadata: { latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Supabase ────────────────────────────────────────────────────────────
async function checkSupabase(): Promise<CheckResult> {
  try {
    const start = Date.now()
    const { error } = await sb().from('integration_health').select('name', { count: 'exact', head: true })
    const latencyMs = Date.now() - start
    if (error) return { status: 'red', error: error.message.slice(0, 200), metadata: { latencyMs } }
    return { status: 'green', metadata: { latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Monday ──────────────────────────────────────────────────────────────
async function checkMonday(): Promise<CheckResult> {
  try {
    const token = process.env.MONDAY_API_TOKEN
    if (!token) return { status: 'red', error: 'MONDAY_API_TOKEN not set in environment' }
    const start = Date.now()
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ me { id name email } }' }),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { status: 'red', error: `HTTP ${res.status}`, metadata: { latencyMs } }
    const json: any = await res.json()
    if (json?.errors?.length) {
      return { status: 'red', error: String(json.errors[0]?.message || 'GraphQL error').slice(0, 200), metadata: { latencyMs } }
    }
    if (!json?.data?.me?.id) return { status: 'red', error: 'Unexpected response — no me.id', metadata: { latencyMs } }
    return { status: 'green', metadata: { user: json.data.me.email || json.data.me.name, latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── ActiveCampaign ──────────────────────────────────────────────────────
async function checkActiveCampaign(): Promise<CheckResult> {
  try {
    const apiUrl = process.env.ACTIVECAMPAIGN_API_URL
    const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
    if (!apiUrl || !apiKey) {
      return { status: 'red', error: 'ACTIVECAMPAIGN_API_URL or ACTIVECAMPAIGN_API_KEY not set in environment' }
    }
    const start = Date.now()
    const url = `${apiUrl.replace(/\/$/, '')}/api/3/users/me`
    const res = await fetch(url, { headers: { 'Api-Token': apiKey, 'Accept': 'application/json' } })
    const latencyMs = Date.now() - start
    if (!res.ok) return { status: 'red', error: `HTTP ${res.status}`, metadata: { latencyMs } }
    const json: any = await res.json().catch(() => ({}))
    return { status: 'green', metadata: { user: json?.user?.email || json?.user?.username || null, latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── MS Graph mailbox ────────────────────────────────────────────────────
async function checkGraphMailbox(integrationName: string): Promise<CheckResult> {
  try {
    const expectedMailbox = MAILBOX_FOR_NAME[integrationName]
    if (!expectedMailbox) return { status: 'red', error: 'No mailbox mapped for this integration name' }

    const subs = await getSubsMap()
    const sub = subs.get(expectedMailbox.toLowerCase())
    if (!sub) {
      return {
        status: 'red',
        error: 'No active Graph subscription for this mailbox',
        metadata: { mailbox: expectedMailbox, hint: 'Run setup-graph-subscriptions for this mailbox' },
      }
    }
    if (sub.status !== 'active') {
      return {
        status: 'red',
        error: `Subscription status is '${sub.status}'`,
        metadata: { mailbox: expectedMailbox, lastRenewalError: sub.last_renewal_error },
      }
    }

    const expiresAtMs = new Date(sub.expiration_date_time).getTime()
    const msUntilExpiry = expiresAtMs - Date.now()
    const hoursUntilExpiry = Math.round(msUntilExpiry / 3_600_000)

    if (msUntilExpiry < 0) {
      return {
        status: 'red',
        error: `Subscription expired ${ageString(-msUntilExpiry)} ago`,
        metadata: { mailbox: expectedMailbox, expiredAt: sub.expiration_date_time },
      }
    }
    if (msUntilExpiry < 12 * 3_600_000) {
      return {
        status: 'yellow',
        error: `Expires in ${hoursUntilExpiry}h — renewal cron should extend soon`,
        metadata: { mailbox: expectedMailbox, expiresAt: sub.expiration_date_time, lastRenewedAt: sub.last_renewed_at },
      }
    }
    return {
      status: 'green',
      metadata: {
        mailbox: expectedMailbox,
        expiresAt: sub.expiration_date_time,
        hoursUntilExpiry,
        lastRenewedAt: sub.last_renewed_at,
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── MS Graph renewal cron ───────────────────────────────────────────────
async function checkGraphRenewalCron(): Promise<CheckResult> {
  try {
    const subs = await getSubsMap()
    if (subs.size === 0) {
      return { status: 'red', error: 'No active Graph subscriptions exist — Pipeline A inert' }
    }

    let oldestExpiry: Date | null = null
    let mostRecentRenewal: Date | null = null
    let firstError: { mailbox: string; err: string } | null = null

    for (const sub of Array.from(subs.values())) {
      const expiresAt = new Date(sub.expiration_date_time)
      if (!oldestExpiry || expiresAt < oldestExpiry) oldestExpiry = expiresAt
      if (sub.last_renewed_at) {
        const renewedAt = new Date(sub.last_renewed_at)
        if (!mostRecentRenewal || renewedAt > mostRecentRenewal) mostRecentRenewal = renewedAt
      }
      if (!firstError && sub.last_renewal_error) {
        firstError = { mailbox: sub.mailbox, err: sub.last_renewal_error }
      }
    }

    const oldestExpiryMs = oldestExpiry ? oldestExpiry.getTime() - Date.now() : 0
    const oldestHoursAhead = Math.round(oldestExpiryMs / 3_600_000)

    const metadata: Record<string, any> = {
      activeSubs: subs.size,
      oldestExpiresIn: `${oldestHoursAhead}h`,
      mostRecentRenewal: mostRecentRenewal?.toISOString() || null,
    }
    if (firstError) metadata.firstError = firstError

    if (oldestExpiryMs < 0) {
      return { status: 'red', error: 'At least one subscription has expired', metadata }
    }
    if (oldestExpiryMs < 12 * 3_600_000) {
      return { status: 'red', error: `Oldest sub expires in ${oldestHoursAhead}h — renewal cron not keeping up`, metadata }
    }
    if (firstError) {
      return { status: 'yellow', error: `Renewal error for ${firstError.mailbox}: ${firstError.err.slice(0, 100)}`, metadata }
    }
    return { status: 'green', metadata }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── GitHub Actions ──────────────────────────────────────────────────────
async function checkGhWorkflow(workflowFile: string): Promise<CheckResult> {
  try {
    const token = process.env.GH_DISPATCH_TOKEN
    if (!token) return { status: 'red', error: 'GH_DISPATCH_TOKEN not set in environment' }

    const url = `https://api.github.com/repos/ChrisJustAutos/JA-Portal/actions/workflows/${workflowFile}/runs?per_page=5`
    const start = Date.now()
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    const latencyMs = Date.now() - start
    if (!res.ok) return { status: 'red', error: `GitHub API HTTP ${res.status}`, metadata: { latencyMs } }
    const json: any = await res.json()
    const runs: any[] = json?.workflow_runs || []
    if (runs.length === 0) {
      return { status: 'yellow', error: 'No workflow runs found', metadata: { workflow: workflowFile, latencyMs } }
    }
    const latest = runs[0]
    const conclusion = latest.conclusion as string | null
    const lastRunAt = latest.run_started_at as string

    if (conclusion === 'success') {
      const ageMs = Date.now() - new Date(lastRunAt).getTime()
      return {
        status: 'green',
        metadata: {
          workflow: workflowFile,
          lastRunAt, conclusion,
          age: ageString(ageMs),
          runUrl: latest.html_url,
          latencyMs,
        },
      }
    }
    if (conclusion === 'failure') {
      return {
        status: 'red',
        error: `Latest run failed`,
        metadata: { workflow: workflowFile, lastRunAt, runUrl: latest.html_url, latencyMs },
      }
    }
    if (conclusion === null) {
      return {
        status: 'yellow',
        error: 'Latest run still in progress',
        metadata: { workflow: workflowFile, lastRunAt, runUrl: latest.html_url, latencyMs },
      }
    }
    return {
      status: 'yellow',
      error: `Latest run conclusion: ${conclusion}`,
      metadata: { workflow: workflowFile, lastRunAt, conclusion, runUrl: latest.html_url, latencyMs },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Mechanics Desk (derived) ────────────────────────────────────────────
async function checkMechanicsDesk(): Promise<CheckResult> {
  try {
    const { data, error } = await sb()
      .from('job_report_runs')
      .select('uploaded_at, row_count')
      .eq('source', 'api')
      .order('uploaded_at', { ascending: false })
      .limit(1)
    if (error) return { status: 'red', error: error.message.slice(0, 200) }
    if (!data || data.length === 0) {
      return { status: 'red', error: 'No auto-pull runs ever — Pipeline C may not be set up' }
    }
    const lastUpload = data[0].uploaded_at
    const rowCount = data[0].row_count
    const ageMs = Date.now() - new Date(lastUpload).getTime()
    const status = freshnessStatus(lastUpload, {
      greenMaxMs: 24 * 3_600_000,
      yellowMaxMs: 48 * 3_600_000,
    })
    return {
      status,
      error: status !== 'green' ? `Last successful pull was ${ageString(ageMs)} ago` : undefined,
      metadata: {
        lastUploadAt: lastUpload,
        rowCount,
        age: ageString(ageMs),
        mode: 'derived from job_report_runs.source=api freshness',
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Slack webhooks (config-only) ────────────────────────────────────────
async function checkSlackWebhooks(): Promise<CheckResult> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) return { status: 'red', error: 'SLACK_WEBHOOK_URL not set in environment' }
  return {
    status: 'green',
    metadata: { mode: 'config-check', note: 'Webhook configured (not pinged to avoid noise)' },
  }
}

// ── Deepgram (derived) ──────────────────────────────────────────────────
async function checkDeepgram(): Promise<CheckResult> {
  try {
    const { data, error } = await sb()
      .from('call_transcripts')
      .select('transcribed_at, model, provider')
      .order('transcribed_at', { ascending: false })
      .limit(1)
    if (error) return { status: 'red', error: error.message.slice(0, 200) }
    if (!data || data.length === 0) {
      return { status: 'red', error: 'No transcripts have ever been recorded' }
    }
    const last = data[0]
    const ageMs = Date.now() - new Date(last.transcribed_at).getTime()
    const status = freshnessStatus(last.transcribed_at, {
      greenMaxMs: 6 * 3_600_000,
      yellowMaxMs: 24 * 3_600_000,
    })
    return {
      status,
      error: status !== 'green' ? `Last transcript ${ageString(ageMs)} ago` : undefined,
      metadata: {
        lastTranscriptAt: last.transcribed_at,
        provider: last.provider,
        model: last.model,
        age: ageString(ageMs),
        mode: 'derived from call_transcripts freshness',
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── FreePBX CDR sync (derived) ──────────────────────────────────────────
async function checkFreepbxCdrSync(): Promise<CheckResult> {
  try {
    const { data, error } = await sb()
      .from('calls')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
    if (error) return { status: 'red', error: error.message.slice(0, 200) }
    if (!data || data.length === 0) {
      return { status: 'red', error: 'No calls have ever been synced' }
    }
    const lastSync = data[0].synced_at
    const ageMs = Date.now() - new Date(lastSync).getTime()
    const status = freshnessStatus(lastSync, {
      greenMaxMs: 4 * 3_600_000,
      yellowMaxMs: 24 * 3_600_000,
    })
    return {
      status,
      error: status !== 'green' ? `Last sync ${ageString(ageMs)} ago` : undefined,
      metadata: {
        lastSyncAt: lastSync,
        age: ageString(ageMs),
        mode: 'derived from calls.synced_at freshness',
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── FreePBX transcribe (derived) ────────────────────────────────────────
async function checkFreepbxTranscribe(): Promise<CheckResult> {
  try {
    const { data, error } = await sb()
      .from('call_transcripts')
      .select('transcribed_at')
      .order('transcribed_at', { ascending: false })
      .limit(1)
    if (error) return { status: 'red', error: error.message.slice(0, 200) }
    if (!data || data.length === 0) {
      return { status: 'red', error: 'No transcripts have ever been created' }
    }
    const lastT = data[0].transcribed_at
    const ageMs = Date.now() - new Date(lastT).getTime()
    const status = freshnessStatus(lastT, {
      greenMaxMs: 6 * 3_600_000,
      yellowMaxMs: 24 * 3_600_000,
    })
    return {
      status,
      error: status !== 'green' ? `Last transcript ${ageString(ageMs)} ago` : undefined,
      metadata: {
        lastTranscribeAt: lastT,
        age: ageString(ageMs),
        mode: 'derived from call_transcripts.transcribed_at freshness',
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Vercel (self-evident) ───────────────────────────────────────────────
async function checkVercel(): Promise<CheckResult> {
  return {
    status: 'green',
    metadata: {
      mode: 'self-check',
      region: process.env.VERCEL_REGION || 'unknown',
      env: process.env.VERCEL_ENV || 'unknown',
      note: 'Self-evident — this worker is running on Vercel',
    },
  }
}

// ── CData MCP (deprecated) ──────────────────────────────────────────────
async function checkCdataMcp(): Promise<CheckResult> {
  return {
    status: 'green',
    metadata: {
      mode: 'deprecated',
      note: 'Replaced by direct MYOB OAuth (5 May 2026) — see myob_jaws / myob_vps',
    },
  }
}

// ════════════════════════════════════════════════════════════════════════
// CHECK REGISTRY
// ════════════════════════════════════════════════════════════════════════
const CHECKS: Record<string, () => Promise<CheckResult>> = {
  // Accounting
  myob_jaws:             () => checkMyob('JAWS'),
  myob_vps:              () => checkMyob('VPS'),
  cdata_mcp:             checkCdataMcp,
  // Workshop
  gh_actions_md_pull:    () => checkGhWorkflow('mechanicdesk-pull.yml'),
  gh_actions_stocktake:  () => checkGhWorkflow('mechanicdesk-stocktake.yml'),
  mechanics_desk:        checkMechanicsDesk,
  // Comms
  graph_mailbox_chris:   () => checkGraphMailbox('graph_mailbox_chris'),
  graph_mailbox_dom:     () => checkGraphMailbox('graph_mailbox_dom'),
  graph_mailbox_graham:  () => checkGraphMailbox('graph_mailbox_graham'),
  graph_mailbox_james:   () => checkGraphMailbox('graph_mailbox_james'),
  graph_mailbox_kaleb:   () => checkGraphMailbox('graph_mailbox_kaleb'),
  graph_mailbox_tyronne: () => checkGraphMailbox('graph_mailbox_tyronne'),
  graph_renewal_cron:    checkGraphRenewalCron,
  slack_webhooks:        checkSlackWebhooks,
  // CRM
  monday:                checkMonday,
  activecampaign:        checkActiveCampaign,
  // Phone
  deepgram:              checkDeepgram,
  freepbx_cdr_sync:      checkFreepbxCdrSync,
  freepbx_transcribe:    checkFreepbxTranscribe,
  // Infra
  supabase:              checkSupabase,
  vercel:                checkVercel,
}

// ════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret
    ? authHeader === `Bearer ${cronSecret}`
    : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  // Reset per-invocation cache (Vercel may warm-restart this module)
  _subsCache = null

  const force = req.query.force === '1'
  const onlyParam = (req.query.only as string | undefined) || ''
  const only = onlyParam ? onlyParam.split(',').map(s => s.trim()).filter(Boolean) : null

  const startMs = Date.now()
  const allKnown = Object.keys(CHECKS)
  const candidates = only ? only.filter(n => allKnown.includes(n)) : allKnown
  const skippedUnknown = only ? only.filter(n => !allKnown.includes(n)) : []

  let toRun: string[] = candidates
  let skippedFresh: string[] = []
  if (!force) {
    const { data: rows, error } = await sb()
      .from('integration_health')
      .select('name, last_check_at, check_interval_min')
      .in('name', candidates)
    if (error) return res.status(500).json({ error: 'Failed to read integration_health: ' + error.message })
    const now = Date.now()
    const rowMap = new Map<string, { last: string | null; interval: number }>(
      (rows || []).map((r: any) => [r.name, { last: r.last_check_at, interval: r.check_interval_min || 5 }])
    )
    toRun = []
    for (const name of candidates) {
      const r = rowMap.get(name)
      if (!r) { toRun.push(name); continue }
      if (!r.last) { toRun.push(name); continue }
      const ageMs = now - new Date(r.last).getTime()
      const intervalMs = r.interval * 60_000
      if (ageMs >= intervalMs) toRun.push(name)
      else skippedFresh.push(name)
    }
  }

  // Run all selected checks in parallel
  const results: CheckRecord[] = []
  await Promise.allSettled(toRun.map(async name => {
    const ranAt = new Date().toISOString()
    try {
      const result = await CHECKS[name]()
      results.push({ ...result, name, ranAt })
    } catch (e: any) {
      results.push({
        status: 'red',
        error: (e?.message || String(e)).slice(0, 200),
        name, ranAt,
      })
    }
  }))

  // Update DB rows in parallel
  await Promise.allSettled(results.map(async r => {
    const update: Record<string, any> = {
      status: r.status,
      last_check_at: r.ranAt,
      last_error: r.error || null,
      metadata: r.metadata || null,
      updated_at: r.ranAt,
    }
    if (r.status === 'green') update.last_success_at = r.ranAt
    const { error } = await sb().from('integration_health').update(update).eq('name', r.name)
    if (error) console.error(`health-check: failed to update ${r.name}:`, error.message)
  }))

  const summary = { total: results.length, green: 0, yellow: 0, red: 0 }
  for (const r of results) summary[r.status]++

  return res.status(200).json({
    ok: true,
    summary,
    durationMs: Date.now() - startMs,
    ranAt: new Date().toISOString(),
    results: results.map(r => ({ name: r.name, status: r.status, error: r.error || null, metadata: r.metadata || null })),
    skipped: { fresh: skippedFresh, unknown: skippedUnknown },
  })
}
