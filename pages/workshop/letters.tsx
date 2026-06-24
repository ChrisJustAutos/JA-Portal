// pages/workshop/letters.tsx
// Workshop Letters — the thank-you-letter automation hub:
//   • History   — every letter (auto + manual), with reprint
//   • Compose   — manually render + print a letter + envelope for any customer
//   • Templates — manage reusable letter bodies ({{placeholders}})
//   • Settings  — automation rule (enabled / >$ threshold / template) + letterhead
//
// Printing flows through the existing label-print-agent: queued jobs land on the
// office printer. Auto letters fire when a finalised job invoice over the
// threshold is pushed to MYOB (lib/workshop-myob-invoice.ts → maybeAutoLetterForBooking).

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { T, inp, pbtn, qbtn, miniBtn, SkeletonRows, Empty, StatusPill } from '../../components/ui'
import { useToast, useConfirm } from '../../components/ui/Feedback'

type Tab = 'history' | 'compose' | 'templates' | 'settings'

interface Template { id: string; name: string; category: string | null; body: string; sign_off_name: string | null; sign_off_title: string | null }
interface Automation {
  enabled: boolean; min_total: number; template_id: string | null; print_envelope: boolean
  letterhead_name: string; letterhead_abn: string | null; letterhead_address: string | null
  letterhead_phone: string | null; letterhead_email: string | null; letterhead_website: string | null
  return_address: string | null; watch_since?: string | null
}
interface LetterJob {
  id: string; trigger: string; recipient_name: string | null; recipient_address: string | null
  invoice_total: number | null; status: string; error: string | null; created_at: string
  letter_storage_path: string | null; template?: { name: string } | null
}

const money = (n: number | null) => n == null ? '' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDateTime = (iso: string) => { try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso } }
const statusColor = (s: string) => s === 'queued' ? T.accent : s === 'printed' ? T.green : s === 'failed' ? T.red : T.text3

export default function LettersPage({ user }: { user: PortalUserSSR }) {
  const [tab, setTab] = useState<Tab>('history')
  const [automation, setAutomation] = useState<Automation | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const toast = useToast()
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const canAdmin = roleHasPermission(user.role, 'admin:settings')

  const loadConfig = useCallback(async () => {
    const r = await fetch('/api/workshop/letters/automation')
    const d = await r.json()
    if (r.ok) { setAutomation(d.automation); setTemplates(d.templates || []) }
  }, [])
  useEffect(() => { loadConfig() }, [loadConfig])

  const TABS: { id: Tab; label: string }[] = [
    { id: 'history', label: 'History' },
    { id: 'compose', label: 'Compose' },
    { id: 'templates', label: 'Templates' },
    { id: 'settings', label: 'Automation & letterhead' },
  ]

  return (
    <>
      <Head><title>Letters · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.text, fontFamily: '"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="letters" role={user.role} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 28px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4, gap: 16, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Letters</h1>
              {automation ? (
                <div style={{ fontSize: 12, color: T.text3 }}>
                  Auto thank-you: {automation.enabled
                    ? <span style={{ color: T.green }}>ON</span>
                    : <span style={{ color: T.text3 }}>off</span>} · {automation.min_total > 0 ? <>invoices over <b>{money(automation.min_total)}</b></> : <>every finalised job invoice</>}
                </div>
              ) : null}
            </div>
            <p style={{ fontSize: 12.5, color: T.text3, margin: '0 0 16px' }}>
              Jobs are finalised in MechanicDesk → pushed to MYOB. The portal checks MYOB hourly and prints a thank-you letter + DL envelope to the office printer for each new <b>job invoice</b> — a real sale (income line), never a booking deposit.
            </p>

            {/* In-page tabs */}
            <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 20 }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  color: tab === t.id ? T.text : T.text2, fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
                  padding: '8px 12px', borderBottom: `2px solid ${tab === t.id ? T.accent : 'transparent'}`,
                }}>{t.label}</button>
              ))}
            </div>

            {tab === 'history' && <History canEdit={canEdit} toast={toast} />}
            {tab === 'compose' && <Compose templates={templates} canEdit={canEdit} toast={toast} />}
            {tab === 'templates' && <Templates templates={templates} canEdit={canEdit} reload={loadConfig} toast={toast} />}
            {tab === 'settings' && <Settings automation={automation} templates={templates} canAdmin={canAdmin} reload={loadConfig} toast={toast} />}
          </div>
        </div>
      </div>
    </>
  )
}

