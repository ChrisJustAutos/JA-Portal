// pages/tasks/index.tsx — standalone Tasks module (Monday-style).
// Board (kanban by status) + List (grouped by group) with create/edit, assign,
// due, priority and groups. Phase 1 — automations come next.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T } from '../../components/ui'
import { useToast, useConfirm } from '../../components/ui/Feedback'

const STATUSES = [
  { key: 'todo', label: 'To do', color: '#6b7280' },
  { key: 'in_progress', label: 'In progress', color: '#4f8ef7' },
  { key: 'blocked', label: 'Blocked', color: '#f04e4e' },
  { key: 'done', label: 'Done', color: '#34c77b' },
] as const
const PRIO: Record<string, { label: string; color: string }> = {
  low: { label: 'Low', color: '#6b7280' }, normal: { label: 'Normal', color: '#4f8ef7' },
  high: { label: 'High', color: '#f5a623' }, urgent: { label: 'Urgent', color: '#f04e4e' },
}
const fmtDue = (iso: string | null) => { if (!iso) return ''; try { return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }) } catch { return '' } }
const overdue = (t: any) => t.due_at && t.status !== 'done' && new Date(t.due_at).getTime() < Date.now()
const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const btn = (c: string, solid?: boolean): React.CSSProperties => ({ padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: solid ? c : 'transparent', color: solid ? '#fff' : c, border: `1px solid ${solid ? c : c + '55'}` })

interface Task { id: string; title: string; description: string | null; status: string; priority: string; assignee_id: string | null; group_id: string | null; due_at: string | null; assignee?: { id: string; display_name: string | null } | null }
interface Group { id: string; name: string; color: string | null }
interface Staff { id: string; display_name: string | null; email: string }

