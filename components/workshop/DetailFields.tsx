// components/workshop/DetailFields.tsx
// Shared "More fields" detail-capture panel for the workshop quote + job
// (booking) forms — brings owner / vehicle / job-detail capture to (and beyond)
// MechanicDesk parity. Backed by migration 121. Reused so quote and job stay
// in lock-step. Each field auto-saves on blur/change via the supplied patch
// callbacks.

import { useEffect, useRef, useState } from 'react'
import { T } from '../../lib/ui/theme'

const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const fieldGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }

export interface StaffLite { id: string; display_name: string | null; email: string }

interface MoreFieldsProps {
  kind: 'quote' | 'booking'
  record: any
  canEdit: boolean
  staff: StaffLite[]
  jobTypes: any[]
  onPatchRecord: (p: any) => void
  onPatchCustomer: (p: any) => void
  onPatchVehicle: (p: any) => void
  defaultOpen?: boolean
}

export default function MoreFields({ kind, record, canEdit, staff, jobTypes, onPatchRecord, onPatchCustomer, onPatchVehicle, defaultOpen }: MoreFieldsProps) {
  const [open, setOpen] = useState(!!defaultOpen)
  const r = record || {}
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'transparent', border: 'none', color: T.text, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
        <span style={{ color: T.text3, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        More fields
        <span style={{ fontSize: 11, color: T.text3, fontWeight: 400 }}>— {kind === 'quote' ? 'quote' : 'job'} details, owner, vehicle</span>
        {!open && <DetailSummary r={r} />}
      </button>
      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <RecordDetailFields kind={kind} r={r} canEdit={canEdit} staff={staff} jobTypes={jobTypes} onPatch={onPatchRecord} />
          {r.customer_id
            ? <OwnerDetailFields c={r.customer} canEdit={canEdit} onPatch={onPatchCustomer} />
            : <Hint>Pick a customer above to edit owner details.</Hint>}
          {r.vehicle_id
            ? <VehicleDetailFields v={r.vehicle} canEdit={canEdit} onPatch={onPatchVehicle} />
            : <Hint>Pick a vehicle above to edit vehicle details.</Hint>}
        </div>
      )}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{children}</div>
}
function SubHead({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, borderBottom: `1px solid ${T.border}`, paddingBottom: 5 }}>{children}</div>
}
function FL({ label, children, span }: { label: string; children: React.ReactNode; span?: number }) {
  return <div style={{ gridColumn: span ? `span ${span}` : undefined, minWidth: 0 }}><div style={{ fontSize: 10, color: T.text3, fontWeight: 600, marginBottom: 3 }}>{label}</div>{children}</div>
}

