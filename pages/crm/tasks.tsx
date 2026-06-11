// pages/crm/tasks.tsx — CRM staff task management. Replaces Monday tasks.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T, PRIORITY_COLOR, fmtDate } from '../../components/crm/CrmShell'
import { Overlay, Field, input, primaryBtn, ghostBtn, closeBtn } from '../../components/crm/ui'
import UserFilter from '../../components/crm/UserFilter'
import { TASK_PRIORITIES } from '../../lib/crm'

interface Task {
  id: string; title: string; description: string | null; status: string; priority: string
  assignee_id: string | null; due_at: string | null; contact_id: string | null; lead_id: string | null
  assignee?: { id: string; display_name: string | null } | null
  contact?: { id: string; name: string } | null
  lead?: { id: string; title: string } | null
}
interface StaffUser { id: string; display_name: string | null; email: string }
const COLUMNS: { key: string; label: string }[] = [
  { key: 'open', label: 'To do' }, { key: 'in_progress', label: 'In progress' }, { key: 'done', label: 'Done' },
]

export default function CrmTasks({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [scope, setScope] = useState<string>('me')   // 'all' | 'me' | <user id>
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/crm/tasks?assignee=${encodeURIComponent(scope === 'all' ? '' : scope)}&view=all`)
      const d = await r.json()
      if (r.ok) setTasks(d.tasks || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [scope])
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/crm/users').then(r => r.json()).then(d => setUsers(d.users || [])).catch(() => {}) }, [])

  const byStatus = useMemo(() => {
    const m: Record<string, Task[]> = { open: [], in_progress: [], done: [] }
    for (const t of tasks) (m[t.status] = m[t.status] || []).push(t)
    return m
  }, [tasks])

  async function setStatus(id: string, status: string) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status } : t))
    try { const r = await fetch(`/api/crm/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); if (!r.ok) load() } catch { load() }
  }

  return (
    <CrmShell user={user} active="tasks" title="Tasks">
      <div style={{ padding: '16px 20px', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Tasks</h1>
          <UserFilter users={users} value={scope} currentUserId={user.id} onChange={setScope} />
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && <button onClick={() => setShowNew(true)} style={primaryBtn}>+ New task</button>}
        </div>

        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
          {COLUMNS.map(col => {
            const items = byStatus[col.key] || []
            return (
              <div key={col.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, minWidth: 0 }}>
                <div style={{ padding: '10px 12px', borderBottom: `1px solid ${T.border}`, fontSize: 12, fontWeight: 600 }}>{col.label} <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{items.length}</span></div>
                <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map(t => (
                    <div key={t.id} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, opacity: t.status === 'done' ? 0.6 : 1 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        {canEdit && (
                          <input type="checkbox" checked={t.status === 'done'} onChange={e => setStatus(t.id, e.target.checked ? 'done' : 'open')} style={{ marginTop: 2, cursor: 'pointer' }} />
                        )}
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</div>
                          {(t.contact || t.lead) && <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{t.contact?.name || t.lead?.title}</div>}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: PRIORITY_COLOR[t.priority] || T.text3 }} title={t.priority} />
                            {t.due_at && <span style={{ fontSize: 10, color: new Date(t.due_at) < new Date() && t.status !== 'done' ? T.red : T.text3 }}>{fmtDate(t.due_at)}</span>}
                            <span style={{ flex: 1 }} />
                            {t.assignee?.display_name && <span title={t.assignee.display_name} style={{ width: 18, height: 18, borderRadius: '50%', background: T.bg4, color: T.text2, fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{t.assignee.display_name.charAt(0).toUpperCase()}</span>}
                          </div>
                          {canEdit && t.status !== 'done' && (
                            <div style={{ marginTop: 6 }}>
                              {col.key === 'open' && <button onClick={() => setStatus(t.id, 'in_progress')} style={miniBtn}>Start →</button>}
                              {col.key === 'in_progress' && <button onClick={() => setStatus(t.id, 'open')} style={miniBtn}>← To do</button>}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && <div style={{ fontSize: 11, color: T.text3, textAlign: 'center', padding: '12px 0', fontStyle: 'italic' }}>—</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {showNew && <NewTaskModal users={users} currentUserId={user.id} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
    </CrmShell>
  )
}

function NewTaskModal({ users, currentUserId, onClose, onCreated }: { users: StaffUser[]; currentUserId: string; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState<any>({ title: '', description: '', assignee_id: currentUserId, due_at: '', priority: 'normal' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  function set(k: string, v: any) { setF((p: any) => ({ ...p, [k]: v })) }
  async function submit() {
    if (!f.title.trim()) { setErr('Title required'); return }
    setBusy(true); setErr('')
    try {
      const payload = { ...f, due_at: f.due_at ? new Date(f.due_at).toISOString() : null }
      const r = await fetch('/api/crm/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json()
      if (r.ok) onCreated(); else setErr(d.error || 'Failed')
    } catch { setErr('Network error') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>New task</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>
      <Field label="Title"><input autoFocus value={f.title} onChange={e => set('title', e.target.value)} style={input} /></Field>
      <Field label="Description"><textarea value={f.description} onChange={e => set('description', e.target.value)} style={{ ...input, minHeight: 54, resize: 'vertical' }} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Assignee">
          <select value={f.assignee_id} onChange={e => set('assignee_id', e.target.value)} style={input}>
            {users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={e => set('priority', e.target.value)} style={input}>
            {TASK_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Due date"><input type="date" value={f.due_at} onChange={e => set('due_at', e.target.value)} style={input} /></Field>
      </div>
      {err && <div style={{ color: T.red, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Create task'}</button>
      </div>
    </Overlay>
  )
}

const miniBtn: React.CSSProperties = { background: 'transparent', border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 5, fontSize: 10, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}
