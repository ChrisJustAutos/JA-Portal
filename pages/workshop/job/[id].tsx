// pages/workshop/job/[id].tsx
// Job Card — the billable heart of the workshop system (ported from the
// autodesk_pro prototype's job_card_screen). Opens a diary booking as a job:
// customer/vehicle header, status flow, line items (labour/parts with an
// inventory picker), live totals, and the vehicle's prior service history.
// Reads/writes via /api/workshop/* (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
import FilesPanel from '../../../components/workshop/FilesPanel'
import TimeClockPanel from '../../../components/workshop/TimeClockPanel'
import SendEmailModal from '../../../components/workshop/SendEmailModal'
import { requirePageAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  BOOKING_STATUS_META, BOOKING_STATUSES, BookingStatus,
  JOB_TYPES, jobTypeLabel, vehicleLabel, customerLabel, PAYMENT_TENDERS,
  ymdBrisbane,
} from '../../../lib/workshop'

import type { PortalUserSSR } from '../../../lib/authServer'
import { T } from '../../../lib/ui/theme'
import { useConfirm, useToast } from '../../../components/ui/Feedback'
import { renderTemplate } from '../../../lib/workshop-comm-templates'
import { money2 as money, fmtDateTime, fmtYmd as fmtDueDate } from '../../../lib/ui/format'

interface Line {
  id: string
  line_type: 'labour' | 'part' | 'sublet' | 'fee' | 'description'
  description: string | null
  part_number: string | null
  qty: number
  unit_price_ex_gst: number
  gst_rate: number
  total_ex_gst: number | null
  sort_order: number
}
interface JobData {
  booking: any
  lines: Line[]
  history: any[]
}

const LINE_TYPE_LABEL: Record<string, string> = { labour: 'Labour', part: 'Part', sublet: 'Sublet', fee: 'Fee', description: 'Desc' }

