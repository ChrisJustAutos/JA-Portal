// pages/workshop/quote/[id].tsx
// Quote Builder — pick customer + vehicle, add line items (labour/parts with an
// inventory picker), set status, and convert an accepted quote into a diary job.
// Reads/writes via /api/workshop/* (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { QUOTE_STATUS_META, QUOTE_STATUSES, QuoteStatus, vehicleLabel, customerLabel } from '../../../lib/workshop'
import { T } from '../../../lib/ui/theme'
import { money2 as money } from '../../../lib/ui/format'
import { useConfirm } from '../../../components/ui/Feedback'
import SendEmailModal from '../../../components/workshop/SendEmailModal'
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { ...inp, padding: '5px 7px', borderRadius: 4 }
function qbtn(color: string): React.CSSProperties {
  return { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color, border: `1px solid ${color}55`, cursor: 'pointer' }
}
const addBtn: React.CSSProperties = { padding: '5px 11px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, cursor: 'pointer' }

interface QuoteLine { id: string; line_type?: string | null; description: string | null; part_number: string | null; qty: number; unit_price: number; inventory_id?: string | null; sort_order: number }
const mvBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 13, padding: '0 3px', lineHeight: 1 }

export default function QuoteBuilderPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<{ quote: any; lines: QuoteLine[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [staff, setStaff] = useState<Array<{ id: string; display_name: string | null; email: string }>>([])
  useEffect(() => { fetch('/api/workshop/users-lite').then(r => r.json()).then(d => setStaff(d.users || [])).catch(() => undefined) }, [])
  const confirmDialog = useConfirm()
  // Job-type presets — fills quote lines from a template (description + items).
  const [jobTypes, setJobTypes] = useState<any[]>([])
  const [applyingJt, setApplyingJt] = useState(false)
  useEffect(() => {
    fetch('/api/workshop/job-types').then(r => r.json())
      .then(d => setJobTypes(d.jobTypes || []))
      .catch(() => undefined)
  }, [])
  async function applyJobType(jobTypeId: string) {
    if (!jobTypeId || !id) return
    setApplyingJt(true)
    try {
      const r = await fetch(`/api/workshop/job-types/${jobTypeId}/apply-to-quote`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quote_id: id }),
      })
      if (!r.ok) { setErr((await r.json()).error || 'Apply failed'); return }
      await load()
    } finally { setApplyingJt(false) }
  }

  // ── Line selection + drag-reorder (mirrors the job card) ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const dragIdxRef = useRef<number | null>(null)
  const overIdxRef = useRef<number | null>(null)
  const setDrag = (i: number | null) => { dragIdxRef.current = i; setDragIdx(i) }
  const setOver = (i: number | null) => { overIdxRef.current = i; setOverIdx(i) }

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
  async function patchCustomer(patch: any) {
    const cid = data?.quote?.customer_id
    if (!cid) return
    const r = await fetch(`/api/workshop/customers?id=${encodeURIComponent(cid)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!r.ok) { setErr((await r.json()).error || 'Save failed'); return }
    await load()
  }
  async function patchVehicle(patch: any) {
    const vid = data?.quote?.vehicle_id
    if (!vid) return
    const r = await fetch(`/api/workshop/vehicles?id=${encodeURIComponent(vid)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
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
  const qlines = data?.lines || []
  function moveLine(idx: number, dir: -1 | 1) { reorderLines(idx, idx + dir) }
  // A job-type heading + every line beneath it until the next heading.
  function sectionIds(startIdx: number): string[] {
    const ids = [qlines[startIdx].id]
    for (let i = startIdx + 1; i < qlines.length; i++) {
      if (qlines[i].line_type === 'description') break
      ids.push(qlines[i].id)
    }
    return ids
  }
  function toggleSelect(index: number) {
    const line = qlines[index]
    if (!line) return
    const ids = line.line_type === 'description' ? sectionIds(index) : [line.id]
    setSelected(prev => {
      const next = new Set(prev)
      const allOn = ids.every(id => next.has(id))
      for (const id of ids) { if (allOn) next.delete(id); else next.add(id) }
      return next
    })
  }
  function toggleSelectAll() {
    setSelected(prev => prev.size === qlines.length && qlines.length > 0 ? new Set() : new Set(qlines.map(l => l.id)))
  }
  async function deleteSelected() {
    const ids = qlines.filter(l => selected.has(l.id)).map(l => l.id)
    if (!ids.length) return
    const headings = qlines.filter(l => selected.has(l.id) && l.line_type === 'description').length
    if (!(await confirmDialog({ title: `Delete ${ids.length} line${ids.length === 1 ? '' : 's'}?`, message: headings ? 'This includes job-type heading(s) and their items.' : undefined, confirmLabel: 'Delete', danger: true }))) return
    const idset = new Set(ids)
    setData(d => d ? { ...d, lines: d.lines.filter(l => !idset.has(l.id)) } : d)  // optimistic
    setSelected(new Set())
    await Promise.all(ids.map(lid => fetch(`/api/workshop/quote-lines?id=${encodeURIComponent(lid)}`, { method: 'DELETE' })))
    await load()
  }
  async function moveSelected(dir: -1 | 1) {
    const arr = [...qlines]
    if (dir === -1) { for (let i = 1; i < arr.length; i++) if (selected.has(arr[i].id) && !selected.has(arr[i - 1].id)) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]] }
    else { for (let i = arr.length - 2; i >= 0; i--) if (selected.has(arr[i].id) && !selected.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]] }
    setData(d => d ? { ...d, lines: arr.map((l, i) => ({ ...l, sort_order: i })) } : d)
    await Promise.all(arr.map((l, i) => Number(l.sort_order) !== i
      ? fetch(`/api/workshop/quote-lines?id=${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: i }) })
      : null))
    await load()
  }
  function dropLine() {
    const from = dragIdxRef.current, to = overIdxRef.current
    setDrag(null); setOver(null)
    if (from !== null && to !== null) reorderLines(from, to)
  }
  async function reorderLines(from: number, to: number) {
    if (from == null || to == null || from === to) return
    const arr = [...qlines]
    if (to < 0 || to >= arr.length || from < 0 || from >= arr.length) return
    const [moved] = arr.splice(from, 1)
    arr.splice(to, 0, moved)
    setData(d => d ? { ...d, lines: arr.map((l, i) => ({ ...l, sort_order: i })) } : d)  // optimistic
    await Promise.all(arr.map((l, i) => Number(l.sort_order) !== i
      ? fetch(`/api/workshop/quote-lines?id=${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: i }) })
      : null))
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
    if (!(await confirmDialog({ title: 'Delete this quote?', danger: true }))) return
    await fetch(`/api/workshop/quotes/${id}`, { method: 'DELETE' })
    router.push('/workshop/quotes')
  }
  function openPdf() { window.open(`/api/workshop/document?type=quote&id=${encodeURIComponent(id)}`, '_blank') }

  const q = data?.quote
  const lines = data?.lines || []
  // Per-section subtotal: a heading + its items until the next heading.
  function sectionTotalAt(start: number): number {
    let s = 0
    for (let j = start + 1; j < lines.length; j++) {
      if (lines[j].line_type === 'description') break
      s += (Number(lines[j].qty) || 0) * (Number(lines[j].unit_price) || 0)
    }
    return Math.round(s * 100) / 100
  }

  return (
    <>
      <Head><title>Quote — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="quotes" role={user.role} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 20 }}>
          <div style={{ margin: '0 auto' }}>
            <Link href="/workshop/quotes" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to quotes</Link>

            {loading ? <div style={{ textAlign: 'center', color: T.text3, padding: 60 }}>Loading…</div>
            : err && !q ? <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: 14, color: T.red, fontSize: 13, marginTop: 16 }}>{err}</div>
            : q ? (
              <>
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600 }}>Quote{q.quote_seq ? ` #Q-${q.quote_seq}` : ''}</div>
                      <div style={{ fontSize: 11, color: T.text3, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        Salesperson:
                        {canEdit ? (
                          <select value={q.salesperson_id || ''} onChange={e => patchQuote({ salesperson_id: e.target.value || null })} style={{ ...inp, width: 'auto', padding: '3px 6px', fontSize: 11 }}>
                            <option value="">— Unassigned —</option>
                            {staff.map(s => <option key={s.id} value={s.id}>{s.display_name || s.email}</option>)}
                          </select>
                        ) : <span style={{ color: T.text2 }}>{q.salesperson_name || '—'}</span>}
                      </div>
                    </div>
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

                {/* More fields — MechanicDesk-parity quote / owner / vehicle detail */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, marginTop: 16, overflow: 'hidden' }}>
                  <button onClick={() => setMoreOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', background: 'transparent', border: 'none', color: T.text, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>
                    <span style={{ color: T.text3, transform: moreOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                    More fields
                    <span style={{ fontSize: 11, color: T.text3, fontWeight: 400 }}>— quote details, owner, vehicle</span>
                    {!moreOpen && <DetailSummary q={q} />}
                  </button>
                  {moreOpen && (
                    <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                      <QuoteDetailFields q={q} canEdit={canEdit} staff={staff} jobTypes={jobTypes} onPatch={patchQuote} />
                      {q.customer_id
                        ? <OwnerDetailFields c={q.customer} canEdit={canEdit} onPatch={patchCustomer} />
                        : <Hint>Pick a customer above to edit owner details.</Hint>}
                      {q.vehicle_id
                        ? <VehicleDetailFields v={q.vehicle} canEdit={canEdit} onPatch={patchVehicle} />
                        : <Hint>Pick a vehicle above to edit vehicle details.</Hint>}
                    </div>
                  )}
                </div>

                {/* Lines — same layout + selection as the job-card invoice */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden', marginTop: 16 }}>
                  {canEdit && selected.size > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: `${T.accent}14`, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{selected.size} selected</span>
                      <span style={{ flex: 1 }} />
                      <button onClick={() => moveSelected(-1)} style={qbtn(T.text2)}>↑ Move up</button>
                      <button onClick={() => moveSelected(1)} style={qbtn(T.text2)}>↓ Move down</button>
                      <button onClick={deleteSelected} style={qbtn(T.red)}>🗑 Delete selected</button>
                      <button onClick={() => setSelected(new Set())} style={qbtn(T.text3)}>Clear</button>
                    </div>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 60px 90px 90px 84px', gap: 8, padding: '8px 14px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', alignItems: 'center' }}>
                    {canEdit ? <input type="checkbox" title="Select all" checked={lines.length > 0 && selected.size === lines.length} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} /> : <div />}
                    <div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit</div><div style={{ textAlign: 'right' }}>Total</div><div/>
                  </div>
                  {lines.length === 0 && <div style={{ padding: 18, textAlign: 'center', fontSize: 12, color: T.text3 }}>No lines yet.</div>}
                  {lines.map((l, i) => (
                    <LineRow key={l.id} line={l} canEdit={canEdit} index={i}
                      sectionTotal={l.line_type === 'description' ? sectionTotalAt(i) : undefined}
                      selected={selected.has(l.id)} onToggleSelect={() => toggleSelect(i)}
                      onPatch={(p) => patchLine(l.id, p)} onDelete={() => deleteLine(l.id)} onMove={(dir) => moveLine(i, dir)}
                      dragOver={overIdx === i && dragIdx !== null && dragIdx !== i}
                      onGrab={() => setDrag(i)} onHover={(idx) => setOver(idx)} onDropLine={dropLine} onCancel={() => { setDrag(null); setOver(null) }} />
                  ))}
                  {canEdit && (
                    <div style={{ padding: 12, borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <JobTypePicker jobTypes={jobTypes} busy={applyingJt} onPick={(jt) => applyJobType(jt.id)} />
                      <button onClick={() => addLine({ line_type: 'item', description: 'Labour', qty: 1, unit_price: 0 })} style={addBtn}>+ Line</button>
                      <button onClick={() => addLine({ line_type: 'description', description: '', qty: 0, unit_price: 0 })} title="A text-only heading row — describe the job, then move the items that belong to it underneath" style={addBtn}>+ Description</button>
                      <PartPicker onPick={(it) => addLine({ line_type: 'item', description: it.part_name, part_number: it.sku, qty: 1, unit_price: Number(it.sell_price) || 0, inventory_id: it.id } as any)} />
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
                  {canEdit && <button onClick={() => setShowEmail(true)} style={qbtn(T.blue)}>✉ Email to customer</button>}
                  <div style={{ flex: 1 }} />
                  {canEdit && (
                    <button onClick={async () => {
                      if (!(await confirmDialog({ title: 'Move this quote to Trash?', message: 'You can restore it later from the trash view.', danger: true }))) return
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
      {showEmail && <SendEmailModal type="quote" id={id} onClose={() => setShowEmail(false)} />}
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

function LineRow({ line, canEdit, index, sectionTotal, selected, onToggleSelect, onPatch, onDelete, onMove, dragOver, onGrab, onHover, onDropLine, onCancel }: {
  line: QuoteLine; canEdit: boolean; index: number; sectionTotal?: number
  selected?: boolean; onToggleSelect?: () => void
  onPatch: (p: any) => void; onDelete: () => void; onMove: (dir: -1 | 1) => void
  dragOver?: boolean; onGrab?: () => void; onHover?: (idx: number) => void; onDropLine?: () => void; onCancel?: () => void
}) {
  const [desc, setDesc] = useState(line.description || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price))
  const [grabbing, setGrabbing] = useState(false)
  useEffect(() => { setDesc(line.description || ''); setQty(String(line.qty)); setPrice(String(line.unit_price)) }, [line.id, line.description, line.qty, line.unit_price])
  const total = (Number(line.qty) || 0) * (Number(line.unit_price) || 0)
  const isHeading = line.line_type === 'description'

  // Touch / pen reordering (HTML5 drag never fires on touch): track the finger,
  // find the row under it via elementFromPoint, drop on pointer-up.
  function gripPointerDown(e: React.PointerEvent) {
    if (!canEdit || e.pointerType === 'mouse') return
    e.preventDefault(); setGrabbing(true); onGrab?.()
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const row = el?.closest('[data-line-index]') as HTMLElement | null
      if (row) { const idx = Number(row.dataset.lineIndex); if (!Number.isNaN(idx)) onHover?.(idx) }
    }
    const end = (drop: boolean) => () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel)
      setGrabbing(false); drop ? onDropLine?.() : onCancel?.()
    }
    const up = end(true), cancel = end(false)
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel)
  }

  const controls = canEdit ? (
    <span style={{ display: 'flex', gap: 0, justifyContent: 'flex-end', alignItems: 'center' }}>
      <span draggable onMouseDown={() => setGrabbing(true)}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onGrab?.() }}
        onDragEnd={() => { setGrabbing(false); onCancel?.() }}
        onPointerDown={gripPointerDown}
        title="Drag to reorder" style={{ cursor: 'grab', color: T.text3, fontSize: 15, padding: '0 4px', lineHeight: 1, userSelect: 'none', touchAction: 'none' }}>⠿</span>
      <button onClick={() => onMove(-1)} title="Move up" style={mvBtn}>↑</button>
      <button onClick={() => onMove(1)} title="Move down" style={mvBtn}>↓</button>
      <button onClick={onDelete} title="Remove" style={{ ...mvBtn, fontSize: 15 }}>×</button>
    </span>
  ) : <span />
  const dragProps: any = { 'data-line-index': index }
  if (canEdit) {
    dragProps.onDragOver = (e: React.DragEvent) => { e.preventDefault(); onHover?.(index) }
    dragProps.onDrop = (e: React.DragEvent) => { e.preventDefault(); onDropLine?.() }
  }
  const dropEdge = dragOver ? { boxShadow: `inset 0 2px 0 0 ${T.accent}` } : {}
  const selBg = selected ? { background: `${T.accent}1a` } : {}
  const checkbox = canEdit
    ? <input type="checkbox" checked={!!selected} onChange={onToggleSelect} style={{ cursor: 'pointer' }} title={isHeading ? 'Select this job type + its items' : 'Select line'} />
    : <span />

  if (isHeading) {
    return (
      <div {...dragProps} style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 90px 84px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'start', background: T.bg3, ...selBg, ...dropEdge }}>
        <span style={{ paddingTop: 5 }}>{checkbox}</span>
        <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', paddingTop: 6 }}>Desc</span>
        <textarea value={desc} disabled={!canEdit} rows={2} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })}
          placeholder="Job description — the items below belong to it"
          style={{ ...cellInp, fontWeight: 600, lineHeight: 1.4, resize: 'vertical', minHeight: 36, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }} />
        <span title="This job type's subtotal" style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right', paddingTop: 6, fontWeight: 700 }}>{sectionTotal != null && sectionTotal > 0 ? money(sectionTotal) : ''}</span>
        {controls}
      </div>
    )
  }
  return (
    <div {...dragProps} style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 60px 90px 90px 84px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', opacity: grabbing ? 0.5 : 1, ...selBg, ...dropEdge }}>
      {checkbox}
      <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{line.part_number || line.inventory_id ? 'Part' : 'Item'}</span>
      <input value={desc} disabled={!canEdit} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })} placeholder={line.part_number || 'Description'} style={cellInp} />
      <input value={qty} disabled={!canEdit} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} disabled={!canEdit} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price) && onPatch({ unit_price: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <span style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right' }}>{money(total)}</span>
      {controls}
    </div>
  )
}

