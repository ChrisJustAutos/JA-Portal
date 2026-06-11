// lib/crm-automation-graph.ts
// CLIENT-SAFE. The automation graph model shared by the React Flow editor
// and the server engine: node/edge types (React Flow native shape so the
// editor persists verbatim), validation, and the legacy linear-steps →
// graph converter (lazy migration of pre-099 automations).

export type TriggerEvent =
  | 'lead_created' | 'stage_changed' | 'manual'
  | 'tag_added' | 'quote_accepted' | 'quote_declined' | 'booking_created'
  | 'campaign_email_opened' | 'campaign_email_clicked'
  | 'no_activity' | 'webhook'

export const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  lead_created: 'A lead is created',
  stage_changed: 'A lead moves to a stage',
  manual: 'Manual enrolment only',
  tag_added: 'A tag is added to a contact',
  quote_accepted: 'A workshop quote is accepted',
  quote_declined: 'A workshop quote is declined',
  booking_created: 'A workshop booking is created',
  campaign_email_opened: 'A campaign email is opened',
  campaign_email_clicked: 'A campaign email is clicked',
  no_activity: 'No activity on a lead for N days',
  webhook: 'Incoming webhook',
}

export type ActionKind =
  | 'email' | 'sms' | 'task' | 'notify_owner'
  | 'add_tag' | 'remove_tag' | 'move_stage' | 'update_field' | 'webhook_out' | 'create_quote_draft'

export interface ConditionRule {
  field: string            // 'lead.stage' | 'lead.value' | 'lead.source' | 'lead.owner_id'
                           // | 'contact.tags' | 'contact.has_email' | 'contact.has_mobile' | 'contact.source'
                           // | 'engagement.opened' | 'engagement.clicked' (any campaign)
                           // | 'time.is_business_hours' | 'time.day_of_week'
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'is_set' | 'not_set'
  value?: string | number
}

export interface TriggerConfig {
  stage?: string | null       // lead_created / stage_changed filter
  tag?: string | null         // tag_added filter ('' = any tag)
  days?: number | null        // no_activity threshold
  campaign_id?: string | null // engagement triggers ('' = any campaign)
}

export interface FlowNodeData {
  kind: 'trigger' | 'action' | 'condition' | 'wait'
  // trigger
  event?: TriggerEvent
  config?: TriggerConfig
  // action
  action?: ActionKind
  subject?: string
  body?: string
  task_priority?: string
  on_failure?: 'continue' | 'stop'
  tag?: string                // add_tag / remove_tag
  stage?: string              // move_stage
  field?: 'value' | 'owner_id' | 'next_follow_up_in_days'   // update_field
  field_value?: string        // update_field value
  url?: string                // webhook_out
  secret?: string             // webhook_out HMAC secret (optional)
  // condition
  match?: 'all' | 'any'
  rules?: ConditionRule[]
  // wait
  hours?: number
}

export interface FlowNode {
  id: string
  type: 'trigger' | 'action' | 'condition' | 'wait'
  position: { x: number; y: number }
  data: FlowNodeData
}
export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: 'yes' | 'no' | null
}
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