function addMonthsYmd(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00+10:00`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return ymdBrisbane(d)
}

export default function JobCardPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<JobData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [savingStatus, setSavingStatus] = useState(false)
  const isAdmin = roleHasPermission(user.role, 'admin:settings')
  const confirmDialog = useConfirm()
  const toast = useToast()
  const [inv, setInv] = useState<{ busy: boolean; msg: string; needAccount: boolean }>({ busy: false, msg: '', needAccount: false })
  const [acct, setAcct] = useState<{ candidates: any[]; sel: string; saving: boolean } | null>(null)
  const [sms, setSms] = useState<{ open: boolean; body: string; busy: boolean; msg: string }>({ open: false, body: '', busy: false, msg: '' })
  const [showEmail, setShowEmail] = useState(false)
  const [payments, setPayments] = useState<any[]>([])
  const [paidTotal, setPaidTotal] = useState(0)
  const [pay, setPay] = useState<{ open: boolean; amount: string; tender: string; note: string; busy: boolean; msg: string }>({ open: false, amount: '', tender: 'card', note: '', busy: false, msg: '' })
  const [creditNotes, setCreditNotes] = useState<any[]>([])
  const [credit, setCredit] = useState<{ open: boolean; mode: 'lines' | 'amount'; sel: Record<string, boolean>; qty: Record<string, string>; amount: string; reason: string; restock: boolean; refund: boolean; tender: string; busy: boolean; msg: string }>({ open: false, mode: 'lines', sel: {}, qty: {}, amount: '', reason: '', restock: false, refund: false, tender: 'card', busy: false, msg: '' })
  const [jobTypes, setJobTypes] = useState<any[]>([])
  const [applyingJt, setApplyingJt] = useState(false)
  const [tab, setTab] = useState<'invoice' | 'checklist' | 'notes' | 'files' | 'activity' | 'history'>('invoice')
  const [dueSet, setDueSet] = useState<{ open: boolean; service: string; km: string; rego: string; busy: boolean; msg: string }>({ open: false, service: '', km: '', rego: '', busy: false, msg: '' })
  const [internalNotes, setInternalNotes] = useState('')
  useEffect(() => { if (data?.booking) setInternalNotes(data.booking.internal_notes || '') }, [data?.booking?.id])
  // Work description — editable on the invoice tab; pushes to the MYOB invoice Comment.
  const [workDesc, setWorkDesc] = useState('')
  useEffect(() => { if (data?.booking) setWorkDesc(data.booking.description || '') }, [data?.booking?.id])
  // Drag-to-reorder line items (alongside the ↑/↓ buttons). Refs mirror the
  // state so the touch pointer-up handler (captured once at grab time) reads
  // the latest indices rather than a stale closure.
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const dragIdxRef = useRef<number | null>(null)
  const overIdxRef = useRef<number | null>(null)
  const setDrag = (i: number | null) => { dragIdxRef.current = i; setDragIdx(i) }
  const setOver = (i: number | null) => { overIdxRef.current = i; setOverIdx(i) }
  // Multi-select line items (bulk delete / move; ticking a job-type heading
  // grabs its whole section down to the next heading).
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/workshop/bookings/${id}`)
      if (!r.ok) { setErr((await r.json()).error || `HTTP ${r.status}`); setLoading(false); return }
      setData(await r.json()); setErr('')
    } catch (e: any) { setErr(e?.message || 'Failed to load') } finally { setLoading(false) }
  }, [id])

  const loadPayments = useCallback(async () => {
    if (!id) return
    try { const r = await fetch(`/api/workshop/payment?booking_id=${id}`); if (r.ok) { const d = await r.json(); setPayments(d.payments || []); setPaidTotal(Number(d.paid_total) || 0) } } catch { /* ignore */ }
    try { const r = await fetch(`/api/workshop/credit-notes?booking_id=${id}`); if (r.ok) setCreditNotes((await r.json()).creditNotes || []) } catch { /* ignore */ }
  }, [id])

  useEffect(() => { load(); loadPayments() }, [load, loadPayments])
  useEffect(() => { (async () => { try { const r = await fetch('/api/workshop/job-types'); if (r.ok) setJobTypes((await r.json()).jobTypes || []) } catch { /* */ } })() }, [])
  // Technicians — to show the lane name instead of its code (e.g. "Jye" not "jye-l2l6").
  const [techs, setTechs] = useState<any[]>([])
  useEffect(() => { (async () => { try { const r = await fetch('/api/workshop/technicians'); if (r.ok) setTechs((await r.json()).technicians || []) } catch { /* */ } })() }, [])
  const techName = (code: string | null | undefined) => { if (!code) return '—'; return techs.find((t: any) => t.code === code)?.name || code }

  async function applyJobType(jobTypeId: string) {
    setApplyingJt(true)
    await fetch(`/api/workshop/job-types/${jobTypeId}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_id: id }) })
    await load()
    setApplyingJt(false)
  }

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
    const ok = await patchBooking(patch)
    if (ok) { await load(); toast(`Marked “${BOOKING_STATUS_META[status]?.label || status}”`, 'success') }
    setSavingStatus(false)
    // On completion, prompt for the vehicle's next service / rego due dates
    // (drives the automated SMS reminders).
    const v = data?.booking?.vehicle
    if (ok && v && (status === 'done' || status === 'invoiced' || status === 'paid')) openDueSet(v)
  }

  // Finish job → mark done, then offer to push straight to MYOB when there
  // are billable lines and it isn't already finalised.
  async function finishJob() {
    await changeStatus('done')
    if (!data?.booking?.myob_invoice_uid && (data?.lines || []).some(l => l.line_type !== 'description')) {
      const ok = await confirmDialog({ title: 'Finalise to MYOB now?', message: 'Push this finished job to MYOB as an invoice and deduct part stock. You can also do it later with the Finalise button.', confirmLabel: 'Finalise' })
      if (ok) await createInvoice()
    }
  }

  function openDueSet(v: any) {
    setDueSet({
      open: true, busy: false, msg: '',
      service: v?.next_service_due_date || '',
      km: v?.next_service_due_km ? String(v.next_service_due_km) : '',
      rego: v?.rego_due_date || '',
    })
  }

  async function saveDueSet() {
    const v = data?.booking?.vehicle
    if (!v) return
    setDueSet(s => ({ ...s, busy: true, msg: '' }))
    const r = await fetch(`/api/workshop/vehicles?id=${v.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_service_due_date: dueSet.service || null, next_service_due_km: dueSet.km || null, rego_due_date: dueSet.rego || null }),
    })
    if (r.ok) { setDueSet(s => ({ ...s, open: false, busy: false })); await load() }
    else setDueSet(s => ({ ...s, busy: false, msg: 'Save failed' }))
  }

  async function submitCredit() {
    setCredit(s => ({ ...s, busy: true, msg: '' }))
    const lineIds = Object.keys(credit.sel).filter(k => credit.sel[k])
    const qtyOverrides: Record<string, number> = {}
    for (const lid of lineIds) { const v = Number(credit.qty[lid]); if (isFinite(v) && v > 0) qtyOverrides[lid] = v }
    const r = await fetch('/api/workshop/credit-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_id: id, kind: credit.mode,
        line_ids: lineIds, qty_overrides: qtyOverrides,
        amount: Number(credit.amount) || 0,
        reason: credit.reason, restock_parts: credit.restock,
        refund: credit.refund ? { tender: credit.tender } : null,
      }),
    })
    const d = await r.json()
    if (!r.ok) { setCredit(s => ({ ...s, busy: false, msg: d.error || 'Credit failed' })); return }
    setCredit(s => ({ ...s, open: false, busy: false, sel: {}, qty: {}, amount: '', reason: '', msg: d.myob_warning || `${d.cn_number} recorded` }))
    await load(); await loadPayments()
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
  // Swap a line with its neighbour, then renumber sort_order = array index for
  // any line that drifted (handles legacy duplicate sort_orders too).
  async function moveLine(idx: number, dir: -1 | 1) {
    await reorderLines(idx, idx + dir)
  }
  // ── Multi-select ──
  // A job-type heading + every line beneath it until the next heading.
  function sectionIds(startIdx: number): string[] {
    const ids = [lines[startIdx].id]
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].line_type === 'description') break
      ids.push(lines[i].id)
    }
    return ids
  }
  function toggleSelect(index: number) {
    const line = lines[index]
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
    setSelected(prev => prev.size === lines.length && lines.length > 0 ? new Set() : new Set(lines.map(l => l.id)))
  }
  async function deleteSelected() {
    const ids = lines.filter(l => selected.has(l.id)).map(l => l.id)
    if (!ids.length) return
    const headings = lines.filter(l => selected.has(l.id) && l.line_type === 'description').length
    if (!(await confirmDialog({
      title: `Delete ${ids.length} line${ids.length === 1 ? '' : 's'}?`,
      message: headings ? 'This includes job-type heading(s) and their items.' : undefined,
      confirmLabel: 'Delete', danger: true,
    }))) return
    const idset = new Set(ids)
    setData(d => d ? { ...d, lines: d.lines.filter(l => !idset.has(l.id)) } : d)  // optimistic
    setSelected(new Set())
    await Promise.all(ids.map(id => fetch(`/api/workshop/booking-lines?id=${encodeURIComponent(id)}`, { method: 'DELETE' })))
    await load()
  }
  // Shift every selected line one step, preserving relative order + gaps.
  async function moveSelected(dir: -1 | 1) {
    const arr = [...lines]
    if (dir === -1) {
      for (let i = 1; i < arr.length; i++) if (selected.has(arr[i].id) && !selected.has(arr[i - 1].id)) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]
    } else {
      for (let i = arr.length - 2; i >= 0; i--) if (selected.has(arr[i].id) && !selected.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
    }
    setData(d => d ? { ...d, lines: arr.map((l, i) => ({ ...l, sort_order: i })) } : d)  // optimistic
    await Promise.all(arr.map((l, i) => Number(l.sort_order) !== i
      ? fetch(`/api/workshop/booking-lines?id=${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: i }) })
      : null))
    await load()
  }

  // Commit the current drag (reads refs so the touch pointer-up sees fresh
  // indices) then clear it.
  function dropLine() {
    const from = dragIdxRef.current, to = overIdxRef.current
    setDrag(null); setOver(null)
    if (from !== null && to !== null) reorderLines(from, to)
  }
  // Move a line from one index to another (drag-drop and ↑/↓), renumbering
  // sort_order = array index. Optimistic so the row jumps immediately.
  async function reorderLines(from: number, to: number) {
    if (from == null || to == null || from === to) return
    const arr = [...lines]
    if (to < 0 || to >= arr.length || from < 0 || from >= arr.length) return
    const [moved] = arr.splice(from, 1)
    arr.splice(to, 0, moved)
    setData(d => d ? { ...d, lines: arr.map((l, i) => ({ ...l, sort_order: i })) } : d)  // optimistic
    await Promise.all(arr.map((l, i) => Number(l.sort_order) !== i
      ? fetch(`/api/workshop/booking-lines?id=${encodeURIComponent(l.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sort_order: i }) })
      : null))
    await load()
  }

  async function createInvoice() {
    setInv({ busy: true, msg: 'Sending to MYOB…', needAccount: false })
    try {
      const r = await fetch('/api/workshop/invoice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_id: id }) })
      const d = await r.json()
      if (r.ok && d.ok) {
        setInv({ busy: false, msg: `Finalised — MYOB${d.myob_number ? ` #${d.myob_number}` : ''} (${d.mode})${d.status === 'already_written' ? ' — already linked' : ''}${d.stock_warning ? ` · ${d.stock_warning}` : ''}`, needAccount: false })
        await load(); return
      }
      if (d.code === 'sales_account_not_set' && isAdmin) {
        setInv({ busy: false, msg: 'Pick the MYOB income account workshop sales post to:', needAccount: true })
        try { const ar = await fetch('/api/workshop/invoice'); const ad = await ar.json(); setAcct({ candidates: ad.candidates || [], sel: ad.settings?.myob_sales_account_uid || '', saving: false }) } catch { /* ignore */ }
        return
      }
      setInv({ busy: false, msg: d.error || 'Invoice failed', needAccount: false })
    } catch (e: any) { setInv({ busy: false, msg: e?.message || 'Invoice failed', needAccount: false }) }
  }

  async function saveAcct() {
    if (!acct?.sel) return
    setAcct({ ...acct, saving: true })
    const chosen = acct.candidates.find((a: any) => a.uid === acct.sel)
    await fetch('/api/workshop/invoice', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ myob_sales_account_uid: acct.sel, myob_sales_account_name: chosen?.name || null }) })
    setAcct(null)
    await createInvoice()
  }

  async function unfinalise() {
    const ok = await confirmDialog({
      title: 'Un-finalise this job?',
      message: 'This deletes the invoice in MYOB, puts the deducted parts back into stock, and returns the job to Done.',
      confirmLabel: 'Un-finalise', danger: true,
    })
    if (!ok) return
    setInv({ busy: true, msg: 'Un-finalising…', needAccount: false })
    try {
      const r = await fetch(`/api/workshop/invoice?booking_id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const d = await r.json()
      if (r.ok && d.ok) {
        setInv({ busy: false, msg: `Un-finalised ✓${d.restocked ? ` — ${d.restocked} part line${d.restocked === 1 ? '' : 's'} restocked` : ''}`, needAccount: false })
        await Promise.all([load(), loadPayments()])
      } else setInv({ busy: false, msg: d.error || 'Un-finalise failed', needAccount: false })
    } catch (e: any) { setInv({ busy: false, msg: e?.message || 'Un-finalise failed', needAccount: false }) }
  }

  async function deleteJob() {
    const ok = await confirmDialog({
      title: 'Delete this job?',
      message: 'Permanently removes the job and its line items, payments, photos and time entries. This can’t be undone.',
      confirmLabel: 'Delete job', danger: true,
    })
    if (!ok) return
    const r = await fetch(`/api/workshop/bookings/${id}`, { method: 'DELETE' })
    const d = await r.json().catch(() => ({}))
    if (r.ok && d.ok) { toast('Job deleted', 'success'); router.push('/workshop/jobs') }
    else toast(d.error || 'Delete failed', 'error')
  }

  async function openSms() {
    const bk = data?.booking
    const name = bk?.customer?.name ? String(bk.customer.name).split(' ')[0] : 'there'
    const v = bk?.vehicle ? vehicleLabel(bk.vehicle) : 'your vehicle'
    let body = `Hi ${name}, your ${v} is ready for collection at Just Autos.`
    // Prefill from the editable "Ready for collection" template if one exists.
    try {
      const r = await fetch('/api/workshop/comm-templates')
      if (r.ok) {
        const tmpls = (await r.json()).templates || []
        const t = tmpls.find((x: any) => x.trigger === 'ready' && x.channel === 'sms')
        if (t?.body) body = renderTemplate(t.body, { first_name: name, customer_name: bk?.customer?.name || '', vehicle: v, rego: bk?.vehicle?.rego || '', business_name: 'Just Autos' })
      }
    } catch { /* fall back to the default text */ }
    setSms({ open: true, body, busy: false, msg: '' })
  }
  async function sendSmsNow() {
    setSms(s => ({ ...s, busy: true, msg: '' }))
    try {
      const r = await fetch('/api/workshop/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer_id: data?.booking?.customer_id, booking_id: id, type: 'ready', body: sms.body }) })
      const d = await r.json()
      if (r.ok && d.ok) setSms(s => ({ ...s, busy: false, open: false, msg: 'Text sent ✓' }))
      else setSms(s => ({ ...s, busy: false, msg: d.message || d.error || 'Send failed' }))
    } catch (e: any) { setSms(s => ({ ...s, busy: false, msg: e?.message || 'Send failed' })) }
  }

  function openPdf(type: 'jobcard' | 'invoice') { window.open(`/api/workshop/document?type=${type}&id=${encodeURIComponent(id)}`, '_blank') }
  const emailDocType: 'jobcard' | 'invoice' = (data?.booking?.status === 'invoiced' || data?.booking?.status === 'paid') ? 'invoice' : 'jobcard'

  function openPay() {
    const bal = Math.max(0, Math.round((totals.inc - paidTotal) * 100) / 100)
    setPay({ open: true, amount: bal ? bal.toFixed(2) : '', tender: 'card', note: '', busy: false, msg: '' })
  }
  async function submitPay() {
    setPay(p => ({ ...p, busy: true, msg: '' }))
    try {
      const r = await fetch('/api/workshop/payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_id: id, amount: Number(pay.amount), tender: pay.tender, note: pay.note }) })
      const d = await r.json()
      if (r.ok && d.ok) { setPay(p => ({ ...p, busy: false, open: false })); await Promise.all([load(), loadPayments()]) }
      else setPay(p => ({ ...p, busy: false, msg: d.error || 'Payment failed' }))
    } catch (e: any) { setPay(p => ({ ...p, busy: false, msg: e?.message || 'Payment failed' })) }
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
  // Per-section subtotal (ex GST): a heading + its items until the next heading.
  function sectionTotalAt(start: number): number {
    let s = 0
    for (let j = start + 1; j < lines.length; j++) {
      if (lines[j].line_type === 'description') break
      s += (Number(lines[j].total_ex_gst) ?? 0) || (Number(lines[j].qty) * Number(lines[j].unit_price_ex_gst)) || 0
    }
    return Math.round(s * 100) / 100
  }

  const b = data?.booking
  const cust = b?.customer
  const veh = b?.vehicle

  return (
    <>
      <Head><title>Job Card — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="diary" role={user.role} />

        <div style={{ flex: 1, overflow: 'auto', background: T.bg, padding: 20 }}>
          <div style={{ margin: '0 auto' }}>
            <Link href="/diary" style={{ fontSize: 12, color: T.text2, textDecoration: 'none' }}>‹ Back to diary</Link>

            {loading ? (
              <div style={{ textAlign: 'center', color: T.text3, padding: 60 }}>Loading job…</div>
            ) : err && !b ? (
              <div style={{ background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8, padding: 14, color: T.red, fontSize: 13, marginTop: 16 }}>{err}</div>
            ) : b ? (
              <>
                {/* Compact header strip */}
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 18px', marginTop: 12, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 17, fontWeight: 600 }}>{veh ? vehicleLabel(veh) : 'No vehicle'}</div>
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>
                      {cust ? customerLabel(cust) : 'No customer'}{cust?.mobile || cust?.phone ? ` · ${cust.mobile || cust.phone}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <StatusPill status={b.status} />
                    {canEdit && (
                      <select value={b.status} disabled={savingStatus} onChange={e => changeStatus(e.target.value as BookingStatus)} style={inp}>
                        {BOOKING_STATUSES.map(s => <option key={s} value={s}>{BOOKING_STATUS_META[s].label}</option>)}
                      </select>
                    )}
                  </div>
                </div>

                {/* Quick status actions — the active stage is filled in. */}
                {canEdit && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <StageBtn cur={b.status} status="prepared" color={BOOKING_STATUS_META.prepared.color} label="📦 Prepared" busy={savingStatus} onClick={() => changeStatus('prepared')} />
                    <StageBtn cur={b.status} status="in_progress" color={T.amber} label="▶ Start job" busy={savingStatus} onClick={() => changeStatus('in_progress')} />
                    <StageBtn cur={b.status} status="done" color={T.green} label="✓ Finish job" busy={savingStatus} onClick={finishJob} />
                    {!b.myob_invoice_uid ? (
                      <button onClick={createInvoice} disabled={inv.busy} style={qbtn(T.teal)}>{inv.busy ? '🧾 Finalising…' : '🧾 Finalise → MYOB'}</button>
                    ) : (
                      <button onClick={unfinalise} disabled={inv.busy} style={qbtn(T.amber)}>{inv.busy ? '↺ Un-finalising…' : '↺ Un-finalise'}</button>
                    )}
                    <button onClick={() => pay.open ? setPay(p => ({ ...p, open: false })) : openPay()} style={qbtn(T.teal)}>💳 Take payment</button>
                    {(b.status === 'invoiced' || b.status === 'paid') && (
                      <button onClick={() => setCredit(s => ({ ...s, open: !s.open, msg: '' }))} style={qbtn(T.red)}>↩ Credit / refund</button>
                    )}
                    <button onClick={() => sms.open ? setSms(s => ({ ...s, open: false })) : openSms()} style={qbtn(T.blue)}>📱 Text customer</button>
                    {inv.msg && <span style={{ fontSize: 11, color: inv.needAccount ? T.amber : T.text2 }}>{inv.msg}</span>}
                    {sms.msg && !sms.open && <span style={{ fontSize: 11, color: T.text2 }}>{sms.msg}</span>}
                  </div>
                )}
                {sms.open && (
                  <div style={{ marginTop: 10, padding: 12, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.blue }}>📱 Text customer</span>
                      <button onClick={() => setSms(s => ({ ...s, open: false }))} title="Close" style={xbtn}>×</button>
                    </div>
                    <textarea value={sms.body} onChange={e => setSms(s => ({ ...s, body: e.target.value }))} rows={3} style={{ ...inp, width: '100%', resize: 'vertical' }} />
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, alignItems: 'center' }}>
                      {sms.msg && <span style={{ fontSize: 11, color: T.amber, marginRight: 'auto' }}>{sms.msg}</span>}
                      <span style={{ fontSize: 10, color: T.text3 }}>{sms.body.length} chars</span>
                      <button onClick={() => setSms(s => ({ ...s, open: false }))} style={qbtn(T.text3)}>Cancel</button>
                      <button onClick={sendSmsNow} disabled={sms.busy} style={{ ...qbtn(T.blue), background: `${T.blue}1e` }}>{sms.busy ? 'Sending…' : 'Send SMS'}</button>
                    </div>
                  </div>
                )}
                {acct && (
                  <div style={{ marginTop: 10, padding: 12, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: T.text2 }}>MYOB sales account:</span>
                    <select value={acct.sel} onChange={e => setAcct({ ...acct, sel: e.target.value })} style={{ ...inp, minWidth: 300 }}>
                      <option value="">— pick income account —</option>
                      {acct.candidates.map((a: any) => <option key={a.uid} value={a.uid}>{a.displayId} · {a.name}</option>)}
                    </select>
                    <button onClick={saveAcct} disabled={!acct.sel || acct.saving} style={qbtn(T.accent)}>{acct.saving ? 'Saving…' : 'Save & invoice'}</button>
                    <button onClick={() => setAcct(null)} style={qbtn(T.text3)}>Cancel</button>
                  </div>
                )}
                {err && b && <div style={{ fontSize: 12, color: T.red, marginTop: 8 }}>{err}</div>}

                {/* Print / email the job card or tax invoice */}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button onClick={() => openPdf('jobcard')} style={qbtn(T.text2)}>🖨 Print job card</button>
                  {(b.status === 'invoiced' || b.status === 'paid') && <button onClick={() => openPdf('invoice')} style={qbtn(T.teal)}>🧾 Tax invoice PDF</button>}
                  {canEdit && <button onClick={() => setShowEmail(true)} style={qbtn(T.blue)}>✉ Email customer</button>}
                  {canEdit && <><span style={{ flex: 1 }} /><button onClick={deleteJob} title={b.myob_invoice_uid ? 'Un-finalise first to delete' : 'Delete this job'} style={qbtn(T.red)}>🗑 Delete job</button></>}
                </div>
                {showEmail && <SendEmailModal type={emailDocType} id={id} onClose={() => setShowEmail(false)} />}

                {dueSet.open && veh && (
                  <div style={{ marginTop: 10, padding: 12, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: T.text2, marginBottom: 8 }}>
                      Next service / rego due for <strong>{vehicleLabel(veh)}</strong> — drives the automated SMS reminders.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Next service due</div>
                        <input type="date" value={dueSet.service} onChange={e => setDueSet(s => ({ ...s, service: e.target.value }))} style={{ ...inp, colorScheme: 'dark' }} />
                      </div>
                      <button onClick={() => setDueSet(s => ({ ...s, service: addMonthsYmd(ymdBrisbane(new Date()), 6) }))} style={qbtn(T.text2)}>+6 mo</button>
                      <button onClick={() => setDueSet(s => ({ ...s, service: addMonthsYmd(ymdBrisbane(new Date()), 12) }))} style={qbtn(T.text2)}>+12 mo</button>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>or by (km)</div>
                        <input value={dueSet.km} inputMode="numeric" placeholder="—" onChange={e => setDueSet(s => ({ ...s, km: e.target.value }))} style={{ ...inp, width: 100 }} />
                      </div>
                      <button onClick={() => setDueSet(s => ({ ...s, km: String((Number(b.odometer ?? veh.odometer) || 0) + 10000) }))} style={qbtn(T.text2)} title="Current odometer + 10,000 km">+10,000 km</button>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Rego due</div>
                        <input type="date" value={dueSet.rego} onChange={e => setDueSet(s => ({ ...s, rego: e.target.value }))} style={{ ...inp, colorScheme: 'dark' }} />
                      </div>
                      <div style={{ flex: 1 }} />
                      {dueSet.msg && <span style={{ fontSize: 11, color: T.red }}>{dueSet.msg}</span>}
                      <button onClick={() => setDueSet(s => ({ ...s, open: false }))} style={qbtn(T.text3)}>Not now</button>
                      <button onClick={saveDueSet} disabled={dueSet.busy} style={{ ...qbtn(T.green), background: `${T.green}1e` }}>{dueSet.busy ? 'Saving…' : 'Save due dates'}</button>
                    </div>
                  </div>
                )}

                {pay.open && (
                  <div style={{ marginTop: 10, padding: 12, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.teal }}>💳 Take payment</span>
                      <button onClick={() => setPay(p => ({ ...p, open: false }))} title="Close" style={xbtn}>×</button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Amount</div><input value={pay.amount} inputMode="decimal" onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} style={{ ...inp, width: 120 }} /></div>
                      <div><div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>Tender</div><select value={pay.tender} onChange={e => setPay(p => ({ ...p, tender: e.target.value }))} style={inp}>{PAYMENT_TENDERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></div>
                      <input value={pay.note} onChange={e => setPay(p => ({ ...p, note: e.target.value }))} placeholder="Note (optional)" style={{ ...inp, flex: 1, minWidth: 140 }} />
                      <button onClick={() => setPay(p => ({ ...p, open: false }))} style={qbtn(T.text3)}>Cancel</button>
                      <button onClick={submitPay} disabled={pay.busy} style={{ ...qbtn(T.teal), background: `${T.teal}1e` }}>{pay.busy ? 'Saving…' : 'Record payment'}</button>
                    </div>
                    {pay.msg && <div style={{ fontSize: 11, color: T.amber, marginTop: 8 }}>{pay.msg}</div>}
                    {payments.length > 0 && (
                      <div style={{ marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 8, fontSize: 11, color: T.text3 }}>
                        {payments.map((p: any) => (
                          <div key={p.id} style={{ display: 'flex', gap: 8 }}>
                            <span style={{ fontFamily: 'monospace', color: T.text2 }}>{money(p.amount)}</span>
                            <span>{p.tender}</span>
                            {p.posted_to_myob ? <span style={{ color: T.green }}>· MYOB</span> : <span style={{ color: T.text3 }}>· local</span>}
                            <span style={{ marginLeft: 'auto' }}>{new Date(p.created_at).toLocaleDateString('en-AU')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {credit.open && (
                  <div style={{ marginTop: 10, padding: 12, background: T.bg2, border: `1px solid ${T.red}55`, borderRadius: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.red }}>↩ Credit note</span>
                      <button onClick={() => setCredit(s => ({ ...s, mode: 'lines' }))} style={{ ...qbtn(credit.mode === 'lines' ? T.red : T.text3) }}>Credit lines</button>
                      <button onClick={() => setCredit(s => ({ ...s, mode: 'amount' }))} style={{ ...qbtn(credit.mode === 'amount' ? T.red : T.text3) }}>Fixed amount</button>
                    </div>
                    {credit.mode === 'lines' ? (
                      <div style={{ marginBottom: 10 }}>
                        {lines.filter(l => l.line_type !== 'description').map(l => {
                          const on = !!credit.sel[l.id]
                          const ex = l.total_ex_gst != null ? Number(l.total_ex_gst) : (Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0)
                          return (
                            <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
                              <input type="checkbox" checked={on} onChange={e => setCredit(s => ({ ...s, sel: { ...s.sel, [l.id]: e.target.checked } }))} />
                              <span style={{ flex: 1, color: on ? T.text : T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description || l.line_type}</span>
                              <span style={{ fontSize: 10, color: T.text3 }}>qty</span>
                              <input value={credit.qty[l.id] ?? String(l.qty)} disabled={!on}
                                onChange={e => setCredit(s => ({ ...s, qty: { ...s.qty, [l.id]: e.target.value } }))}
                                style={{ ...inp, width: 56, opacity: on ? 1 : 0.4 }} inputMode="decimal" />
                              <span style={{ fontFamily: 'monospace', color: T.text3, minWidth: 70, textAlign: 'right' }}>{money(ex * 1.1)}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                        <span style={{ fontSize: 11, color: T.text3 }}>Amount (inc GST)</span>
                        <input value={credit.amount} inputMode="decimal" onChange={e => setCredit(s => ({ ...s, amount: e.target.value }))} style={{ ...inp, width: 120 }} />
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input value={credit.reason} onChange={e => setCredit(s => ({ ...s, reason: e.target.value }))} placeholder="Reason (shows in MYOB + activity log)…" style={{ ...inp, flex: 1, minWidth: 200 }} />
                      {credit.mode === 'lines' && (
                        <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 11, color: T.text2, cursor: 'pointer' }}>
                          <input type="checkbox" checked={credit.restock} onChange={e => setCredit(s => ({ ...s, restock: e.target.checked }))} /> restock parts
                        </label>
                      )}
                      <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 11, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={credit.refund} onChange={e => setCredit(s => ({ ...s, refund: e.target.checked }))} /> refund via
                      </label>
                      <select value={credit.tender} disabled={!credit.refund} onChange={e => setCredit(s => ({ ...s, tender: e.target.value }))} style={{ ...inp, opacity: credit.refund ? 1 : 0.4 }}>
                        {PAYMENT_TENDERS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <button onClick={() => setCredit(s => ({ ...s, open: false }))} style={qbtn(T.text3)}>Cancel</button>
                      <button onClick={submitCredit} disabled={credit.busy} style={{ ...qbtn(T.red), background: `${T.red}1e` }}>{credit.busy ? 'Saving…' : 'Issue credit'}</button>
                    </div>
                    {credit.msg && <div style={{ fontSize: 11, color: T.amber, marginTop: 8 }}>{credit.msg}</div>}
                  </div>
                )}
                {credit.msg && !credit.open && <div style={{ fontSize: 11, color: T.text2, marginTop: 6 }}>{credit.msg}</div>}

                <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, marginTop: 16, alignItems: 'start' }}>
                  {/* LEFT — Job details panel(s) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Panel title="Vehicle">
                      {veh ? (
                        <>
                          <FieldRow label="Rego" value={veh.rego} mono />
                          <FieldRow label="Make / Model" value={[veh.make, veh.model].filter(Boolean).join(' ') || '—'} />
                          <FieldRow label="Year" value={veh.year || '—'} />
                          <FieldRow label="VIN" value={veh.vin || '—'} mono />
                          <FieldRow label="Colour" value={veh.colour || '—'} />
                          <FieldRow label="Odometer" value={veh.odometer ? `${Number(veh.odometer).toLocaleString()} km` : '—'} mono />
                          <FieldRow label="Service due" mono
                            value={veh.next_service_due_date ? `${fmtDueDate(veh.next_service_due_date)}${veh.next_service_due_km ? ` / ${Number(veh.next_service_due_km).toLocaleString()} km` : ''}` : '—'}
                            accent={veh.next_service_due_date && veh.next_service_due_date < ymdBrisbane(new Date()) ? T.red : undefined} />
                          <FieldRow label="Rego due" mono value={fmtDueDate(veh.rego_due_date)}
                            accent={veh.rego_due_date && veh.rego_due_date < ymdBrisbane(new Date()) ? T.red : undefined} />
                          {canEdit && (
                            <div style={{ paddingTop: 6, marginTop: 4, borderTop: `1px solid ${T.border}` }}>
                              <button onClick={() => openDueSet(veh)} style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, color: T.blue, cursor: 'pointer', fontFamily: 'inherit' }}>Set service / rego due →</button>
                            </div>
                          )}
                        </>
                      ) : <div style={{ padding: '8px 0', fontSize: 12, color: T.text3 }}>No vehicle attached.</div>}
                    </Panel>

                    <Panel title="Customer">
                      {cust ? (
                        <>
                          <FieldRow label="Name" value={cust.name} />
                          <FieldRow label="Mobile" value={cust.mobile || '—'} mono />
                          <FieldRow label="Phone" value={cust.phone || '—'} mono />
                          <FieldRow label="Email" value={cust.email || '—'} />
                          <div style={{ paddingTop: 6, marginTop: 4, borderTop: `1px solid ${T.border}` }}>
                            <Link href={`/workshop/customer/${cust.id}`} style={{ fontSize: 11, color: T.blue, textDecoration: 'none' }}>View customer history →</Link>
                          </div>
                        </>
                      ) : <div style={{ padding: '8px 0', fontSize: 12, color: T.text3 }}>No customer attached.</div>}
                    </Panel>

                    <Panel title="Booking">
                      <FieldRow label="Start" value={fmtDateTime(b.starts_at)} mono />
                      <FieldRow label="End" value={fmtDateTime(b.ends_at)} mono />
                      {b.pickup_at && <FieldRow label="Collection" value={fmtDateTime(b.pickup_at)} mono accent={T.amber} />}
                      <FieldRow label="Technician" value={techName(b.technician_ext)} />
                      <FieldRow label="Bay" value={b.bay || '—'} />
                      <FieldRow label="Est. value" value={b.estimated_value ? money(b.estimated_value) : '—'} mono />
                      <FieldRow label="Category" value={jobTypeLabel(b.job_type) || '—'} />
                    </Panel>

                    {canEdit && (
                      <Panel title="Internal notes · staff only">
                        <textarea value={internalNotes} onChange={e => setInternalNotes(e.target.value)}
                          onBlur={async () => { if (internalNotes !== (b.internal_notes || '')) { await patchBooking({ internal_notes: internalNotes || null }); await load() } }}
                          rows={4} placeholder="Notes that never appear on the customer's invoice…"
                          style={{ ...inp, width: '100%', resize: 'vertical', minHeight: 70, fontFamily: 'inherit' }} />
                      </Panel>
                    )}
                  </div>

                  {/* RIGHT — Tabbed content */}
                  <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, background: T.bg3 }}>
                      <TabBtn active={tab==='invoice'} onClick={() => setTab('invoice')} label="Invoice" badge={lines.length || undefined} />
                      <TabBtn active={tab==='checklist'} onClick={() => setTab('checklist')} label="Checklist" badge={(Array.isArray((b as any).checklist) ? (b as any).checklist.length : 0) || undefined} />
                      <TabBtn active={tab==='notes'} onClick={() => setTab('notes')} label="Notes" />
                      <TabBtn active={tab==='files'} onClick={() => setTab('files')} label="Files & photos" />
                      <TabBtn active={tab==='activity'} onClick={() => setTab('activity')} label="Activity / time" />
                      <TabBtn active={tab==='history'} onClick={() => setTab('history')} label="Service history" badge={(data?.history || []).length || undefined} />
                    </div>

                    {tab === 'invoice' && (
                      <>
                        {/* Work description — shows on the customer's invoice (MYOB Comment). */}
                        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}` }}>
                          <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Work description · shows on invoice</div>
                          <textarea value={workDesc} disabled={!canEdit} onChange={e => setWorkDesc(e.target.value)}
                            onBlur={async () => { if (workDesc !== (b.description || '')) { await patchBooking({ description: workDesc || null }); await load() } }}
                            rows={3} placeholder="Work carried out, summary for the customer…"
                            style={{ ...inp, width: '100%', resize: 'vertical', minHeight: 56, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }} />
                        </div>
                        {/* Bulk-select action bar — appears when ≥1 line ticked. */}
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
                        <div style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 60px 90px 90px 84px', gap: 8, padding: '7px 14px', fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', background: T.bg3, borderBottom: `1px solid ${T.border}`, alignItems: 'center' }}>
                          {canEdit
                            ? <input type="checkbox" title="Select all" checked={lines.length > 0 && selected.size === lines.length} onChange={toggleSelectAll} style={{ cursor: 'pointer' }} />
                            : <div />}
                          <div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div style={{ textAlign: 'right' }}>Total ex</div><div/>
                        </div>
                        {lines.length === 0 && <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.text3 }}>No lines yet.</div>}
                        {lines.map((l, i) => (
                          <LineRow key={l.id} line={l} canEdit={canEdit} index={i}
                            sectionTotal={l.line_type === 'description' ? sectionTotalAt(i) : undefined}
                            selected={selected.has(l.id)} onToggleSelect={() => toggleSelect(i)}
                            onPatch={(p) => patchLine(l.id, p)} onDelete={() => deleteLine(l.id)} onMove={(dir) => moveLine(i, dir)}
                            dragOver={overIdx === i && dragIdx !== null && dragIdx !== i}
                            onGrab={() => setDrag(i)}
                            onHover={(idx) => setOver(idx)}
                            onDropLine={dropLine}
                            onCancel={() => { setDrag(null); setOver(null) }} />
                        ))}

                        {canEdit && (
                          <div style={{ padding: 12, borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <JobTypePicker jobTypes={jobTypes} busy={applyingJt} onPick={(jt) => applyJobType(jt.id)} />
                            <button onClick={() => addLine({ line_type: 'labour', description: 'Labour', qty: 1, unit_price_ex_gst: 0 })} style={addBtn}>+ Labour</button>
                            <button onClick={() => addLine({ line_type: 'fee', description: '', qty: 1, unit_price_ex_gst: 0 })} style={addBtn}>+ Fee</button>
                            <button onClick={() => addLine({ line_type: 'description', description: '', qty: 0, unit_price_ex_gst: 0 })} title="A text-only heading row — describe the job, then move the labour/parts that belong to it underneath" style={addBtn}>+ Description</button>
                            <PartPicker onPick={(it) => addLine({ line_type: 'part', description: it.part_name, part_number: it.sku, qty: 1, unit_price_ex_gst: Number(it.sell_price) || 0, inventory_id: it.id } as any)} />
                          </div>
                        )}

                        <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.border2}`, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                          <Row label="Subtotal (ex GST)" value={money(totals.ex)} />
                          <Row label="GST" value={money(totals.gst)} />
                          <Row label="Total (inc GST)" value={money(totals.inc)} bold />
                          {paidTotal > 0 && <Row label="Paid" value={money(paidTotal)} />}
                          {paidTotal > 0 && <Row label="Balance" value={money(Math.round((totals.inc - paidTotal) * 100) / 100)} bold />}
                        </div>

                        {payments.length > 0 && (
                          <div style={{ padding: '10px 16px', borderTop: `1px solid ${T.border}` }}>
                            <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Payments</div>
                            {payments.map((p: any) => (
                              <div key={p.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: T.text3, padding: '4px 0' }}>
                                <span style={{ fontFamily: 'monospace', color: Number(p.amount) < 0 ? T.red : T.text2, minWidth: 70 }}>{money(p.amount)}</span>
                                <span>{p.tender}{p.kind === 'refund' ? ' · refund' : ''}</span>
                                {p.posted_to_myob ? <span style={{ color: T.green }}>· MYOB</span> : <span>· local</span>}
                                <span style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>{new Date(p.created_at).toLocaleDateString('en-AU')}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {creditNotes.length > 0 && (
                          <div style={{ padding: '10px 16px', borderTop: `1px solid ${T.border}` }}>
                            <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Credit notes</div>
                            {creditNotes.map((cn: any) => (
                              <div key={cn.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: T.text3, padding: '4px 0' }}>
                                <span style={{ fontFamily: 'monospace', color: T.red, minWidth: 70 }}>−{money(cn.total_inc)}</span>
                                <span style={{ color: T.text2 }}>CN-{cn.cn_seq}</span>
                                {cn.reason && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{cn.reason}</span>}
                                {cn.myob_credit_uid ? <span style={{ color: T.green }}>· MYOB{cn.myob_credit_number ? ` ${cn.myob_credit_number}` : ''}</span> : <span>· local</span>}
                                {cn.refunded && <span style={{ color: T.amber }}>· refunded</span>}
                                <span style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>{new Date(cn.created_at).toLocaleDateString('en-AU')}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}

                    {tab === 'checklist' && (
                      <div style={{ padding: 16 }}>
                        <JobChecklist items={Array.isArray((b as any).checklist) ? (b as any).checklist : []} canEdit={canEdit}
                          onChange={async (items) => { await patchBooking({ checklist: items }); await load() }} />
                      </div>
                    )}

                    {tab === 'notes' && (
                      <div style={{ padding: 20, fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
                        Per-note timeline (timestamped, with author) lands in the next batch. For now, the "Internal notes" panel on the left holds staff-only notes, and the Checklist tab holds the work steps.
                      </div>
                    )}

                    {tab === 'files' && (
                      <FilesPanel bookingId={id} vehicleId={b.vehicle_id} customerId={b.customer_id} canEdit={canEdit} />
                    )}

                    {tab === 'activity' && (
                      <TimeClockPanel bookingId={id} defaultTech={b.technician_ext}
                        quotedHours={lines.filter(l => l.line_type === 'labour').reduce((s, l) => s + (Number(l.qty) || 0), 0)}
                        canEdit={canEdit} />
                    )}

                    {tab === 'history' && (
                      <>
                        {(data?.history || []).length === 0 ? (
                          <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.text3 }}>No prior completed jobs on this vehicle.</div>
                        ) : (data?.history || []).map((h: any) => (
                          <Link key={h.id} href={`/workshop/job/${h.id}`} style={{ display: 'block', padding: '10px 16px', borderTop: `1px solid ${T.border}`, textDecoration: 'none', color: 'inherit' }}>
                            <div style={{ fontSize: 12, color: T.text }}>{jobTypeLabel(h.job_type) || 'Job'}{h.total_inc_gst ? ` · ${money(h.total_inc_gst)}` : ''}</div>
                            <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', marginTop: 2 }}>{fmtDateTime(h.completed_at || h.starts_at)}{h.odometer ? ` · ${h.odometer.toLocaleString()} km` : ''}</div>
                            {h.summary && <div style={{ fontSize: 11, color: T.text2, marginTop: 3 }}>{h.summary}</div>}
                          </Link>
                        ))}
                      </>
                    )}
                  </div>
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', borderBottom: `1px solid ${T.border}`, fontSize: 10, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.08em', background: T.bg3 }}>{title}</div>
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>{children}</div>
    </div>
  )
}

function JobChecklist({ items, canEdit, onChange }: { items: Array<{ text: string; done: boolean }>; canEdit: boolean; onChange: (items: Array<{ text: string; done: boolean }>) => void }) {
  const [add, setAdd] = useState('')
  const done = items.filter(c => c.done).length
  function toggle(i: number) { onChange(items.map((c, idx) => idx === i ? { ...c, done: !c.done } : c)) }
  function remove(i: number) { onChange(items.filter((_, idx) => idx !== i)) }
  function addItem() { const t = add.trim(); if (!t) return; onChange([...items, { text: t, done: false }]); setAdd('') }
  return (
    <div>
      {items.length > 0 && <div style={{ fontSize: 10, color: T.text3, marginBottom: 4 }}>{done}/{items.length} done</div>}
      {items.map((c, i) => (
        <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0', cursor: canEdit ? 'pointer' : 'default' }}>
          <input type="checkbox" checked={!!c.done} disabled={!canEdit} onChange={() => toggle(i)} style={{ marginTop: 2 }} />
          <span style={{ flex: 1, fontSize: 13, color: c.done ? T.text3 : T.text, textDecoration: c.done ? 'line-through' : 'none' }}>{c.text}</span>
          {canEdit && <button onClick={e => { e.preventDefault(); remove(i) }} title="Remove" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>}
        </label>
      ))}
      {items.length === 0 && <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic', marginBottom: canEdit ? 6 : 0 }}>No checklist items — apply a job type or add one below.</div>}
      {canEdit && (
        <input value={add} onChange={e => setAdd(e.target.value)} placeholder="+ Add checklist item" onKeyDown={e => { if (e.key === 'Enter') addItem() }} style={{ ...inp, width: '100%', marginTop: 6 }} />
      )}
    </div>
  )
}

function FieldRow({ label, value, mono, accent }: { label: string; value: any; mono?: boolean; accent?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12 }}>
      <span style={{ color: T.text3, minWidth: 80, fontSize: 11 }}>{label}</span>
      <span style={{ flex: 1, color: accent || T.text, fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-word' }}>{value ?? '—'}</span>
    </div>
  )
}

function TabBtn({ active, onClick, label, badge }: { active: boolean; onClick: () => void; label: string; badge?: number }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '10px 14px', background: active ? T.bg2 : 'transparent', border: 'none',
      borderBottom: active ? `2px solid ${T.blue}` : '2px solid transparent',
      color: active ? T.text : T.text3, fontSize: 12, fontWeight: active ? 600 : 500,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    }}>
      {label}
      {badge !== undefined && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: active ? T.blue : T.bg3, color: active ? '#fff' : T.text3 }}>{badge}</span>}
    </button>
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

// A status quick-action — fills solid when it's the booking's current stage,
// so it's obvious which one is active and that clicking did something.
function StageBtn({ cur, status, color, label, busy, onClick }: { cur: BookingStatus; status: BookingStatus; color: string; label: string; busy: boolean; onClick: () => void }) {
  const on = cur === status
  return (
    <button onClick={onClick} disabled={busy} style={{
      padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
      background: on ? color : 'transparent', color: on ? '#fff' : color, border: `1px solid ${on ? color : `${color}55`}`, opacity: busy ? 0.6 : 1,
    }}>{on ? `✓ ${label.replace(/^[^ ]+ /, '')}` : label}</button>
  )
}

function LineRow({ line, canEdit, index, sectionTotal, selected, onToggleSelect, onPatch, onDelete, onMove, dragOver, onGrab, onHover, onDropLine, onCancel }: {
  line: Line; canEdit: boolean; index: number; sectionTotal?: number
  selected?: boolean; onToggleSelect?: () => void
  onPatch: (p: any) => void; onDelete: () => void; onMove: (dir: -1 | 1) => void
  dragOver?: boolean
  onGrab?: () => void; onHover?: (idx: number) => void; onDropLine?: () => void; onCancel?: () => void
}) {
  const [desc, setDesc] = useState(line.description || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price_ex_gst))
  const [grabbing, setGrabbing] = useState(false)
  useEffect(() => { setDesc(line.description || ''); setQty(String(line.qty)); setPrice(String(line.unit_price_ex_gst)) }, [line.id, line.description, line.qty, line.unit_price_ex_gst])
  const lineTotal = (Number(line.total_ex_gst) ?? 0) || (Number(line.qty) * Number(line.unit_price_ex_gst))

  // Touch / pen reordering: HTML5 drag never fires on touch, so for those
  // pointer types we track the finger, find the row under it via
  // elementFromPoint (rows carry data-line-index), and drop on pointer-up.
  // Mouse keeps using native HTML5 drag (the draggable grip below).
  function gripPointerDown(e: React.PointerEvent) {
    if (!canEdit || e.pointerType === 'mouse') return
    e.preventDefault()
    setGrabbing(true)
    onGrab?.()
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const row = el?.closest('[data-line-index]') as HTMLElement | null
      if (row) { const idx = Number(row.dataset.lineIndex); if (!Number.isNaN(idx)) onHover?.(idx) }
    }
    const end = (drop: boolean) => () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      setGrabbing(false)
      drop ? onDropLine?.() : onCancel?.()
    }
    const up = end(true), cancel = end(false)
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
  }

  const controls = canEdit ? (
    <span style={{ display: 'flex', gap: 0, justifyContent: 'flex-end', alignItems: 'center' }}>
      {/* Grip is the only draggable element so the text inputs stay selectable.
          touchAction:none lets a touch-drag start without scrolling the page. */}
      <span draggable
        onMouseDown={() => setGrabbing(true)}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onGrab?.() }}
        onDragEnd={() => { setGrabbing(false); onCancel?.() }}
        onPointerDown={gripPointerDown}
        title="Drag to reorder" style={{ cursor: 'grab', color: T.text3, fontSize: 15, padding: '0 4px', lineHeight: 1, userSelect: 'none', touchAction: 'none' }}>⠿</span>
      <button onClick={() => onMove(-1)} title="Move up" style={mvBtn}>↑</button>
      <button onClick={() => onMove(1)} title="Move down" style={mvBtn}>↓</button>
      <button onClick={onDelete} title="Remove" style={{ ...mvBtn, fontSize: 15 }}>×</button>
    </span>
  ) : <span/>
  // Row-level drag-drop wiring: the grip starts the drag, any row is a drop
  // target (mouse via HTML5, touch via elementFromPoint). A top border marks
  // where the dragged line will land. data-line-index is the touch lookup key.
  const dragProps: any = { 'data-line-index': index }
  if (canEdit) {
    dragProps.onDragOver = (e: React.DragEvent) => { e.preventDefault(); onHover?.(index) }
    dragProps.onDrop = (e: React.DragEvent) => { e.preventDefault(); onDropLine?.() }
  }
  const dropEdge = dragOver ? { boxShadow: `inset 0 2px 0 0 ${T.accent}` } : {}
  const selBg = selected ? { background: `${T.accent}1a` } : {}
  const checkbox = canEdit
    ? <input type="checkbox" checked={!!selected} onChange={onToggleSelect} style={{ cursor: 'pointer' }} title={line.line_type === 'description' ? 'Select this job type + its items' : 'Select line'} />
    : <span />
  if (line.line_type === 'description') {
    return (
      <div {...dragProps} style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 90px 84px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'start', background: T.bg3, ...selBg, ...dropEdge }}>
        <span style={{ paddingTop: 5 }}>{checkbox}</span>
        <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', paddingTop: 6 }}>Desc</span>
        <textarea value={desc} disabled={!canEdit} rows={2} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })}
          placeholder="Job description — the parts/labour below belong to it"
          style={{ ...cellInp, fontWeight: 600, lineHeight: 1.4, resize: 'vertical', minHeight: 36, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }} />
        <span title="This job type's subtotal (ex GST)" style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right', paddingTop: 6, fontWeight: 700 }}>{sectionTotal != null && sectionTotal > 0 ? money(sectionTotal) : ''}</span>
        {controls}
      </div>
    )
  }
  return (
    <div {...dragProps} style={{ display: 'grid', gridTemplateColumns: '28px 70px 1fr 60px 90px 90px 84px', gap: 8, padding: '8px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', opacity: grabbing ? 0.5 : 1, ...selBg, ...dropEdge }}>
      {checkbox}
      <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{LINE_TYPE_LABEL[line.line_type] || line.line_type}</span>
      <input value={desc} disabled={!canEdit} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })}
        placeholder={line.part_number || 'Description'} style={cellInp} />
      <input value={qty} disabled={!canEdit} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} disabled={!canEdit} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price_ex_gst) && onPatch({ unit_price_ex_gst: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <span style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right' }}>{money(lineTotal)}</span>
      {controls}
    </div>
  )
}

