// pages/tasks/automations/index.tsx — Tasks automation flows. Each is a graph
// (trigger → actions/conditions/waits) edited on the canvas at
// /tasks/automations/[id]. This page lists them: enable/disable, counts,
// create, delete.
import { useState, useEffect, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { T } from '../../../components/ui'
import { useConfirm, useToast } from '../../../components/ui/Feedback'
import { TRIGGER_LABELS } from '../../../lib/task-automation-graph'

interface Automation { id: string; name: string; description: string | null; trigger_event: string; enabled: boolean; graph: any }
const primaryBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }
const ghostBtn: React.CSSProperties = { padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }

export default function TaskAutomations({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:tasks')
  const confirmDialog = useConfirm()
  const toast = useToast()
  const [autos, setAutos] = useState<Automation[]>([])
  const [counts, setCounts] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/tasks/automations'); const d = await r.json()
      if (r.ok) { setAutos(d.automations || []); setCounts(d.counts || {}) }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function toggle(a: Automation) {
    setAutos(prev => prev.map(x => x.id === a.id ? { ...x, enabled: !x.enabled } : x))
    await fetch(`/api/tasks/automations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled }) })
    load()
  }
  async function remove(a: Automation) {
    if (!(await confirmDialog({ title: `Delete automation "${a.name}"?`, message: 'Active enrolments will stop.', danger: true }))) return
    await fetch(`/api/tasks/automations/${a.id}`, { method: 'DELETE' }); load()
  }
  async function newAutomation() {
    setCreating(true)
    try {
      const r = await fetch('/api/tasks/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New flow' }) })
      const d = await r.json()
      if (r.ok && d.id) router.push(`/tasks/automations/${d.id}`)
      else { toast(d.error || 'Create failed', 'error'); setCreating(false) }
    } catch { setCreating(false) }
  }
  function nodeCount(a: Automation): number {
    return a.graph && Array.isArray(a.graph.nodes) ? a.graph.nodes.filter((n: any) => n.data?.kind !== 'trigger').length : 0
  }

  return (
    <>
      <Head><title>Task automations — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text, background: T.bg }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />
        <PortalTopBar activeId="tasks" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <button onClick={() => router.push('/tasks')} style={ghostBtn}>‹ Tasks</button>
              <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Task automations</h1>
              <span style={{ flex: 1 }} />
              {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
              {canEdit && <button onClick={newAutomation} disabled={creating} style={primaryBtn}>{creating ? 'Creating…' : '+ New flow'}</button>}
            </div>
            <p style={{ fontSize: 12.5, color: T.text2, margin: '0 0 18px', lineHeight: 1.5 }}>
              Flows run on their own once enabled — a trigger (task created, status change, due soon, overdue…) kicks off actions, waits and yes/no branches built on the canvas. Runs every 5 minutes.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {autos.map(a => {
                const c = counts[a.id] || {}
                return (
                  <div key={a.id} onClick={() => canEdit && router.push(`/tasks/automations/${a.id}`)} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, cursor: canEdit ? 'pointer' : 'default' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</span>
                          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: a.enabled ? 'rgba(52,199,123,0.16)' : T.bg3, color: a.enabled ? T.green : T.text3, border: `1px solid ${a.enabled ? T.green + '40' : T.border2}` }}>{a.enabled ? 'Active' : 'Off'}</span>
                        </div>
                        <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{TRIGGER_LABELS[a.trigger_event as keyof typeof TRIGGER_LABELS] || a.trigger_event} · {nodeCount(a)} node{nodeCount(a) === 1 ? '' : 's'}</div>
                        <div style={{ fontSize: 11, color: T.text3, marginTop: 6, fontFamily: 'monospace' }}>{c.active || 0} active · {c.done || 0} completed · {c.cancelled || 0} stopped</div>
                      </div>
                      {canEdit && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }} onClick={e => e.stopPropagation()}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.text2, cursor: 'pointer' }}>
                            <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled
                          </label>
                          <button onClick={() => router.push(`/tasks/automations/${a.id}`)} style={ghostBtn}>Open canvas</button>
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
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:tasks')
}
