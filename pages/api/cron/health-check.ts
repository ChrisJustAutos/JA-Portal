// pages/api/cron/health-check.ts
//
// Health check worker for the Connections page (Chunk 1 of 3).
//
// Runs a set of lightweight integration checks and updates `integration_health`
// rows with current status, last_check_at, last_success_at, last_error,
// and per-check metadata.
//
// Triggered by Vercel Cron every 5 minutes (see vercel.json). Can also be
// invoked manually for testing:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check?force=1
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/health-check?only=monday,supabase
//
// Auth:
//   - If CRON_SECRET is set, requires `Authorization: Bearer ${CRON_SECRET}`
//     (Vercel Cron auto-attaches this header when the env var is set on the
//     project — no extra config needed for scheduled invocations).
//   - If CRON_SECRET is unset, falls back to checking the user-agent for
//     `vercel-cron`.
//
// Chunk 1 covers (5 checks):
//   - myob_jaws / myob_vps  (lightweight MYOB API call to confirm token+scope)
//   - supabase              (trivial SELECT against integration_health)
//   - monday                (GraphQL `me` query)
//   - activecampaign        (GET /users/me)
//
// Chunk 2 (queued):  GH Actions workflow status, MS Graph subscription expiry, Deepgram
// Chunk 3 (queued):  FreePBX heartbeat (requires touching sync.js / transcribe.js)

import { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from '../../../lib/myob'

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

// ── Individual checks ───────────────────────────────────────────────────

// MYOB — lightweight Sale/Invoice query against the connected company file.
// Verifies: connection exists, OAuth token valid, scope grants sales-read,
// company file is reachable. Cheap (returns 1 row + count).
async function checkMyob(label: 'JAWS' | 'VPS'): Promise<CheckResult> {
  try {
    const conn = await getConnection(label)
    if (!conn) {
      return { status: 'red', error: 'Not connected — reconnect in Settings → MYOB Connection' }
    }
    if (!conn.company_file_id) {
      return { status: 'yellow', error: 'Connected but no company file selected' }
    }

    const start = Date.now()
    const { status, data } = await myobFetch(
      conn.id,
      `/accountright/${conn.company_file_id}/Sale/Invoice`,
      { query: { '$top': 1, '$count': 'true' } }
    )
    const latencyMs = Date.now() - start

    if (status === 200) {
      const invoiceCount = typeof data === 'object' && data?.Count != null
        ? Number(data.Count)
        : null
      return {
        status: 'green',
        metadata: {
          companyFile: conn.company_file_name,
          companyFileId: conn.company_file_id,
          invoiceCount,
          latencyMs,
        },
      }
    }
    if (status === 401) {
      return { status: 'red', error: 'Token rejected (401) — likely needs reconnect' }
    }
    if (status === 403) {
      return { status: 'red', error: 'Forbidden (403) — scope may be missing' }
    }
    const errMsg = typeof data === 'object' && data?.Errors?.[0]?.Message
      ? String(data.Errors[0].Message).slice(0, 200)
      : `HTTP ${status}`
    return { status: 'red', error: errMsg, metadata: { latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// Supabase — confirm DB is reachable with our service role key. Trivial
// SELECT against the very table we're about to write to.
async function checkSupabase(): Promise<CheckResult> {
  try {
    const start = Date.now()
    const { error } = await sb()
      .from('integration_health')
      .select('name', { count: 'exact', head: true })
    const latencyMs = Date.now() - start
    if (error) {
      return { status: 'red', error: error.message.slice(0, 200), metadata: { latencyMs } }
    }
    return { status: 'green', metadata: { latencyMs } }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// Monday.com — GraphQL `me` query confirms API token is valid and Monday is up.
async function checkMonday(): Promise<CheckResult> {
  try {
    const token = process.env.MONDAY_API_TOKEN
    if (!token) {
      return { status: 'red', error: 'MONDAY_API_TOKEN not set in environment' }
    }
    const start = Date.now()
    const res = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ me { id name email } }' }),
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      return { status: 'red', error: `HTTP ${res.status}`, metadata: { latencyMs } }
    }
    const json: any = await res.json()
    if (json?.errors?.length) {
      const msg = String(json.errors[0]?.message || 'GraphQL error').slice(0, 200)
      return { status: 'red', error: msg, metadata: { latencyMs } }
    }
    if (!json?.data?.me?.id) {
      return { status: 'red', error: 'Unexpected response — no me.id', metadata: { latencyMs } }
    }
    return {
      status: 'green',
      metadata: {
        user: json.data.me.email || json.data.me.name,
        latencyMs,
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ActiveCampaign — /users/me confirms API key is valid and AC is up.
async function checkActiveCampaign(): Promise<CheckResult> {
  try {
    const apiUrl = process.env.AC_API_URL
    const apiKey = process.env.AC_API_KEY
    if (!apiUrl || !apiKey) {
      return { status: 'red', error: 'AC_API_URL or AC_API_KEY not set in environment' }
    }
    const start = Date.now()
    const url = `${apiUrl.replace(/\/$/, '')}/api/3/users/me`
    const res = await fetch(url, {
      headers: { 'Api-Token': apiKey, 'Accept': 'application/json' },
    })
    const latencyMs = Date.now() - start
    if (!res.ok) {
      return { status: 'red', error: `HTTP ${res.status}`, metadata: { latencyMs } }
    }
    const json: any = await res.json().catch(() => ({}))
    return {
      status: 'green',
      metadata: {
        user: json?.user?.email || json?.user?.username || null,
        latencyMs,
      },
    }
  } catch (e: any) {
    return { status: 'red', error: (e?.message || String(e)).slice(0, 200) }
  }
}

// ── Check registry ──────────────────────────────────────────────────────
// Maps integration_health.name → check function. Names not in this map
// remain UNKNOWN until later chunks add their checks.
const CHECKS: Record<string, () => Promise<CheckResult>> = {
  'myob_jaws':      () => checkMyob('JAWS'),
  'myob_vps':       () => checkMyob('VPS'),
  'supabase':       checkSupabase,
  'monday':         checkMonday,
  'activecampaign': checkActiveCampaign,
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth — Vercel Cron auto-sends `Authorization: Bearer ${CRON_SECRET}`
  // when CRON_SECRET is set on the project. Manual invocation must include
  // the same header. Falls back to user-agent check if CRON_SECRET unset.
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()

  const authorized = cronSecret
    ? authHeader === `Bearer ${cronSecret}`
    : userAgent.includes('vercel-cron')

  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  // Query options:
  //   ?force=1               — ignore check_interval_min, run every applicable check
  //   ?only=name1,name2      — only run specified checks (comma-separated)
  const force = req.query.force === '1'
  const onlyParam = (req.query.only as string | undefined) || ''
  const only = onlyParam ? onlyParam.split(',').map(s => s.trim()).filter(Boolean) : null

  const startMs = Date.now()
  const allKnown = Object.keys(CHECKS)

  // Names we'd LIKE to run (filtered by ?only= if provided)
  const candidates = only ? only.filter(n => allKnown.includes(n)) : allKnown
  const skippedUnknown = only ? only.filter(n => !allKnown.includes(n)) : []

  // If not forced, skip rows whose last_check_at is still within their interval.
  let toRun: string[] = candidates
  let skippedFresh: string[] = []
  if (!force) {
    const { data: rows, error } = await sb()
      .from('integration_health')
      .select('name, last_check_at, check_interval_min')
      .in('name', candidates)
    if (error) {
      return res.status(500).json({ error: 'Failed to read integration_health: ' + error.message })
    }
    const now = Date.now()
    const rowMap = new Map<string, { last: string | null; interval: number }>(
      (rows || []).map((r: any) => [r.name, { last: r.last_check_at, interval: r.check_interval_min || 5 }])
    )
    toRun = []
    for (const name of candidates) {
      const r = rowMap.get(name)
      if (!r) { toRun.push(name); continue }    // row missing — run anyway, will error sensibly
      if (!r.last) { toRun.push(name); continue }   // never checked — run
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
        name,
        ranAt,
      })
    }
  }))

  // Update rows in DB (parallel, errors logged but not fatal)
  await Promise.allSettled(results.map(async r => {
    const update: Record<string, any> = {
      status: r.status,
      last_check_at: r.ranAt,
      last_error: r.error || null,
      metadata: r.metadata || null,
      updated_at: r.ranAt,
    }
    if (r.status === 'green') update.last_success_at = r.ranAt
    const { error } = await sb()
      .from('integration_health')
      .update(update)
      .eq('name', r.name)
    if (error) console.error(`health-check: failed to update ${r.name}:`, error.message)
  }))

  // Summary
  const summary = { total: results.length, green: 0, yellow: 0, red: 0 }
  for (const r of results) summary[r.status]++

  return res.status(200).json({
    ok: true,
    summary,
    durationMs: Date.now() - startMs,
    ranAt: new Date().toISOString(),
    results: results.map(r => ({
      name: r.name,
      status: r.status,
      error: r.error || null,
      metadata: r.metadata || null,
    })),
    skipped: {
      fresh: skippedFresh,
      unknown: skippedUnknown,
    },
  })
}
