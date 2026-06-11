// components/crm/flow/FlowEditor.tsx
// The Make-style automation canvas (React Flow v11, dynamically imported with
// ssr:false — the portal's only external UI dependency, confined to this
// directory). Nodes: trigger / action / condition (yes·no) / wait. Saving
// PATCHes the whole graph; the server re-validates and bumps graph_version.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  useNodesState, useEdgesState, addEdge,
  type Connection, type Edge, type Node, type NodeProps, MarkerType,
} from 'reactflow'
// reactflow/dist/style.css is imported globally in pages/_app.tsx (the pages
// router only allows node_modules CSS there); it's ~2kb.
import { T } from '../CrmShell'
import { input, primaryBtn, ghostBtn } from '../ui'
import { useToast, useConfirm } from '../../ui/Feedback'
import { validateGraph, TRIGGER_LABELS, type FlowNodeData, type ConditionRule, type TriggerEvent } from '../../../lib/crm-automation-graph'

// ── Node visuals (defined at module level — React Flow needs stable refs) ──
const NODE_W = 230

const ACTION_META: Record<string, { icon: string; label: string; color: string }> = {
  email: { icon: '✉️', label: 'Send email', color: '#4f8ef7' },
  sms: { icon: '💬', label: 'Send SMS', color: '#2dd4bf' },
  task: { icon: '✅', label: 'Create task', color: '#fbbf24' },
  notify_owner: { icon: '🔔', label: 'Notify owner', color: '#a78bfa' },
  add_tag: { icon: '🏷', label: 'Add tag', color: '#38bdf8' },
  remove_tag: { icon: '🏷', label: 'Remove tag', color: '#8b90a0' },
  move_stage: { icon: '➡️', label: 'Move stage', color: '#34c77b' },
  update_field: { icon: '✏️', label: 'Update field', color: '#f472b6' },
  webhook_out: { icon: '🌐', label: 'Send webhook', color: '#fb923c' },
  create_quote_draft: { icon: '🔧', label: 'Create quote draft', color: '#2dd4bf' },
}

function cardStyle(color: string, selected?: boolean): React.CSSProperties {
  return {
    width: NODE_W, background: T.bg2, borderRadius: 10, fontFamily: '"DM Sans", system-ui, sans-serif',
    border: `1.5px solid ${selected ? color : T.border2}`, boxShadow: selected ? `0 0 0 2px ${color}44` : '0 4px 14px rgba(0,0,0,0.25)',
  }
}
const headStyle = (color: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px',
  borderBottom: `1px solid ${T.border}`, color, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
})
const bodyStyle: React.CSSProperties = { padding: '8px 11px', fontSize: 12, color: T.text2, lineHeight: 1.4, minHeight: 20, overflow: 'hidden' }
const dot = (color: string): React.CSSProperties => ({ width: 10, height: 10, background: color, border: `2px solid ${T.bg}` })