// Searchable job-type picker — picking one appends its description heading +
// template items to the quote (mirrors the job card).
function JobTypePicker({ jobTypes, busy, onPick }: { jobTypes: any[]; busy: boolean; onPick: (jt: any) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const active = jobTypes.filter(t => t.active !== false)
  const needle = q.trim().toLowerCase()
  const results = (needle ? active.filter(t => `${t.name || ''} ${t.code || ''}`.toLowerCase().includes(needle)) : active).slice(0, 60)
  if (!open) return <button onClick={() => setOpen(true)} disabled={busy} style={{ ...addBtn, color: T.teal }} title="Add a preset job — its description heading + items">{busy ? 'Adding job…' : '+ Job type'}</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search job types…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 220, padding: '6px 8px' }} />
      <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 320, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 260, overflowY: 'auto', zIndex: 10 }}>
        {results.length === 0 && <div style={{ padding: '10px 12px', fontSize: 11, color: T.text3 }}>{active.length === 0 ? 'No job types yet — create them in Settings → Workshop → Job types.' : 'No matches.'}</div>}
        {results.map(jt => {
          const lineCount = Array.isArray(jt.lines) ? jt.lines.length : 0
          return (
            <div key={jt.id} onMouseDown={() => { onPick(jt); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ color: T.text }}>{jt.name}{jt.code ? <span style={{ color: T.text3 }}> · {jt.code}</span> : null}</div>
              <div style={{ fontSize: 10, color: T.text3 }}>{lineCount} line{lineCount === 1 ? '' : 's'}</div>
            </div>
          )
        })}
      </div>
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
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || value) return
    const t = setTimeout(async () => {
      try {
        const url = kind === 'customer' ? `/api/workshop/customers?q=${encodeURIComponent(q)}` : `/api/workshop/vehicles?${customerId ? `customer_id=${customerId}` : `q=${encodeURIComponent(q)}`}`
        const r = await fetch(url); const d = await r.json()
        if (kind === 'customer') setResults((d.customers || []).map((c: any) => ({ id: c.id, label: customerLabel(c) + (c.mobile || c.phone ? ` · ${c.mobile || c.phone}` : '') })))
        else setResults((d.vehicles || []).map((v: any) => ({ id: v.id, label: vehicleLabel(v) })))
      } catch { /* ignore */ }
    }, 120)
    return () => clearTimeout(t)
  }, [q, open, kind, customerId, value])

  // Close the dropdown when clicking anywhere outside the picker.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

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
        <div ref={boxRef} style={{ position: 'relative' }}>
          <input value={q} disabled={disabled} onFocus={() => setOpen(true)}
            onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
            onChange={e => { setQ(e.target.value); setOpen(true) }}
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

