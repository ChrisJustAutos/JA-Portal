// pages/crm/automations/index.tsx — CRM automation flows. Each automation is
// a graph (trigger → actions/conditions/waits) edited on the full-screen
// canvas at /crm/automations/[id]. This page is the list: enable/disable,
// live enrolment counts, create, delete.
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import CrmShell, { PortalUserSSR, T } from '../../../components/crm/CrmShell'
import { primaryBtn, ghostBtn } from '../../../components/crm/ui'
import { useConfirm, useToast } from '../../../components/ui/Feedback'

interface StageOpt { key: string; label: string; archived_at: string | null }
interface Automation {
  id: string; name: string; description: string | null; trigger_event: string; trigger_stage: string | null
  enabled: boolean; cancel_on_stages: string[]; steps: any[]; graph: any
}

export default function CrmAutomations({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const confirmDialog = useConfirm()
  const toast = useToast()
  const [autos, setAutos] = useState<Automation[]>([])
  const [counts, setCounts] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [stages, setStages] = useState<StageOpt[]>([])
  useEffect(() => {
    fetch('/api/crm/stages').then(r => r.json()).then(d => setStages((d.stages || []).filter((s: StageOpt) => !s.archived_at))).catch(() => {})
  }, [])
  const stageLabel = (key: string | null) => stages.find(s => s.key === key)?.label || key || ''

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/crm/automations'); const d = await r.json()
      if (r.ok) { setAutos(d.automations || []); setCounts(d.counts || {}) }
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function toggle(a: Automation) {
    setAutos(prev => prev.map(x => x.id === a.id ? { ...x, enabled: !x.enabled } : x))
    await fetch(`/api/crm/automations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled }) })
    load()
  }
  async function remove(a: Automation) {
    if (!(await confirmDialog({ title: `Delete automation "${a.name}"?`, message: 'Active enrolments will stop.', danger: true }))) return
    await fetch(`/api/crm/automations/${a.id}`, { method: 'DELETE' }); load()
  }
  async function newAutomation() {
    setCreating(true)
    try {
      const r = await fetch('/api/crm/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New flow' }) })
      const d = await r.json()
      if (r.ok && d.id) router.push(`/crm/automations/${d.id}`)
      else { toast(d.error || 'Create failed', 'error'); setCreating(false) }
    } catch { setCreating(false) }
  }

  function nodeCount(a: Automation): number {
    if (a.graph && Array.isArray(a.graph.nodes)) return a.graph.nodes.filter((n: any) => n.data?.kind !== 'trigger').length
    return (a.steps || []).length
  }
  function triggerSummary(a: Automation) {
    if (a.trigger_event === 'lead_created') return a.trigger_stage ? `When a lead is created at "${stageLabel(a.trigger_stage)}"` : 'When any lead is created'
    return `When a lead moves to "${stageLabel(a.trigger_stage) || 'a stage'}"`
  }

  return (
    <CrmShell user={user} active="automations" title="Automations">
      <div style={{ margin: '0 auto', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Automations</h1>
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && <button onClick={newAutomation} disabled={creating} style={primaryBtn}>{creating ? 'Creating…' : '+ New flow'}</button>}
        </div>
        <p style={{ fontSize: 12.5, color: T.text2, margin: '0 0 18px', lineHeight: 1.5 }}>
          Flows run on their own once enabled — trigger → emails, SMS, tasks, waits and yes/no branches, built on the canvas. They stop automatically when the lead reaches a stop stage (or the contact is marked do-not-contact). Runs every 5 minutes.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {autos.map(a => {
            const c = counts[a.id] || {}
            return (
              <div key={a.id} onClick={() => canEdit && router.push(`/crm/automations/${a.id}`)}
                style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, cursor: canEdit ? 'pointer' : 'default' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</span>
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: a.enabled ? 'rgba(52,199,123,0.16)' : T.bg3, color: a.enabled ? T.green : T.text3, border: `1px solid ${a.enabled ? T.green + '40' : T.border2}` }}>{a.enabled ? 'Active' : 'Off'}</span>
                      {a.graph && Array.isArray(a.graph.nodes) && a.graph.nodes.some((n: any) => n.data?.kind === 'condition') && (
                        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: T.bg3, color: T.text3, border: `1px solid ${T.border2}` }}>branching</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{triggerSummary(a)} · {nodeCount(a)} node{nodeCount(a) === 1 ? '' : 's'}</div>
                    {a.description && <div style={{ fontSize: 12, color: T.text3, marginTop: 4 }}>{a.description}</div>}
                    <div style={{ fontSize: 11, color: T.text3, marginTop: 6, fontFamily: 'monospace' }}>{c.active || 0} active · {c.done || 0} completed · {c.cancelled || 0} stopped</div>
                  </div>
                  {canEdit && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }} onClick={e => e.stopPropagation()}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled
                      </label>
                      <button onClick={() => router.push(`/crm/automations/${a.id}`)} style={ghostBtn}>Open canvas</button>
                      <button onClick={() => remove(a)} style={{ ...ghostBtn, color: T.red, borderColor: 'transparent' }}>Delete</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {!loading && autos.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 13 }}>No automations yet.</div>}
        </div>
      </div>
    </CrmShell>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}