// Searchable job-type picker — picking one appends the job type's name as a
// description heading plus its template labour/parts (via the apply endpoint).
function JobTypePicker({ jobTypes, busy, onPick }: { jobTypes: any[]; busy: boolean; onPick: (jt: any) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const active = jobTypes.filter(t => t.active !== false)
  const needle = q.trim().toLowerCase()
  const results = (needle
    ? active.filter(t => `${t.name || ''} ${t.code || ''}`.toLowerCase().includes(needle))
    : active
  ).slice(0, 60)
  if (!open) return <button onClick={() => setOpen(true)} disabled={busy} style={{ ...addBtn, color: T.teal }} title="Add a preset job — its description heading + labour/parts">{busy ? 'Adding job…' : '+ Job type'}</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search job types…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 220, padding: '6px 8px' }} />
      <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 320, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 260, overflowY: 'auto', zIndex: 10 }}>
        {results.length === 0 && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: T.text3 }}>
            {active.length === 0 ? 'No job types yet — create them in Settings → Workshop → Job types.' : 'No matches.'}
          </div>
        )}
        {results.map(jt => {
          const lineCount = Array.isArray(jt.lines) ? jt.lines.length : 0
          const est = (jt.lines || []).reduce((s: number, l: any) => s + (Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0), 0)
          return (
            <div key={jt.id} onMouseDown={() => { onPick(jt); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}>
              <div style={{ color: T.text }}>{jt.name}</div>
              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
                {jt.code ? `${jt.code} · ` : ''}{lineCount} line{lineCount === 1 ? '' : 's'}{est > 0 ? ` · ${money(est * 1.1)} inc` : ''}
              </div>
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

const inp: React.CSSProperties = { padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', colorScheme: 'dark', boxSizing: 'border-box' }
const cellInp: React.CSSProperties = { width: '100%', padding: '5px 7px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
function qbtn(color: string): React.CSSProperties {
  return { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color, border: `1px solid ${color}55`, cursor: 'pointer' }
}
const addBtn: React.CSSProperties = { padding: '5px 11px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color: T.blue, border: `1px solid ${T.border2}`, cursor: 'pointer' }
const xbtn: React.CSSProperties = { marginLeft: 'auto', background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }
const mvBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '2px 3px' }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