// ── Validation (client preview + server authoritative) ────────────────
export function validateGraph(graph: any): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const nodes: FlowNode[] = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges: FlowEdge[] = Array.isArray(graph?.edges) ? graph.edges : []
  if (!nodes.length) return { ok: false, errors: ['The flow is empty.'] }

  const triggers = nodes.filter(n => n.data?.kind === 'trigger')
  if (triggers.length !== 1) errors.push('The flow needs exactly one trigger node.')

  const ids = new Set(nodes.map(n => n.id))
  if (ids.size !== nodes.length) errors.push('Duplicate node ids.')
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) errors.push('An edge points at a missing node.')
  }

  // ≤1 outgoing edge per (node, handle); condition nodes use yes/no handles.
  const outBy = new Map<string, number>()
  for (const e of edges) {
    const key = `${e.source}:${e.sourceHandle || ''}`
    outBy.set(key, (outBy.get(key) || 0) + 1)
  }
  outBy.forEach((n, key) => { if (n > 1) errors.push(`Node ${key.split(':')[0]} has more than one connection from the same output.`) })
  for (const n of nodes) {
    if (n.data?.kind === 'condition') {
      const hasYes = edges.some(e => e.source === n.id && e.sourceHandle === 'yes')
      if (!hasYes) errors.push('A condition node has no "yes" branch.')
      if (!Array.isArray(n.data.rules) || n.data.rules.length === 0) errors.push('A condition node has no rules.')
    }
    if (n.data?.kind === 'wait' && !(Number(n.data.hours) > 0)) errors.push('A wait node needs a duration greater than zero.')
    if (n.data?.kind === 'action' && !n.data.action) errors.push('An action node has no action selected.')
  }

  // All nodes reachable from the trigger; the graph must be acyclic.
  if (triggers.length === 1) {
    const adj = new Map<string, string[]>()
    for (const e of edges) { (adj.get(e.source) || adj.set(e.source, []).get(e.source))!.push(e.target) }
    const seen = new Set<string>()
    const stack = [triggers[0].id]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const t of adj.get(id) || []) stack.push(t)
    }
    for (const n of nodes) if (!seen.has(n.id)) errors.push(`Node "${n.id}" isn't connected to the trigger.`)
    // Cycle check (DFS colouring) on the directed graph.
    const colour = new Map<string, 1 | 2>()
    const dfs = (id: string): boolean => {
      colour.set(id, 1)
      for (const t of adj.get(id) || []) {
        if (colour.get(t) === 1) return true
        if (!colour.has(t) && dfs(t)) return true
      }
      colour.set(id, 2)
      return false
    }
    if (dfs(triggers[0].id)) errors.push('The flow contains a loop — flows must run forward only.')
  }

  return { ok: errors.length === 0, errors }
}

// ── Legacy converter ───────────────────────────────────────────────────
// Linear steps (cumulative delay_hours) → vertical graph with RELATIVE wait
// nodes between actions. Deterministic ids: trigger-1, wait-N, step-N — the
// enrolment cursor migration maps next_step_order → 'step-N'.
export function linearStepsToGraph(automation: { trigger_event: string; trigger_stage: string | null }, steps: Array<{ step_order: number; delay_hours: number; action: string; subject: string | null; body: string | null; task_priority: string | null }>): FlowGraph {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const X = 120, W = 90
  let y = 40
  nodes.push({
    id: 'trigger-1', type: 'trigger', position: { x: X, y },
    data: { kind: 'trigger', event: (automation.trigger_event as TriggerEvent) || 'lead_created', config: { stage: automation.trigger_stage || null } },
  })
  let prevId = 'trigger-1'
  let prevDelay = 0
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  for (const s of sorted) {
    y += W
    const delta = Math.max(0, (Number(s.delay_hours) || 0) - prevDelay)
    prevDelay = Math.max(prevDelay, Number(s.delay_hours) || 0)
    if (delta > 0) {
      const waitId = `wait-${s.step_order}`
      nodes.push({ id: waitId, type: 'wait', position: { x: X, y }, data: { kind: 'wait', hours: delta } })
      edges.push({ id: `e-${prevId}-${waitId}`, source: prevId, target: waitId })
      prevId = waitId
      y += W
    }
    const stepId = `step-${s.step_order}`
    nodes.push({
      id: stepId, type: 'action', position: { x: X, y },
      data: { kind: 'action', action: (s.action as ActionKind) || 'email', subject: s.subject || '', body: s.body || '', task_priority: s.task_priority || 'normal', on_failure: 'continue' },
    })
    edges.push({ id: `e-${prevId}-${stepId}`, source: prevId, target: stepId })
    prevId = stepId
  }
  return { nodes, edges }
}

// First node after the trigger (where new enrolments start walking).
export function entryNodeId(graph: FlowGraph): string | null {
  const trigger = graph.nodes.find(n => n.data?.kind === 'trigger')
  if (!trigger) return null
  const out = graph.edges.find(e => e.source === trigger.id)
  return out?.target || null
}

export function nextNodeId(graph: FlowGraph, fromId: string, handle?: 'yes' | 'no'): string | null {
  const edge = graph.edges.find(e => e.source === fromId && (handle ? e.sourceHandle === handle : !e.sourceHandle || e.sourceHandle === null))
  return edge?.target || null
}