// ── History ────────────────────────────────────────────────────────────
function History({ canEdit, toast }: { canEdit: boolean; toast: (m: string, k?: any) => void }) {
  const [jobs, setJobs] = useState<LetterJob[] | null>(null)
  const load = useCallback(async () => {
    const r = await fetch('/api/workshop/letters/jobs')
    const d = await r.json()
    if (r.ok) setJobs(d.jobs || [])
  }, [])
  useEffect(() => { load() }, [load])

  const reprint = async (id: string) => {
    const r = await fetch('/api/workshop/letters/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reprint', id }) })
    const d = await r.json()
    toast(r.ok ? 'Re-queued to the printer' : (d.error || 'Reprint failed'), r.ok ? 'success' : 'error')
  }

  if (!jobs) return <SkeletonRows rows={6} />
  if (!jobs.length) return <Empty>No letters yet. They appear here when the automation fires or you compose one.</Empty>
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 0.8fr 0.7fr 0.6fr 90px', gap: 8, padding: '10px 14px', background: T.bg2, fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase' }}>
        <div>Recipient</div><div>Template</div><div>Invoice</div><div>Source</div><div>Status</div><div></div>
      </div>
      {jobs.map(j => (
        <div key={j.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 0.8fr 0.7fr 0.6fr 90px', gap: 8, padding: '10px 14px', borderTop: `1px solid ${T.border}`, fontSize: 13, alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 500 }}>{j.recipient_name || '—'}</div>
            <div style={{ fontSize: 11, color: T.text3 }}>{fmtDateTime(j.created_at)}</div>
          </div>
          <div style={{ color: T.text2 }}>{j.template?.name || '—'}</div>
          <div style={{ color: T.text2 }}>{money(j.invoice_total)}</div>
          <div><StatusPill label={j.trigger} color={j.trigger === 'auto' ? T.accent : T.text3} /></div>
          <div title={j.error || ''}><StatusPill label={j.status} color={statusColor(j.status)} /></div>
          <div>{canEdit && j.letter_storage_path ? <button onClick={() => reprint(j.id)} style={miniBtn(T.accent)}>Reprint</button> : null}</div>
        </div>
      ))}
    </div>
  )
}

// ── Compose ────────────────────────────────────────────────────────────
function Compose({ templates, canEdit, toast }: { templates: Template[]; canEdit: boolean; toast: (m: string, k?: any) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [customer, setCustomer] = useState<any | null>(null)
  const [templateId, setTemplateId] = useState(templates[0]?.id || '')
  const [body, setBody] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const timer = useRef<any>(null)

  useEffect(() => { if (!templateId && templates[0]) setTemplateId(templates[0].id) }, [templates, templateId])
  const tpl = templates.find(t => t.id === templateId)
  useEffect(() => { setBody(tpl?.body || '') }, [templateId]) // prefill editable body from template

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!q.trim()) { setResults([]); return }
    timer.current = setTimeout(async () => {
      const r = await fetch(`/api/workshop/customers?q=${encodeURIComponent(q)}&limit=8`)
      const d = await r.json()
      if (r.ok) setResults(d.customers || [])
    }, 200)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  const payload = () => ({
    customerId: customer?.id || '', templateId,
    body: body || null, recipientName: recipientName || null, recipientAddress: recipientAddress || null,
  })

  const preview = async (kind: 'letter' | 'envelope') => {
    if (!templateId) return toast('Pick a template first', 'error')
    const r = await fetch('/api/workshop/letters/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload(), kind }) })
    if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || 'Preview failed', 'error') }
    const blob = await r.blob()
    window.open(URL.createObjectURL(blob), '_blank')
  }

  const queue = async () => {
    if (!customer) return toast('Pick a customer', 'error')
    if (!templateId) return toast('Pick a template', 'error')
    setBusy(true)
    try {
      const r = await fetch('/api/workshop/letters/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'manual', ...payload() }) })
      const d = await r.json()
      toast(r.ok ? 'Queued to the printer ✓' : (d.error || 'Failed'), r.ok ? 'success' : 'error')
    } finally { setBusy(false) }
  }

  if (!canEdit) return <Empty>You don't have permission to compose letters.</Empty>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, maxWidth: 640 }}>
      <Field label="Customer">
        {customer ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', border: `1px solid ${T.border}`, borderRadius: 6 }}>
            <span>{customer.name}</span>
            <button onClick={() => { setCustomer(null); setRecipientName('') }} style={miniBtn(T.text3)}>Change</button>
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, mobile, phone…" style={inp} />
            {results.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, marginTop: 4, maxHeight: 240, overflowY: 'auto' }}>
                {results.map(c => (
                  <button key={c.id} onClick={() => { setCustomer(c); setRecipientName(c.name || ''); setQ(''); setResults([]) }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: `1px solid ${T.border}`, padding: '8px 12px', cursor: 'pointer', color: T.text, fontFamily: 'inherit', fontSize: 13 }}>
                    {c.name}{c.mobile ? <span style={{ color: T.text3 }}> · {c.mobile}</span> : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Field>

      <Field label="Template">
        <select value={templateId} onChange={e => setTemplateId(e.target.value)} style={inp as any}>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>

      <Field label="Letter body" hint="{{first_name}}, {{customer_name}}, {{vehicle}}, {{rego}}, {{business_name}} fill on print.">
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={8} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 } as any} />
      </Field>

      <Field label="Recipient name override" hint="Blank = customer's name on file.">
        <input value={recipientName} onChange={e => setRecipientName(e.target.value)} placeholder="(use file)" style={inp} />
      </Field>
      <Field label="Recipient address override" hint="Blank = customer's address on file. One line per row.">
        <textarea value={recipientAddress} onChange={e => setRecipientAddress(e.target.value)} rows={3} placeholder="(use file)" style={{ ...inp, resize: 'vertical' } as any} />
      </Field>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => preview('letter')} style={qbtn(T.text2)}>Preview letter</button>
        <button onClick={() => preview('envelope')} style={qbtn(T.text2)}>Preview envelope</button>
        <button onClick={queue} disabled={busy || !customer} style={pbtn(T.accent)}>{busy ? 'Queuing…' : 'Print letter + envelope'}</button>
      </div>
    </div>
  )
}

