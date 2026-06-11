// pages/crm/contacts.tsx — CRM contacts list + detail drawer (timeline,
// linked leads/tasks, workshop handoff). Replaces ActiveCampaign contact storage.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T, fmtDate } from '../../components/crm/CrmShell'
import { Overlay, Field, Timeline, input, primaryBtn, ghostBtn, closeBtn } from '../../components/crm/ui'
import CallButton from '../../components/crm/CallButton'
import ComposeModal from '../../components/crm/ComposeModal'
import { useToast } from '../../components/ui/Feedback'

interface Contact {
  id: string; name: string; email: string | null; phone: string | null; mobile: string | null
  company_name: string | null; source: string | null; owner_id: string | null
  last_activity_at: string | null; created_at: string
  owner?: { id: string; display_name: string | null } | null
}

export default function CrmContacts({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const [contacts, setContacts] = useState<Contact[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const debRef = useRef<any>(null)

  const load = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const r = await fetch(`/api/crm/contacts?q=${encodeURIComponent(query)}&limit=100`)
      const d = await r.json()
      if (r.ok) setContacts(d.contacts || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load('') }, [load])
  function onSearch(v: string) {
    setQ(v)
    if (debRef.current) clearTimeout(debRef.current)
    debRef.current = setTimeout(() => load(v), 300)
  }

  return (
    <CrmShell user={user} active="contacts" title="Contacts">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <input value={q} onChange={e => onSearch(e.target.value)} placeholder="Search name, company, phone, email…" style={{ ...input, maxWidth: 380 }} />
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && <button onClick={() => setShowImport(true)} style={ghostBtn}>⬆ Import CSV</button>}
          {canEdit && <button onClick={() => setShowNew(true)} style={primaryBtn}>+ New contact</button>}
        </div>

        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1.4fr 1fr 90px', gap: 12, padding: '9px 14px', background: T.bg3, fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <div>Name</div><div>Company</div><div>Contact</div><div>Owner</div><div style={{ textAlign: 'right' }}>Activity</div>
          </div>
          {contacts.map(c => (
            <div key={c.id} onClick={() => setOpenId(c.id)} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 1.4fr 1fr 90px', gap: 12, padding: '11px 14px', borderTop: `1px solid ${T.border}`, fontSize: 13, cursor: 'pointer', alignItems: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(var(--t-ink),0.03)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <div style={{ fontWeight: 500 }}>{c.name}</div>
              <div style={{ color: T.text2 }}>{c.company_name || '—'}</div>
              <div style={{ color: T.text2, fontSize: 12 }}>{c.mobile || c.phone || c.email || '—'}</div>
              <div style={{ color: T.text2, fontSize: 12 }}>{c.owner?.display_name || '—'}</div>
              <div style={{ textAlign: 'right', color: T.text3, fontSize: 11 }}>{c.last_activity_at ? fmtDate(c.last_activity_at) : fmtDate(c.created_at)}</div>
            </div>
          ))}
          {!loading && contacts.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 13 }}>No contacts{q ? ' match your search' : ' yet'}.</div>}
        </div>
      </div>

      {openId && <ContactDrawer id={openId} canEdit={canEdit} onClose={() => setOpenId(null)} onChanged={() => load(q)} />}
      {showNew && <NewContactModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(q) }} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); load(q) }} />}
    </CrmShell>
  )
}

// ── CSV import (the ActiveCampaign cutover tool) ─────────────────────
// Paste/upload the AC contact export; headers are auto-mapped (Email,
// First Name, Last Name, Phone, Tags, Organization…). Dedupe + tag-merge
// happen server-side (/api/crm/import-contacts).
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else inQ = false }
      else cell += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(c => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some(c => c.trim() !== '')) rows.push(row)
  return rows
}