function TriggerNode({ data, selected }: NodeProps<FlowNodeData>) {
  const label = TRIGGER_LABELS[(data.event || 'lead_created') as TriggerEvent] || data.event
  const extra = data.config?.stage ? ` · "${data.config.stage}"`
    : data.config?.tag ? ` · "${data.config.tag}"`
    : data.event === 'no_activity' ? ` · ${data.config?.days || 7}d` : ''
  return (
    <div style={cardStyle(T.green, selected)}>
      <div style={headStyle(T.green)}>⚡ Trigger</div>
      <div style={bodyStyle}>{label}{extra}</div>
      <Handle type="source" position={Position.Bottom} style={dot(T.green)} />
    </div>
  )
}
function ActionNode({ data, selected }: NodeProps<FlowNodeData>) {
  const meta = ACTION_META[data.action || 'email'] || ACTION_META.email
  const preview = (data.subject || data.body || '').slice(0, 70)
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

const VARS = ['first_name', 'contact_name', 'vehicle', 'lead_title', 'value', 'owner_name', 'company']
const RULE_FIELDS: { value: string; label: string }[] = [
  { value: 'lead.stage', label: 'Lead stage' },
  { value: 'lead.value', label: 'Lead value ($)' },
  { value: 'lead.source', label: 'Lead source' },
  { value: 'contact.tags', label: 'Contact tags' },
  { value: 'contact.has_email', label: 'Contact has email' },
  { value: 'contact.has_mobile', label: 'Contact has mobile' },
  { value: 'contact.source', label: 'Contact source' },
  { value: 'engagement.opened', label: 'Opened a campaign email' },
  { value: 'engagement.clicked', label: 'Clicked a campaign email' },
  { value: 'time.is_business_hours', label: 'Is business hours (Bris)' },
  { value: 'time.day_of_week', label: 'Day of week (mon…sun)' },
]
const RULE_OPS: { value: ConditionRule['op']; label: string }[] = [
  { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' },
  { value: 'gt', label: '>' }, { value: 'gte', label: '≥' }, { value: 'lt', label: '<' }, { value: 'lte', label: '≤' },
  { value: 'contains', label: 'contains' }, { value: 'not_contains', label: "doesn't contain" },
  { value: 'is_set', label: 'is set' }, { value: 'not_set', label: 'is not set' },
]

interface StageOpt { key: string; label: string; archived_at: string | null }

export default function FlowEditor({ automationId }: { automationId: string }) {
  const router = useRouter()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [name, setName] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [cancelStages, setCancelStages] = useState<string[]>(['won', 'lost'])
  const [stages, setStages] = useState<StageOpt[]>([])
  const [counts, setCounts] = useState<{ active: number; done: number; cancelled: number } | null>(null)
  const [webhook, setWebhook] = useState<{ token: string | null; secret: string | null }>({ token: null, secret: null })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const seq = useRef(1)

  useEffect(() => {
    fetch('/api/crm/stages').then(r => r.json()).then(d => setStages((d.stages || []).filter((s: StageOpt) => !s.archived_at))).catch(() => {})
  }, [])
  useEffect(() => {
    let alive = true
    fetch(`/api/crm/automations/${automationId}`).then(r => r.json()).then(d => {
      if (!alive || !d.automation) return
      const a = d.automation
      setName(a.name || ''); setEnabled(!!a.enabled); setCancelStages(a.cancel_on_stages || ['won', 'lost'])
      setCounts(d.counts || null)
      setWebhook({ token: a.webhook_token || null, secret: a.webhook_secret || null })
      const g = a.graph || { nodes: [{ id: 'trigger-1', type: 'trigger', position: { x: 120, y: 40 }, data: { kind: 'trigger', event: a.trigger_event || 'lead_created', config: { stage: a.trigger_stage || null } } }], edges: [] }
      setNodes((g.nodes || []).map((n: any) => ({ ...n, deletable: n.data?.kind !== 'trigger' })))
      setEdges((g.edges || []).map((e: any) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 } })))
      const maxN = Math.max(0, ...((g.nodes || []) as any[]).map((n: any) => Number(String(n.id).split('-').pop()) || 0))
      seq.current = maxN + 1
    }).catch(() => {})
    return () => { alive = false }
  }, [automationId, setNodes, setEdges])

  const markDirty = useCallback(() => setDirty(true), [])

  // Single outgoing edge per (source, handle): a new connection replaces it.
  const onConnect = useCallback((conn: Connection) => {
    setEdges(eds => addEdge(
      { ...conn, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.5 } },
      eds.filter(e => !(e.source === conn.source && (e.sourceHandle || null) === (conn.sourceHandle || null))),
    ))
    markDirty()
  }, [setEdges, markDirty])

  function addNode(kind: 'action' | 'condition' | 'wait', action?: string) {
    const id = `${kind === 'action' ? 'step' : kind}-n${seq.current++}`
    const maxY = Math.max(40, ...nodes.map(n => n.position.y))
    const data: FlowNodeData = kind === 'action'
      ? { kind, action: (action as any) || 'email', subject: '', body: '', task_priority: 'normal', on_failure: 'continue' }
      : kind === 'wait' ? { kind, hours: 24 }
      : { kind, match: 'all', rules: [] }
    setNodes(nds => [...nds, { id, type: kind, position: { x: 120 + (kind === 'condition' ? 40 : 0), y: maxY + 110 }, data } as Node])
    setSelectedId(id)
    markDirty()
  }

  function updateNodeData(id: string, patch: Partial<FlowNodeData>) {
    setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, ...patch } } : n))
    markDirty()
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
      const r = await fetch(`/api/crm/automations/${automationId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, enabled, cancel_on_stages: cancelStages, graph }),
      })
      const d = await r.json()
      if (r.ok) {
        toast('Flow saved', 'success'); setDirty(false)
        // Webhook token/secret are minted server-side on first save — refresh.
        const rr = await fetch(`/api/crm/automations/${automationId}`)
        const dd = await rr.json()
        if (rr.ok && dd.automation) setWebhook({ token: dd.automation.webhook_token || null, secret: dd.automation.webhook_secret || null })
      }
      else toast(d.error || 'Save failed', 'error')
    } catch (e: any) { toast(e?.message || 'Save failed', 'error') } finally { setSaving(false) }
  }

  const selected = useMemo(() => nodes.find(n => n.id === selectedId) || null, [nodes, selectedId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${T.border}`, background: T.bg2, flexShrink: 0, flexWrap: 'wrap' }}>
        <button onClick={() => router.push('/crm/automations')} style={ghostBtn}>‹ Flows</button>
        <input value={name} onChange={e => { setName(e.target.value); markDirty() }} placeholder="Flow name…"
          style={{ ...input, width: 260, fontWeight: 600 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text2, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={e => { setEnabled(e.target.checked); markDirty() }} /> Enabled
        </label>
        <span style={{ fontSize: 11, color: T.text3 }}>Stop if lead reaches:</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {stages.map(s => (
            <button key={s.key} onClick={() => { setCancelStages(p => p.includes(s.key) ? p.filter(x => x !== s.key) : [...p, s.key]); markDirty() }} style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
              background: cancelStages.includes(s.key) ? 'rgba(240,78,78,0.16)' : 'transparent',
              color: cancelStages.includes(s.key) ? T.red : T.text3, border: `1px solid ${cancelStages.includes(s.key) ? T.red + '55' : T.border2}`,
            }}>{s.label}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {counts && <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{counts.active} active · {counts.done} done</span>}
        <button onClick={save} disabled={saving || !dirty} style={{ ...primaryBtn, opacity: saving || !dirty ? 0.6 : 1 }}>{saving ? 'Saving…' : dirty ? 'Save flow' : 'Saved ✓'}</button>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Palette */}
        <div style={{ width: 150, borderRight: `1px solid ${T.border}`, background: T.bg2, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Add a node</div>
          {Object.entries(ACTION_META).map(([k, m]) => (
            <button key={k} onClick={() => addNode('action', k)} style={paletteBtn(m.color)}>{m.icon} {m.label}</button>
          ))}
          <button onClick={() => addNode('wait')} style={paletteBtn(T.text3)}>⏳ Wait</button>
          <button onClick={() => addNode('condition')} style={paletteBtn(T.amber)}>⑂ Condition</button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 10, color: T.text3, lineHeight: 1.5 }}>
            Drag from a node's bottom dot to connect. Select + Delete removes. Conditions branch yes/no.
          </div>
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, minWidth: 0, background: T.bg }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(c) => { onNodesChange(c); if (c.some(x => x.type !== 'select' && x.type !== 'dimensions')) markDirty() }}
            onEdgesChange={(c) => { onEdgesChange(c); if (c.some(x => x.type === 'remove')) markDirty() }}
            onConnect={onConnect}
            onSelectionChange={(sel) => setSelectedId(sel.nodes[0]?.id || null)}
            fitView fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color={T.border2} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* Config drawer */}
        {selected && (
          <div style={{ width: 320, borderLeft: `1px solid ${T.border}`, background: T.bg2, padding: 14, overflowY: 'auto', flexShrink: 0 }}>
            <NodeConfig node={selected} stages={stages} webhook={webhook} onChange={(patch) => updateNodeData(selected.id, patch)} />
          </div>
        )}
      </div>
    </div>
  )
}

