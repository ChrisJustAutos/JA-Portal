// lib/agents/store.ts
// Service-role persistence for the agents framework: run audit + findings
// upsert (deduped on (agent, dedupe_key)). Server-only.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { AgentId, Finding } from './types'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export interface NewFinding { id: string; agent: string; kind: string; severity: string; title: string; body: string | null; href: string | null }
export interface UpsertResult { inserted: number; updated: number; newFindings: NewFinding[] }

export async function startRun(agent: AgentId): Promise<string | null> {
  const { data } = await sb().from('agent_runs').insert({ agent }).select('id').maybeSingle()
  return data?.id || null
}

export async function finishRun(runId: string | null, r: { ok: boolean; findingsCount?: number; error?: string | null; detail?: any }) {
  if (!runId) return
  await sb().from('agent_runs').update({
    finished_at: new Date().toISOString(),
    ok: r.ok, findings_count: r.findingsCount ?? 0,
    error: r.error ? String(r.error).slice(0, 500) : null,
    detail: r.detail ?? null,
  }).eq('id', runId)
}

// Upsert findings deduped on (agent, dedupe_key). Existing keys are updated in
// place (content refreshed, status untouched so a human's decision sticks);
// genuinely new ones are inserted and returned for the digest.
export async function upsertFindings(agent: AgentId, findings: Finding[]): Promise<UpsertResult> {
  if (!findings.length) return { inserted: 0, updated: 0, newFindings: [] }
  const c = sb()
  const withKey = findings.map(f => ({ ...f, _key: f.dedupeKey || f.kind }))
  const keys = Array.from(new Set(withKey.map(f => f._key)))

  const { data: existing } = await c.from('agent_findings')
    .select('id, dedupe_key').eq('agent', agent).in('dedupe_key', keys)
  const byKey = new Map<string, { id: string }>((existing || []).map((r: any) => [r.dedupe_key, r]))

  const toInsert: any[] = []
  let updated = 0
  for (const f of withKey) {
    const row = {
      agent, kind: f.kind, severity: f.severity || 'info', confidence: f.confidence || null,
      title: f.title.slice(0, 300), body: f.body ?? null, href: f.href ?? null,
      suggested_action: f.suggestedAction ?? null, payload: f.payload ?? null, dedupe_key: f._key,
    }
    const ex = byKey.get(f._key)
    if (ex) {
      await c.from('agent_findings').update({ ...row, updated_at: new Date().toISOString() }).eq('id', ex.id)
      updated++
    } else {
      toInsert.push(row)
    }
  }

  const newFindings: NewFinding[] = []
  if (toInsert.length) {
    const { data: ins, error } = await c.from('agent_findings')
      .insert(toInsert).select('id, agent, kind, severity, title, body, href')
    if (!error && ins) newFindings.push(...(ins as any[]))
  }
  return { inserted: toInsert.length, updated, newFindings }
}
