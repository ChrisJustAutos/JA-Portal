// components/settings/StaffSection.tsx
// Workshop staff / diary lanes, managed INSIDE Settings → Users & Staff so
// logins and lanes live on one screen (previously a separate grid buried in
// Workshop settings). Each lane can be linked to a portal login — the link
// powers "one person, one record" views (a login maps to at most one lane).
// Lanes are keyed by `code` on bookings/time entries, so people who never
// log in (apprentices, casuals) can still be lanes with no login.

import { useCallback, useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { useToast, useConfirm } from '../ui/Feedback'

interface Tech {
  id: string; name: string; code: string; role: string | null; color: string | null
  daily_hours: number; show_in_diary: boolean; active: boolean; user_id: string | null
}
interface PortalUser { id: string; email: string; display_name: string | null; phone_extension?: string | null }

const cellInp: React.CSSProperties = { width: '100%', padding: '4px 7px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }

export default function StaffSection({ users }: { users: PortalUser[] }) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [techs, setTechs] = useState<Tech[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/workshop/technicians')
      const d = await r.json()
      if (r.ok) setTechs(d.technicians || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function patch(id: string, p: any) {
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    if (!r.ok) toast((await r.json()).error || 'Save failed', 'error')
    await load()
  }
  async function add(name: string, userId?: string) {
    const user = userId ? users.find(u => u.id === userId) : null
    const r = await fetch('/api/workshop/technicians', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, user_id: userId || null, phone_ext: user?.phone_extension || null }),
    })
    if (!r.ok) toast((await r.json()).error || 'Add failed', 'error')
    await load()
  }
  async function remove(t: Tech) {
    const ok = await confirmDialog({
      title: `Remove ${t.name} from the diary?`,
      message: 'If they have bookings, the lane is retired (history keeps their name); otherwise it\'s deleted. Their portal login (if any) is not affected.',
      confirmLabel: 'Remove', danger: true,
    })
    if (!ok) return
    const r = await fetch(`/api/workshop/technicians?id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
    if (!r.ok) toast((await r.json()).error || 'Remove failed', 'error')
    await load()
  }

  const linkedUserIds = new Set(techs.map(t => t.user_id).filter(Boolean))
  const unlinkedUsers = users.filter(u => !linkedUserIds.has(u.id))

  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10 }}>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Workshop staff &amp; diary lanes ({techs.length})</div>
        <div style={{ fontSize: 11, color: T.text3, marginTop: 4, lineHeight: 1.5 }}>
          Diary lanes for the workshop calendar. <strong>Login</strong> links a lane to a portal user above (one each) — staff who never log in can still be lanes.
          “Diary” shows/hides the lane; “Active” off retires someone who has left. Hours drive the workload bars.
        </div>
      </div>
      <div style={{ padding: '10px 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr 56px 64px 50px 50px 1.3fr 28px', gap: 8, padding: '6px 4px', fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          <div>Name</div><div>Role</div><div style={{ textAlign: 'center' }}>Colour</div><div style={{ textAlign: 'right' }}>Hrs/day</div><div style={{ textAlign: 'center' }}>Diary</div><div style={{ textAlign: 'center' }}>Active</div><div>Portal login</div><div/>
        </div>
        {loading && <div style={{ padding: 14, fontSize: 12, color: T.text3 }}>Loading…</div>}
        {!loading && techs.length === 0 && <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: T.text3 }}>No staff yet — add someone below.</div>}
        {techs.map(t => (
          <StaffRow key={t.id} tech={t} users={users} linkedUserIds={linkedUserIds}
            onPatch={(p) => patch(t.id, p)} onRemove={() => remove(t)} />
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...cellInp, flex: 1, minWidth: 180 }} value={newName} onChange={e => setNewName(e.target.value)}
            placeholder="New staff name (lane without a login)…"
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { add(newName.trim()); setNewName('') } }} />
          <button onClick={() => { if (newName.trim()) { add(newName.trim()); setNewName('') } }}
            style={{ padding: '6px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, background: T.accent, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>+ Add</button>
          {unlinkedUsers.length > 0 && (
            <select value="" onChange={e => { if (e.target.value) add(users.find(u => u.id === e.target.value)?.display_name || users.find(u => u.id === e.target.value)?.email || 'Staff', e.target.value) }}
              title="Create a diary lane for an existing portal user (links them automatically)"
              style={{ ...cellInp, width: 'auto', minWidth: 220 }}>
              <option value="">+ Add lane for a portal user…</option>
              {unlinkedUsers.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
            </select>
          )}
        </div>
      </div>
    </div>
  )
}

function StaffRow({ tech, users, linkedUserIds, onPatch, onRemove }: {
  tech: Tech; users: PortalUser[]; linkedUserIds: Set<string | null>
  onPatch: (p: any) => void; onRemove: () => void
}) {
  const [name, setName] = useState(tech.name || '')
  const [role, setRole] = useState(tech.role || '')
  const [hours, setHours] = useState(String(tech.daily_hours ?? 8))
  useEffect(() => { setName(tech.name || ''); setRole(tech.role || ''); setHours(String(tech.daily_hours ?? 8)) }, [tech.id, tech.name, tech.role, tech.daily_hours])
  const dim = !tech.active ? 0.5 : 1
  // The linked user plus anyone not already linked elsewhere.
  const options = users.filter(u => u.id === tech.user_id || !linkedUserIds.has(u.id))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr 56px 64px 50px 50px 1.3fr 28px', gap: 8, padding: '6px 4px', borderTop: `1px solid ${T.border}`, alignItems: 'center', opacity: dim }}>
      <input style={cellInp} value={name} onChange={e => setName(e.target.value)} onBlur={() => name !== (tech.name || '') && name.trim() && onPatch({ name })} />
      <input style={cellInp} value={role} onChange={e => setRole(e.target.value)} onBlur={() => role !== (tech.role || '') && onPatch({ role })} placeholder="Technician" />
      <input type="color" value={tech.color || '#4f8ef7'} onChange={e => onPatch({ color: e.target.value })} style={{ width: 30, height: 26, padding: 0, border: `1px solid ${T.border}`, borderRadius: 4, background: T.bg3, cursor: 'pointer', justifySelf: 'center' }} />
      <input style={{ ...cellInp, textAlign: 'right' }} inputMode="decimal" value={hours} onChange={e => setHours(e.target.value)} onBlur={() => Number(hours) !== Number(tech.daily_hours) && onPatch({ daily_hours: Number(hours) || 0 })} />
      <input type="checkbox" checked={!!tech.show_in_diary} onChange={e => onPatch({ show_in_diary: e.target.checked })} style={{ justifySelf: 'center', cursor: 'pointer' }} />
      <input type="checkbox" checked={!!tech.active} onChange={e => onPatch({ active: e.target.checked })} style={{ justifySelf: 'center', cursor: 'pointer' }} />
      <select value={tech.user_id || ''} onChange={e => onPatch({ user_id: e.target.value || null })}
        title="Link this lane to a portal login"
        style={{ ...cellInp, color: tech.user_id ? T.text : T.text3 }}>
        <option value="">— no login —</option>
        {options.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
      </select>
      <button onClick={onRemove} title="Remove from the diary" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, justifySelf: 'center' }}>×</button>
    </div>
  )
}
