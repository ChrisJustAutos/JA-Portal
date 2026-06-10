// pages/crm/index.tsx — CRM pipeline (kanban). Replaces the Monday quote board.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T, STAGE_COLOR, fmtMoney, fmtDate } from '../../components/crm/CrmShell'
import { Overlay, Field, Timeline, input, primaryBtn, ghostBtn, closeBtn } from '../../components/crm/ui'
import { PIPELINE_COLUMNS, LEAD_STAGE_LABELS, LEAD_STAGES, LeadStage } from '../../lib/crm'
import { useToast } from '../../components/ui/Feedback'

interface Lead {
  id: string; title: string; stage: string; value: number | null; source: string | null
  vehicle: string | null; owner_id: string | null; contact_id: string | null
  contact_attempts: number; next_follow_up_at: string | null; created_at: string
  contact?: { id: string; name: string; email: string | null; phone: string | null; mobile: string | null; company_name: string | null } | null
  owner?: { id: string; display_name: string | null } | null
}
interface StaffUser { id: string; display_name: string | null; email: string }

export default function CrmPipeline({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const [leads, setLeads] = useState<Lead[]>([])
  const [users, setUsers] = useState<StaffUser[]>([])
  const [loading, setLoading] = useState(true)
  const [owner, setOwner] = useState<'me' | 'all'>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/crm/leads?owner=${owner}`)
      const d = await r.json()
      if (r.ok) setLeads(d.leads || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [owner])
  useEffect(() => { load() }, [load])
  useEffect(() => { fetch('/api/crm/users').then(r => r.json()).then(d => setUsers(d.users || [])).catch(() => {}) }, [])

  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {}
    for (const s of PIPELINE_COLUMNS) m[s] = []
    for (const l of leads) (m[l.stage] = m[l.stage] || []).push(l)
    return m
  }, [leads])

  async function moveStage(id: string, stage: string) {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, stage } : l))  // optimistic
    try {
      const r = await fetch(`/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage }) })
      if (!r.ok) load()
    } catch { load() }
  }

  return (
    <CrmShell user={user} active="pipeline">
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexShrink: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Pipeline</h1>
          <div style={{ display: 'flex', background: T.bg3, borderRadius: 7, padding: 2 }}>
            {(['all', 'me'] as const).map(o => (
              <button key={o} onClick={() => setOwner(o)} style={{
                background: owner === o ? T.bg4 : 'transparent', border: 'none', cursor: 'pointer',
                color: owner === o ? T.text : T.text2, fontSize: 12, fontFamily: 'inherit',
                padding: '5px 12px', borderRadius: 6,
              }}>{o === 'all' ? 'Everyone' : 'My leads'}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && (
            <button onClick={() => setShowNew(true)} style={primaryBtn}>+ New lead</button>
          )}
        </div>

        {/* Board */}
        <div style={{ display: 'flex', gap: 12, flex: 1, overflowX: 'auto', minHeight: 0 }}>
          {PIPELINE_COLUMNS.map(stage => {
            const items = byStage[stage] || []
            const sum = items.reduce((a, l) => a + (Number(l.value) || 0), 0)
            return (
              <div key={stage}
                onDragOver={e => { if (dragId) { e.preventDefault(); setDragOver(stage) } }}
                onDragLeave={() => setDragOver(o => o === stage ? null : o)}
                onDrop={e => { e.preventDefault(); if (dragId) moveStage(dragId, stage); setDragId(null); setDragOver(null) }}
                style={{
                  width: 270, minWidth: 270, display: 'flex', flexDirection: 'column',
                  background: dragOver === stage ? 'rgba(79,142,247,0.06)' : T.bg2,
                  border: `1px solid ${dragOver === stage ? T.accent : T.border}`, borderRadius: 10,
                }}>
                <div style={{ padding: '10px 12px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STAGE_COLOR[stage] }} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{LEAD_STAGE_LABELS[stage]}</span>
                  <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{items.length}</span>
                  <span style={{ flex: 1 }} />
                  {sum > 0 && <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{fmtMoney(sum)}</span>}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map(l => (
                    <div key={l.id}
                      draggable={canEdit}
                      onDragStart={() => setDragId(l.id)}
                      onDragEnd={() => { setDragId(null); setDragOver(null) }}
                      onClick={() => setOpenId(l.id)}
                      style={{
                        background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10,
                        cursor: 'pointer', opacity: dragId === l.id ? 0.4 : 1,
                      }}>
                      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, lineHeight: 1.3 }}>{l.title}</div>
                      {l.contact && <div style={{ fontSize: 11, color: T.text2, marginBottom: 6 }}>{l.contact.name}{l.contact.company_name ? ` · ${l.contact.company_name}` : ''}</div>}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {l.value != null && <span style={{ fontSize: 11, color: T.green, fontFamily: 'monospace' }}>{fmtMoney(l.value)}</span>}
                        <span style={{ flex: 1 }} />
                        {l.next_follow_up_at && <span title="Follow-up due" style={{ fontSize: 10, color: T.amber }}>⏰ {fmtDate(l.next_follow_up_at)}</span>}
                        {l.owner?.display_name && (
                          <span title={l.owner.display_name} style={{ width: 20, height: 20, borderRadius: '50%', background: T.bg4, color: T.text2, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {l.owner.display_name.charAt(0).toUpperCase()}
                          </span>
                        )}
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

      {openId && <LeadDrawer id={openId} canEdit={canEdit} users={users} currentUserId={user.id}
        onClose={() => setOpenId(null)} onChanged={load}
        onOpenWorkshop={(quoteId: string) => router.push(`/workshop/quote/${quoteId}`)} />}
      {showNew && <NewLeadModal users={users} currentUserId={user.id} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load() }} />}
    </CrmShell>
  )
}

// ── Lead drawer ──────────────────────────────────────────────────────
function LeadDrawer({ id, canEdit, users, currentUserId, onClose, onChanged, onOpenWorkshop }: {
  id: string; canEdit: boolean; users: StaffUser[]; currentUserId: string
  onClose: () => void; onChanged: () => void; onOpenWorkshop: (quoteId: string) => void
}) {
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const r = await fetch(`/api/crm/leads/${id}`); const d = await r.json()
    if (r.ok) setData(d)
  }, [id])
  useEffect(() => { load() }, [load])

  async function patch(body: any) {
    setBusy(true)
    try { await fetch(`/api/crm/leads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await load(); onChanged() }
    finally { setBusy(false) }
  }
  async function addNote() {
    if (!note.trim()) return
    setBusy(true)
    try {
      await fetch('/api/crm/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: id, contact_id: lead?.contact_id, type: 'note', body: note.trim() }) })
      setNote(''); await load()
    } finally { setBusy(false) }
  }
  async function startWorkshop() {
    if (!lead?.contact_id) { toast('Link a contact first.', 'error'); return }
    setBusy(true)
    try {
      const r = await fetch(`/api/crm/contacts/${lead.contact_id}/to-workshop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_id: id, notes: lead.details || lead.title }) })
      const d = await r.json()
      if (r.ok) { onChanged(); onOpenWorkshop(d.quoteId) }
      else toast(d.error || 'Could not start workshop quote', 'error')
    } finally { setBusy(false) }
  }

  const lead = data?.lead
  return (
    <Overlay onClose={onClose}>
      {!lead ? <div style={{ padding: 24, color: T.text3 }}>Loading…</div> : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 4 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{lead.title}</h2>
            <button onClick={onClose} style={closeBtn}>✕</button>
          </div>
          {lead.contact && (
            <div style={{ fontSize: 13, color: T.text2, marginBottom: 14 }}>
              {lead.contact.name}{lead.contact.company_name ? ` · ${lead.contact.company_name}` : ''}
              <div style={{ fontSize: 12, color: T.text3, marginTop: 2 }}>
                {[lead.contact.mobile, lead.contact.phone, lead.contact.email].filter(Boolean).join('  ·  ')}
              </div>
            </div>
          )}

          {/* Stage */}
          <Field label="Stage">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LEAD_STAGES.map(s => (
                <button key={s} disabled={!canEdit} onClick={() => patch({ stage: s })} style={{
                  fontSize: 11, padding: '5px 10px', borderRadius: 6, cursor: canEdit ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  background: lead.stage === s ? `${STAGE_COLOR[s]}26` : 'transparent',
                  color: lead.stage === s ? STAGE_COLOR[s] : T.text2,
                  border: `1px solid ${lead.stage === s ? STAGE_COLOR[s] : T.border2}`,
                }}>{LEAD_STAGE_LABELS[s as LeadStage]}</button>
              ))}
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Value (inc GST)">
              <input type="number" defaultValue={lead.value ?? ''} disabled={!canEdit}
                onBlur={e => { const v = e.target.value; if (String(v) !== String(lead.value ?? '')) patch({ value: v }) }}
                style={input} placeholder="—" />
            </Field>
            <Field label="Owner">
              <select value={lead.owner_id || ''} disabled={!canEdit} onChange={e => patch({ owner_id: e.target.value || null })} style={input}>
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
              </select>
            </Field>
            <Field label="Follow-up date">
              <input type="date" disabled={!canEdit}
                defaultValue={lead.next_follow_up_at ? lead.next_follow_up_at.slice(0, 10) : ''}
                onChange={e => patch({ next_follow_up_at: e.target.value ? new Date(e.target.value).toISOString() : null })}
                style={input} />
            </Field>
            <Field label="Vehicle">
              <input defaultValue={lead.vehicle || ''} disabled={!canEdit}
                onBlur={e => { if (e.target.value !== (lead.vehicle || '')) patch({ vehicle: e.target.value }) }} style={input} placeholder="—" />
            </Field>
          </div>

          {lead.details && <div style={{ fontSize: 13, color: T.text2, background: T.bg3, borderRadius: 8, padding: 10, margin: '6px 0 12px', whiteSpace: 'pre-wrap' }}>{lead.details}</div>}

          {canEdit && (
            <div style={{ display: 'flex', gap: 8, margin: '6px 0 16px' }}>
              <button onClick={startWorkshop} disabled={busy || !lead.contact_id} style={{ ...primaryBtn, background: T.teal }} title={lead.workshop_quote_id ? 'A workshop quote already exists — opens the board' : 'Create a workshop quote for this contact'}>
                🔧 {lead.workshop_quote_id ? 'Open in Workshop' : 'Start quote in Workshop'}
              </button>
            </div>
          )}

          {/* Timeline */}
          <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Activity</div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note…" onKeyDown={e => { if (e.key === 'Enter') addNote() }} style={{ ...input, flex: 1 }} />
              <button onClick={addNote} disabled={busy || !note.trim()} style={primaryBtn}>Add</button>
            </div>
          )}
          <Timeline activities={data.activities || []} />
        </>
      )}
    </Overlay>
  )
}

