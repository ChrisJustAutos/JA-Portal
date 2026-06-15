// components/tasks/flow/TaskFlowEditor.tsx
// The Monday-style task-automation canvas (React Flow v11, dynamically imported
// with ssr:false). Nodes: trigger / action / condition (yes·no) / wait. Saving
// PATCHes the whole graph; the server re-validates and bumps graph_version.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Node, type NodeProps, MarkerType,
} from 'reactflow'
import { T } from '../../ui'
import { useToast, useConfirm } from '../../ui/Feedback'
import {
  validateGraph, TRIGGER_LABELS, STATUSES, PRIORITIES,
  type FlowNodeData, type ConditionRule, type TriggerEvent,
} from '../../../lib/task-automation-graph'

const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 12.5, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }
const ghostBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }

const NODE_W = 230
const ACTION_META: Record<string, { icon: string; label: string; color: string }> = {
  set_status: { icon: '➡️', label: 'Set status', color: '#4f8ef7' },
  set_priority: { icon: '⚑', label: 'Set priority', color: '#f5a623' },
  assign: { icon: '👤', label: 'Assign', color: '#a78bfa' },
  move_group: { icon: '📁', label: 'Move group', color: '#2dd4bf' },
  notify: { icon: '🔔', label: 'Notify', color: '#38bdf8' },
  create_task: { icon: '➕', label: 'Create task', color: '#34c77b' },
  webhook_out: { icon: '🌐', label: 'Send webhook', color: '#fb923c' },
}
const STATUS_LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' }

function cardStyle(color: string, selected?: boolean): React.CSSProperties {
  return { width: NODE_W, background: T.bg2, borderRadius: 10, fontFamily: '"DM Sans", system-ui, sans-serif', border: `1.5px solid ${selected ? color : T.border2}`, boxShadow: selected ? `0 0 0 2px ${color}44` : '0 4px 14px rgba(0,0,0,0.25)' }
}
const headStyle = (color: string): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderBottom: `1px solid ${T.border}`, color, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' })
const bodyStyle: React.CSSProperties = { padding: '8px 11px', fontSize: 12, color: T.text2, lineHeight: 1.4, minHeight: 20, overflow: 'hidden' }
const dot = (color: string): React.CSSProperties => ({ width: 10, height: 10, background: color, border: `2px solid ${T.bg}` })

function TriggerNode({ data, selected }: NodeProps<FlowNodeData>) {
  const label = TRIGGER_LABELS[(data.event || 'task_created') as TriggerEvent] || data.event
  const extra = data.config?.status ? ` · ${STATUS_LABEL[data.config.status] || data.config.status}` : data.event === 'due_soon' ? ` · ${data.config?.days || 3}d` : ''
  return (
    <div style={cardStyle(T.green, selected)}>
      <div style={headStyle(T.green)}>⚡ Trigger</div>
      <div style={bodyStyle}>{label}{extra}</div>
      <Handle type="source" position={Position.Bottom} style={dot(T.green)} />
    </div>
  )
}
function ActionNode({ data, selected }: NodeProps<FlowNodeData>) {
  const meta = ACTION_META[data.action || 'set_status'] || ACTION_META.set_status
  const preview = (data.title || data.status || data.priority || '').slice(0, 70)
  return (
    <div style={cardStyle(meta.color, selected)}>
      <Handle type="target" position={Position.Top} style={dot(meta.color)} />
      <div style={headStyle(meta.color)}>{meta.icon} {meta.label}</div>
      <div style={bodyStyle}>{preview || <span style={{ color: T.text3, fontStyle: 'italic' }}>Click to configure…</span>}</div>
      <Handle type="source" position={Position.Bottom} style={dot(meta.color)} />
    </div>
  )
}
function ConditionNode({ data, selected }: NodeProps<FlowNodeData>) {
  const n = (data.rules || []).length
  return (
    <div style={cardStyle(T.amber, selected)}>
      <Handle type="target" position={Position.Top} style={dot(T.amber)} />
      <div style={headStyle(T.amber)}>⑂ Condition</div>
      <div style={bodyStyle}>{n ? `${n} rule${n === 1 ? '' : 's'} (${data.match === 'any' ? 'any' : 'all'} must match)` : <span style={{ color: T.text3, fontStyle: 'italic' }}>Click to add rules…</span>}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 18px 6px', fontSize: 9, fontWeight: 700 }}>
        <span style={{ color: T.green }}>YES</span><span style={{ color: T.red }}>NO</span>
      </div>
      <Handle id="yes" type="source" position={Position.Bottom} style={{ ...dot(T.green), left: '25%' }} />
      <Handle id="no" type="source" position={Position.Bottom} style={{ ...dot(T.red), left: '75%' }} />
    </div>
  )
}
function WaitNode({ data, selected }: NodeProps<FlowNodeData>) {
  const h = Number(data.hours) || 0
  const label = h % 24 === 0 && h >= 24 ? `${h / 24} day${h / 24 === 1 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`
  return (
    <div style={cardStyle(T.text3, selected)}>
      <Handle type="target" position={Position.Top} style={dot(T.text3)} />
      <div style={headStyle(T.text3)}>⏳ Wait</div>
      <div style={bodyStyle}>{h > 0 ? `Wait ${label}` : <span style={{ color: T.red }}>Set a duration…</span>}</div>
      <Handle type="source" position={Position.Bottom} style={dot(T.text3)} />
    </div>
  )
}
const nodeTypes = { trigger: TriggerNode, action: ActionNode, condition: ConditionNode, wait: WaitNode }