function PInput({ value, disabled, onSave, type = 'text', placeholder }: { value: any; disabled?: boolean; onSave: (v: any) => void; type?: string; placeholder?: string }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  return <input type={type} value={v} disabled={disabled} placeholder={placeholder} inputMode={type === 'number' ? 'decimal' : undefined}
    onChange={e => setV(e.target.value)}
    onBlur={() => { const nv = v === '' ? null : (type === 'number' ? (Number(v) || null) : v); if (nv !== (value ?? null)) onSave(nv) }}
    style={inp} />
}
function PArea({ value, disabled, onSave, placeholder }: { value: any; disabled?: boolean; onSave: (v: any) => void; placeholder?: string }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  return <textarea value={v} disabled={disabled} placeholder={placeholder} rows={2} onChange={e => setV(e.target.value)} onBlur={() => { const nv = v === '' ? null : v; if ((nv ?? '') !== (value ?? '')) onSave(nv) }} style={{ ...inp, resize: 'vertical' }} />
}
function PSelect({ value, disabled, onSave, options, placeholder }: { value: any; disabled?: boolean; onSave: (v: any) => void; options: Array<{ value: string; label: string }>; placeholder?: string }) {
  return <select value={value || ''} disabled={disabled} onChange={e => onSave(e.target.value || null)} style={inp}>
    <option value="">{placeholder || '—'}</option>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
}
function Chips({ value, disabled, onSave, placeholder, color }: { value: string[] | null; disabled?: boolean; onSave: (v: string[]) => void; placeholder?: string; color?: string }) {
  const tags = Array.isArray(value) ? value : []
  const [draft, setDraft] = useState('')
  function add() { const t = draft.trim(); if (!t || tags.includes(t)) { setDraft(''); return } onSave([...tags, t]); setDraft('') }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', ...inp, height: 'auto', minHeight: 30, padding: 5 }}>
      {tags.map(t => <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: `${color || T.accent}22`, color: T.text, borderRadius: 4, padding: '2px 6px', fontSize: 11 }}>{t}{!disabled && <span onClick={() => onSave(tags.filter(x => x !== t))} style={{ cursor: 'pointer', color: T.text3 }}>×</span>}</span>)}
      {!disabled && <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }} onBlur={add} placeholder={tags.length ? '' : (placeholder || 'Add…')} style={{ flex: 1, minWidth: 60, border: 'none', outline: 'none', background: 'transparent', color: T.text, fontSize: 12, fontFamily: 'inherit' }} />}
    </div>
  )
}
function JobTypesMulti({ value, disabled, jobTypes, onSave }: { value: string[] | null; disabled?: boolean; jobTypes: any[]; onSave: (v: string[]) => void }) {
  const sel = Array.isArray(value) ? value : []
  const active = (jobTypes || []).filter(t => t.active !== false)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', ...inp, height: 'auto', minHeight: 30, padding: 5 }}>
      {sel.map(n => <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: `${T.teal}22`, color: T.text, borderRadius: 4, padding: '2px 6px', fontSize: 11 }}>{n}{!disabled && <span onClick={() => onSave(sel.filter(x => x !== n))} style={{ cursor: 'pointer', color: T.text3 }}>×</span>}</span>)}
      {!disabled && (
        <select value="" onChange={e => { const n = e.target.value; if (n && !sel.includes(n)) onSave([...sel, n]) }} style={{ flex: 1, minWidth: 90, border: 'none', outline: 'none', background: 'transparent', color: T.text3, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>
          <option value="">+ Add job type…</option>
          {active.filter(t => !sel.includes(t.name)).map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
        </select>
      )}
    </div>
  )
}

// Self-contained customer search for the "Invoice to 3rd party" field.
function ThirdPartyPicker({ value, disabled, onPick }: { value: { id: string; name: string } | null; disabled?: boolean; onPick: (v: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<Array<{ id: string; name: string; mobile?: string; phone?: string }>>([])
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || value) return
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/workshop/customers?q=${encodeURIComponent(q)}`); const d = await r.json(); setResults(d.customers || []) } catch { /* ignore */ }
    }, 150)
    return () => clearTimeout(t)
  }, [q, open, value])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  if (value) {
    return <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ flex: 1, ...inp }}>{value.name}</div>
      {!disabled && <button onClick={() => onPick(null)} style={{ ...inp, width: 'auto', cursor: 'pointer', color: T.blue }}>Clear</button>}
    </div>
  }
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input value={q} disabled={disabled} onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }} placeholder="Search a customer to bill instead…" style={inp} />
      {open && !disabled && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginTop: 2, maxHeight: 200, overflowY: 'auto' }}>
          {results.length === 0 && <div style={{ padding: '7px 10px', fontSize: 11, color: T.text3 }}>No matches.</div>}
          {results.map(c => <div key={c.id} onMouseDown={() => { onPick({ id: c.id, name: c.name }); setOpen(false) }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>{c.name}{(c.mobile || c.phone) ? <span style={{ color: T.text3 }}> · {c.mobile || c.phone}</span> : null}</div>)}
        </div>
      )}
    </div>
  )
}

function DetailSummary({ r }: { r: any }) {
  const bits: string[] = []
  if (r.order_number) bits.push(`PO ${r.order_number}`)
  if (Array.isArray(r.job_types) && r.job_types.length) bits.push(`${r.job_types.length} job type${r.job_types.length === 1 ? '' : 's'}`)
  if (r.due_date) bits.push(`due ${r.due_date}`)
  if (Array.isArray(r.tags) && r.tags.length) bits.push(r.tags.join(', '))
  if (!bits.length) return null
  return <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text3, fontWeight: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>{bits.join(' · ')}</span>
}

function RecordDetailFields({ kind, r, canEdit, staff, jobTypes, onPatch }: { kind: 'quote' | 'booking'; r: any; canEdit: boolean; staff: StaffLite[]; jobTypes: any[]; onPatch: (p: any) => void }) {
  const staffOpts = staff.map(s => ({ value: s.id, label: s.display_name || s.email }))
  return (
    <div>
      <SubHead>{kind === 'quote' ? 'Quote details' : 'Job details'}</SubHead>
      <div style={fieldGrid}>
        {kind === 'quote' && <FL label="Type"><PSelect value={r.quote_type || 'quote'} disabled={!canEdit} onSave={v => onPatch({ quote_type: v })} options={[{ value: 'quote', label: 'Quote' }, { value: 'estimate', label: 'Estimate' }]} /></FL>}
        <FL label="Order number"><PInput value={r.order_number} disabled={!canEdit} onSave={v => onPatch({ order_number: v })} placeholder="Customer PO" /></FL>
        {kind === 'quote' && <FL label="Issue date"><PInput type="date" value={r.issue_date} disabled={!canEdit} onSave={v => onPatch({ issue_date: v })} /></FL>}
        {kind === 'quote' && <FL label="Due date"><PInput type="date" value={r.due_date} disabled={!canEdit} onSave={v => onPatch({ due_date: v })} /></FL>}
        <FL label="Assessed by"><PSelect value={r.assessed_by} disabled={!canEdit} onSave={v => onPatch({ assessed_by: v })} options={staffOpts} placeholder="—" /></FL>
        <FL label="Estimated by"><PSelect value={r.estimated_by} disabled={!canEdit} onSave={v => onPatch({ estimated_by: v })} options={staffOpts} placeholder="—" /></FL>
        <FL label="Estimated work hours"><PInput type="number" value={r.estimated_hours} disabled={!canEdit} onSave={v => onPatch({ estimated_hours: v })} /></FL>
        <FL label="Odometer"><PInput type="number" value={r.odometer} disabled={!canEdit} onSave={v => onPatch({ odometer: v })} /></FL>
        <FL label="Driver name"><PInput value={r.driver_name} disabled={!canEdit} onSave={v => onPatch({ driver_name: v })} /></FL>
        <FL label="Driver phone"><PInput value={r.driver_phone} disabled={!canEdit} onSave={v => onPatch({ driver_phone: v })} /></FL>
        <FL label="Job types" span={2}><JobTypesMulti value={r.job_types} disabled={!canEdit} jobTypes={jobTypes} onSave={v => onPatch({ job_types: v })} /></FL>
        <FL label="Invoice to 3rd party" span={2}><ThirdPartyPicker value={r.third_party_customer || null} disabled={!canEdit} onPick={v => onPatch({ third_party_customer_id: v?.id || null })} /></FL>
        <FL label="Tags" span={2}><Chips value={r.tags} disabled={!canEdit} onSave={v => onPatch({ tags: v })} placeholder="Add tag…" /></FL>
        {kind === 'quote' && <FL label="Short description" span={4}><PArea value={r.short_description} disabled={!canEdit} onSave={v => onPatch({ short_description: v })} placeholder="One-line summary" /></FL>}
      </div>
    </div>
  )
}

function OwnerDetailFields({ c, canEdit, onPatch }: { c: any; canEdit: boolean; onPatch: (p: any) => void }) {
  const isCompany = c?.customer_type === 'company'
  return (
    <div>
      <SubHead>Owner details</SubHead>
      <div style={fieldGrid}>
        <FL label="Name" span={2}><PInput value={c?.name} disabled={!canEdit} onSave={v => onPatch({ name: v })} /></FL>
        <FL label="Type"><PSelect value={c?.customer_type || 'individual'} disabled={!canEdit} onSave={v => onPatch({ customer_type: v })} options={[{ value: 'individual', label: 'Individual' }, { value: 'company', label: 'Company' }]} /></FL>
        {isCompany && <FL label="Company name"><PInput value={c?.company} disabled={!canEdit} onSave={v => onPatch({ company: v })} /></FL>}
        <FL label="Mobile"><PInput value={c?.mobile} disabled={!canEdit} onSave={v => onPatch({ mobile: v })} /></FL>
        <FL label="Phone"><PInput value={c?.phone} disabled={!canEdit} onSave={v => onPatch({ phone: v })} /></FL>
        <FL label="Email" span={2}><PInput value={c?.email} disabled={!canEdit} onSave={v => onPatch({ email: v })} /></FL>
        <FL label="Source of business"><PInput value={c?.source_of_business} disabled={!canEdit} onSave={v => onPatch({ source_of_business: v })} placeholder="e.g. Google, referral" /></FL>
        <FL label="Street address" span={2}><PInput value={c?.address} disabled={!canEdit} onSave={v => onPatch({ address: v })} /></FL>
        <FL label="Suburb"><PInput value={c?.address_suburb} disabled={!canEdit} onSave={v => onPatch({ address_suburb: v })} /></FL>
        <FL label="State"><PInput value={c?.address_state} disabled={!canEdit} onSave={v => onPatch({ address_state: v })} placeholder="QLD" /></FL>
        <FL label="Postcode"><PInput value={c?.address_postcode} disabled={!canEdit} onSave={v => onPatch({ address_postcode: v })} /></FL>
      </div>
    </div>
  )
}

function VehicleDetailFields({ v, canEdit, onPatch }: { v: any; canEdit: boolean; onPatch: (p: any) => void }) {
  return (
    <div>
      <SubHead>Vehicle details</SubHead>
      <div style={fieldGrid}>
        <FL label="Registration"><PInput value={v?.rego} disabled={!canEdit} onSave={x => onPatch({ rego: x })} /></FL>
        <FL label="Rego state"><PInput value={v?.rego_state} disabled={!canEdit} onSave={x => onPatch({ rego_state: x })} placeholder="QLD" /></FL>
        <FL label="Make"><PInput value={v?.make} disabled={!canEdit} onSave={x => onPatch({ make: x })} /></FL>
        <FL label="Series"><PInput value={v?.series} disabled={!canEdit} onSave={x => onPatch({ series: x })} /></FL>
        <FL label="Model"><PInput value={v?.model} disabled={!canEdit} onSave={x => onPatch({ model: x })} /></FL>
        <FL label="Year"><PInput type="number" value={v?.year} disabled={!canEdit} onSave={x => onPatch({ year: x })} /></FL>
        <FL label="Model code"><PInput value={v?.model_code} disabled={!canEdit} onSave={x => onPatch({ model_code: x })} /></FL>
        <FL label="VIN" span={2}><PInput value={v?.vin} disabled={!canEdit} onSave={x => onPatch({ vin: x })} /></FL>
        <FL label="Colour"><PInput value={v?.colour} disabled={!canEdit} onSave={x => onPatch({ colour: x })} /></FL>
        <FL label="Engine"><PInput value={v?.engine} disabled={!canEdit} onSave={x => onPatch({ engine: x })} /></FL>
        <FL label="Transmission"><PInput value={v?.transmission} disabled={!canEdit} onSave={x => onPatch({ transmission: x })} /></FL>
      </div>
    </div>
  )
}