export default function TasksPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:tasks')
  const router = useRouter()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [tasks, setTasks] = useState<Task[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [users, setUsers] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [owner, setOwner] = useState('all')   // all | me | <id>
  const [edit, setEdit] = useState<Partial<Task> | null>(null)  // open modal (new if no id)
  const [dragId, setDragId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/tasks'); const d = await r.json()
      if (r.ok) { setTasks(d.tasks || []); setGroups(d.groups || []); setUsers(d.users || []) }
      setLastRefresh(new Date())
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { try { const v = localStorage.getItem('tasks_layout'); if (v === 'list' || v === 'board') setLayout(v) } catch { /* */ } }, [])
  function pickLayout(v: 'board' | 'list') { setLayout(v); try { localStorage.setItem('tasks_layout', v) } catch { /* */ } }

  const shown = useMemo(() => tasks.filter(t => owner === 'all' || (owner === 'me' ? t.assignee_id === user.id : t.assignee_id === owner)), [tasks, owner, user.id])
  const groupName = (id: string | null) => groups.find(g => g.id === id)?.name || 'No group'

  async function patchTask(id: string, p: any) {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...p } : t))   // optimistic
    const r = await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    if (!r.ok) { toast((await r.json()).error || 'Save failed', 'error'); load() }
  }
  async function saveModal() {
    if (!edit) return
    const payload = { title: edit.title, description: edit.description, status: edit.status, priority: edit.priority, assignee_id: edit.assignee_id || null, group_id: edit.group_id || null, due_at: edit.due_at || null }
    if (!String(payload.title || '').trim()) { toast('Title required', 'error'); return }
    if (edit.id) await patchTask(edit.id, payload)
    else { const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (!r.ok) { toast((await r.json()).error || 'Create failed', 'error'); return } await load() }
    setEdit(null)
  }
  async function delTask(id: string) {
    if (!(await confirmDialog({ title: 'Delete this task?', danger: true }))) return
    setTasks(prev => prev.filter(t => t.id !== id)); setEdit(null)
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  }
  async function addGroup() {
    const name = window.prompt('New group name')?.trim(); if (!name) return
    await fetch('/api/tasks/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, sort_order: groups.length }) })
    load()
  }

  function Avatar({ id }: { id: string | null }) {
    const u = users.find(x => x.id === id)
    if (!u) return <span style={{ width: 20 }} />
    return <span title={u.display_name || u.email} style={{ width: 20, height: 20, borderRadius: '50%', background: T.bg4, color: T.text2, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{(u.display_name || u.email).charAt(0).toUpperCase()}</span>
  }

  return (
    <>
      <Head><title>Tasks — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <PortalTopBar activeId="tasks" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          {/* Toolbar */}
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Tasks</span>
            <div style={{ display: 'flex', border: `1px solid ${T.border2}`, borderRadius: 7, overflow: 'hidden' }}>
              {(['board', 'list'] as const).map(v => <button key={v} onClick={() => pickLayout(v)} style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', border: 'none', background: layout === v ? T.accent : 'transparent', color: layout === v ? '#fff' : T.text2 }}>{v === 'board' ? '▦ Board' : '☰ List'}</button>)}
            </div>
            <select value={owner} onChange={e => setOwner(e.target.value)} style={{ ...inp, width: 'auto', padding: '5px 8px', fontSize: 12 }}>
              <option value="all">Everyone</option><option value="me">My tasks</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
            <span style={{ flex: 1 }} />
            <button onClick={() => router.push('/tasks/automations')} style={btn(T.amber)}>⚡ Automations</button>
            {canEdit && <button onClick={addGroup} style={btn(T.text2)}>+ Group</button>}
            {canEdit && <button onClick={() => setEdit({ status: 'todo', priority: 'normal', group_id: groups[0]?.id || null })} style={btn(T.accent, true)}>+ Task</button>}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {layout === 'board' ? (
              <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
                {STATUSES.map(st => {
                  const items = shown.filter(t => t.status === st.key)
                  return (
                    <div key={st.key} onDragOver={e => { if (dragId) e.preventDefault() }} onDrop={e => { e.preventDefault(); if (dragId) { patchTask(dragId, { status: st.key }); setDragId(null) } }}
                      style={{ width: 290, minWidth: 290, display: 'flex', flexDirection: 'column', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10 }}>
                      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color }} />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{st.label}</span>
                        <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{items.length}</span>
                      </div>
                      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {items.map(t => (
                          <div key={t.id} draggable={canEdit} onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)} onClick={() => setEdit(t)}
                            style={{ background: T.bg3, border: `1px solid ${overdue(t) ? `${T.red}66` : T.border}`, borderRadius: 8, padding: 10, cursor: 'pointer', opacity: dragId === t.id ? 0.4 : 1 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, lineHeight: 1.3 }}>{t.title}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: PRIO[t.priority]?.color, background: `${PRIO[t.priority]?.color}1e`, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' }}>{PRIO[t.priority]?.label}</span>
                              {t.group_id && <span style={{ fontSize: 10, color: T.text3 }}>{groupName(t.group_id)}</span>}
                              <span style={{ flex: 1 }} />
                              {t.due_at && <span style={{ fontSize: 10, color: overdue(t) ? T.red : T.text3, fontWeight: overdue(t) ? 700 : 400 }}>⏰ {fmtDue(t.due_at)}</span>}
                              <Avatar id={t.assignee_id} />
                            </div>
                          </div>
                        ))}
                        {items.length === 0 && <div style={{ fontSize: 11, color: T.text3, textAlign: 'center', padding: '10px 0', fontStyle: 'italic' }}>—</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1100 }}>
                {[...groups, { id: '__none', name: 'No group', color: T.text3 }].map(g => {
                  const items = shown.filter(t => (t.group_id || '__none') === g.id)
                  if (!items.length && g.id === '__none') return null
                  return (
                    <div key={g.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', background: T.bg2 }}>
                      <div style={{ padding: '8px 12px', background: T.bg3, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.color || T.text3 }} />
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{g.name}</span>
                        <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{items.length}</span>
                      </div>
                      {items.map(t => (
                        <div key={t.id} onClick={() => setEdit(t)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: `1px solid ${T.border}`, cursor: 'pointer', fontSize: 12.5 }}>
                          <span style={{ flex: '2 1 240px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                          {canEdit
                            ? <select value={t.status} onClick={e => e.stopPropagation()} onChange={e => patchTask(t.id, { status: e.target.value })} style={{ ...inp, width: 'auto', padding: '4px 6px', fontSize: 11 }}>{STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                            : <span style={{ width: 90 }}>{STATUSES.find(s => s.key === t.status)?.label}</span>}
                          <span style={{ width: 60, fontSize: 10, fontWeight: 700, color: PRIO[t.priority]?.color }}>{PRIO[t.priority]?.label}</span>
                          <span style={{ width: 80, textAlign: 'right', fontSize: 11, color: overdue(t) ? T.red : T.text3 }}>{t.due_at ? `⏰ ${fmtDue(t.due_at)}` : ''}</span>
                          <Avatar id={t.assignee_id} />
                        </div>
                      ))}
                      {items.length === 0 && <div style={{ padding: '10px 12px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>No tasks.</div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Create / edit modal */}
      {edit && (
        <div onClick={() => setEdit(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '94vw', maxHeight: '90vh', overflow: 'auto', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, color: T.text }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{edit.id ? 'Edit task' : 'New task'}</div>
            <input autoFocus value={edit.title || ''} onChange={e => setEdit({ ...edit, title: e.target.value })} placeholder="Task title" style={{ ...inp, marginBottom: 10 }} disabled={!canEdit} />
            <textarea value={edit.description || ''} onChange={e => setEdit({ ...edit, description: e.target.value })} placeholder="Notes…" rows={3} style={{ ...inp, resize: 'vertical', marginBottom: 10 }} disabled={!canEdit} />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>Status</div><select value={edit.status || 'todo'} onChange={e => setEdit({ ...edit, status: e.target.value })} style={inp} disabled={!canEdit}>{STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
              <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>Priority</div><select value={edit.priority || 'normal'} onChange={e => setEdit({ ...edit, priority: e.target.value })} style={inp} disabled={!canEdit}>{Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>Assignee</div><select value={edit.assignee_id || ''} onChange={e => setEdit({ ...edit, assignee_id: e.target.value || null })} style={inp} disabled={!canEdit}><option value="">— Unassigned —</option>{users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}</select></div>
              <div style={{ flex: 1, minWidth: 120 }}><div style={lbl}>Group</div><select value={edit.group_id || ''} onChange={e => setEdit({ ...edit, group_id: e.target.value || null })} style={inp} disabled={!canEdit}><option value="">— No group —</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
            </div>
            <div style={{ marginBottom: 16 }}><div style={lbl}>Due</div><input type="date" value={(edit.due_at || '').slice(0, 10)} onChange={e => setEdit({ ...edit, due_at: e.target.value || null })} style={{ ...inp, colorScheme: 'dark' }} disabled={!canEdit} /></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              {edit.id && canEdit ? <button onClick={() => delTask(edit.id!)} style={btn(T.red)}>Delete</button> : <span />}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEdit(null)} style={btn(T.text2)}>Cancel</button>
                {canEdit && <button onClick={saveModal} style={btn(T.accent, true)}>{edit.id ? 'Save' : 'Create'}</button>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const lbl: React.CSSProperties = { fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:tasks')
}
