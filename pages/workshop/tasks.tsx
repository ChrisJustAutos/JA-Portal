// pages/workshop/tasks.tsx
// Tasks board — to-do / in-progress / done columns for the workshop. Add tasks,
// move them across columns, set priority/assignee/due. Gated view:diary.

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { TASK_STATUS_META, TASK_STATUSES, TaskStatus, TASK_PRIORITIES, TASK_PRIORITY_META, TaskPriority } from '../../lib/workshop'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const inp: React.CSSProperties = { padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', colorScheme: 'dark' }
const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'done']

interface Task { id: string; title: string; assignee: string | null; status: TaskStatus; priority: TaskPriority; category: string | null; notes: string | null; due_date: string | null }

export default function TasksPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/workshop/tasks')
      const d = await r.json()
      if (r.ok) setTasks(Array.isArray(d.tasks) ? d.tasks : [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function addTask() {
    if (!title.trim()) return
    await fetch('/api/workshop/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, priority, assignee: assignee || null, due_date: due || null }) })
    setTitle(''); setAssignee(''); setDue(''); setPriority('medium')
    load()
  }
  async function patchTask(id: string, patch: any) {
    await fetch(`/api/workshop/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    load()
  }
  async function delTask(id: string) {
    await fetch(`/api/workshop/tasks/${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <>
      <Head><title>Tasks — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="workshop-tasks" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          <div style={{ minHeight: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '8px 20px', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600, marginRight: 6 }}>Tasks</span>
            {canEdit && (
              <>
                <input value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTask()} placeholder="New task…" style={{ ...inp, width: 260 }} />
                <select value={priority} onChange={e => setPriority(e.target.value as TaskPriority)} style={inp}>
                  {TASK_PRIORITIES.map(p => <option key={p} value={p}>{TASK_PRIORITY_META[p].label}</option>)}
                </select>
                <input value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="Assignee" style={{ ...inp, width: 120 }} />
                <input type="date" value={due} onChange={e => setDue(e.target.value)} style={inp} />
                <button onClick={addTask} style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, background: T.accent, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Add</button>
              </>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, alignItems: 'start' }}>
              {COLUMNS.map(col => {
                const colTasks = tasks.filter(t => t.status === col)
                return (
                  <div key={col} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: TASK_STATUS_META[col].color }} />
                      <span style={{ fontSize: 11, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{TASK_STATUS_META[col].label}</span>
                      <span style={{ fontSize: 11, color: T.text3, marginLeft: 'auto' }}>{colTasks.length}</span>
                    </div>
                    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 60 }}>
                      {colTasks.length === 0 && <div style={{ fontSize: 11, color: T.text3, textAlign: 'center', padding: 12 }}>—</div>}
                      {colTasks.map(t => {
                        const pm = TASK_PRIORITY_META[t.priority] || TASK_PRIORITY_META.medium
                        return (
                          <div key={t.id} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 7, padding: 10 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                              <div style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>{t.title}</div>
                              {canEdit && <button onClick={() => delTask(t.id)} style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: pm.color, background: `${pm.color}1e`, border: `1px solid ${pm.color}44`, borderRadius: 3, padding: '1px 6px', textTransform: 'uppercase' }}>{pm.label}</span>
                              {t.assignee && <span style={{ fontSize: 10, color: T.text2 }}>{t.assignee}</span>}
                              {t.due_date && <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{new Date(t.due_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</span>}
                              {canEdit && (
                                <select value={t.status} onChange={e => patchTask(t.id, { status: e.target.value })} style={{ ...inp, padding: '2px 6px', fontSize: 10, marginLeft: 'auto' }}>
                                  {TASK_STATUSES.map(s => <option key={s} value={s}>{TASK_STATUS_META[s].label}</option>)}
                                </select>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
