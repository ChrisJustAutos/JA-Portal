// lib/agents/types.ts
// Shared types for the monitoring-agents framework. An "agent" is a scheduled
// function that produces Findings into the unified inbox (agent_findings).

export type AgentId = 'comms' | 'accounts' | 'marketing' | 'ops'
export type Severity = 'info' | 'warn' | 'action'
export type Confidence = 'high' | 'medium' | 'low'
export type FindingStatus =
  | 'new' | 'auto_done' | 'awaiting_approval' | 'approved' | 'dismissed' | 'done'

// What a watcher returns. dedupeKey keeps re-runs from piling up duplicates —
// always set a stable one (falls back to `kind` if omitted).
export interface Finding {
  kind: string
  title: string
  severity?: Severity
  confidence?: Confidence
  body?: string | null
  href?: string | null
  dedupeKey?: string
  suggestedAction?: any   // proposed action, executed only on approval (or auto when high-confidence)
  payload?: any
}

export interface AgentContext {
  dryRun: boolean
}

export interface AgentDef {
  id: AgentId
  label: string
  run: (ctx: AgentContext) => Promise<Finding[]>
}