// ── Templates ──────────────────────────────────────────────────────────
function Templates({ templates, canEdit, reload, toast }: { templates: Template[]; canEdit: boolean; reload: () => void; toast: (m: string, k?: any) => void }) {
  const [editing, setEditing] = useState<Partial<Template> | null>(null)
  const confirm = useConfirm()

  const save = async () => {
    if (!editing?.name?.trim() || !editing?.body?.trim()) return toast('Name and body are required', 'error')
    const r = await fetch('/api/workshop/letters/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editing) })
    const d = await r.json()
    if (r.ok) { toast('Saved', 'success'); setEditing(null); reload() } else toast(d.error || 'Save failed', 'error')
  }
  const del = async (id: string) => {
    if (!(await confirm({ title: 'Delete template?', message: 'This cannot be undone.', danger: true }))) return
    const r = await fetch(`/api/workshop/letters/templates?id=${id}`, { method: 'DELETE' })
    if (r.ok) { toast('Deleted', 'success'); reload() } else toast('Delete failed', 'error')
  }

  if (editing) {
    return (
      <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
        <Field label="Name"><input value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} style={inp} /></Field>
        <Field label="Category" hint="thank_you, rego_due, service_due, custom…"><input value={editing.category || ''} onChange={e => setEditing({ ...editing, category: e.target.value })} style={inp} /></Field>
        <Field label="Body" hint="{{first_name}}, {{customer_name}}, {{vehicle}}, {{rego}}, {{business_name}}, {{date}}, {{total}}">
          <textarea value={editing.body || ''} onChange={e => setEditing({ ...editing, body: e.target.value })} rows={9} style={{ ...inp, resize: 'vertical', lineHeight: 1.5 } as any} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Sign-off name"><input value={editing.sign_off_name || ''} onChange={e => setEditing({ ...editing, sign_off_name: e.target.value })} placeholder="Matt Smith" style={inp} /></Field>
          <Field label="Sign-off title"><input value={editing.sign_off_title || ''} onChange={e => setEditing({ ...editing, sign_off_title: e.target.value })} placeholder="Owner/Director" style={inp} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} style={pbtn(T.accent)}>Save template</button>
          <button onClick={() => setEditing(null)} style={qbtn(T.text2)}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {canEdit && <button onClick={() => setEditing({ name: '', body: '', category: 'custom' })} style={{ ...pbtn(T.accent), marginBottom: 14 }}>+ New template</button>}
      {!templates.length ? <Empty>No templates.</Empty> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {templates.map(t => (
            <div key={t.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{t.name} {t.category ? <span style={{ fontSize: 11, color: T.text3, fontWeight: 400 }}>· {t.category}</span> : null}</div>
                  <div style={{ fontSize: 12.5, color: T.text2, marginTop: 6, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{t.body}</div>
                </div>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => setEditing(t)} style={miniBtn(T.accent)}>Edit</button>
                    <button onClick={() => del(t.id)} style={miniBtn(T.red)}>Delete</button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Settings ───────────────────────────────────────────────────────────
function Settings({ automation, templates, canAdmin, reload, toast }: { automation: Automation | null; templates: Template[]; canAdmin: boolean; reload: () => void; toast: (m: string, k?: any) => void }) {
  const [form, setForm] = useState<Automation | null>(automation)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => { setForm(automation) }, [automation])
  if (!form) return <SkeletonRows rows={6} />
  const set = (k: keyof Automation, v: any) => setForm({ ...form, [k]: v })
  const fmtD = (iso?: string | null) => { if (!iso) return ''; try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso } }

  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/workshop/letters/automation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const d = await r.json()
      if (r.ok) { toast('Saved', 'success'); reload() } else toast(d.error || 'Save failed', 'error')
    } finally { setBusy(false) }
  }

  const run = async (dry: boolean) => {
    setRunning(true)
    try {
      const r = await fetch('/api/workshop/letters/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run', dry }) })
      const d = await r.json()
      if (!r.ok) return toast(d.error || 'Run failed', 'error')
      const o = d.outcome || {}
      if (!o.enabled) toast('Automation is off — turn it on and save first', 'error')
      else { toast(`${dry ? 'Preview' : 'Done'}: ${o.printed} ${dry ? 'would print' : 'queued'}, ${o.skipped} skipped, ${o.scanned} scanned`, 'success'); if (!dry) reload() }
    } finally { setRunning(false) }
  }

  const disabled = !canAdmin
  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={form.enabled} disabled={disabled} onChange={e => set('enabled', e.target.checked)} id="en" />
          <label htmlFor="en" style={{ fontWeight: 600 }}>Auto-print a thank-you letter when a job invoice lands in MYOB</label>
        </div>
        {form.enabled && form.watch_since ? <div style={{ fontSize: 11, color: T.text3, marginTop: 4, marginLeft: 26 }}>Watching invoices since {fmtD(form.watch_since)} · checked hourly</div> : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Minimum invoice total (inc GST)" hint="0 = every finalised job invoice. Deposits never trigger a letter regardless.">
          <input type="number" value={form.min_total} disabled={disabled} onChange={e => set('min_total', e.target.value)} style={inp} />
        </Field>
        <Field label="Template">
          <select value={form.template_id || ''} disabled={disabled} onChange={e => set('template_id', e.target.value)} style={inp as any}>
            <option value="">— none —</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="checkbox" checked={form.print_envelope} disabled={disabled} onChange={e => set('print_envelope', e.target.checked)} id="env" />
        <label htmlFor="env">Also print a DL envelope</label>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
        <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Letterhead</h3>
        <p style={{ fontSize: 12, color: T.text3, margin: '0 0 12px' }}>Shown at the top of every letter. To add the logo, drop a <code>letterhead-logo.png</code> into the app's <code>/public</code> folder.</p>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Business name"><input value={form.letterhead_name} disabled={disabled} onChange={e => set('letterhead_name', e.target.value)} style={inp} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="ABN"><input value={form.letterhead_abn || ''} disabled={disabled} onChange={e => set('letterhead_abn', e.target.value)} style={inp} /></Field>
            <Field label="Website"><input value={form.letterhead_website || ''} disabled={disabled} onChange={e => set('letterhead_website', e.target.value)} style={inp} /></Field>
          </div>
          <Field label="Address"><input value={form.letterhead_address || ''} disabled={disabled} onChange={e => set('letterhead_address', e.target.value)} style={inp} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Phone"><input value={form.letterhead_phone || ''} disabled={disabled} onChange={e => set('letterhead_phone', e.target.value)} style={inp} /></Field>
            <Field label="Email"><input value={form.letterhead_email || ''} disabled={disabled} onChange={e => set('letterhead_email', e.target.value)} style={inp} /></Field>
          </div>
          <Field label="Return address (envelope)" hint="One line per row.">
            <textarea value={form.return_address || ''} disabled={disabled} onChange={e => set('return_address', e.target.value)} rows={3} style={{ ...inp, resize: 'vertical' } as any} />
          </Field>
        </div>
      </div>

      {canAdmin ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={save} disabled={busy} style={pbtn(T.accent)}>{busy ? 'Saving…' : 'Save settings'}</button>
          <button onClick={() => run(true)} disabled={running} style={qbtn(T.text2)} title="Scan MYOB now and report what would print, without queuing">{running ? 'Running…' : 'Preview scan'}</button>
          <button onClick={() => run(false)} disabled={running} style={qbtn(T.text2)} title="Scan MYOB now and queue any new job-invoice letters">Run now</button>
        </div>
      ) : <p style={{ fontSize: 12, color: T.text3 }}>Only admins can change these settings.</p>}
    </div>
  )
}

// ── Small field wrapper ──────────────────────────────────────────────────
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: T.text2, fontWeight: 500, marginBottom: 5 }}>{label}</div>
      {children}
      {hint ? <div style={{ fontSize: 11, color: T.text3, marginTop: 4 }}>{hint}</div> : null}
    </label>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