const VARS = ['task_title', 'status', 'priority', 'assignee_name', 'group_name', 'due_date']
const RULE_FIELDS: { value: string; label: string; bool?: boolean }[] = [
  { value: 'task.status', label: 'Status' },
  { value: 'task.priority', label: 'Priority' },
  { value: 'task.assignee_id', label: 'Assignee' },
  { value: 'task.group_id', label: 'Group' },
  { value: 'task.is_overdue', label: 'Is overdue', bool: true },
  { value: 'task.has_due', label: 'Has a due date', bool: true },
  { value: 'task.has_assignee', label: 'Has an assignee', bool: true },
]
const RULE_OPS: { value: ConditionRule['op']; label: string }[] = [
  { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' },
  { value: 'is_true', label: 'is true' }, { value: 'is_false', label: 'is false' },
  { value: 'is_set', label: 'is set' }, { value: 'not_set', label: 'is not set' },
]

interface Group { id: string; name: string }
interface Staff { id: string; display_name: string | null; email: string }

export default function TaskFlowEditor({ automationId }: { automationId: string }) {
  const router = useRouter()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [groups, setGroups] = useState<Group[]>([])
  const [users, setUsers] = useState<Staff[]>([])
  const [counts, setCounts] = useState<{ active: number; done: number; cancelled: number } | null>(null)
  const [webhook, setWebhook] = useState<{ token: string | null; secret: string | null }>({ token: null, secret: null })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const seq = useRef(1)

  useEffect(() => {
    fetch('/api/tasks').then(r => r.json()).then(d => { setGroups(d.groups || []); setUsers(d.users || []) }).catch(() => {})
  }, [])
  useEffect(() => {
    let alive = true
    fetch(`/api/tasks/automations/${automationId}`).then(r => r.json()).then(d => {
      if (!alive || !d.automation) return
      const a = d.automation
      setName(a.name || ''); setEnabled(!!a.enabled); setCounts(d.counts || null)
      setWebhook({ token: a.webhook_token || null, secret: a.webhook_secret || null })
      const g = a.graph && Array.isArray(a.graph.nodes) ? a.graph
        : { nodes: [{ id: 'trigger-1', type: 'trigger', position: { x: 120, y: 40 }, data: { kind: 'trigger', event: a.trigger_event || 'task_created', config: a.trigger_config || {} } }], edges: [] }
      setNodes((g.nodes || []).map((n: any) => ({ ...n, deletable: n.data?.kind !== 'trigger' })))
      setEdges((g.edges || []).map((e: any) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 }, interactionWidth: 24 })))
      const maxN = Math.max(0, ...((g.nodes || []) as any[]).map((n: any) => Number(String(n.id).split('-').pop()) || 0))
      seq.current = maxN + 1
    }).catch(() => {})
    return () => { alive = false }
  }, [automationId, setNodes, setEdges])

  const markDirty = useCallback(() => setDirty(true), [])

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return
    setEdges(eds => addEdge(
      { ...conn, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 }, interactionWidth: 24 },
      eds.filter(e => !(e.source === conn.source && (e.sourceHandle || null) === (conn.sourceHandle || null))),
    ))
    markDirty()
  }, [setEdges, markDirty])

  function removeEdge(edgeId: string) { setEdges(eds => eds.filter(e => e.id !== edgeId)); setSelectedEdgeId(null); markDirty() }
  function removeNode(nodeId: string) {
    setNodes(nds => nds.filter(n => n.id !== nodeId))
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId))
    setSelectedId(null); markDirty()
  }
  function addNode(kind: 'action' | 'condition' | 'wait', action?: string) {
    const id = `${kind}-n${seq.current++}`
    const maxY = Math.max(40, ...nodes.map(n => n.position.y))
    const data: FlowNodeData = kind === 'action'
      ? { kind, action: (action as any) || 'set_status', status: 'in_progress', on_failure: 'continue' }
      : kind === 'wait' ? { kind, hours: 24 }
      : { kind, match: 'all', rules: [] }
    setNodes(nds => [...nds, { id, type: kind, position: { x: 120 + (kind === 'condition' ? 40 : 0), y: maxY + 110 }, data } as Node])
    setSelectedId(id); markDirty()
  }
  function updateNodeData(id: string, patch: Partial<FlowNodeData>) {
    setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)); markDirty()
  }

  async function save() {
    const graph = {
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data })),
      edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: (e.sourceHandle as any) || null })),
    }
    const v = validateGraph(graph)
    if (!v.ok) { toast(v.errors[0], 'error'); return }
    if ((counts?.active || 0) > 0) {
      const ok = await confirmDialog({ title: 'Save changes to a live flow?', message: `${counts!.active} enrolment${counts!.active === 1 ? ' is' : 's are'} mid-flow. Removed nodes cancel those runs; other edits apply from their current position.` })
      if (!ok) return
    }
    setSaving(true)
    try {
      const r = await fetch(`/api/tasks/automations/${automationId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled, graph }),
      })
      const d = await r.json()
      if (r.ok) {
        toast('Flow saved', 'success'); setDirty(false)
        const rr = await fetch(`/api/tasks/automations/${automationId}`)
        const dd = await rr.json()
        if (rr.ok && dd.automation) setWebhook({ token: dd.automation.webhook_token || null, secret: dd.automation.webhook_secret || null })
      } else toast(d.error || 'Save failed', 'error')
    } catch (e: any) { toast(e?.message || 'Save failed', 'error') } finally { setSaving(false) }
  }

  const selected = useMemo(() => nodes.find(n => n.id === selectedId) || null, [nodes, selectedId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${T.border}`, background: T.bg2, flexShrink: 0, flexWrap: 'wrap' }}>
        <button onClick={() => router.push('/tasks/automations')} style={ghostBtn}>‹ Flows</button>
        <input value={name} onChange={e => { setName(e.target.value); markDirty() }} placeholder="Flow name…" style={{ ...inp, width: 260, fontWeight: 600 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text2, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); markDirty() }} /> Enabled
        </label>
        <span style={{ flex: 1 }} />
        {counts && <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{counts.active} active · {counts.done} done</span>}
        <button onClick={save} disabled={saving || !dirty} style={{ ...primaryBtn, opacity: saving || !dirty ? 0.6 : 1 }}>{saving ? 'Saving…' : dirty ? 'Save flow' : 'Saved ✓'}</button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 150, borderRight: `1px solid ${T.border}`, background: T.bg2, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Add a node</div>
          {Object.entries(ACTION_META).map(([k, m]) => (
            <button key={k} onClick={() => addNode('action', k)} style={paletteBtn(m.color)}>{m.icon} {m.label}</button>
          ))}
          <button onClick={() => addNode('wait')} style={paletteBtn(T.text3)}>⏳ Wait</button>
          <button onClick={() => addNode('condition')} style={paletteBtn(T.amber)}>⑂ Condition</button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10, color: T.text3, lineHeight: 1.5 }}>
            Drag from a node's bottom dot to connect.<br /><br />
            <strong>Remove a connection:</strong> click the line, then “Remove connection”.<br /><br />
            <strong>Delete a node:</strong> select it and use the red button, or press Delete.
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, background: T.bg, position: 'relative' }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(c) => { onNodesChange(c); if (c.some(x => x.type !== 'select' && x.type !== 'dimensions')) markDirty() }}
            onEdgesChange={(c) => { onEdgesChange(c); if (c.some(x => x.type === 'remove')) markDirty() }}
            onConnect={onConnect}
            onSelectionChange={(sel) => { setSelectedId(sel.nodes[0]?.id || null); setSelectedEdgeId(sel.edges[0]?.id || null) }}
            onEdgeDoubleClick={(_, edge) => removeEdge(edge.id)}
            fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={T.border2} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {selectedEdgeId && !selected && (
            <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', alignItems: 'center', gap: 10, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8, padding: '7px 12px', boxShadow: '0 6px 20px rgba(0,0,0,0.35)' }}>
              <span style={{ fontSize: 12, color: T.text2 }}>Connection selected</span>
              <button onClick={() => removeEdge(selectedEdgeId)} style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: `${T.red}1e`, color: T.red, border: `1px solid ${T.red}55` }}>✕ Remove connection</button>
            </div>
          )}
        </div>

        {selected && (
          <div style={{ width: 320, borderLeft: `1px solid ${T.border}`, background: T.bg2, padding: 14, overflowY: 'auto', flexShrink: 0 }}>
            <NodeConfig node={selected} groups={groups} users={users} webhook={webhook} onChange={(patch) => updateNodeData(selected.id, patch)} />
            {selected.data?.kind !== 'trigger' && (
              <button onClick={() => removeNode(selected.id)} style={{ marginTop: 18, width: '100%', padding: '8px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.red, border: `1px solid ${T.red}55` }}>🗑 Delete this node</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function paletteBtn(color: string): React.CSSProperties {
  return { textAlign: 'left', padding: '7px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color, border: `1px solid ${color}44`, cursor: 'pointer' }
}

function NodeConfig({ node, groups, users, webhook, onChange }: { node: Node; groups: Group[]; users: Staff[]; webhook: { token: string | null; secret: string | null }; onChange: (patch: Partial<FlowNodeData>) => void }) {
  const d = node.data as FlowNodeData
  const label = (txt: string) => <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 5px' }}>{txt}</div>
  const userOpts = (extra?: { value: string; label: string }[]) => (
    <>
      {(extra || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      {users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
    </>
  )

  if (d.kind === 'trigger') {
    const ev = d.event || 'task_created'
    return (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.green }}>⚡ Trigger</div>
        {label('When')}
        <select value={ev} onChange={e => onChange({ event: e.target.value as any, config: {} })} style={inp}>
          {Object.entries(TRIGGER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {ev === 'status_changed' && (<>
          {label('Only when the new status is')}
          <select value={d.config?.status || ''} onChange={e => onChange({ config: { ...(d.config || {}), status: e.target.value || null } })} style={inp}>
            <option value="">Any status</option>
            {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </>)}
        {ev === 'task_created' && (<>
          {label('Only with priority')}
          <select value={d.config?.priority || ''} onChange={e => onChange({ config: { ...(d.config || {}), priority: e.target.value || null } })} style={inp}>
            <option value="">Any priority</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </>)}
        {ev === 'due_soon' && (<>
          {label('Days before due')}
          <input type="number" min={1} value={d.config?.days || 3} onChange={e => onChange({ config: { ...(d.config || {}), days: Math.max(1, Number(e.target.value) || 3) } })} style={{ ...inp, width: 100 }} />
        </>)}
        {(ev === 'task_created' || ev === 'status_changed' || ev === 'due_soon' || ev === 'overdue') && (<>
          {label('Only in group')}
          <select value={d.config?.group_id || ''} onChange={e => onChange({ config: { ...(d.config || {}), group_id: e.target.value || null } })} style={inp}>
            <option value="">Any group</option>
            {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </>)}
        {ev === 'webhook' && (<>
          {label('Webhook URL')}
          {webhook.token ? (<>
            <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: 8, borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>{`${typeof window !== 'undefined' ? window.location.origin : ''}/api/tasks/automation-hooks/${webhook.token}`}</div>
            {label('Secret header · X-Hook-Secret')}
            <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: 8, borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>{webhook.secret}</div>
            <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>POST JSON with a <code>task_id</code> to enrol that task; the whole body is available to "Send webhook" actions downstream.</div>
          </>) : <div style={{ fontSize: 11, color: T.amber }}>Save the flow once — the URL + secret are generated on save.</div>}
        </>)}
        {ev === 'manual' && <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>This flow only runs when enrolled manually (or via webhook).</div>}
      </>
    )
  }

  if (d.kind === 'wait') {
    const h = Number(d.hours) || 0
    const days = h >= 24 && h % 24 === 0
    return (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text2 }}>⏳ Wait</div>
        {label('Duration')}
        <div style={{ display: 'flex', gap: 6 }}>
          <input type="number" min={1} value={days ? h / 24 : h} onChange={e => { const v = Math.max(1, Number(e.target.value) || 1); onChange({ hours: days ? v * 24 : v }) }} style={{ ...inp, width: 90 }} />
          <select value={days ? 'days' : 'hours'} onChange={e => { const cur = days ? h / 24 : h; onChange({ hours: e.target.value === 'days' ? cur * 24 : cur }) }} style={inp}>
            <option value="hours">hours</option><option value="days">days</option>
          </select>
        </div>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 12, lineHeight: 1.5 }}>Waits are relative — the timer starts when the flow reaches this node.</div>
      </>
    )
  }

  if (d.kind === 'condition') {
    const rules = d.rules || []
    const setRules = (next: ConditionRule[]) => onChange({ rules: next })
    return (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.amber }}>⑂ Condition</div>
        {label('Match')}
        <select value={d.match || 'all'} onChange={e => onChange({ match: e.target.value as any })} style={inp}>
          <option value="all">ALL rules must match (and)</option>
          <option value="any">ANY rule can match (or)</option>
        </select>
        {label('Rules')}
        {rules.map((r, i) => {
          const fieldMeta = RULE_FIELDS.find(f => f.value === r.field)
          const noValue = r.op === 'is_set' || r.op === 'not_set' || r.op === 'is_true' || r.op === 'is_false' || fieldMeta?.bool
          return (
            <div key={i} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 7, padding: 8, marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <select value={r.field} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} style={{ ...inp, fontSize: 11 }}>
                  {RULE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <button onClick={() => setRules(rules.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <select value={r.op} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, op: e.target.value as any } : x))} style={{ ...inp, fontSize: 11, width: 110 }}>
                  {RULE_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {!noValue && (
                  r.field === 'task.status'
                    ? <select value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inp, fontSize: 11 }}><option value="">—</option>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
                    : r.field === 'task.priority'
                    ? <select value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inp, fontSize: 11 }}><option value="">—</option>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select>
                    : r.field === 'task.assignee_id'
                    ? <select value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inp, fontSize: 11 }}><option value="">—</option>{userOpts()}</select>
                    : r.field === 'task.group_id'
                    ? <select value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inp, fontSize: 11 }}><option value="">—</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                    : <input value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...inp, fontSize: 11 }} placeholder="value" />
                )}
              </div>
            </div>
          )
        })}
        <button onClick={() => setRules([...rules, { field: 'task.status', op: 'eq', value: '' }])} style={{ ...ghostBtn, fontSize: 11 }}>+ Add rule</button>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 12, lineHeight: 1.5 }}>The flow follows the green YES handle when the rules match, otherwise the red NO handle (no NO connection = the flow ends).</div>
      </>
    )
  }

  // action
  const meta = ACTION_META[d.action || 'set_status'] || ACTION_META.set_status
  const a = d.action || 'set_status'
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{meta.icon} {meta.label}</div>
      {label('Action')}
      <select value={a} onChange={e => onChange({ action: e.target.value as any })} style={inp}>
        {Object.entries(ACTION_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
      </select>

      {(a === 'set_status' || a === 'create_task') && (<>
        {label('Status')}
        <select value={d.status || 'todo'} onChange={e => onChange({ status: e.target.value })} style={inp}>{STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
      </>)}
      {(a === 'set_priority' || a === 'create_task') && (<>
        {label('Priority')}
        <select value={d.priority || 'normal'} onChange={e => onChange({ priority: e.target.value })} style={inp}>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select>
      </>)}
      {(a === 'assign' || a === 'create_task') && (<>
        {label('Assign to')}
        <select value={d.assignee_id ?? ''} onChange={e => onChange({ assignee_id: e.target.value })} style={inp}>
          {userOpts([{ value: '', label: '— Unassigned —' }, { value: 'creator', label: 'The task creator' }])}
        </select>
      </>)}
      {(a === 'move_group' || a === 'create_task') && (<>
        {label('Group')}
        <select value={d.group_id ?? ''} onChange={e => onChange({ group_id: e.target.value })} style={inp}>
          <option value="">{a === 'create_task' ? 'Same group as source' : '— No group —'}</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </>)}
      {a === 'notify' && (<>
        {label('Notify')}
        <select value={d.notify_target || 'assignee'} onChange={e => onChange({ notify_target: e.target.value as any })} style={inp}>
          <option value="assignee">The assignee</option><option value="creator">The task creator</option>
        </select>
        {label('Title')}
        <input value={d.title || ''} onChange={e => onChange({ title: e.target.value })} style={inp} />
        {label('Message')}
        <textarea value={d.body || ''} onChange={e => onChange({ body: e.target.value })} rows={4} style={{ ...inp, resize: 'vertical' }} />
      </>)}
      {a === 'create_task' && (<>
        {label('Title')}
        <input value={d.title || ''} onChange={e => onChange({ title: e.target.value })} style={inp} />
        {label('Description')}
        <textarea value={d.body || ''} onChange={e => onChange({ body: e.target.value })} rows={3} style={{ ...inp, resize: 'vertical' }} />
        <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>New tasks don't re-trigger automations (prevents loops).</div>
      </>)}
      {a === 'webhook_out' && (<>
        {label('POST to URL')}
        <input value={d.url || ''} onChange={e => onChange({ url: e.target.value })} style={inp} placeholder="https://…" />
        {label('HMAC secret (optional — X-Hook-Signature)')}
        <input value={d.secret || ''} onChange={e => onChange({ secret: e.target.value })} style={inp} />
      </>)}

      {label('If this action fails (after 3 retries)')}
      <select value={d.on_failure || 'continue'} onChange={e => onChange({ on_failure: e.target.value as any })} style={inp}>
        <option value="continue">Continue to the next node</option>
        <option value="stop">Stop the flow</option>
      </select>
      {(a === 'notify' || a === 'create_task') && (
        <div style={{ fontSize: 10, color: T.text3, marginTop: 12 }}>
          Placeholders: {VARS.map(v => <code key={v} style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}
        </div>
      )}
    </>
  )
}
