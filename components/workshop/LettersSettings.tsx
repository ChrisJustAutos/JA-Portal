// components/workshop/LettersSettings.tsx
// Admin configuration for the thank-you letter automation — the automation
// rule + threshold, letterhead (incl. logo upload), and printer routing.
// Lives under Settings → Workshop → Letters. Self-contained: loads its own
// config so it can be embedded anywhere. (The staff-facing History / Compose /
// Templates stay on /workshop/letters.)

import { useEffect, useState, useCallback, useRef } from 'react'
import { UserRole, roleHasPermission } from '../../lib/permissions'
import { T, inp, pbtn, qbtn, miniBtn, SkeletonRows } from '../ui'
import { useToast } from '../ui/Feedback'

interface Template { id: string; name: string }
interface Automation {
  enabled: boolean; min_total: number; template_id: string | null; print_envelope: boolean
  letterhead_name: string; letterhead_abn: string | null; letterhead_address: string | null
  letterhead_phone: string | null; letterhead_email: string | null; letterhead_website: string | null
  return_address: string | null; watch_since?: string | null; logo_path?: string | null
}

export default function LettersSettings({ role }: { role: UserRole }) {
  const [automation, setAutomation] = useState<Automation | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [form, setForm] = useState<Automation | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const toast = useToast()
  const canAdmin = roleHasPermission(role, 'admin:settings')

  const load = useCallback(async () => {
    const r = await fetch('/api/workshop/letters/automation')
    const d = await r.json()
    if (r.ok) { setAutomation(d.automation); setTemplates(d.templates || []); setForm(d.automation) }
  }, [])
  useEffect(() => { load() }, [load])

  if (!form) return <SkeletonRows rows={6} />
  const set = (k: keyof Automation, v: any) => setForm({ ...form, [k]: v })
  const fmtD = (iso?: string | null) => { if (!iso) return ''; try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso } }
  const disabled = !canAdmin

  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/workshop/letters/automation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const d = await r.json()
      if (r.ok) { toast('Saved', 'success'); load() } else toast(d.error || 'Save failed', 'error')
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
      else { toast(`${dry ? 'Preview' : 'Done'}: ${o.printed} ${dry ? 'would print' : 'queued'}, ${o.skipped} skipped, ${o.scanned} scanned`, 'success'); if (!dry) load() }
    } finally { setRunning(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 18, maxWidth: 560 }}>
      <p style={{ fontSize: 12.5, color: T.text3, margin: 0 }}>
        Jobs are finalised in MechanicDesk → pushed to MYOB. The portal checks MYOB hourly and prints a thank-you letter + DL envelope to the office printer for each new <b>job invoice</b> (a real sale — never a booking deposit).
      </p>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" checked={form.enabled} disabled={disabled} onChange={e => set('enabled', e.target.checked)} id="le-en" />
          <label htmlFor="le-en" style={{ fontWeight: 600 }}>Auto-print a thank-you letter when a job invoice lands in MYOB</label>
        </div>
        {form.enabled && form.watch_since ? <div style={{ fontSize: 11, color: T.text3, marginTop: 4, marginLeft: 26 }}>Watching invoices since {fmtD(form.watch_since)} · checked hourly</div> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Minimum invoice total (inc GST)" hint="0 = every job invoice. Deposits never trigger a letter regardless.">
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
        <input type="checkbox" checked={form.print_envelope} disabled={disabled} onChange={e => set('print_envelope', e.target.checked)} id="le-env" />
        <label htmlFor="le-env">Also print a DL envelope</label>
      </div>

      <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
        <h3 style={{ fontSize: 14, margin: '0 0 4px' }}>Letterhead</h3>
        <p style={{ fontSize: 12, color: T.text3, margin: '0 0 12px' }}>Shown at the top of every letter.</p>
        <LogoUploader hasLogo={!!form.logo_path} canAdmin={canAdmin} reload={load} toast={toast} />
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

      <PrintersSection canAdmin={canAdmin} toast={toast} />

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

// ── Logo uploader ─────────────────────────────────────────────────────────
function LogoUploader({ hasLogo, canAdmin, reload, toast }: { hasLogo: boolean; canAdmin: boolean; reload: () => void; toast: (m: string, k?: any) => void }) {
  const [bust, setBust] = useState(0)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    if (f.size > 6_000_000) return toast('Logo too large (max ~6MB)', 'error')
    setBusy(true)
    try {
      const dataUrl: string = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) })
      const r = await fetch('/api/workshop/letters/logo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl }) })
      const d = await r.json()
      if (r.ok) { toast('Logo uploaded', 'success'); setBust(b => b + 1); reload() } else toast(d.error || 'Upload failed', 'error')
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const remove = async () => {
    const r = await fetch('/api/workshop/letters/logo', { method: 'DELETE' })
    if (r.ok) { toast('Logo removed', 'success'); setBust(b => b + 1); reload() } else toast('Remove failed', 'error')
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, padding: 12, border: `1px solid ${T.border}`, borderRadius: 8, background: T.bg2 }}>
      <div style={{ width: 150, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' }}>
        {hasLogo ? <img src={`/api/workshop/letters/logo?cb=${bust}`} alt="Logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <span style={{ fontSize: 11, color: T.text3 }}>No logo</span>}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: T.text2, fontWeight: 500, marginBottom: 4 }}>Logo (top-right of the letter)</div>
        <div style={{ fontSize: 11, color: T.text3, marginBottom: 8 }}>PNG or JPG, transparent background ideal.</div>
        {canAdmin ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif" onChange={onFile} style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()} disabled={busy} style={qbtn(T.accent)}>{busy ? 'Uploading…' : hasLogo ? 'Replace logo' : 'Upload logo'}</button>
            {hasLogo ? <button onClick={remove} style={miniBtn(T.red)}>Remove</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Printers (portal-managed; agent reads these) ────────────────────────────
interface PrinterCfg {
  letter_printer: string | null; envelope_printer: string | null; invoice_printer: string | null
  letter_bin: string | null; envelope_bin: string | null; invoice_bin: string | null
  letter_scale: string; envelope_scale: string
  available_printers: string[]; agent_host: string | null; agent_last_seen: string | null
}
function PrintersSection({ canAdmin, toast }: { canAdmin: boolean; toast: (m: string, k?: any) => void }) {
  const [cfg, setCfg] = useState<PrinterCfg | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { const r = await fetch('/api/workshop/letters/printers'); const d = await r.json(); if (r.ok) setCfg(d.printers) }, [])
  useEffect(() => { load() }, [load])
  if (!cfg) return null
  const set = (k: keyof PrinterCfg, v: any) => setCfg({ ...cfg, [k]: v })
  const online = cfg.agent_last_seen && (Date.now() - new Date(cfg.agent_last_seen).getTime() < 15 * 60 * 1000)
  const opts = cfg.available_printers || []
  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/workshop/letters/printers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) })
      const d = await r.json()
      toast(r.ok ? 'Printers saved' : (d.error || 'Save failed'), r.ok ? 'success' : 'error')
    } finally { setBusy(false) }
  }
  type PKey = 'letter_printer' | 'envelope_printer' | 'invoice_printer'
  type BKey = 'letter_bin' | 'envelope_bin' | 'invoice_bin'
  const picker = (k: PKey) => opts.length
    ? <select value={cfg[k] || ''} disabled={!canAdmin} onChange={e => set(k, e.target.value)} style={inp as any}>
        <option value="">— Windows default —</option>
        {opts.map(p => <option key={p} value={p}>{p}</option>)}
        {cfg[k] && !opts.includes(cfg[k]!) ? <option value={cfg[k]!}>{cfg[k]} (not detected)</option> : null}
      </select>
    : <input value={cfg[k] || ''} disabled={!canAdmin} onChange={e => set(k, e.target.value)} placeholder="Exact Windows printer name" style={inp} />
  const row = (label: string, pk: PKey, bk: BKey, hint?: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10, alignItems: 'start' }}>
      <Field label={label} hint={hint}>{picker(pk)}</Field>
      <Field label="Tray"><input value={cfg[bk] || ''} disabled={!canAdmin} onChange={e => set(bk, e.target.value)} placeholder="Default" style={inp} /></Field>
    </div>
  )
  return (
    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Printers &amp; trays</h3>
        <span style={{ fontSize: 11, color: online ? T.green : T.text3 }}>
          {online ? `● Agent online${cfg.agent_host ? ` (${cfg.agent_host})` : ''}` : '○ Print agent offline'}
        </span>
      </div>
      {!opts.length ? <p style={{ fontSize: 11, color: T.text3, margin: 0 }}>No printers reported yet — start the print agent on the workshop PC and it'll list them here. You can type a name meanwhile.</p> : null}
      <p style={{ fontSize: 11, color: T.text3, margin: 0 }}>Same printer, different trays: set the tray name/number as the driver shows it (e.g. <code>Tray 2</code>, <code>Manual</code>). Blank = the printer's default tray.</p>
      {row('Letter printer (A4)', 'letter_printer', 'letter_bin', 'Thank-you letters.')}
      {row('Invoice printer (A4)', 'invoice_printer', 'invoice_bin', 'B2B invoices — point at a different tray for plain A4.')}
      {row('Envelope printer (DL)', 'envelope_printer', 'envelope_bin', 'DL envelopes — prints at actual size.')}
      {canAdmin ? <button onClick={save} disabled={busy} style={qbtn(T.accent)}>{busy ? 'Saving…' : 'Save printers'}</button> : null}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 12, color: T.text2, fontWeight: 500, marginBottom: 5 }}>{label}</div>
      {children}
      {hint ? <div style={{ fontSize: 11, color: T.text3, marginTop: 4 }}>{hint}</div> : null}
    </label>
  )
}