// ── New lead modal ───────────────────────────────────────────────────
function NewLeadModal({ users, currentUserId, onClose, onCreated }: {
  users: StaffUser[]; currentUserId: string; onClose: () => void; onCreated: () => void
}) {
  const [f, setF] = useState<any>({ title: '', contact_name: '', mobile: '', email: '', value: '', vehicle: '', details: '', owner_id: currentUserId })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  function set(k: string, v: any) { setF((p: any) => ({ ...p, [k]: v })) }
  async function submit() {
    if (!f.title.trim() && !f.contact_name.trim()) { setErr('Add a title or a contact name'); return }
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/crm/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
      const d = await r.json()
      if (r.ok) onCreated(); else setErr(d.error || 'Failed')
    } catch { setErr('Network error') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>New lead</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>
      <Field label="Title"><input autoFocus value={f.title} onChange={e => set('title', e.target.value)} style={input} placeholder="e.g. 200 Series exhaust quote" /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Contact name"><input value={f.contact_name} onChange={e => set('contact_name', e.target.value)} style={input} /></Field>
        <Field label="Mobile"><input value={f.mobile} onChange={e => set('mobile', e.target.value)} style={input} /></Field>
        <Field label="Email"><input value={f.email} onChange={e => set('email', e.target.value)} style={input} /></Field>
        <Field label="Value (inc GST)"><input type="number" value={f.value} onChange={e => set('value', e.target.value)} style={input} /></Field>
        <Field label="Vehicle"><input value={f.vehicle} onChange={e => set('vehicle', e.target.value)} style={input} /></Field>
        <Field label="Owner">
          <select value={f.owner_id} onChange={e => set('owner_id', e.target.value)} style={input}>
            {users.map(u => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Details"><textarea value={f.details} onChange={e => set('details', e.target.value)} style={{ ...input, minHeight: 64, resize: 'vertical' }} /></Field>
      {err && <div style={{ color: T.red, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Create lead'}</button>
      </div>
    </Overlay>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}