function paletteBtn(color: string): React.CSSProperties {
  return {
    textAlign: 'left', padding: '7px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
    background: 'transparent', color, border: `1px solid ${color}44`, cursor: 'pointer',
  }
}

// ── Per-node config forms ──────────────────────────────────────────────
function NodeConfig({ node, stages, webhook, onChange }: { node: Node; stages: StageOpt[]; webhook: { token: string | null; secret: string | null }; onChange: (patch: Partial<FlowNodeData>) => void }) {
  const d = node.data as FlowNodeData
  const label = (txt: string) => <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '10px 0 5px' }}>{txt}</div>

  if (d.kind === 'trigger') {
    const ev = d.event || 'lead_created'
    const showStage = ev === 'lead_created' || ev === 'stage_changed' || ev === 'no_activity'
    return (
      <>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.green }}>⚡ Trigger</div>
        {label('When')}
        <select value={ev} onChange={e => onChange({ event: e.target.value as any })} style={input}>
          {Object.entries(TRIGGER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {showStage && (
          <>
            {label('Stage filter')}
            <select value={d.config?.stage || ''} onChange={e => onChange({ config: { ...(d.config || {}), stage: e.target.value || null } })} style={input}>
              <option value="">{ev === 'stage_changed' ? 'Choose a stage…' : 'Any stage'}</option>
              {stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </>
        )}
        {ev === 'tag_added' && (
          <>
            {label('Tag (blank = any tag)')}
            <input value={d.config?.tag || ''} onChange={e => onChange({ config: { ...(d.config || {}), tag: e.target.value || null } })} style={input} placeholder="e.g. hot-lead" />
          </>
        )}
        {ev === 'no_activity' && (
          <>
            {label('Days without activity')}
            <input type="number" min={1} value={d.config?.days || 7} onChange={e => onChange({ config: { ...(d.config || {}), days: Math.max(1, Number(e.target.value) || 7) } })} style={{ ...input, width: 100 }} />
          </>
        )}
        {ev === 'webhook' && (
          <>
            {label('Webhook URL')}
            {webhook.token ? (
              <>
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: 8, borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>
                  {`${typeof window !== 'undefined' ? window.location.origin : ''}/api/crm/automation-hooks/${webhook.token}`}
                </div>
                {label('Secret header  ·  X-Hook-Secret')}
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: T.text2, background: T.bg3, padding: 8, borderRadius: 6, wordBreak: 'break-all', userSelect: 'all' }}>{webhook.secret}</div>
                <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>POST JSON with email / mobile / name to match-or-create the contact; the whole body is available to "Send webhook" actions downstream.</div>
              </>
            ) : (
              <div style={{ fontSize: 11, color: T.amber }}>Save the flow once — the URL + secret are generated on save.</div>
            )}
          </>
        )}
        {(ev === 'campaign_email_opened' || ev === 'campaign_email_clicked') && (
          <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>Fires on the FIRST open/click of any campaign email per recipient.</div>
        )}
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
          <input type="number" min={1} value={days ? h / 24 : h} onChange={e => {
            const v = Math.max(1, Number(e.target.value) || 1)
            onChange({ hours: days ? v * 24 : v })
          }} style={{ ...input, width: 90 }} />
          <select value={days ? 'days' : 'hours'} onChange={e => {
            const cur = days ? h / 24 : h
            onChange({ hours: e.target.value === 'days' ? cur * 24 : cur })
          }} style={input}>
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
        <select value={d.match || 'all'} onChange={e => onChange({ match: e.target.value as any })} style={input}>
          <option value="all">ALL rules must match (and)</option>
          <option value="any">ANY rule can match (or)</option>
        </select>
        {label('Rules')}
        {rules.map((r, i) => {
          const noValue = r.op === 'is_set' || r.op === 'not_set' || r.field.startsWith('contact.has_')
          return (
            <div key={i} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 7, padding: 8, marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <select value={r.field} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} style={{ ...input, fontSize: 11 }}>
                  {RULE_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <button onClick={() => setRules(rules.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <select value={r.op} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, op: e.target.value as any } : x))} style={{ ...input, fontSize: 11, width: 110 }}>
                  {RULE_OPS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {!noValue && (
                  r.field === 'lead.stage'
                    ? (
                      <select value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...input, fontSize: 11 }}>
                        <option value="">—</option>
                        {stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                      </select>
                    )
                    : <input value={String(r.value ?? '')} onChange={e => setRules(rules.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...input, fontSize: 11 }} placeholder="value" />
                )}
              </div>
            </div>
          )
        })}
        <button onClick={() => setRules([...rules, { field: 'lead.stage', op: 'eq', value: '' }])} style={{ ...ghostBtn, fontSize: 11 }}>+ Add rule</button>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 12, lineHeight: 1.5 }}>The flow follows the green YES handle when the rules match, otherwise the red NO handle (no NO connection = the flow ends).</div>
      </>
    )
  }

  // action
  const meta = ACTION_META[d.action || 'email'] || ACTION_META.email
  const a = d.action || 'email'
  const hasSubject = a === 'email' || a === 'task' || a === 'notify_owner'
  const hasBody = a === 'email' || a === 'sms' || a === 'task' || a === 'notify_owner'
  return (
    <>
      <div style={{ fontSize: 13, fontWeight: 700, color: meta.color }}>{meta.icon} {meta.label}</div>
      {label('Action')}
      <select value={a} onChange={e => onChange({ action: e.target.value as any })} style={input}>
        {Object.entries(ACTION_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
      </select>
      {hasSubject && (
        <>
          {label(a === 'email' ? 'Subject' : 'Title')}
          <input value={d.subject || ''} onChange={e => onChange({ subject: e.target.value })} style={input} />
        </>
      )}
      {hasBody && (
        <>
          {label(a === 'sms' ? 'Message' : a === 'task' ? 'Description' : 'Body')}
          <textarea value={d.body || ''} onChange={e => onChange({ body: e.target.value })} rows={6} style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
        </>
      )}
      {a === 'task' && (
        <>
          {label('Priority')}
          <select value={d.task_priority || 'normal'} onChange={e => onChange({ task_priority: e.target.value })} style={input}>
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </>
      )}
      {(a === 'add_tag' || a === 'remove_tag') && (
        <>
          {label('Tag')}
          <input value={d.tag || ''} onChange={e => onChange({ tag: e.target.value })} style={input} placeholder="e.g. hot-lead" />
        </>
      )}
      {a === 'move_stage' && (
        <>
          {label('Move the lead to')}
          <select value={d.stage || ''} onChange={e => onChange({ stage: e.target.value })} style={input}>
            <option value="">Choose a stage…</option>
            {stages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </>
      )}
      {a === 'update_field' && (
        <>
          {label('Field')}
          <select value={d.field || 'value'} onChange={e => onChange({ field: e.target.value as any })} style={input}>
            <option value="value">Lead value ($)</option>
            <option value="next_follow_up_in_days">Follow-up date (days from now)</option>
            <option value="owner_id">Owner (user id)</option>
          </select>
          {label('Value')}
          <input value={d.field_value || ''} onChange={e => onChange({ field_value: e.target.value })} style={input} placeholder={d.field === 'next_follow_up_in_days' ? 'e.g. 3' : ''} />
        </>
      )}
      {a === 'webhook_out' && (
        <>
          {label('POST to URL')}
          <input value={d.url || ''} onChange={e => onChange({ url: e.target.value })} style={input} placeholder="https://…" />
          {label('HMAC secret (optional — sent as X-Hook-Signature)')}
          <input value={d.secret || ''} onChange={e => onChange({ secret: e.target.value })} style={input} />
          <div style={{ fontSize: 10, color: T.text3, marginTop: 6 }}>Sends lead + contact + the trigger's webhook context as JSON.</div>
        </>
      )}
      {a === 'create_quote_draft' && (
        <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>Creates the workshop customer (if needed) and a draft quote, and links it to the lead — same as "Start quote in Workshop".</div>
      )}
      {label('If this action fails (after 3 retries)')}
      <select value={d.on_failure || 'continue'} onChange={e => onChange({ on_failure: e.target.value as any })} style={input}>
        <option value="continue">Continue to the next node</option>
        <option value="stop">Stop the flow</option>
      </select>
      {hasBody && (
        <div style={{ fontSize: 10, color: T.text3, marginTop: 12 }}>
          Placeholders: {VARS.map(v => <code key={v} style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}
        </div>
      )}
    </>
  )
}