const HEADER_MAP: Array<{ match: RegExp; key: string }> = [
  { match: /^e-?mail/i, key: 'email' },
  { match: /^first\s*_?name/i, key: 'first_name' },
  { match: /^last\s*_?name/i, key: 'last_name' },
  { match: /^(full\s*)?name$/i, key: 'name' },
  { match: /^mobile/i, key: 'mobile' },
  { match: /^phone|^number/i, key: 'phone' },
  { match: /^tags?$/i, key: 'tags' },
  { match: /^(organi[sz]ation|company|account)/i, key: 'company_name' },
]

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast()
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>('')

  const parsed = (() => {
    if (!raw.trim()) return null
    const rows = parseCsv(raw)
    if (rows.length < 2) return null
    const headers = rows[0].map(h => {
      const hit = HEADER_MAP.find(m => m.match.test(h.trim()))
      return hit ? hit.key : null
    })
    if (!headers.some(Boolean)) return null
    const out = rows.slice(1).map(r => {
      const o: any = {}
      headers.forEach((k, i) => { if (k && r[i] != null && String(r[i]).trim()) o[k] = String(r[i]).trim() })
      return o
    }).filter(o => Object.keys(o).length > 0)
    return { mapped: headers.filter(Boolean) as string[], rows: out }
  })()

  async function run() {
    if (!parsed) return
    setBusy(true); setResult('')
    let created = 0, mergedN = 0, skippedN = 0
    try {
      for (let i = 0; i < parsed.rows.length; i += 1000) {
        const r = await fetch('/api/crm/import-contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: parsed.rows.slice(i, i + 1000) }) })
        const d = await r.json()
        if (!r.ok) { toast(d.error || 'Import failed', 'error'); setBusy(false); return }
        created += d.created; mergedN += d.merged; skippedN += d.skipped
        setResult(`Importing… ${Math.min(i + 1000, parsed.rows.length)}/${parsed.rows.length}`)
      }
      setResult(`Done — ${created} created, ${mergedN} merged, ${skippedN} skipped`)
      toast(`${created} contacts created, ${mergedN} merged`, 'success')
      onImported()
    } catch (e: any) { toast(e?.message || 'Import failed', 'error') } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>Import contacts (CSV)</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: T.text2, marginBottom: 10, lineHeight: 1.5 }}>
        Paste the CSV (including the header row) from your ActiveCampaign contact export — or any CSV with Email / First Name / Last Name / Phone / Tags / Organization columns. Existing contacts are matched by email/phone: their tags merge and blanks fill, nothing gets overwritten.
      </div>
      <input type="file" accept=".csv,text/csv" onChange={e => {
        const f = e.target.files?.[0]
        if (!f) return
        const rd = new FileReader()
        rd.onload = () => setRaw(String(rd.result || ''))
        rd.readAsText(f)
      }} style={{ marginBottom: 8, fontSize: 12, color: T.text2 }} />
      <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={8} placeholder={'Email,First Name,Last Name,Phone,Tags\njane@example.com,Jane,Smith,0410 000 000,"vip, exhaust"'}
        style={{ ...input, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} />
      <div style={{ fontSize: 11, color: parsed ? T.green : T.text3, margin: '8px 0' }}>
        {raw.trim() ? (parsed ? `✓ ${parsed.rows.length} rows · columns mapped: ${parsed.mapped.join(', ')}` : 'Couldn’t map any columns — check the header row.') : ''}
      </div>
      {result && <div style={{ fontSize: 12, color: T.text2, marginBottom: 8 }}>{result}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Close</button>
        <button onClick={run} disabled={busy || !parsed} style={primaryBtn}>{busy ? 'Importing…' : `Import ${parsed?.rows.length || 0} rows`}</button>
      </div>
    </Overlay>
  )
}

