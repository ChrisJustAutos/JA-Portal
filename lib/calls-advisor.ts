// lib/calls-advisor.ts
//
// Shared "effective advisor" attribution for the Phone Calls module.
//
// Some staff (e.g. hot-deskers) have no extension of their own — they answer
// on whatever phone is free, so their calls land under another person's
// agent_ext. The sync/analysis pipeline records who *actually* handled the
// call in effective_advisor_slack_user_id / effective_advisor_name. We key
// agents off the slack id when present (so a person's calls group together
// regardless of which handset rang) and fall back to the extension otherwise.
//
// Mirrors the rule already used in lib/reports/fetchers.ts:
//   key  = effective_advisor_slack_user_id || `ext:${agent_ext}`
//   name = effective_advisor_name || agent_name

export type AgentKey =
  | { kind: 'slack'; id: string }
  | { kind: 'ext'; ext: string }
  | null

/**
 * Parse an agent filter token from the UI/query string.
 *   "slack:U0AEPGD608H" → identified advisor
 *   "ext:999"           → calls on that extension with no identified advisor
 *   "999" (bare)        → treated as an extension (back-compat)
 *   "" | "all" | null   → no filter
 */
export function parseAgentKey(raw: string | null | undefined): AgentKey {
  if (!raw || raw === 'all') return null
  if (raw.startsWith('slack:')) {
    const id = raw.slice('slack:'.length).trim()
    return id ? { kind: 'slack', id } : null
  }
  if (raw.startsWith('ext:')) {
    const ext = raw.slice('ext:'.length).trim()
    return ext ? { kind: 'ext', ext } : null
  }
  return { kind: 'ext', ext: raw }
}

/**
 * Stable grouping key for a single call row. Identified advisors group by
 * slack id; everything else groups by extension. Returns null when the call
 * has no answering agent at all (missed / no extension).
 */
export function callAgentKey(row: { effective_advisor_slack_user_id?: string | null; agent_ext?: string | null }): string | null {
  if (row.effective_advisor_slack_user_id) return `slack:${row.effective_advisor_slack_user_id}`
  if (row.agent_ext) return `ext:${row.agent_ext}`
  return null
}
