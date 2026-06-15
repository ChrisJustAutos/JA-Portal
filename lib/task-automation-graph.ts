// lib/task-automation-graph.ts
// CLIENT-SAFE. The task-automation graph model shared by the React Flow editor
// and the server engine: node/edge types (React Flow native shape), validation,
// and the entry/next helpers. Tasks-only — no CRM concepts here.

export type TriggerEvent =
  | 'task_created' | 'status_changed' | 'assignee_changed'
  | 'due_soon' | 'overdue' | 'manual' | 'webhook'

export const TRIGGER_LABELS: Record<TriggerEvent, string> = {
  task_created: 'A task is created',
  status_changed: 'A task changes status',
  assignee_changed: 'A task is assigned to someone',
  due_soon: 'A task is due within N days',
  overdue: 'A task becomes overdue',
  manual: 'Manual enrolment only',
  webhook: 'Incoming webhook',
}

export type ActionKind =
  | 'set_status' | 'set_priority' | 'assign' | 'move_group'
  | 'notify' | 'create_task' | 'webhook_out'

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done'] as const
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export interface ConditionRule {
  field: string   // task.status | task.priority | task.assignee_id | task.group_id
                  // | task.is_overdue | task.has_due | task.has_assignee
  op: 'eq' | 'neq' | 'is_set' | 'not_set' | 'is_true' | 'is_false'
  value?: string
}

export interface TriggerConfig {
  status?: string | null       // status_changed → only this new status
  group_id?: string | null     // task_created / status_changed → only this group
  priority?: string | null     // task_created → only this priority
  days?: number | null         // due_soon threshold
}

export interface FlowNodeData {
  kind: 'trigger' | 'action' | 'condition' | 'wait'
  // trigger
  event?: TriggerEvent
  config?: TriggerConfig
  // action
  action?: ActionKind
  on_failure?: 'continue' | 'stop'
  status?: string              // set_status / create_task
  priority?: string            // set_priority / create_task
  assignee_id?: string         // assign / create_task ('' = unassign, 'creator' = task creator)
  group_id?: string            // move_group / create_task
  title?: string               // create_task / notify (notify title)
  body?: string                // notify body / create_task description
  url?: string                 // webhook_out
  secret?: string              // webhook_out HMAC secret
  notify_target?: 'assignee' | 'creator'   // notify
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
function nodeLabel(n: FlowNode): string {
  if (n.data?.kind === 'action') return `"${String(n.data.action || 'action').replace(/_/g, ' ')}" action`
  return `${n.data?.kind || 'unknown'} node`
}

export function validateGraph(graph: any): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const nodes: FlowNode[] = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges: FlowEdge[] = Array.isArray(graph?.edges) ? graph.edges : []
  if (!nodes.length) return { ok: false, errors: ['The flow is empty.'] }

  const triggers = nodes.filter(n => n.data?.kind === 'trigger')
  if (triggers.length !== 1) errors.push('The flow needs exactly one trigger node.')

  const ids = new Set(nodes.map(n => n.id))
  const byId = new Map(nodes.map(n => [n.id, n]))
  if (ids.size !== nodes.length) errors.push('Duplicate node ids.')
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) errors.push('A connection points at a missing node.')
    if (e.source === e.target) errors.push('A node is connected to itself — remove that connection.')
  }

  const outBy = new Map<string, number>()
  for (const e of edges) {
    const key = `${e.source}:${e.sourceHandle || ''}`
    outBy.set(key, (outBy.get(key) || 0) + 1)
  }
  outBy.forEach((n, key) => {
    if (n > 1) {
      const node = byId.get(key.split(':')[0])
      errors.push(`The ${node ? nodeLabel(node) : 'node'} has more than one connection from the same output.`)
    }
  })
  for (const n of nodes) {
    if (n.data?.kind === 'condition') {
      const hasYes = edges.some(e => e.source === n.id && e.sourceHandle === 'yes')
      if (!hasYes) errors.push('A condition node has no "yes" branch — connect its green output.')
      if (!Array.isArray(n.data.rules) || n.data.rules.length === 0) errors.push('A condition node has no rules — click it and add at least one.')
    }
    if (n.data?.kind === 'wait' && !(Number(n.data.hours) > 0)) errors.push('A wait node needs a duration greater than zero.')
    if (n.data?.kind === 'action' && !n.data.action) errors.push('An action node has no action selected.')
  }

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
    for (const n of nodes) if (!seen.has(n.id)) errors.push(`The ${nodeLabel(n)} isn't connected to the flow — link it up or delete it.`)
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
