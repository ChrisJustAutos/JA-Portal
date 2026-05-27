// pages/workshop/job/[id].tsx
// Job Card — the billable heart of the workshop system (ported from the
// autodesk_pro prototype's job_card_screen). Opens a diary booking as a job:
// customer/vehicle header, status flow, line items (labour/parts with an
// inventory picker), live totals, and the vehicle's prior service history.
// Reads/writes via /api/workshop/* (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  BOOKING_STATUS_META, BOOKING_STATUSES, BookingStatus,
  JOB_TYPES, jobTypeLabel, vehicleLabel, customerLabel,
} from '../../../lib/workshop'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}

interface Line {
  id: string
  line_type: 'labour' | 'part' | 'sublet' | 'fee'
  description: string | null
  part_number: string | null
  qty: number
  unit_price_ex_gst: number
  gst_rate: number
  total_ex_gst: number | null
}
interface JobData {
  booking: any
  lines: Line[]
  history: any[]
}

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`
const LINE_TYPE_LABEL: Record<string, string> = { labour: 'Labour', part: 'Part', sublet: 'Sublet', fee: 'Fee' }

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function JobCardPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<JobData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [savingStatus, setSavingStatus] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/workshop/bookings/${id}`)
      if (!r.ok) { setErr((await r.json()).error || `HTTP ${r.status}`); setLoading(false); return }
      setData(await r.json()); setErr('')
    } catch (e: any) { setErr(e?.message || 'Failed to load') } finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function patchBooking(patch: any) {
    const r = await fetch(`/api/workshop/bookings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!r.ok) { const d = await r.json(); setErr(d.error || 'Save failed'); return false }
    return true
  }

  async function changeStatus(status: BookingStatus) {
    setSavingStatus(true)
    const patch: any = { status }
    if (status === 'invoiced' || status === 'paid') {
      patch.completed_at = data?.booking?.completed_at || new Date().toISOString()
      patch.total_ex_gst = totals.ex
      patch.total_inc_gst = totals.inc
    }
    if (await patchBooking(patch)) await load()
    setSavingStatus(false)
  }

  // ── Line mutations ──
  async function addLine(line: Partial<Line> & { line_type: Line['line_type'] }) {
    await fetch('/api/workshop/booking-lines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_id: id, sort_order: (data?.lines.length || 0), ...line }) })
    await load()
  }
  async function patchLine(lineId: string, patch: any) {
    await fetch(`/api/workshop/booking-lines?id=${encodeURIComponent(lineId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    await load()
  }
  async function deleteLine(lineId: string) {
    await fetch(`/api/workshop/booking-lines?id=${encodeURIComponent(lineId)}`, { method: 'DELETE' })
    await load()
  }

  const lines = data?.lines || []
  const totals = (() => {
    let ex = 0, gst = 0
    for (const l of lines) {
      const lineEx = (Number(l.total_ex_gst) ?? 0) || (Number(l.qty) * Number(l.unit_price_ex_gst))
      ex += lineEx
      gst += lineEx * (Number(l.gst_rate) || 0.10)
    }
    ex = Math.round(ex * 100) / 100; gst = Math.round(gst * 100) / 100
    return { ex, gst, inc: Math.round((ex + gst) * 100) / 100 }
  })()

  const b = data?.booking
  const cust = b?.customer
  const veh = b?.vehicle

  return (
    <>
      <Head><title>Job Card — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 20 }}>
          <div style={{ maxWidth: 1100, margin: '0 auto' }}>
            <Link href="/diary" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to diary</Link>

            {loading ? (
              <div style={{ textAlign: 'center', color: T.text3, padding: 60 }}>Loading job…</div>
            ) : err && !b ? (
              <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: 14, color: T.red, fontSize: 13, marginTop: 16 }}>{err}</div>
            ) : b ? (
              <>
                {/* Header */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 12, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 19, fontWeight: 600 }}>{veh ? vehicleLabel(veh) : 'No vehicle'}</div>
                    <div style={{ fontSize: 13, color: T.text2, marginTop: 3 }}>
                      {cust ? customerLabel(cust) : 'No customer'}{cust?.mobile || cust?.phone ? ` · ${cust.mobile || cust.phone}` : ''}
                    </div>
                    <div style={{ fontSize: 12, color: T.text3, marginTop: 6, fontFamily: 'monospace' }}>
                      {jobTypeLabel(b.job_type)} · {fmtDateTime(b.starts_at)}{b.technician_ext ? ` · Ext ${b.technician_ext}` : ''}
                    </div>
                    {b.description && <div style={{ fontSize: 13, color: T.text, marginTop: 8 }}>{b.description}</div>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <StatusPill status={b.status} />
                    {canEdit && (
                      <div style={{ marginTop: 8 }}>
                        <select value={b.status} disabled={savingStatus} onChange={e => changeStatus(e.target.value as BookingStatus)} style={inp}>
                          {BOOKING_STATUSES.map(s => <option key={s} value={s}>{BOOKING_STATUS_META[s].label}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                {/* Quick status actions */}
                {canEdit && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <button onClick={() => changeStatus('in_progress')} style={qbtn(T.amber)}>▶ Start job</button>
                    <button onClick={() => changeStatus('awaiting_parts')} style={qbtn(T.purple)}>⏸ Awaiting parts</button>
                    <button onClick={() => changeStatus('done')} style={qbtn(T.green)}>✓ Done</button>
                    <button onClick={() => changeStatus('invoiced')} style={qbtn(T.teal)}>🧾 Mark invoiced</button>
                    <button onClick={() => changeStatus('paid')} style={qbtn(T.green)}>$ Paid</button>
                  </div>
                )}
                {err && b && <div style={{ fontSize: 12, color: T.red, marginTop: 8 }}>{err}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, marginTop: 16, alignItems: 'start' }}>
                  {/* Line items */}
                  <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Line items</div>
                      <div style={{ fontSize: 11, color: T.text3 }}>{lines.length} lines</div>
                    </div>

                    {/* header row */}
                    <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 60px 90px 90px 28px', gap: 8, padding: '7px 14px', fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: T.bg3, borderBottom: `1px solid ${T.border}` }}>
                      <div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div style={{ textAlign: 'right' }}>Total ex</div><div/>
                    </div>

                    {lines.length === 0 && <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.text3 }}>No lines yet.</div>}
                    {lines.map(l => (
                      <LineRow key={l.id} line={l} canEdit={canEdit} onPatch={(p) => patchLine(l.id, p)} onDelete={() => deleteLine(l.id)} />
                    ))}

                    {canEdit && (
                      <div style={{ padding: 12, borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button onClick={() => addLine({ line_type: 'labour', description: 'Labour', qty: 1, unit_price_ex_gst: 0 })} style={addBtn}>+ Labour</button>
                        <button onClick={() => addLine({ line_type: 'fee', description: '', qty: 1, unit_price_ex_gst: 0 })} style={addBtn}>+ Fee</button>
                        <PartPicker onPick={(it) => addLine({ line_type: 'part', description: it.part_name, part_number: it.sku, qty: 1, unit_price_ex_gst: Number(it.sell_price) || 0, inventory_id: it.id } as any)} />
                      </div>
                    )}

                    {/* totals */}
                    <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.border2}`, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                      <Row label="Subtotal (ex GST)" value={money(totals.ex)} />
                      <Row label="GST" value={money(totals.gst)} />
                      <Row label="Total (inc GST)" value={money(totals.inc)} bold />
                    </div>
                  </div>

                  {/* Service history */}
                  <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, fontSize: 11, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      Service history{veh ? '' : ' — no vehicle'}
                    </div>
                    {(data?.history || []).length === 0 ? (
                      <div style={{ padding: 16, fontSize: 12, color: T.text3 }}>No prior completed jobs on this vehicle.</div>
                    ) : (
                      (data?.history || []).map((h: any) => (
                        <Link key={h.id} href={`/workshop/job/${h.id}`} style={{ display: 'block', padding: '10px 16px', borderTop: `1px solid ${T.border}`, textDecoration: 'none', color: 'inherit' }}>
                          <div style={{ fontSize: 12, color: T.text }}>{jobTypeLabel(h.job_type) || 'Job'}{h.total_inc_gst ? ` · ${money(h.total_inc_gst)}` : ''}</div>
                          <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', marginTop: 2 }}>{fmtDateTime(h.completed_at || h.starts_at)}{h.odometer ? ` · ${h.odometer.toLocaleString()} km` : ''}</div>
                          {h.summary && <div style={{ fontSize: 11, color: T.text2, marginTop: 3 }}>{h.summary}</div>}
                        </Link>
                      ))
                    )}
                  </div>
                </div>

                <div style={{ fontSize: 11, color: T.text3, marginTop: 14 }}>
                  MYOB invoice push reuses the existing invoicing rails — wired in the next pass. “Mark invoiced” saves the totals + completes the job so it shows in the vehicle’s history.
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 20, fontSize: bold ? 14 : 12, color: bold ? T.text : T.text2, fontWeight: bold ? 700 : 400 }}>
      <span>{label}</span><span style={{ fontFamily: 'monospace', minWidth: 90, textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function StatusPill({ status }: { status: BookingStatus }) {
  const m = BOOKING_STATUS_META[status] || { label: status, color: T.text3 }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 4, background: `${m.color}1e`, border: `1px solid ${m.color}55`, color: m.color, fontSize: 11, fontWeight: 700 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color }} />{m.label}
    </span>
  )
}

function LineRow({ line, canEdit, onPatch, onDelete }: { line: Line; canEdit: boolean; onPatch: (p: any) => void; onDelete: () => void }) {
  const [desc, setDesc] = useState(line.description || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price_ex_gst))
  useEffect(() => { setDesc(line.description || ''); setQty(String(line.qty)); setPrice(String(line.unit_price_ex_gst)) }, [line.id, line.description, line.qty, line.unit_price_ex_gst])
  const lineTotal = (Number(line.total_ex_gst) ?? 0) || (Number(line.qty) * Number(line.unit_price_ex_gst))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 60px 90px 90px 28px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{LINE_TYPE_LABEL[line.line_type] || line.line_type}</span>
      <input value={desc} disabled={!canEdit} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })}
        placeholder={line.part_number || 'Description'} style={cellInp} />
      <input value={qty} disabled={!canEdit} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} disabled={!canEdit} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price_ex_gst) && onPatch({ unit_price_ex_gst: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <span style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right' }}>{money(lineTotal)}</span>
      {canEdit ? <button onClick={onDelete} title="Remove" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 15 }}>×</button> : <span/>}
    </div>
  )
}

function PartPicker({ onPick }: { onPick: (item: any) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/workshop/inventory?q=${encodeURIComponent(q)}`); const d = await r.json(); setResults(d.items || []) } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [q, open])
  if (!open) return <button onClick={() => setOpen(true)} style={addBtn}>+ Part</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search parts…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 200, padding: '6px 8px' }} />
      {results.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 280, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 220, overflowY: 'auto', zIndex: 10 }}>
          {results.map(it => (
            <div key={it.id} onMouseDown={() => { onPick(it); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ color: T.text }}>{it.part_name}</div>
              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{it.sku || ''}{it.sell_price ? ` · ${money(it.sell_price)}` : ''}{it.available != null ? ` · ${it.available} avail` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const inp: React.CSSProperties = { padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { width: '100%', padding: '5px 7px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
function qbtn(color: string): React.CSSProperties {
  return { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color, border: `1px solid ${color}55`, cursor: 'pointer' }
}
const addBtn: React.CSSProperties = { padding: '5px 11px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, cursor: 'pointer' }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
