// lib/agents/comms.ts
// Communications Agent — watches the channels the business runs on (Outlook,
// Monday, internal pipelines) and surfaces what's broken or needs attention.
//
// Phase 1 ships the reliable, DB-only watchers (no external API calls, no
// Claude): mailbox-sync health and follow-up pipeline failures. Live Outlook /
// Monday "needs a reply / overdue" watchers + drafted actions come next.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { AgentContext, Finding } from './types'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

// Outlook mailbox sync health. An active Graph subscription that has a renewal
// error or has lapsed past its expiry means that mailbox has stopped feeding
// the portal (quotes, AP, statements) — exactly the silent failure that bit us
// before. One finding per affected mailbox so each clears independently.
async function graphSubscriptionHealth(): Promise<Finding[]> {
  const c = sb()
  const nowIso = new Date().toISOString()
  const { data } = await c.from('graph_subscriptions')
    .select('mailbox, subscription_id, resource, status, expiration_date_time, last_renewal_error')
    .eq('status', 'active')
  const out: Finding[] = []
  for (const s of (data || []) as any[]) {
    const expired = s.expiration_date_time && s.expiration_date_time < nowIso
    const errored = !!s.last_renewal_error
    if (!expired && !errored) continue
    out.push({
      kind: 'graph_sub_unhealthy',
      severity: 'warn',
      title: `Mailbox sync issue — ${s.mailbox}`,
      body: errored
        ? `Graph subscription renewal failed: ${String(s.last_renewal_error).slice(0, 200)}`
        : `Graph subscription lapsed (expired ${s.expiration_date_time}). This mailbox may not be feeding the portal.`,
      href: '/settings',
      dedupeKey: `comms:graph-sub:${s.subscription_id}`,
      payload: { mailbox: s.mailbox, subscription_id: s.subscription_id, resource: s.resource },
    })
  }
  return out
}

// Follow-up sync pipeline (call → Monday + ActiveCampaign) failures in the last
// 24h. One rolled-up finding per day so it nudges without spamming.
async function followUpFailures(): Promise<Finding[]> {
  const c = sb()
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data } = await c.from('follow_up_sync_jobs')
    .select('id, error_message, failed_at, stage')
    .eq('status', 'failed').gte('failed_at', since)
    .order('failed_at', { ascending: false }).limit(50)
  const rows = (data || []) as any[]
  if (!rows.length) return []
  const sample = rows.slice(0, 5).map(r => `· ${r.stage || 'job'}: ${String(r.error_message || 'failed').slice(0, 120)}`).join('\n')
  const day = new Date().toISOString().slice(0, 10)
  return [{
    kind: 'followup_failures',
    severity: 'warn',
    title: `${rows.length} follow-up sync${rows.length === 1 ? '' : 's'} failed (24h)`,
    body: `Calls that didn't push to Monday/ActiveCampaign:\n${sample}${rows.length > 5 ? `\n…and ${rows.length - 5} more` : ''}`,
    href: '/calls',
    dedupeKey: `comms:followup-fail:${day}`,
    payload: { count: rows.length },
  }]
}

export async function runComms(_ctx: AgentContext): Promise<Finding[]> {
  const findings: Finding[] = []
  // Each watcher is isolated — one failing shouldn't sink the whole run.
  for (const watcher of [graphSubscriptionHealth, followUpFailures]) {
    try { findings.push(...(await watcher())) }
    catch (e: any) { console.error(`[comms] watcher ${watcher.name} failed:`, e?.message || e) }
  }
  return findings
}
