// pages/crm/campaigns.tsx — CRM email campaigns (Phase 3). Compose a broadcast,
// pick an audience (segment or all), test, then send now or schedule. Replaces
// ActiveCampaign campaign management.
import { useState, useEffect, useCallback } from 'react'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T, fmtDate, fmtDateTime } from '../../components/crm/CrmShell'
import { Overlay, Field, input, primaryBtn, ghostBtn, closeBtn } from '../../components/crm/ui'

interface Segment { id: string; name: string; description: string | null; definition: any }
interface Campaign {
  id: string; name: string; subject: string; status: string; segment_id: string | null; audience_all: boolean
  scheduled_at: string | null; total_recipients: number; sent_count: number; fail_count: number; sent_at: string | null
  created_at: string; opened?: number; clicked?: number; segment?: { id: string; name: string } | null
}
const STATUS_COLOR: Record<string, string> = { draft: T.text3, scheduled: T.amber, sending: T.blue, sent: T.green, cancelled: T.red }
const VARS = ['first_name', 'contact_name', 'company']

export default function CrmCampaigns({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showSegments, setShowSegments] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, s] = await Promise.all([fetch('/api/crm/campaigns').then(r => r.json()), fetch('/api/crm/segments').then(r => r.json())])
      setCampaigns(c.campaigns || []); setSegments(s.segments || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function newCampaign() {
    const name = prompt('Campaign name?')
    if (!name) return
    const r = await fetch('/api/crm/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    const d = await r.json()
    if (r.ok) { await load(); setOpenId(d.id) } else alert(d.error || 'Failed')
  }

  function rate(n: number | undefined, total: number) { return total > 0 ? Math.round(((n || 0) / total) * 100) + '%' : '—' }

  return (
    <CrmShell user={user} active="campaigns" title="Campaigns">
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Campaigns</h1>
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && <button onClick={() => setShowSegments(true)} style={ghostBtn}>Segments</button>}
          {canEdit && <button onClick={newCampaign} style={primaryBtn}>+ New campaign</button>}
        </div>

        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 90px 90px 80px 80px 90px', gap: 10, padding: '9px 14px', background: T.bg3, fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <div>Campaign</div><div>Status</div><div style={{ textAlign: 'right' }}>Sent</div><div style={{ textAlign: 'right' }}>Opens</div><div style={{ textAlign: 'right' }}>Clicks</div><div style={{ textAlign: 'right' }}>Date</div>
          </div>
          {campaigns.map(c => (
            <div key={c.id} onClick={() => setOpenId(c.id)} style={{ display: 'grid', gridTemplateColumns: '1.8fr 90px 90px 80px 80px 90px', gap: 10, padding: '11px 14px', borderTop: `1px solid ${T.border}`, fontSize: 13, cursor: 'pointer', alignItems: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <div><div style={{ fontWeight: 500 }}>{c.name}</div><div style={{ fontSize: 11, color: T.text3 }}>{c.subject || 'No subject'}</div></div>
              <div><span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${STATUS_COLOR[c.status]}22`, color: STATUS_COLOR[c.status], textTransform: 'capitalize' }}>{c.status}</span></div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>{c.sent_count}/{c.total_recipients}</div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: T.text2 }}>{rate(c.opened, c.total_recipients)}</div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: T.text2 }}>{rate(c.clicked, c.total_recipients)}</div>
              <div style={{ textAlign: 'right', fontSize: 11, color: T.text3 }}>{fmtDate(c.sent_at || c.created_at)}</div>
            </div>
          ))}
          {!loading && campaigns.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 13 }}>No campaigns yet.</div>}
        </div>
      </div>

      {openId && <CampaignEditor id={openId} canEdit={canEdit} segments={segments} onClose={() => setOpenId(null)} onChanged={load} />}
      {showSegments && <SegmentManager segments={segments} canEdit={canEdit} onClose={() => setShowSegments(false)} onChanged={load} />}
    </CrmShell>
  )
}

function CampaignEditor({ id, canEdit, segments, onClose, onChanged }: { id: string; canEdit: boolean; segments: Segment[]; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null)
  const [f, setF] = useState<any>(null)
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState('')
  const [schedule, setSchedule] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`/api/crm/campaigns/${id}`); const d = await r.json()
    if (r.ok) { setData(d); setF({ ...d.campaign }) }
  }, [id])
  useEffect(() => { load() }, [load])

  const editable = f && ['draft', 'scheduled'].includes(f.status)
  function set(k: string, v: any) { setF((p: any) => ({ ...p, [k]: v })) }

  // Live recipient preview when the audience changes.
  useEffect(() => {
    if (!f) return
    const def = f.audience_all ? {} : (segments.find(s => s.id === f.segment_id)?.definition || {})
    fetch('/api/crm/segments/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: def, audience_all: f.audience_all }) })
      .then(r => r.json()).then(d => setCount(d.count ?? null)).catch(() => setCount(null))
  }, [f?.audience_all, f?.segment_id, segments]) // eslint-disable-line

  async function save() {
    setBusy(true); setMsg('')
    try {
      const r = await fetch(`/api/crm/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, subject: f.subject, preheader: f.preheader, body: f.body, from_name: f.from_name, reply_to: f.reply_to, segment_id: f.audience_all ? null : f.segment_id, audience_all: f.audience_all }) })
      const d = await r.json()
      setMsg(r.ok ? 'Saved.' : (d.error || 'Failed')); if (r.ok) onChanged()
    } finally { setBusy(false) }
  }
  async function sendTest() {
    const email = prompt('Send a test to which email?')
    if (!email) return
    setBusy(true); setMsg('')
    try { await save(); const r = await fetch(`/api/crm/campaigns/${id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); const d = await r.json(); setMsg(r.ok ? `Test sent to ${email}` : (d.error || 'Failed')) }
    finally { setBusy(false) }
  }
  async function sendNow() {
    if (!confirm(`Send "${f.name}" to ${count ?? '—'} contacts now?`)) return
    setBusy(true); setMsg('')
    try { await save(); const r = await fetch(`/api/crm/campaigns/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); const d = await r.json(); if (r.ok) { setMsg(`Sending to ${d.recipients} contacts…`); onChanged(); load() } else setMsg(d.error || 'Failed') }
    finally { setBusy(false) }
  }
  async function doSchedule() {
    if (!schedule) { setMsg('Pick a date/time'); return }
    setBusy(true); setMsg('')
    try { await save(); const r = await fetch(`/api/crm/campaigns/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_at: new Date(schedule).toISOString() }) }); const d = await r.json(); if (r.ok) { setMsg(`Scheduled for ${fmtDateTime(d.scheduled_at)}`); onChanged(); load() } else setMsg(d.error || 'Failed') }
    finally { setBusy(false) }
  }

  if (!f) return <Overlay onClose={onClose}><div style={{ padding: 24, color: T.text3 }}>Loading…</div></Overlay>
  const stats = data?.stats

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{f.name}</h2>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${STATUS_COLOR[f.status]}22`, color: STATUS_COLOR[f.status], textTransform: 'capitalize' }}>{f.status}</span>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>

      {stats && f.status !== 'draft' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          {[['Recipients', stats.total], ['Sent', f.sent_count], ['Opened', stats.opened], ['Clicked', stats.clicked], ['Unsub', stats.unsub], ['Bounced', stats.bounced]].map(([l, v]) => (
            <div key={l as string} style={{ background: T.bg3, borderRadius: 8, padding: '8px 12px', minWidth: 70 }}>
              <div style={{ fontSize: 17, fontWeight: 600 }}>{v as number}</div>
              <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{l}</div>
            </div>
          ))}
        </div>
      )}

      <Field label="Name"><input value={f.name} disabled={!editable} onChange={e => set('name', e.target.value)} style={input} /></Field>
      <Field label="Subject"><input value={f.subject || ''} disabled={!editable} onChange={e => set('subject', e.target.value)} style={input} placeholder="Subject line" /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="From name"><input value={f.from_name || ''} disabled={!editable} onChange={e => set('from_name', e.target.value)} style={input} placeholder="Just Autos" /></Field>
        <Field label="Reply-to"><input value={f.reply_to || ''} disabled={!editable} onChange={e => set('reply_to', e.target.value)} style={input} placeholder="(default)" /></Field>
      </div>

      <Field label="Audience">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 6 }}>
          <input type="radio" checked={!!f.audience_all} disabled={!editable} onChange={() => set('audience_all', true)} /> All mailable contacts
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 6 }}>
          <input type="radio" checked={!f.audience_all} disabled={!editable} onChange={() => set('audience_all', false)} /> Segment:
          <select value={f.segment_id || ''} disabled={!editable || f.audience_all} onChange={e => set('segment_id', e.target.value || null)} style={{ ...input, width: 'auto', flex: 1 }}>
            <option value="">Choose…</option>
            {segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {count != null && <div style={{ fontSize: 12, color: T.teal }}>≈ {count} contact{count === 1 ? '' : 's'} will receive this</div>}
      </Field>

      <Field label="Body">
        <textarea value={f.body || ''} disabled={!editable} onChange={e => set('body', e.target.value)} style={{ ...input, minHeight: 180, resize: 'vertical', fontFamily: 'inherit' }} placeholder={'Write your email. Plain text becomes a tidy HTML email; you can also paste HTML.\n\nLinks are tracked automatically and an unsubscribe footer is added.'} />
        <div style={{ fontSize: 11, color: T.text3, marginTop: 6 }}>Placeholders: {VARS.map(v => <code key={v} style={{ background: T.bg3, padding: '1px 5px', borderRadius: 3, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}</div>
      </Field>

      {msg && <div style={{ fontSize: 12, color: msg.toLowerCase().includes('fail') || msg.toLowerCase().includes('error') ? T.red : T.green, margin: '8px 0' }}>{msg}</div>}

      {editable && canEdit && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={save} disabled={busy} style={ghostBtn}>Save draft</button>
            <button onClick={sendTest} disabled={busy} style={ghostBtn}>Send test</button>
            <span style={{ flex: 1 }} />
            <button onClick={sendNow} disabled={busy} style={primaryBtn}>Send now</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input type="datetime-local" value={schedule} onChange={e => setSchedule(e.target.value)} style={{ ...input, flex: 1 }} />
            <button onClick={doSchedule} disabled={busy} style={ghostBtn}>Schedule</button>
          </div>
        </>
      )}
      {f.status === 'scheduled' && <div style={{ fontSize: 12, color: T.amber, marginTop: 8 }}>Scheduled for {fmtDateTime(f.scheduled_at)}. Editing reverts it to a draft you can re-send.</div>}
    </Overlay>
  )
}

function SegmentManager({ segments, canEdit, onClose, onChanged }: { segments: Segment[]; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  function blank() { return { id: '', name: '', description: '', tags_any: '', sources: '', search: '' } }
  function toForm(s: Segment) { const d = s.definition || {}; return { id: s.id, name: s.name, description: s.description || '', tags_any: (d.tags_any || []).join(', '), sources: (d.sources || []).join(', '), search: d.search || '' } }

  async function save() {
    const e = editing
    const definition = {
      tags_any: e.tags_any.split(',').map((x: string) => x.trim()).filter(Boolean),
      sources: e.sources.split(',').map((x: string) => x.trim()).filter(Boolean),
      search: e.search.trim() || undefined,
    }
    setBusy(true)
    try {
      if (e.id) await fetch(`/api/crm/segments/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.name, description: e.description, definition }) })
      else await fetch('/api/crm/segments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: e.name, description: e.description, definition }) })
      setEditing(null); onChanged()
    } finally { setBusy(false) }
  }
  async function remove(s: Segment) { if (!confirm(`Delete segment "${s.name}"?`)) return; await fetch(`/api/crm/segments/${s.id}`, { method: 'DELETE' }); onChanged() }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>Segments</h2>
        {canEdit && !editing && <button onClick={() => setEditing(blank())} style={primaryBtn}>+ New</button>}
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>

      {editing ? (
        <>
          <Field label="Name"><input autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} style={input} /></Field>
          <Field label="Description"><input value={editing.description} onChange={e => setEditing({ ...editing, description: e.target.value })} style={input} /></Field>
          <Field label="Has any of these tags (comma-separated)"><input value={editing.tags_any} onChange={e => setEditing({ ...editing, tags_any: e.target.value })} style={input} placeholder="e.g. 200-series, repeat" /></Field>
          <Field label="Source is one of (comma-separated)"><input value={editing.sources} onChange={e => setEditing({ ...editing, sources: e.target.value })} style={input} placeholder="e.g. website, manual" /></Field>
          <Field label="Name/email/company contains"><input value={editing.search} onChange={e => setEditing({ ...editing, search: e.target.value })} style={input} /></Field>
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 10 }}>Audiences always exclude unsubscribed / do-not-contact people and anyone without an email.</div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setEditing(null)} style={ghostBtn}>Cancel</button>
            <button onClick={save} disabled={busy || !editing.name.trim()} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segments.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: T.bg3, borderRadius: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</div>
                {s.description && <div style={{ fontSize: 11, color: T.text3 }}>{s.description}</div>}
              </div>
              {canEdit && <button onClick={() => setEditing(toForm(s))} style={ghostBtn}>Edit</button>}
              {canEdit && <button onClick={() => remove(s)} style={{ ...ghostBtn, color: T.red, borderColor: 'transparent' }}>Delete</button>}
            </div>
          ))}
          {segments.length === 0 && <div style={{ fontSize: 13, color: T.text3, fontStyle: 'italic' }}>No segments yet. Create one to target a subset of contacts.</div>}
        </div>
      )}
    </Overlay>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}