function ContactDrawer({ id, canEdit, onClose, onChanged }: { id: string; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [data, setData] = useState<any>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [compose, setCompose] = useState<'sms' | 'email' | null>(null)
  const load = useCallback(async () => { const r = await fetch(`/api/crm/contacts/${id}`); const d = await r.json(); if (r.ok) setData(d) }, [id])
  useEffect(() => { load() }, [load])

  const c = data?.contact
  async function patchField(k: string, v: string, current: string) {
    if (v === (current || '')) return
    await fetch(`/api/crm/contacts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [k]: v }) })
    load(); onChanged()
  }
  async function addNote() {
    if (!note.trim()) return
    setBusy(true)
    try { await fetch('/api/crm/activities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: id, type: 'note', body: note.trim() }) }); setNote(''); await load() }
    finally { setBusy(false) }
  }
  async function startWorkshop() {
    setBusy(true)
    try {
      const r = await fetch(`/api/crm/contacts/${id}/to-workshop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const d = await r.json()
      if (r.ok) router.push(`/workshop/quote/${d.quoteId}`); else toast(d.error || 'Could not start workshop quote', 'error')
    } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      {!c ? <div style={{ padding: 24, color: T.text3 }}>Loading…</div> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{c.name}</h2>
            <button onClick={onClose} style={closeBtn}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Mobile"><input defaultValue={c.mobile || ''} disabled={!canEdit} onBlur={e => patchField('mobile', e.target.value, c.mobile)} style={input} /></Field>
            <Field label="Phone"><input defaultValue={c.phone || ''} disabled={!canEdit} onBlur={e => patchField('phone', e.target.value, c.phone)} style={input} /></Field>
            <Field label="Email"><input defaultValue={c.email || ''} disabled={!canEdit} onBlur={e => patchField('email', e.target.value, c.email)} style={input} /></Field>
            <Field label="Company"><input defaultValue={c.company_name || ''} disabled={!canEdit} onBlur={e => patchField('company_name', e.target.value, c.company_name)} style={input} /></Field>
          </div>
          <Field label="Notes"><textarea defaultValue={c.notes || ''} disabled={!canEdit} onBlur={e => patchField('notes', e.target.value, c.notes)} style={{ ...input, minHeight: 54, resize: 'vertical' }} /></Field>

          {canEdit && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={startWorkshop} disabled={busy} style={{ ...primaryBtn, background: T.teal }} title={c.workshop_customer_id ? 'Linked to a workshop customer — opens a new quote' : 'Create the workshop customer + a quote'}>🔧 Start quote in Workshop</button>
              {(c.mobile || c.phone) && <CallButton contactId={c.id} />}
              {(c.mobile || c.phone) && <button onClick={() => setCompose('sms')} style={{ ...ghostBtn, padding: '5px 12px', fontSize: 12 }}>💬 SMS</button>}
              {c.email && <button onClick={() => setCompose('email')} style={{ ...ghostBtn, padding: '5px 12px', fontSize: 12 }}>✉️ Email</button>}
            </div>
          )}
          {compose && (
            <ComposeModal contactId={c.id} channel={compose}
              to={compose === 'sms' ? (c.mobile || c.phone) : c.email}
              onClose={() => setCompose(null)} onSent={load} />
          )}

          {/* Linked leads */}
          <SectionLabel>Leads</SectionLabel>
          {(data.leads || []).length === 0 ? <Muted>No leads.</Muted> : (data.leads).map((l: any) => (
            <div key={l.id} onClick={() => router.push('/crm')} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderBottom: `1px solid ${T.border}`, cursor: 'pointer' }}>
              <span style={{ fontSize: 13, flex: 1 }}>{l.title}</span>
              <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{l.stage}</span>
            </div>
          ))}

          {/* Open tasks */}
          <SectionLabel>Open tasks</SectionLabel>
          {(data.tasks || []).length === 0 ? <Muted>None.</Muted> : (data.tasks).map((t: any) => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>{t.title}</span>
              {t.due_at && <span style={{ fontSize: 10, color: T.amber }}>{fmtDate(t.due_at)}</span>}
            </div>
          ))}

          {/* Timeline */}
          <SectionLabel>Activity</SectionLabel>
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

function NewContactModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState<any>({ name: '', mobile: '', email: '', company_name: '' })
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  function set(k: string, v: any) { setF((p: any) => ({ ...p, [k]: v })) }
  async function submit() {
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/crm/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
      const d = await r.json()
      if (r.ok) onCreated(); else setErr(d.error || 'Failed')
    } catch { setErr('Network error') } finally { setBusy(false) }
  }
  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>New contact</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>
      <Field label="Name"><input autoFocus value={f.name} onChange={e => set('name', e.target.value)} style={input} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Mobile"><input value={f.mobile} onChange={e => set('mobile', e.target.value)} style={input} /></Field>
        <Field label="Email"><input value={f.email} onChange={e => set('email', e.target.value)} style={input} /></Field>
      </div>
      <Field label="Company"><input value={f.company_name} onChange={e => set('company_name', e.target.value)} style={input} /></Field>
      {err && <div style={{ color: T.red, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={submit} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </Overlay>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '16px 0 8px' }}>{children}</div>
}
function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>{children}</div>
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}
