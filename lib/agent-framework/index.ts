// lib/agents/index.ts
// Run harness for the agents framework: run an agent (or all), persist its
// findings (deduped), and push the newly-surfaced ones to the team. dryRun
// returns the findings without writing or notifying.

import { AGENTS, getAgent } from './registry'
import { startRun, finishRun, upsertFindings } from './store'
import { notify } from '../notifications'
import type { AgentContext, Finding } from './types'

export interface RunOutcome {
  agent: string
  ok: boolean
  findings: number
  inserted: number
  updated: number
  error?: string
  dryRun: boolean
  preview?: Finding[]
}

export async function runAgentById(id: string, opts: { dryRun?: boolean } = {}): Promise<RunOutcome> {
  const def = getAgent(id)
  const dryRun = !!opts.dryRun
  if (!def) return { agent: id, ok: false, findings: 0, inserted: 0, updated: 0, error: 'unknown agent', dryRun }

  const ctx: AgentContext = { dryRun }
  const runId = dryRun ? null : await startRun(def.id)
  try {
    const found = await def.run(ctx)
    if (dryRun) {
      await finishRun(runId, { ok: true, findingsCount: found.length, detail: { dryRun: true } })
      return { agent: id, ok: true, findings: found.length, inserted: 0, updated: 0, dryRun: true, preview: found }
    }
    const res = await upsertFindings(def.id, found)
    // Digest: ping admins/managers for genuinely-new warn/action findings only
    // (info stays in the inbox without interrupting). notify() is best-effort.
    for (const f of res.newFindings) {
      if (f.severity === 'info') continue
      await notify({
        module: 'agents',
        title: f.title,
        body: f.body || null,
        href: f.href || '/agents',
        dedupeKey: `agent-finding:${f.id}`,
        roles: ['admin', 'manager'],
      })
    }
    await finishRun(runId, { ok: true, findingsCount: found.length, detail: { inserted: res.inserted, updated: res.updated } })
    return { agent: id, ok: true, findings: found.length, inserted: res.inserted, updated: res.updated, dryRun: false }
  } catch (e: any) {
    const msg = e?.message || String(e)
    await finishRun(runId, { ok: false, error: msg })
    return { agent: id, ok: false, findings: 0, inserted: 0, updated: 0, error: msg, dryRun }
  }
}

export async function runAllAgents(opts: { dryRun?: boolean } = {}): Promise<RunOutcome[]> {
  const out: RunOutcome[] = []
  for (const id of Object.keys(AGENTS)) out.push(await runAgentById(id, opts))
  return out
}
