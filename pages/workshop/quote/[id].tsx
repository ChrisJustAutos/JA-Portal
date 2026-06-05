// pages/workshop/quote/[id].tsx
// Quote Builder — pick customer + vehicle, add line items (labour/parts with an
// inventory picker), set status, and convert an accepted quote into a diary job.
// Reads/writes via /api/workshop/* (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { QUOTE_STATUS_META, QUOTE_STATUSES, QuoteStatus, vehicleLabel, customerLabel } from '../../../lib/workshop'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { ...inp, padding: '5px 7px', borderRadius: 4 }
function qbtn(color: string): React.CSSProperties {
  return { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color, border: `1px solid ${color}55`, cursor: 'pointer' }
}
const addBtn: React.CSSProperties = { padding: '5px 11px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, cursor: 'pointer' }

interface QuoteLine { id: string; description: string | null; part_number: string | null; qty: number; unit_price: number; sort_order: number }

export default function QuoteBuilderPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<{ quote: any; lines: QuoteLine[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [emailMsg, setEmailMsg] = useState('')
  // Job-type presets — fills quote lines from a template.
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  const [applyJt, setApplyJt] = useState('')
  useEffect(() => {
    fetch('/api/workshop/job-types').then(r => r.json())
      .then(d => setPresets((d.jobTypes || []).filter((t: any) => t.active).map((t: any) => ({ id: t.id, name: t.name }))))
      .catch(() => undefined)
  }, [])
  async function applyJobType() {
    if (!applyJt || !id) return
    const r = await fetch(`/api/workshop/job-types/${applyJt}/apply-to-quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote_id: id }),
    })
    if (!r.ok) { setErr((await r.json()).error || 'Apply failed'); return }
    setApplyJt('')
    await load()
  }

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/workshop/quotes/${id}`)
      if (!r.ok) { setErr((await r.json()).error || `HTTP ${r.status}`); setLoading(false); return }
      setData(await r.json()); setErr('')
    } catch (e: any) { setErr(e?.message || 'Failed to load') } finally { setLoading(false) }
  }, [id])
  useEffect(() => { load() }, [load])

  async function patchQuote(patch: any) {
    const r = await fetch(`/api/workshop/quotes/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!r.ok) { setErr((await r.json()).error || 'Save failed'); return }
    await load()
  }
  async function addLine(line: Partial<QuoteLine>) {
    await fetch('/api/workshop/quote-lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quote_id: id, sort_order: data?.lines.length || 0, ...line }) })
    await load()
  }
  async function patchLine(lineId: string, patch: any) {
    await fetch(`/api/workshop/quote-lines?id=${encodeURIComponent(lineId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    await load()
  }
  async function deleteLine(lineId: string) {
    await fetch(`/api/workshop/quote-lines?id=${encodeURIComponent(lineId)}`, { method: 'DELETE' })
    await load()
  }
  async function convert() {
    setBusy(true)
    try {
      const r = await fetch(`/api/workshop/quotes/${id}/convert`, { method: 'POST' })
      const d = await r.json()
      if (r.ok && d.booking_id) { router.push(`/workshop/job/${d.booking_id}`); return }
      setErr(d.error || 'Convert failed'); setBusy(false)
    } catch (e: any) { setErr(e?.message || 'Convert failed'); setBusy(false) }
  }
  async function removeQuote() {
    if (!confirm('Delete this quote?')) return
    await fetch(`/api/workshop/quotes/${id}`, { method: 'DELETE' })
    router.push('/workshop/quotes')
  }
  function openPdf() { window.open(`/api/workshop/document?type=quote&id=${encodeURIComponent(id)}`, '_blank') }
  async function emailQuote() {
    setEmailing(true); setEmailMsg('')
    try {
      const r = await fetch('/api/workshop/document', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'quote', id }) })
      const d = await r.json()
      setEmailMsg(r.ok && d.ok ? `Emailed to ${d.to} ✓` : (d.message || d.error || 'Email failed'))
    } catch (e: any) { setEmailMsg(e?.message || 'Email failed') } finally { setEmailing(false) }
  }

  const q = data?.quote
  const lines = data?.lines || []

  return (
    <>
      <Head><title>Quote — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="workshop-quotes" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 20 }}>
          <div style={{ maxWidth: 1200, margin: '0 auto' }}>
            <Link href="/workshop/quotes" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to quotes</Link>

            {loading ? <div style={{ textAlign: 'center', color: T.text3, padding: 60 }}>Loading…</div>
            : err && !q ? <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: 14, color: T.red, fontSize: 13, marginTop: 16 }}>{err}</div>
            : q ? (
              <>
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>Quote</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <StatusPill status={q.status} />
                      {canEdit && (
                        <select value={q.status} onChange={e => patchQuote({ status: e.target.value })} style={{ ...inp, width: 'auto' }}>
                          {QUOTE_STATUSES.map(s => <option key={s} value={s}>{QUOTE_STATUS_META[s].label}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <EntityPicker label="Customer" kind="customer" disabled={!canEdit}
                      value={q.customer ? { id: q.customer.id, label: customerLabel(q.customer) } : null}
                      onPick={(v) => patchQuote({ customer_id: v?.id || null })} />
                    <EntityPicker label="Vehicle" kind="vehicle" customerId={q.customer_id || null} disabled={!canEdit}
                      value={q.vehicle ? { id: q.vehicle.id, label: vehicleLabel(q.vehicle) } : null}
                      onPick={(v) => patchQuote({ vehicle_id: v?.id || null })} />
                  </div>
                </div>

                {/* Lines */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', marginTop: 16 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 60px 90px 90px 28px', gap: 8, padding: '8px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    <div>Description</div><div>Part #</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit</div><div style={{ textAlign: 'right' }}>Total</div><div/>
                  </div>
                  {lines.length === 0 && <div style={{ padding: 18, textAlign: 'center', fontSize: 12, color: T.text3 }}>No lines yet.</div>}
                  {lines.map(l => <LineRow key={l.id} line={l} canEdit={canEdit} onPatch={(p) => patchLine(l.id, p)} onDelete={() => deleteLine(l.id)} />)}
                  {canEdit && (
                    <div style={{ padding: 12, borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button onClick={() => addLine({ description: 'Labour', qty: 1, unit_price: 0 })} style={addBtn}>+ Line</button>
                      <PartPicker onPick={(it) => addLine({ description: it.part_name, part_number: it.sku, qty: 1, unit_price: Number(it.sell_price) || 0, inventory_id: it.id } as any)} />
                      {presets.length > 0 && (
                        <>
                          <div style={{ flex: 1 }} />
                          <select value={applyJt} onChange={e => setApplyJt(e.target.value)} title="Apply a job-type preset — adds its lines + appends its work narrative to the notes" style={{ padding: '5px 9px', background: T.bg3, color: T.text, border: `1px solid ${T.border2}`, borderRadius: 5, fontSize: 11, fontFamily: 'inherit', maxWidth: 220 }}>
                            <option value="">Apply job type…</option>
                            {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <button onClick={applyJobType} disabled={!applyJt} style={addBtn}>Apply</button>
                        </>
                      )}
                    </div>
                  )}
                  <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.border2}`, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                    <Row label="Subtotal" value={money(q.subtotal)} />
                    <Row label="GST" value={money(q.gst)} />
                    <Row label="Total" value={money(q.total)} bold />
                  </div>
                </div>

                {/* Notes */}
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Notes</div>
                  <NotesField initial={q.notes || ''} disabled={!canEdit} onSave={(v) => patchQuote({ notes: v })} />
                </div>

                {/* Print / email / delete */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={openPdf} style={qbtn(T.text2)}>🖨 Print / PDF</button>
                  {canEdit && <button onClick={emailQuote} disabled={emailing} style={qbtn(T.blue)}>{emailing ? 'Sending…' : '✉ Email to customer'}</button>}
                  {emailMsg && <span style={{ fontSize: 11, color: T.text2 }}>{emailMsg}</span>}
                  <div style={{ flex: 1 }} />
                  {canEdit && (
                    <button onClick={async () => {
                      if (!confirm('Move this quote to Trash? You can restore it later from the trash view.')) return
                      const r = await fetch(`/api/workshop/quotes/${id}`, { method: 'DELETE' })
                      if (r.ok) router.push('/workshop/quotes')
                      else { const d = await r.json().catch(()=>({})); setErr(d.error || 'Delete failed') }
                    }} style={qbtn(T.red)}>🗑 Delete</button>
                  )}
                </div>

                {canEdit && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button onClick={() => patchQuote({ status: 'sent' })} style={qbtn(T.blue)}>Mark sent</button>
                    <button onClick={() => patchQuote({ status: 'accepted' })} style={qbtn(T.green)}>Accepted</button>
                    <button onClick={() => patchQuote({ status: 'declined' })} style={qbtn(T.red)}>Declined</button>
                    <div style={{ flex: 1 }} />
                    <button onClick={removeQuote} style={qbtn(T.text3)}>Delete</button>
                    <button onClick={convert} disabled={busy} style={{ ...qbtn(T.teal), background: `${T.teal}1e` }}>{busy ? 'Converting…' : 'Convert to job →'}</button>
                  </div>
                )}
                {err && q && <div style={{ fontSize: 12, color: T.red, marginTop: 8 }}>{err}</div>}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div style={{ display: 'flex', gap: 20, fontSize: bold ? 14 : 12, color: bold ? T.text : T.text2, fontWeight: bold ? 700 : 400 }}><span>{label}</span><span style={{ fontFamily: 'monospace', minWidth: 90, textAlign: 'right' }}>{value}</span></div>
}
function StatusPill({ status }: { status: QuoteStatus }) {
  const m = QUOTE_STATUS_META[status] || { label: status, color: T.text3 }
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 4, background: `${m.color}1e`, border: `1px solid ${m.color}55`, color: m.color, fontSize: 11, fontWeight: 700 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color }} />{m.label}</span>
}

function NotesField({ initial, disabled, onSave }: { initial: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial)
  useEffect(() => { setV(initial) }, [initial])
  return <textarea value={v} disabled={disabled} onChange={e => setV(e.target.value)} onBlur={() => v !== initial && onSave(v)} rows={2} style={{ ...inp, resize: 'vertical' }} placeholder="Quote notes / scope…" />
}

function LineRow({ line, canEdit, onPatch, onDelete }: { line: QuoteLine; canEdit: boolean; onPatch: (p: any) => void; onDelete: () => void }) {
  const [desc, setDesc] = useState(line.description || '')
  const [pn, setPn] = useState(line.part_number || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price))
  useEffect(() => { setDesc(line.description || ''); setPn(line.part_number || ''); setQty(String(line.qty)); setPrice(String(line.unit_price)) }, [line.id, line.description, line.part_number, line.qty, line.unit_price])
  const total = (Number(line.qty) || 0) * (Number(line.unit_price) || 0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 60px 90px 90px 28px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center' }}>
      <input value={desc} disabled={!canEdit} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })} placeholder="Description" style={cellInp} />
      <input value={pn} disabled={!canEdit} onChange={e => setPn(e.target.value)} onBlur={() => pn !== (line.part_number || '') && onPatch({ part_number: pn })} placeholder="—" style={cellInp} />
      <input value={qty} disabled={!canEdit} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} disabled={!canEdit} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price) && onPatch({ unit_price: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <span style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right' }}>{money(total)}</span>
      {canEdit ? <button onClick={onDelete} style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 15 }}>×</button> : <span/>}
    </div>
  )
}

function PartPicker({ onPick }: { onPick: (item: any) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => { try { const r = await fetch(`/api/workshop/inventory?q=${encodeURIComponent(q)}`); const d = await r.json(); setResults(d.items || []) } catch { /* */ } }, 250)
    return () => clearTimeout(t)
  }, [q, open])
  if (!open) return <button onClick={() => setOpen(true)} style={addBtn}>+ Part</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search parts…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 220 }} />
      {results.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 280, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 220, overflowY: 'auto', zIndex: 10 }}>
          {results.map(it => (
            <div key={it.id} onMouseDown={() => { onPick(it); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ color: T.text }}>{it.part_name}</div>
              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{it.sku || ''}{it.sell_price ? ` · ${money(it.sell_price)}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function EntityPicker({ label, kind, value, customerId, disabled, onPick }: {
  label: string; kind: 'customer' | 'vehicle'; value: { id: string; label: string } | null
  customerId?: string | null; disabled?: boolean; onPick: (v: { id: string; label: string } | null) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ id: string; label: string }[]>([])
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || value) return
    const t = setTimeout(async () => {
      try {
        const url = kind === 'customer' ? `/api/workshop/customers?q=${encodeURIComponent(q)}` : `/api/workshop/vehicles?${customerId ? `customer_id=${customerId}` : `q=${encodeURIComponent(q)}`}`
        const r = await fetch(url); const d = await r.json()
        if (kind === 'customer') setResults((d.customers || []).map((c: any) => ({ id: c.id, label: customerLabel(c) + (c.mobile || c.phone ? ` · ${c.mobile || c.phone}` : '') })))
        else setResults((d.vehicles || []).map((v: any) => ({ id: v.id, label: vehicleLabel(v) })))
      } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [q, open, kind, customerId, value])

  // Vehicle auto-populate: when a customer is chosen, pull their vehicles and
  // auto-select if there's exactly one; otherwise pre-load the list.
  useEffect(() => {
    if (kind !== 'vehicle' || !customerId || value) return
    let alive = true
    fetch(`/api/workshop/vehicles?customer_id=${customerId}`).then(r => r.json()).then(d => {
      if (!alive) return
      const vs = d.vehicles || []
      if (vs.length === 1) onPick({ id: vs[0].id, label: vehicleLabel(vs[0]) })
      else setResults(vs.map((v: any) => ({ id: v.id, label: vehicleLabel(v) })))
    }).catch(() => undefined)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, customerId, value])

  async function create() {
    setBusy(true)
    try {
      if (kind === 'customer') {
        const r = await fetch('/api/workshop/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
        const d = await r.json(); if (r.ok && d.customer) { onPick({ id: d.customer.id, label: d.customer.name }); reset() }
      } else {
        const r = await fetch('/api/workshop/vehicles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, customer_id: customerId || null }) })
        const d = await r.json(); if (r.ok && d.vehicle) { onPick({ id: d.vehicle.id, label: vehicleLabel(d.vehicle) }); reset() }
      }
    } finally { setBusy(false) }
  }
  function reset() { setAdding(false); setForm({}); setOpen(false); setQ('') }

  if (value) {
    return (
      <Field label={label}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1, ...inp }}>{value.label}</div>
          {!disabled && <button onClick={() => onPick(null)} style={{ ...addBtn }}>Change</button>}
        </div>
      </Field>
    )
  }
  return (
    <Field label={label}>
      {!adding ? (
        <div style={{ position: 'relative' }}>
          <input value={q} disabled={disabled} onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }}
            placeholder={kind === 'customer' ? 'Search name / phone…' : (customerId ? 'Pick or add vehicle' : 'Search rego / make…')} style={inp} />
          {open && !disabled && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginTop: 2, maxHeight: 200, overflowY: 'auto' }}>
              {results.map(r => <div key={r.id} onMouseDown={() => { onPick(r); setOpen(false) }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>{r.label}</div>)}
              <div onMouseDown={() => { setAdding(true); setOpen(false) }} style={{ padding: '7px 10px', fontSize: 12, color: T.blue, cursor: 'pointer', fontWeight: 600 }}>＋ New {kind}</div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6 }}>
          {kind === 'customer' ? (
            <>
              <input autoFocus placeholder="Name *" style={inp} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              <input placeholder="Mobile" style={inp} onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))} />
            </>
          ) : (
            <>
              <input autoFocus placeholder="Rego" style={inp} onChange={e => setForm(f => ({ ...f, rego: e.target.value }))} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px', gap: 6 }}>
                <input placeholder="Make" style={inp} onChange={e => setForm(f => ({ ...f, make: e.target.value }))} />
                <input placeholder="Model" style={inp} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
                <input placeholder="Year" style={inp} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
              </div>
            </>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={reset} style={addBtn}>Cancel</button>
            <button onClick={create} disabled={busy} style={{ ...addBtn, color: '#fff', background: T.accent, borderColor: T.accent }}>{busy ? 'Adding…' : 'Add'}</button>
          </div>
        </div>
      )}
    </Field>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block' }}><div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>{children}</label>
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