// A <div>, NOT a <label> — labels re-dispatch clicks to their form control,
// which undid EntityPicker selections (see the matching comment in diary.tsx).
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: 'block' }}><div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>{children}</div>
}

// ── "More fields" helper UI (MechanicDesk-parity detail capture) ──────────
function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{children}</div>
}
function SubHead({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, borderBottom: `1px solid ${T.border}`, paddingBottom: 5 }}>{children}</div>
}
const fieldGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }
function FL({ label, children, span }: { label: string; children: React.ReactNode; span?: number }) {
  return <div style={{ gridColumn: span ? `span ${span}` : undefined, minWidth: 0 }}><div style={{ fontSize: 10, color: T.text3, fontWeight: 600, marginBottom: 3 }}>{label}</div>{children}</div>
}

// Text/number/date input that saves on blur only if the value changed.
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
// Free-form tag chips.
function Chips({ value, disabled, onSave, placeholder }: { value: string[] | null; disabled?: boolean; onSave: (v: string[]) => void; placeholder?: string }) {
  const tags = Array.isArray(value) ? value : []
  const [draft, setDraft] = useState('')
  function add() { const t = draft.trim(); if (!t || tags.includes(t)) { setDraft(''); return } onSave([...tags, t]); setDraft('') }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', ...inp, height: 'auto', minHeight: 30, padding: 5 }}>
      {tags.map(t => <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: `${T.accent}22`, color: T.text, borderRadius: 4, padding: '2px 6px', fontSize: 11 }}>{t}{!disabled && <span onClick={() => onSave(tags.filter(x => x !== t))} style={{ cursor: 'pointer', color: T.text3 }}>×</span>}</span>)}
      {!disabled && <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() } }} onBlur={add} placeholder={tags.length ? '' : (placeholder || 'Add…')} style={{ flex: 1, minWidth: 60, border: 'none', outline: 'none', background: 'transparent', color: T.text, fontSize: 12, fontFamily: 'inherit' }} />}
    </div>
  )
}
// Multi-select of job-type presets (stores their names).
function JobTypesMulti({ value, disabled, jobTypes, onSave }: { value: string[] | null; disabled?: boolean; jobTypes: any[]; onSave: (v: string[]) => void }) {
  const sel = Array.isArray(value) ? value : []
  const active = jobTypes.filter(t => t.active !== false)
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

function DetailSummary({ q }: { q: any }) {
  const bits: string[] = []
  if (q.order_number) bits.push(`PO ${q.order_number}`)
  if (Array.isArray(q.job_types) && q.job_types.length) bits.push(`${q.job_types.length} job type${q.job_types.length === 1 ? '' : 's'}`)
  if (q.due_date) bits.push(`due ${q.due_date}`)
  if (Array.isArray(q.tags) && q.tags.length) bits.push(q.tags.join(', '))
  if (!bits.length) return null
  return <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text3, fontWeight: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>{bits.join(' · ')}</span>
}

function QuoteDetailFields({ q, canEdit, staff, jobTypes, onPatch }: { q: any; canEdit: boolean; staff: Array<{ id: string; display_name: string | null; email: string }>; jobTypes: any[]; onPatch: (p: any) => void }) {
  const staffOpts = staff.map(s => ({ value: s.id, label: s.display_name || s.email }))
  return (
    <div>
      <SubHead>Quote details</SubHead>
      <div style={fieldGrid}>
        <FL label="Type"><PSelect value={q.quote_type || 'quote'} disabled={!canEdit} onSave={v => onPatch({ quote_type: v })} options={[{ value: 'quote', label: 'Quote' }, { value: 'estimate', label: 'Estimate' }]} /></FL>
        <FL label="Order number"><PInput value={q.order_number} disabled={!canEdit} onSave={v => onPatch({ order_number: v })} placeholder="Customer PO" /></FL>
        <FL label="Issue date"><PInput type="date" value={q.issue_date} disabled={!canEdit} onSave={v => onPatch({ issue_date: v })} /></FL>
        <FL label="Due date"><PInput type="date" value={q.due_date} disabled={!canEdit} onSave={v => onPatch({ due_date: v })} /></FL>
        <FL label="Assessed by"><PSelect value={q.assessed_by} disabled={!canEdit} onSave={v => onPatch({ assessed_by: v })} options={staffOpts} placeholder="—" /></FL>
        <FL label="Estimated by"><PSelect value={q.estimated_by} disabled={!canEdit} onSave={v => onPatch({ estimated_by: v })} options={staffOpts} placeholder="—" /></FL>
        <FL label="Estimated work hours"><PInput type="number" value={q.estimated_hours} disabled={!canEdit} onSave={v => onPatch({ estimated_hours: v })} /></FL>
        <FL label="Odometer"><PInput type="number" value={q.odometer} disabled={!canEdit} onSave={v => onPatch({ odometer: v })} /></FL>
        <FL label="Driver name"><PInput value={q.driver_name} disabled={!canEdit} onSave={v => onPatch({ driver_name: v })} /></FL>
        <FL label="Driver phone"><PInput value={q.driver_phone} disabled={!canEdit} onSave={v => onPatch({ driver_phone: v })} /></FL>
        <FL label="Job types" span={2}><JobTypesMulti value={q.job_types} disabled={!canEdit} jobTypes={jobTypes} onSave={v => onPatch({ job_types: v })} /></FL>
        <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <EntityPicker label="Invoice to 3rd party" kind="customer" disabled={!canEdit}
            value={q.third_party_customer ? { id: q.third_party_customer.id, label: q.third_party_customer.name } : null}
            onPick={v => onPatch({ third_party_customer_id: v?.id || null })} />
        </div>
        <FL label="Tags" span={2}><Chips value={q.tags} disabled={!canEdit} onSave={v => onPatch({ tags: v })} placeholder="Add tag…" /></FL>
        <FL label="Short description" span={4}><PArea value={q.short_description} disabled={!canEdit} onSave={v => onPatch({ short_description: v })} placeholder="One-line summary for the quote" /></FL>
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

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
