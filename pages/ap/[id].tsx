// pages/ap/[id].tsx
// AP Invoice Detail — PDF preview, line editor with per-line account picker,
// MD job link, MYOB preset picker, approve/reject/unpost actions, delete.
//
// Round 6 (smart line→account pickup A+B):
//   - LineRow extended with account_source + suggested_account_*
//   - LinesTable shows source badges + history suggestions
//   - AccountPickerModal grew a "Save as rule for {supplier}" affordance
//
// Phase 1 mobile (Mar 2026):
//   - Single-column stack on phones, sticky bottom action bar
//
// May 2026 — invoice header edit + form overlap fix
//
// May 2026 — AccountTypeahead pre-pick name + bigger results:
//   - When seeded from invoice.resolved_account_uid/_code (no name on the
//     invoice row), fetch the chart-of-accounts entry by displayId on
//     mount and show "6-1174 BAS Agent MYOB Consultant Fees" instead of
//     just "6-1174". Falls back silently if the lookup fails.
//   - Bumped account search limit 40 → 100 (server cap) and container
//     maxHeight 380 → 480 so users see ~16 rows instead of ~12.
//
// May 2026 — Un-post button:
//   - When an invoice is in `posted` state, admin/canEdit users see an
//     "Un-post" button next to the green "Posted to MYOB" line. Use case:
//     someone deletes the bill manually in MYOB; we need to flip the
//     portal back to pending_review so they can re-approve and re-post.
//   - Calls POST /api/ap/{id}/unpost with an optional reason. Server
//     resets myob_bill_uid/posted_at/posted_by, re-runs triage, leaves
//     attempts counter intact for audit.
//   - Safety net: on re-approve, smart-adopt's findExistingMyobBill
//     detects any remaining MYOB bill and re-links it instead of
//     creating a duplicate.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { GetServerSideProps } from 'next'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'
import { useIsMobile } from '../../lib/useIsMobile'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

type AccountSource =
  | 'unset' | 'rule' | 'history-strong' | 'history-weak' | 'manual' | 'supplier-default'

interface InvoiceRow {
  id: string
  source: string
  email_from: string | null
  email_subject: string | null
  pdf_filename: string | null
  received_at: string
  vendor_name_parsed: string | null
  vendor_abn: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  po_number: string | null
  subtotal_ex_gst: number | null
  gst_amount: number | null
  total_inc_gst: number | null
  via_capricorn: boolean
  capricorn_reference: string | null
  capricorn_member_number: string | null
  notes: string | null
  parse_confidence: 'high' | 'medium' | 'low' | null
  resolved_supplier_uid: string | null
  resolved_supplier_name: string | null
  resolved_account_uid: string | null
  resolved_account_code: string | null
  myob_company_file: 'VPS' | 'JAWS'
  triage_status: 'pending' | 'green' | 'yellow' | 'red'
  triage_reasons: string[] | null
  status: string
  myob_bill_uid: string | null
  myob_posted_at: string | null
  myob_post_error: string | null
  myob_post_attempts: number | null
  rejection_reason: string | null
  linked_job_number: string | null
  linked_job_match_method: 'auto-po' | 'manual' | null
  linked_job_at: string | null
  po_check_status: 'matched' | 'unmatched' | 'no-po-on-invoice' | null
}

interface LineRow {
  id: string
  invoice_id: string
  line_no: number
  part_number: string | null
  description: string
  qty: number | null
  uom: string | null
  unit_price_ex_gst: number | null
  line_total_ex_gst: number
  gst_amount: number | null
  tax_code: string
  account_uid: string | null
  account_code: string | null
  account_name: string | null
  account_source: AccountSource | null
  suggested_account_uid: string | null
  suggested_account_code: string | null
  suggested_account_name: string | null
}

interface JobInfo {
  job_number: string
  customer_name: string | null
  vehicle: string | null
  status: string | null
  opened_date: string | null
  closed_date: string | null
  job_type: string | null
  vehicle_platform: string | null
  estimated_total: number | null
}

interface MyobSupplier {
  uid: string
  displayId: string | null
  name: string
  abn: string | null
  isIndividual: boolean
}

interface MyobAccount {
  uid: string
  displayId: string
  name: string
  type: string
  parentName: string | null
  isHeader: boolean
}

interface DetailResponse {
  invoice: InvoiceRow
  lines: LineRow[]
  pdfUrl: string | null
  linkedJob: JobInfo | null
}

interface HeaderEditable {
  vendor_name_parsed: string
  vendor_abn:         string
  invoice_number:     string
  invoice_date:       string
  po_number:          string
  due_date:           string
  subtotal_ex_gst:    string
  gst_amount:         string
  total_inc_gst:      string
  notes:              string
}

interface PageProps {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

export default function APDetailPage({ user }: PageProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const id = router.query.id as string | undefined
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingLines, setEditingLines] = useState<LineRow[] | null>(null)
  const [editingHeader, setEditingHeader] = useState<HeaderEditable | null>(null)
  const [savingHeader, setSavingHeader] = useState(false)
  const [headerMessage, setHeaderMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [unposting, setUnposting] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [accountPickerLineId, setAccountPickerLineId] = useState<string | null>(null)
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerResults, setPickerResults] = useState<JobInfo[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)

  const [presetOpen, setPresetOpen] = useState(false)

  async function fetchData() {
    if (!id) return
    setLoading(true)
    try {
      const res = await fetch(`/api/ap/${id}`, { credentials: 'same-origin' })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const json: DetailResponse = await res.json()
      setData(json)
      setEditingLines(null)
      setEditingHeader(null)
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (id) fetchData() }, [id])

  useEffect(() => {
    if (!pickerOpen) return
    setPickerLoading(true)
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: pickerQuery, limit: '25' })
        const res = await fetch(`/api/ap/jobs/search?${params.toString()}`, { credentials: 'same-origin' })
        const json = await res.json()
        setPickerResults(Array.isArray(json.jobs) ? json.jobs : [])
      } catch (e: any) {
        console.error('job search failed:', e)
        setPickerResults([])
      } finally {
        setPickerLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [pickerOpen, pickerQuery])

  async function linkToJob(jobNumber: string | null) {
    if (!id) return
    setLinkBusy(true)
    try {
      const res = await fetch(`/api/ap/${id}/link-job`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobNumber }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setPickerOpen(false)
      await fetchData()
    } catch (e: any) {
      alert('Link failed: ' + (e?.message || e))
    } finally {
      setLinkBusy(false)
    }
  }

  async function deleteInvoice() {
    if (!id || !data) return
    const label = `${data.invoice.vendor_name_parsed || 'this invoice'} ${data.invoice.invoice_number || ''}`.trim()
    const ok = confirm(`Delete ${label}?\n\nThis permanently removes the invoice, its lines, and the PDF. This cannot be undone.`)
    if (!ok) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/ap/${id}`, { method: 'DELETE', credentials: 'same-origin' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      router.push('/ap')
    } catch (e: any) {
      alert('Delete failed: ' + (e?.message || e))
      setDeleting(false)
    }
  }

  async function approveAndPost() {
    if (!id || !data) return
    const inv = data.invoice
    const summary =
      `Post bill to MYOB ${inv.myob_company_file}?\n\n` +
      `Supplier:  ${inv.resolved_supplier_name || '(not set)'}\n` +
      `Account:   ${inv.resolved_account_code || '(not set)'}\n` +
      `Total:     ${fmtMoney(inv.total_inc_gst)}\n` +
      `Inv #:     ${inv.invoice_number}\n` +
      `Date:      ${inv.invoice_date}\n` +
      (inv.via_capricorn && inv.capricorn_reference ? `Capricorn: ${inv.capricorn_reference}\n` : '') +
      (inv.linked_job_number ? `Job:       ${inv.linked_job_number}\n` : '')
    if (!confirm(summary)) return
    setApproving(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)

      const uidPart = json.myobBillUid ? ` — bill UID ${String(json.myobBillUid).substring(0, 8)}…` : ''
      const attachPart =
        json.attachmentStatus === 'attached' ? ' · 📎 PDF attached' :
        json.attachmentStatus === 'failed'   ? ` · ⚠️ PDF attach failed: ${json.attachmentError || ''}` :
        json.attachmentStatus === 'no-pdf'   ? ' · (no PDF on file)' :
        json.attachmentStatus === 'skipped'  ? ' · (PDF attach skipped)' :
        json.attachmentStatus === 'adopted'  ? ` · ↷ adopted as posted` :
        ''
      setActionMessage({
        kind: json.attachmentStatus === 'failed' ? 'err' : 'ok',
        text: `✅ Posted to MYOB${uidPart}${attachPart}`,
      })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ ${e?.message || String(e)}` })
      await fetchData()
    } finally {
      setApproving(false)
    }
  }

  async function rejectInvoice() {
    if (!id) return
    const reason = prompt('Reason for rejecting this invoice?\n(Will be stored on the record. Required.)')
    if (!reason || !reason.trim()) return
    setRejecting(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/reject`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setActionMessage({ kind: 'ok', text: '✅ Rejected' })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ ${e?.message || String(e)}` })
    } finally {
      setRejecting(false)
    }
  }

  // Un-post: flip a `posted` invoice back to `pending_review` so it can be
  // re-approved. Use case: someone deleted the bill in MYOB, and our DB
  // still says it's posted — re-approve from the portal otherwise refuses.
  // Safe by design: smart-adopt will detect any remaining MYOB bill on
  // re-approve and re-link it without duplicating.
  async function unpostInvoice() {
    if (!id || !data) return
    const inv = data.invoice
    const confirmMsg =
      `Un-post this invoice?\n\n` +
      `Vendor:  ${inv.vendor_name_parsed || '?'}\n` +
      `Inv #:   ${inv.invoice_number || '?'}\n` +
      `Total:   ${fmtMoney(inv.total_inc_gst)}\n` +
      (inv.myob_bill_uid ? `MYOB UID: ${inv.myob_bill_uid.substring(0, 8)}…\n` : '') +
      `\n` +
      `Use this when the bill has been deleted in MYOB and you need to re-enter it.\n\n` +
      `The invoice will go back to pending_review. When you re-approve, the system\n` +
      `will check MYOB first — if the bill still exists it'll just re-link, otherwise\n` +
      `it'll create a fresh one.`
    if (!confirm(confirmMsg)) return

    const reason = prompt(
      'Reason for un-posting? (optional, stored as audit note)',
      'Bill deleted in MYOB',
    )
    // null = user cancelled the second prompt; treat as cancel.
    if (reason === null) return

    setUnposting(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/unpost`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setActionMessage({
        kind: 'ok',
        text: `↩ Un-posted — back to pending_review${json.previousMyobBillUid ? ` (was UID ${String(json.previousMyobBillUid).substring(0, 8)}…)` : ''}`,
      })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ Un-post failed: ${e?.message || String(e)}` })
    } finally {
      setUnposting(false)
    }
  }

  function startHeaderEdit() {
    if (!data) return
    const inv = data.invoice
    setEditingHeader({
      vendor_name_parsed: inv.vendor_name_parsed || '',
      vendor_abn:         inv.vendor_abn || '',
      invoice_number:     inv.invoice_number || '',
      invoice_date:       (inv.invoice_date || '').substring(0, 10),
      po_number:          inv.po_number || '',
      due_date:           (inv.due_date || '').substring(0, 10),
      subtotal_ex_gst:    inv.subtotal_ex_gst !== null ? String(inv.subtotal_ex_gst) : '',
      gst_amount:         inv.gst_amount      !== null ? String(inv.gst_amount)      : '',
      total_inc_gst:      inv.total_inc_gst   !== null ? String(inv.total_inc_gst)   : '',
      notes:              inv.notes || '',
    })
    setHeaderMessage(null)
  }

  function cancelHeaderEdit() {
    setEditingHeader(null)
    setHeaderMessage(null)
  }

  function updateHeader(patch: Partial<HeaderEditable>) {
    if (!editingHeader) return
    setEditingHeader({ ...editingHeader, ...patch })
  }

  async function saveHeader() {
    if (!editingHeader || !id) return
    setSavingHeader(true)
    setHeaderMessage(null)
    try {
      const body: Record<string, any> = {
        vendor_name_parsed: trimToNull(editingHeader.vendor_name_parsed),
        vendor_abn:         trimToNull(editingHeader.vendor_abn),
        invoice_number:     trimToNull(editingHeader.invoice_number),
        invoice_date:       trimToNull(editingHeader.invoice_date),
        po_number:          trimToNull(editingHeader.po_number),
        due_date:           trimToNull(editingHeader.due_date),
        subtotal_ex_gst:    parseNumOrNull(editingHeader.subtotal_ex_gst),
        gst_amount:         parseNumOrNull(editingHeader.gst_amount),
        total_inc_gst:      parseNumOrNull(editingHeader.total_inc_gst),
        notes:              trimToNull(editingHeader.notes),
      }
      const res = await fetch(`/api/ap/${id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      if (json && json.invoice) setData(json)
      else await fetchData()
      setEditingHeader(null)
      setHeaderMessage('✅ Saved · re-triaged')
    } catch (e: any) {
      setHeaderMessage(`❌ Save failed: ${e?.message || e}`)
    } finally {
      setSavingHeader(false)
    }
  }

  function startEdit() {
    if (!data) return
    setEditingLines(data.lines.map(l => ({ ...l })))
  }
  function cancelEdit() {
    setEditingLines(null)
    setSaveMessage(null)
    setAccountPickerLineId(null)
  }
  function updateLine(lineId: string, patch: Partial<LineRow>) {
    if (!editingLines) return
    setEditingLines(editingLines.map(l => l.id === lineId ? { ...l, ...patch } : l))
  }
  function addLine() {
    if (!editingLines || !data) return
    const nextNo = (editingLines.length === 0 ? 1 : Math.max(...editingLines.map(l => l.line_no)) + 1)
    setEditingLines([
      ...editingLines,
      {
        id: `new-${Date.now()}`,
        invoice_id: data.invoice.id,
        line_no: nextNo,
        part_number: null,
        description: '',
        qty: null,
        uom: null,
        unit_price_ex_gst: null,
        line_total_ex_gst: 0,
        gst_amount: null,
        tax_code: 'GST',
        account_uid: null,
        account_code: null,
        account_name: null,
        account_source: 'unset',
        suggested_account_uid: null,
        suggested_account_code: null,
        suggested_account_name: null,
      },
    ])
  }
  function removeLine(lineId: string) {
    if (!editingLines) return
    setEditingLines(editingLines.filter(l => l.id !== lineId))
  }

  function applySuggestion(l: LineRow) {
    if (!l.suggested_account_uid) return
    updateLine(l.id, {
      account_uid:    l.suggested_account_uid,
      account_code:   l.suggested_account_code,
      account_name:   l.suggested_account_name,
      account_source: 'manual',
    })
  }

  async function saveLines() {
    if (!editingLines || !id) return
    setSaving(true)
    setSaveMessage(null)
    try {
      const payload = editingLines.map(l => ({
        line_no: l.line_no,
        part_number: l.part_number,
        description: l.description,
        qty: l.qty,
        uom: l.uom,
        unit_price_ex_gst: l.unit_price_ex_gst,
        line_total_ex_gst: l.line_total_ex_gst,
        gst_amount: l.gst_amount,
        tax_code: l.tax_code,
        account_uid: l.account_uid,
        account_code: l.account_code,
        account_name: l.account_name,
        account_source: l.account_source || (l.account_uid ? 'manual' : 'unset'),
      }))
      const res = await fetch(`/api/ap/${id}/lines`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: payload }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMessage('✅ Lines saved')
      await fetchData()
    } catch (e: any) {
      setSaveMessage(`❌ Save failed: ${e?.message || e}`)
    } finally {
      setSaving(false)
    }
  }

  const isPosted   = data?.invoice.status === 'posted'
  const isRejected = data?.invoice.status === 'rejected'
  const isTerminal = isPosted || isRejected
  const hasAccountFallbackOrPerLine = (() => {
    if (!data) return false
    if (data.invoice.resolved_account_uid) return true
    return data.lines.length > 0 && data.lines.every(l => !!l.account_uid)
  })()
  const canApprove = canEdit && data
                  && !isTerminal
                  && data.invoice.triage_status !== 'red'
                  && !!data.invoice.resolved_supplier_uid
                  && hasAccountFallbackOrPerLine
  const approveBlockedReason =
    !data ? '' :
    isPosted   ? 'Already posted' :
    isRejected ? 'Invoice rejected' :
    data.invoice.triage_status === 'red' ? 'Triage RED — fix issues' :
    !data.invoice.resolved_supplier_uid ? 'No MYOB supplier mapped' :
    !hasAccountFallbackOrPerLine ? 'Some lines have no account and no default account is set' :
    ''

  const pickerLine = editingLines?.find(l => l.id === accountPickerLineId) || null

  const pagePadding   = isMobile ? '14px 14px 96px' : '20px 28px'
  const showStickyBar = isMobile && !!data && !isTerminal && canEdit
  const gridCols      = isMobile ? '1fr' : 'minmax(0, 5fr) minmax(0, 7fr)'
  const rightColStyle: React.CSSProperties = isMobile
    ? { display:'flex', flexDirection:'column', gap:14 }
    : { display:'flex', flexDirection:'column', gap:14, height:'calc(100vh - 110px)', overflow:'auto' }
  const pdfWrapStyle: React.CSSProperties = isMobile
    ? { background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden', height:'50vh', display:'flex', flexDirection:'column' }
    : { background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden', height:'calc(100vh - 110px)', display:'flex', flexDirection:'column' }

  return (
    <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:"'DM Sans', system-ui, sans-serif"}}>
      <PortalSidebar
        activeId="ap"
        currentUserRole={user.role}
        currentUserVisibleTabs={user.visibleTabs}
        currentUserName={user.displayName || user.email}
        currentUserEmail={user.email}
      />

      <div style={{flex:1, padding: pagePadding, overflow:'auto'}}>
        <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:14, flexWrap:'wrap'}}>
          <button
            onClick={() => router.push('/ap')}
            style={{background:'none', border:'none', color:T.text2, cursor:'pointer', fontSize: isMobile ? 14 : 13, fontFamily:'inherit', padding:0}}
          >← Back</button>
          <span style={{fontSize:12, color:T.text3}}>·</span>
          <span style={{fontSize:13, color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0}}>
            {data?.invoice.vendor_name_parsed || 'Loading…'}
            {data?.invoice.invoice_number ? ` — ${data.invoice.invoice_number}` : ''}
          </span>
          {data && canEdit && !isPosted && !isMobile && (
            <>
              <span style={{flex:1}}/>
              <button
                onClick={deleteInvoice}
                disabled={deleting}
                title="Delete invoice + PDF"
                style={{
                  background:'transparent',
                  border:`1px solid ${T.red}40`,
                  color:T.red,
                  padding:'5px 11px', borderRadius:5,
                  fontSize:11, fontFamily:'inherit',
                  cursor: deleting ? 'wait' : 'pointer',
                  opacity: deleting ? 0.6 : 1,
                }}
              >
                {deleting ? 'Deleting…' : '🗑 Delete'}
              </button>
            </>
          )}
        </div>

        {error && (
          <div style={{background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:7, padding:10, color:T.red, fontSize:12, marginBottom:12}}>
            <strong>Failed to load:</strong> {error}
          </div>
        )}
        {loading && !data && (
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:30, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</div>
        )}

        {data && (
          <div style={{display:'grid', gridTemplateColumns: gridCols, gap:18}}>
            <div style={pdfWrapStyle}>
              <div style={{padding:'10px 14px', borderBottom:`1px solid ${T.border2}`, fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', display:'flex', alignItems:'center', gap:10}}>
                <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  PDF · {data.invoice.pdf_filename || 'unnamed'}
                </span>
                {isMobile && data.pdfUrl && (
                  <a
                    href={data.pdfUrl} target="_blank" rel="noopener noreferrer"
                    style={{
                      fontSize:11, color:T.blue, textDecoration:'none',
                      padding:'4px 10px', border:`1px solid ${T.blue}40`,
                      borderRadius:5, fontFamily:'inherit',
                    }}
                  >Open ↗</a>
                )}
              </div>
              {data.pdfUrl ? (
                <iframe src={data.pdfUrl} style={{flex:1, border:'none', background:'#fff'}} title="invoice pdf"/>
              ) : (
                <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:T.text3, fontSize:12}}>
                  PDF not available (storage failed?)
                </div>
              )}
            </div>

            <div style={rightColStyle}>

              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', gap:10, marginBottom: data.invoice.triage_reasons && data.invoice.triage_reasons.length > 0 ? 8 : 10, flexWrap:'wrap'}}>
                  <TriagePill status={data.invoice.triage_status}/>
                  <StatusPill status={data.invoice.status}/>
                  <span style={{fontSize:11, color:T.text3}}>
                    Parse: {data.invoice.parse_confidence || 'unknown'}
                    {data.invoice.via_capricorn && (
                      <> · <span style={{color:T.amber}}>via Capricorn{data.invoice.capricorn_reference ? ` ${data.invoice.capricorn_reference}` : ''}</span></>
                    )}
                  </span>
                  <span style={{flex:1}}/>
                  <span style={{fontSize:11, color:T.text3}}>{data.invoice.myob_company_file}</span>
                </div>
                {data.invoice.triage_reasons && data.invoice.triage_reasons.length > 0 && (
                  <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:10}}>
                    {data.invoice.triage_reasons.map((r, i) => {
                      const isRed    = r.startsWith('RED:')
                      const isYellow = r.startsWith('YELLOW:')
                      const isInfo   = r.startsWith('INFO:')
                      const c = isRed ? T.red : isYellow ? T.amber : isInfo ? T.teal : T.text3
                      return (
                        <span key={i} style={{
                          fontSize:10, fontFamily:'monospace',
                          padding:'2px 8px', borderRadius:3,
                          background: `${c}15`,
                          color: c,
                          border: `1px solid ${c}40`,
                        }}>{r}</span>
                      )
                    })}
                  </div>
                )}

                {!isTerminal && canEdit && !isMobile && (
                  <div style={{display:'flex', alignItems:'center', gap:8, paddingTop:10, borderTop:`1px solid ${T.border}`}}>
                    {data.invoice.myob_post_error && (
                      <span style={{fontSize:10, color:T.red, flex:1, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}
                        title={data.invoice.myob_post_error}>
                        Last error: {data.invoice.myob_post_error}
                      </span>
                    )}
                    {!data.invoice.myob_post_error && <span style={{flex:1}}/>}
                    <button
                      onClick={rejectInvoice}
                      disabled={rejecting || approving}
                      style={{
                        background:'transparent', border:`1px solid ${T.red}40`, color:T.red,
                        padding:'6px 14px', borderRadius:5, fontSize:11, fontFamily:'inherit',
                        cursor: rejecting ? 'wait' : 'pointer',
                        opacity: rejecting ? 0.6 : 1,
                      }}>
                      {rejecting ? 'Rejecting…' : 'Reject'}
                    </button>
                    <button
                      onClick={approveAndPost}
                      disabled={!canApprove || approving || rejecting}
                      title={canApprove ? '' : `Cannot post: ${approveBlockedReason}`}
                      style={{
                        background: canApprove ? T.blue : T.bg4,
                        color: canApprove ? '#fff' : T.text3,
                        border:'none',
                        padding:'6px 14px', borderRadius:5, fontSize:11, fontWeight:600, fontFamily:'inherit',
                        cursor: !canApprove ? 'not-allowed' : approving ? 'wait' : 'pointer',
                        opacity: approving ? 0.6 : 1,
                      }}>
                      {approving ? 'Posting…' : 'Approve & Post to MYOB'}
                    </button>
                  </div>
                )}
                {!isTerminal && canEdit && isMobile && data.invoice.myob_post_error && (
                  <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`, fontSize:11, color:T.red}}>
                    Last error: {data.invoice.myob_post_error}
                  </div>
                )}

                {isPosted && (
                  <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`}}>
                    <div style={{
                      display:'flex', alignItems:'center', gap:10, flexWrap:'wrap',
                      justifyContent:'space-between',
                    }}>
                      <div style={{fontSize:11, color:T.green, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flex:1, minWidth:0}}>
                        <span>✅ Posted to MYOB {data.invoice.myob_posted_at ? new Date(data.invoice.myob_posted_at).toLocaleString() : ''}</span>
                        {data.invoice.myob_bill_uid && (
                          <span style={{fontFamily:'monospace', color:T.text3}}>
                            · UID {data.invoice.myob_bill_uid.substring(0, 8)}…
                          </span>
                        )}
                      </div>
                      {canEdit && (
                        <button
                          onClick={unpostInvoice}
                          disabled={unposting}
                          title="Reset to pending_review (use if the bill was deleted in MYOB and you need to re-enter it)"
                          style={{
                            background:'transparent',
                            border:`1px solid ${T.amber}50`,
                            color:T.amber,
                            padding:'5px 11px', borderRadius:5,
                            fontSize:11, fontFamily:'inherit',
                            cursor: unposting ? 'wait' : 'pointer',
                            opacity: unposting ? 0.6 : 1,
                            whiteSpace:'nowrap',
                          }}
                        >
                          {unposting ? 'Un-posting…' : '↩ Un-post'}
                        </button>
                      )}
                    </div>
                    {data.invoice.myob_post_error && (
                      <div style={{marginTop:6, fontSize:11, color:T.amber}}>
                        ⚠️ {data.invoice.myob_post_error}
                      </div>
                    )}
                  </div>
                )}
                {isRejected && (
                  <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`, fontSize:11, color:T.text2}}>
                    🚫 Rejected{data.invoice.rejection_reason ? ` — ${data.invoice.rejection_reason}` : ''}
                  </div>
                )}

                {actionMessage && (
                  <div style={{
                    marginTop:10, padding:'8px 10px', borderRadius:5, fontSize:11,
                    background: actionMessage.kind === 'ok' ? `${T.green}15` : `${T.red}15`,
                    border: `1px solid ${actionMessage.kind === 'ok' ? T.green : T.red}40`,
                    color: actionMessage.kind === 'ok' ? T.green : T.red,
                  }}>
                    {actionMessage.text}
                  </div>
                )}
              </div>

              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
                  <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Invoice</div>
                  <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                    {editingHeader === null && canEdit && !isTerminal && (
                      <button onClick={startHeaderEdit} style={btnSecondary()}>Edit</button>
                    )}
                    {editingHeader !== null && (
                      <>
                        <button onClick={cancelHeaderEdit} disabled={savingHeader} style={btnSecondary()}>Cancel</button>
                        <button onClick={saveHeader} disabled={savingHeader} style={btnPrimary()}>
                          {savingHeader ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {headerMessage && (
                  <div style={{
                    fontSize:11,
                    color: headerMessage.startsWith('❌') ? T.red : T.green,
                    marginBottom:10,
                  }}>{headerMessage}</div>
                )}

                {editingHeader === null ? (
                  <>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
                      <Field label="Vendor"        value={data.invoice.vendor_name_parsed}/>
                      <Field label="ABN"           value={data.invoice.vendor_abn} mono/>
                      <Field label="Invoice #"     value={data.invoice.invoice_number} mono/>
                      <Field label="Invoice date"  value={data.invoice.invoice_date}/>
                      <Field label="PO #"          value={data.invoice.po_number || '—'} mono/>
                      <Field label="Due date"      value={data.invoice.due_date || '—'}/>
                      <Field label="Subtotal"      value={fmtMoney(data.invoice.subtotal_ex_gst)} mono align="right"/>
                      <Field label="GST"           value={fmtMoney(data.invoice.gst_amount)}      mono align="right"/>
                      <Field label="Total inc GST" value={fmtMoney(data.invoice.total_inc_gst)}   mono align="right" emphasised/>
                      <Field label="Source"        value={`${data.invoice.source}${data.invoice.email_from ? ' · ' + data.invoice.email_from : ''}`}/>
                    </div>
                    {data.invoice.notes && (
                      <div style={{marginTop:10, padding:'8px 10px', background:T.bg3, borderRadius:6, fontSize:11, color:T.text2}}>
                        📝 {data.invoice.notes}
                      </div>
                    )}
                  </>
                ) : (
                  <HeaderEditForm
                    value={editingHeader}
                    onChange={updateHeader}
                    disabled={savingHeader}
                  />
                )}
              </div>

              <WorkshopJobSection
                invoice={data.invoice}
                linkedJob={data.linkedJob}
                canEdit={canEdit && !isTerminal}
                pickerOpen={pickerOpen}
                pickerQuery={pickerQuery}
                pickerResults={pickerResults}
                pickerLoading={pickerLoading}
                linkBusy={linkBusy}
                onOpenPicker={() => { setPickerQuery(''); setPickerOpen(true) }}
                onClosePicker={() => setPickerOpen(false)}
                onPickerQueryChange={setPickerQuery}
                onPickJob={(jn) => linkToJob(jn)}
                onUnlink={() => linkToJob(null)}
              />

              <MyobMappingSection
                invoice={data.invoice}
                canEdit={canEdit && !isTerminal}
                presetOpen={presetOpen}
                onOpenPreset={() => setPresetOpen(true)}
                onClosePreset={() => setPresetOpen(false)}
                onPresetSaved={async () => { setPresetOpen(false); await fetchData() }}
              />

              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
                  <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Line items ({editingLines?.length ?? data.lines.length})</div>
                  <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                    {editingLines === null && canEdit && !isTerminal && (
                      <button onClick={startEdit} style={btnSecondary()}>Edit lines</button>
                    )}
                    {editingLines !== null && (
                      <>
                        <button onClick={addLine} style={btnSecondary()}>+ Add line</button>
                        <button onClick={cancelEdit} disabled={saving} style={btnSecondary()}>Cancel</button>
                        <button onClick={saveLines} disabled={saving} style={btnPrimary()}>
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {saveMessage && (
                  <div style={{fontSize:11, color: saveMessage.startsWith('❌') ? T.red : T.green, marginBottom:8}}>{saveMessage}</div>
                )}
                <LinesTable
                  lines={editingLines || data.lines}
                  invoiceDefaultAccountCode={data.invoice.resolved_account_code}
                  editable={editingLines !== null}
                  onChange={updateLine}
                  onRemove={removeLine}
                  onPickAccount={(lineId) => setAccountPickerLineId(lineId)}
                  onApplySuggestion={applySuggestion}
                />
                {editingLines !== null && !isMobile && (
                  <div style={{marginTop:10, fontSize:10, color:T.text3, lineHeight:1.5}}>
                    💡 Smart pickup: lines auto-mapped by rule or 5+ past bills with the same description show <span style={{color:T.teal}}>🔁 Auto</span>. Lower-confidence matches show <span style={{color:T.amber}}>💡 Suggestion</span> with one-click [Use]. Click an account button to override; tick &quot;Save as rule&quot; in the picker to teach the system.
                  </div>
                )}
              </div>

              {data && canEdit && !isPosted && isMobile && (
                <button
                  onClick={deleteInvoice}
                  disabled={deleting}
                  style={{
                    background:'transparent',
                    border:`1px solid ${T.red}40`,
                    color:T.red,
                    padding:'12px 14px', borderRadius:6,
                    fontSize:13, fontFamily:'inherit',
                    cursor: deleting ? 'wait' : 'pointer',
                    opacity: deleting ? 0.6 : 1,
                  }}
                >
                  {deleting ? 'Deleting…' : '🗑 Delete invoice'}
                </button>
              )}
            </div>
          </div>
        )}

        {pickerLine && data && (
          <AccountPickerModal
            companyFile={data.invoice.myob_company_file}
            currentAccountCode={pickerLine.account_code}
            currentAccountName={pickerLine.account_name}
            invoiceDefaultCode={data.invoice.resolved_account_code}
            lineLabel={`Line #${pickerLine.line_no}: ${pickerLine.description.substring(0, 60)}`}
            lineDescription={pickerLine.description}
            linePartNumber={pickerLine.part_number}
            supplier={
              data.invoice.resolved_supplier_uid && data.invoice.resolved_supplier_name
                ? { uid: data.invoice.resolved_supplier_uid, name: data.invoice.resolved_supplier_name }
                : null
            }
            onClose={() => setAccountPickerLineId(null)}
            onSelect={(account) => {
              if (account === null) {
                updateLine(pickerLine.id, {
                  account_uid: null,
                  account_code: null,
                  account_name: null,
                  account_source: 'unset',
                })
              } else {
                updateLine(pickerLine.id, {
                  account_uid: account.uid,
                  account_code: account.displayId,
                  account_name: account.name || null,
                  account_source: 'manual',
                })
              }
              setAccountPickerLineId(null)
            }}
          />
        )}
      </div>

      {showStickyBar && data && (
        <div style={{
          position:'fixed', left:0, right:0, bottom:0, zIndex:900,
          background: T.bg2,
          borderTop: `1px solid ${T.border2}`,
          padding: '10px 14px calc(10px + env(safe-area-inset-bottom)) 14px',
          display:'flex', gap:10, alignItems:'center',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
        }}>
          <button
            onClick={rejectInvoice}
            disabled={rejecting || approving}
            style={{
              flex: '0 0 auto',
              background:'transparent', border:`1px solid ${T.red}60`, color:T.red,
              padding:'12px 16px', borderRadius:8,
              fontSize:14, fontWeight:500, fontFamily:'inherit',
              cursor: rejecting ? 'wait' : 'pointer',
              opacity: rejecting ? 0.6 : 1,
              minHeight: 48,
            }}>
            {rejecting ? '…' : 'Reject'}
          </button>
          <button
            onClick={approveAndPost}
            disabled={!canApprove || approving || rejecting}
            title={canApprove ? '' : `Cannot post: ${approveBlockedReason}`}
            style={{
              flex: 1,
              background: canApprove ? T.blue : T.bg4,
              color: canApprove ? '#fff' : T.text3,
              border:'none',
              padding:'12px 16px', borderRadius:8,
              fontSize:15, fontWeight:600, fontFamily:'inherit',
              cursor: !canApprove ? 'not-allowed' : approving ? 'wait' : 'pointer',
              opacity: approving ? 0.6 : 1,
              minHeight: 48,
            }}>
            {approving ? 'Posting…' : '✓ Approve & Post'}
          </button>
        </div>
      )}
    </div>
  )
}

function HeaderEditForm({
  value, onChange, disabled,
}: {
  value: HeaderEditable
  onChange: (patch: Partial<HeaderEditable>) => void
  disabled: boolean
}) {
  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10}}>
        <FormRow label="Vendor">
          <input
            value={value.vendor_name_parsed}
            onChange={e => onChange({ vendor_name_parsed: e.target.value })}
            placeholder="e.g. TIME EXPRESS COURIER"
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
        <FormRow label="ABN">
          <input
            value={value.vendor_abn}
            onChange={e => onChange({ vendor_abn: e.target.value })}
            placeholder="11 digits"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Invoice #">
          <input
            value={value.invoice_number}
            onChange={e => onChange({ invoice_number: e.target.value })}
            placeholder="required to post"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Invoice date">
          <input
            type="date"
            value={value.invoice_date}
            onChange={e => onChange({ invoice_date: e.target.value })}
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
        <FormRow label="PO #">
          <input
            value={value.po_number}
            onChange={e => onChange({ po_number: e.target.value })}
            placeholder="(optional)"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Due date">
          <input
            type="date"
            value={value.due_date}
            onChange={e => onChange({ due_date: e.target.value })}
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10}}>
        <FormRow label="Subtotal ex GST">
          <input
            value={value.subtotal_ex_gst}
            onChange={e => onChange({ subtotal_ex_gst: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right'}}
          />
        </FormRow>
        <FormRow label="GST">
          <input
            value={value.gst_amount}
            onChange={e => onChange({ gst_amount: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right'}}
          />
        </FormRow>
        <FormRow label="Total inc GST">
          <input
            value={value.total_inc_gst}
            onChange={e => onChange({ total_inc_gst: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right', fontWeight:600}}
          />
        </FormRow>
      </div>

      <FormRow label="Notes">
        <textarea
          value={value.notes}
          onChange={e => onChange({ notes: e.target.value })}
          placeholder="(optional)"
          disabled={disabled}
          rows={2}
          style={{
            ...inputStyle(),
            resize: 'vertical',
            minHeight: 50,
          }}
        />
      </FormRow>

      <div style={{fontSize:10, color:T.text3, lineHeight:1.5}}>
        Save runs triage again — fixing missing invoice # / total clears the matching RED reason. PO # changes also re-run the auto job-link.
      </div>
    </div>
  )
}

function MyobMappingSection({
  invoice, canEdit, presetOpen, onOpenPreset, onClosePreset, onPresetSaved,
}: {
  invoice: InvoiceRow
  canEdit: boolean
  presetOpen: boolean
  onOpenPreset: () => void
  onClosePreset: () => void
  onPresetSaved: () => Promise<void>
}) {
  const isMapped = !!invoice.resolved_supplier_uid
  const accountMissing = isMapped && !invoice.resolved_account_uid

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>
          MYOB mapping ({invoice.myob_company_file})
        </div>
        {canEdit && !presetOpen && (
          <button onClick={onOpenPreset} style={btnSecondary()}>
            {isMapped ? 'Change…' : 'Set preset…'}
          </button>
        )}
        {canEdit && presetOpen && (
          <button onClick={onClosePreset} style={btnSecondary()}>Close</button>
        )}
      </div>

      {!presetOpen && isMapped && (
        <>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
            <Field label="Supplier"        value={invoice.resolved_supplier_name}/>
            <Field label="Default account" value={invoice.resolved_account_code} mono/>
          </div>
          {accountMissing && (
            <div style={{marginTop:10, fontSize:11, color:T.amber}}>
              Supplier auto-matched but no default account on the MYOB supplier card.
              Click "Change…" to pick a default, or set per-line accounts in the line editor.
            </div>
          )}
        </>
      )}

      {!presetOpen && !isMapped && (
        <div style={{fontSize:12, color:T.amber}}>
          Supplier not mapped. {canEdit ? 'Click "Set preset…" to pick the MYOB supplier and account.' : 'Ask an admin to set the preset.'}
        </div>
      )}

      {presetOpen && (
        <SupplierPresetForm
          invoice={invoice}
          onSaved={onPresetSaved}
        />
      )}
    </div>
  )
}

function SupplierPresetForm({
  invoice, onSaved,
}: {
  invoice: InvoiceRow
  onSaved: () => Promise<void>
}) {
  const [pattern, setPattern] = useState<string>(
    (invoice.vendor_name_parsed || '').trim().toUpperCase().split(/[\s,]+/).slice(0, 2).join(' ') || ''
  )
  const [viaCapricorn, setViaCapricorn] = useState<boolean>(invoice.via_capricorn)
  const [supplier, setSupplier] = useState<MyobSupplier | null>(
    invoice.resolved_supplier_uid && invoice.resolved_supplier_name
      ? { uid: invoice.resolved_supplier_uid, displayId: null, name: invoice.resolved_supplier_name, abn: invoice.vendor_abn, isIndividual: false }
      : null
  )
  // Account starts with empty name when seeded from invoice.resolved_*
  // (the invoice row doesn't store the account name). AccountTypeahead's
  // displaySelected hydration will fetch and show the full name.
  const [account, setAccount] = useState<MyobAccount | null>(
    invoice.resolved_account_uid && invoice.resolved_account_code
      ? { uid: invoice.resolved_account_uid, displayId: invoice.resolved_account_code, name: '', type: 'Expense', parentName: null, isHeader: false }
      : null
  )
  const [saving, setSavingState] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!pattern.trim()) { setError('Match pattern is required'); return }
    if (!supplier) { setError('Pick a MYOB supplier'); return }
    if (!account)  { setError('Pick a MYOB default account'); return }
    setError(null)
    setSavingState(true)
    try {
      const res = await fetch('/api/ap/supplier-presets', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: pattern.trim().toUpperCase(),
          matchAbn: invoice.vendor_abn || null,
          myobCompanyFile: invoice.myob_company_file,
          myobSupplierUid: supplier.uid,
          myobSupplierName: supplier.name,
          defaultAccountUid: account.uid,
          defaultAccountCode: account.displayId,
          defaultAccountName: account.name || null,
          viaCapricorn,
          applyToInvoiceId: invoice.id,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingState(false)
    }
  }

  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <FormRow label="Match pattern (case-insensitive substring of parsed vendor name)">
        <input
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          placeholder="e.g. REPCO"
          style={inputStyle()}
        />
      </FormRow>

      <div style={{fontSize:10, color:T.text3}}>
        Company file: <span style={{color:T.text2}}>{invoice.myob_company_file}</span>
      </div>

      <FormRow label="MYOB supplier">
        <SupplierTypeahead
          companyFile={invoice.myob_company_file}
          selected={supplier}
          onSelect={setSupplier}
          initialQuery={(invoice.vendor_name_parsed || '').trim()}
        />
      </FormRow>

      <FormRow label="Default account (any account type)">
        <AccountTypeahead
          companyFile={invoice.myob_company_file}
          selected={account}
          onSelect={setAccount}
        />
      </FormRow>

      <div style={{display:'flex', alignItems:'center', gap:8}}>
        <input
          id="viaCapricorn"
          type="checkbox"
          checked={viaCapricorn}
          onChange={e => setViaCapricorn(e.target.checked)}
        />
        <label htmlFor="viaCapricorn" style={{fontSize:12, color:T.text2, cursor:'pointer'}}>
          This vendor is typically billed via Capricorn
        </label>
      </div>

      {error && (
        <div style={{fontSize:11, color:T.red, padding:'6px 10px', background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:5}}>
          {error}
        </div>
      )}

      <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
        <button
          onClick={save}
          disabled={saving || !supplier || !account || !pattern.trim()}
          style={{
            ...btnPrimary(),
            opacity: saving || !supplier || !account || !pattern.trim() ? 0.6 : 1,
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save preset & re-triage'}
        </button>
      </div>
      <div style={{fontSize:10, color:T.text3}}>
        Saving creates/updates a preset for the pattern. Future invoices whose parsed vendor name contains "{pattern.toUpperCase() || '…'}" will auto-resolve.
      </div>
    </div>
  )
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{minWidth:0}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4}}>{label}</div>
      {children}
    </div>
  )
}

function inputStyle(): React.CSSProperties {
  return {
    width:'100%',
    boxSizing:'border-box',
    background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
    padding:'8px 10px', borderRadius:5,
    fontSize:16, fontFamily:'inherit', outline:'none',
  }
}

function AccountPickerModal({
  companyFile, currentAccountCode, currentAccountName, invoiceDefaultCode,
  lineLabel, lineDescription, linePartNumber,
  supplier,
  onClose, onSelect,
}: {
  companyFile: 'VPS' | 'JAWS'
  currentAccountCode: string | null
  currentAccountName: string | null
  invoiceDefaultCode: string | null
  lineLabel: string
  lineDescription: string
  linePartNumber: string | null
  supplier: { uid: string; name: string } | null
  onClose: () => void
  onSelect: (account: MyobAccount | null) => void
}) {
  const [saveAsRule, setSaveAsRule] = useState(false)
  const [pattern, setPattern] = useState<string>(defaultPatternFor(lineDescription, linePartNumber))
  const [matchType, setMatchType] = useState<'contains' | 'starts_with' | 'exact'>('contains')
  const [matchField, setMatchField] = useState<'description' | 'part_number' | 'both'>('description')
  const [savingRule, setSavingRule] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)

  async function handleAccountClick(account: MyobAccount) {
    if (saveAsRule && supplier) {
      const trimmedPattern = pattern.trim()
      if (!trimmedPattern) {
        setRuleError('Pattern is required')
        return
      }
      setSavingRule(true)
      setRuleError(null)
      try {
        const res = await fetch('/api/ap/line-rules', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplier_uid:      supplier.uid,
            supplier_name:     supplier.name,
            myob_company_file: companyFile,
            pattern:           trimmedPattern,
            match_type:        matchType,
            match_field:       matchField,
            account_uid:       account.uid,
            account_code:      account.displayId,
            account_name:      account.name || account.displayId,
          }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      } catch (e: any) {
        setRuleError(`Rule save failed: ${e?.message || e}`)
        setSavingRule(false)
        return
      }
      setSavingRule(false)
    }
    onSelect(account)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
        display:'flex', alignItems:'flex-start', justifyContent:'center',
        zIndex:1000, paddingTop:'8vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.bg2,
          border: `1px solid ${T.border2}`,
          borderRadius: 10,
          width: 'min(680px, 92vw)',
          padding: '18px 20px',
          maxHeight: '84vh',
          overflowY: 'auto',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', marginBottom:12}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:3}}>
              Pick account ({companyFile})
            </div>
            <div style={{fontSize:13, color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{lineLabel}</div>
          </div>
          <button onClick={onClose} style={btnSecondary()}>Close</button>
        </div>

        <div style={{
          padding:'8px 10px', background:T.bg3, borderRadius:6, fontSize:11,
          color:T.text2, marginBottom:12,
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap',
        }}>
          <div>
            Current:{' '}
            {currentAccountCode ? (
              <span style={{fontFamily:'monospace', color:T.text}}>
                {currentAccountCode}
                {currentAccountName ? <span style={{color:T.text3}}> · {currentAccountName}</span> : null}
              </span>
            ) : (
              <span style={{color:T.text3}}>
                Default ({invoiceDefaultCode ? <span style={{fontFamily:'monospace'}}>{invoiceDefaultCode}</span> : 'none'})
              </span>
            )}
          </div>
          {currentAccountCode && (
            <button
              onClick={() => onSelect(null)}
              style={{
                ...btnSecondary(),
                color: T.amber,
                borderColor: `${T.amber}40`,
              }}
            >
              Reset to default
            </button>
          )}
        </div>

        {supplier && (
          <div style={{
            marginBottom:12, padding:'10px 12px',
            background:T.bg3, border:`1px solid ${T.border}`, borderRadius:6,
          }}>
            <label style={{display:'flex', alignItems:'center', gap:8, fontSize:12, color:T.text2, cursor:'pointer'}}>
              <input
                type="checkbox"
                checked={saveAsRule}
                onChange={e => setSaveAsRule(e.target.checked)}
                disabled={savingRule}
                style={{width:18, height:18}}
              />
              <span>Save as rule for <span style={{color:T.text}}>{supplier.name}</span></span>
            </label>
            {saveAsRule && (
              <div style={{marginTop:10, display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:8, alignItems:'end'}}>
                <FormRow label="Pattern">
                  <input
                    value={pattern}
                    onChange={e => setPattern(e.target.value)}
                    placeholder="brake pad"
                    style={inputStyle()}
                    disabled={savingRule}
                  />
                </FormRow>
                <FormRow label="Match">
                  <select
                    value={matchType}
                    onChange={e => setMatchType(e.target.value as any)}
                    disabled={savingRule}
                    style={{...inputStyle(), padding:'7px 8px'}}
                  >
                    <option value="contains">contains</option>
                    <option value="starts_with">starts with</option>
                    <option value="exact">exact</option>
                  </select>
                </FormRow>
                <FormRow label="Field">
                  <select
                    value={matchField}
                    onChange={e => setMatchField(e.target.value as any)}
                    disabled={savingRule}
                    style={{...inputStyle(), padding:'7px 8px'}}
                  >
                    <option value="description">description</option>
                    <option value="part_number">part number</option>
                    <option value="both">both</option>
                  </select>
                </FormRow>
              </div>
            )}
            {ruleError && (
              <div style={{marginTop:8, fontSize:11, color:T.red}}>{ruleError}</div>
            )}
          </div>
        )}

        <AccountTypeahead
          companyFile={companyFile}
          selected={null}
          onSelect={(a) => { if (a) handleAccountClick(a) }}
          forceOpen
          placeholder="Search any account by code or name…"
        />

        {savingRule && (
          <div style={{marginTop:10, fontSize:11, color:T.text3}}>Saving rule…</div>
        )}
      </div>
    </div>
  )
}

function defaultPatternFor(description: string, partNumber: string | null): string {
  const desc = (description || '').trim()
  if (desc) {
    return desc.split(/\s+/).slice(0, 2).join(' ').toLowerCase()
  }
  if (partNumber) return partNumber.trim().toLowerCase()
  return ''
}

function SupplierTypeahead({
  companyFile, selected, onSelect, initialQuery,
}: {
  companyFile: 'VPS' | 'JAWS'
  selected: MyobSupplier | null
  onSelect: (s: MyobSupplier | null) => void
  initialQuery?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(initialQuery || '')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<MyobSupplier[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '20' })
        const res = await fetch(`/api/myob/suppliers?${params.toString()}`, { credentials: 'same-origin' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResults(Array.isArray(json.suppliers) ? json.suppliers : [])
      } catch (e: any) {
        setSearchError(e?.message || 'search failed')
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [open, query, companyFile])

  if (!open) {
    return (
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <div style={{flex:1, fontSize:12, color: selected ? T.text : T.text3, minWidth:0}}>
          {selected ? selected.name : 'No supplier picked'}
          {selected?.abn && <span style={{color:T.text3, marginLeft:8, fontFamily:'monospace'}}>ABN {selected.abn}</span>}
        </div>
        <button onClick={() => setOpen(true)} style={btnSecondary()}>{selected ? 'Change…' : 'Search MYOB…'}</button>
        {selected && (
          <button onClick={() => onSelect(null)} style={btnSecondary()}>Clear</button>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{display:'flex', gap:8, marginBottom:8}}>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search MYOB suppliers…"
          style={inputStyle()}
        />
        <button onClick={() => setOpen(false)} style={btnSecondary()}>Close</button>
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:240, overflowY:'auto', background: T.bg3,
      }}>
        {loading && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching MYOB…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
            {query ? 'No matching suppliers in MYOB.' : 'Type to search…'}
          </div>
        )}
        {!loading && results.map((s, i) => (
          <div
            key={s.uid}
            onClick={() => { onSelect(s); setOpen(false) }}
            style={{
              padding:'10px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'center',
            }}
          >
            <div>
              <div style={{color:T.text}}>{s.name}</div>
              {s.abn && <div style={{fontSize:10, fontFamily:'monospace', color:T.text3, marginTop:2}}>ABN {s.abn}</div>}
            </div>
            {s.displayId && (
              <span style={{fontSize:10, color:T.text3, fontFamily:'monospace'}}>{s.displayId}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── AccountTypeahead ─────────────────────────────────────────────────────
//
// Two changes in May 2026:
//
// 1. PRE-PICKED NAME HYDRATION
//    SupplierPresetForm seeds `selected` from the invoice's
//    resolved_account_uid + resolved_account_code. The invoice doesn't
//    store the account name — there's no resolved_account_name column —
//    so the seed has `name: ''`. The closed-state display showed only
//    "6-1174" until the user re-selected. Fix: track an internal
//    `displaySelected` state that mirrors `selected` but, when the name
//    is empty, fires a one-shot fetch via /api/myob/accounts?q=<displayId>
//    to find the matching entry and enrich `name` (and type / parent /
//    isHeader). We DON'T call onSelect with the enriched account —
//    parent state stays as-is until the user actually changes the pick.
//
// 2. RESULT LIMIT + LIST HEIGHT
//    Frontend was asking for 40 rows; bumped to 100 (server's hard cap).
//    Container maxHeight 380px → 480px so users see ~16 rows at once.
function AccountTypeahead({
  companyFile, selected, onSelect, forceOpen, placeholder,
}: {
  companyFile: 'VPS' | 'JAWS'
  selected: MyobAccount | null
  onSelect: (a: MyobAccount | null) => void
  forceOpen?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(!!forceOpen)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<MyobAccount[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  // Display copy of `selected` — same data, but with the name hydrated
  // when the upstream caller couldn't supply it.
  const [displaySelected, setDisplaySelected] = useState<MyobAccount | null>(selected)

  // Re-sync if the parent's selected prop changes (e.g. user picks a
  // different account in this typeahead, parent re-renders us).
  useEffect(() => {
    setDisplaySelected(selected)
  }, [selected?.uid, selected?.displayId, selected?.name])

  // Hydrate the name when it's missing. Searches /api/myob/accounts by
  // the displayId and finds the exact match. Fails silently — if the
  // lookup errors out, we keep showing just the code (pre-fix behaviour).
  useEffect(() => {
    if (!selected || !selected.uid || !selected.displayId) return
    if (selected.name) return
    let cancelled = false
    ;(async () => {
      try {
        const params = new URLSearchParams({
          q: selected.displayId, company: companyFile, limit: '5',
        })
        const res = await fetch(`/api/myob/accounts?${params.toString()}`, { credentials: 'same-origin' })
        if (!res.ok) return
        const json = await res.json()
        const accounts: MyobAccount[] = Array.isArray(json.accounts) ? json.accounts : []
        const match = accounts.find(a => a.displayId === selected.displayId) || null
        if (match && !cancelled) {
          setDisplaySelected({
            ...selected,
            name:       match.name,
            type:       match.type       || selected.type,
            parentName: match.parentName ?? selected.parentName,
            isHeader:   match.isHeader,
          })
        }
      } catch {
        // swallow — falls back to just the code in the closed state
      }
    })()
    return () => { cancelled = true }
  }, [selected?.uid, selected?.displayId, selected?.name, companyFile])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        // limit 100 = server's hard cap. Combined with maxHeight 480px
        // below, this surfaces ~16 rows on screen at once.
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '100' })
        const res = await fetch(`/api/myob/accounts?${params.toString()}`, { credentials: 'same-origin' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResults(Array.isArray(json.accounts) ? json.accounts : [])
      } catch (e: any) {
        setSearchError(e?.message || 'search failed')
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [open, query, companyFile])

  if (!open) {
    return (
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <div style={{flex:1, fontSize:12, color: displaySelected ? T.text : T.text3, minWidth:0}}>
          {displaySelected ? (
            <>
              <span style={{fontFamily:'monospace'}}>{displaySelected.displayId}</span>
              {displaySelected.name && <span style={{marginLeft:8, color:T.text2}}>{displaySelected.name}</span>}
            </>
          ) : 'No account picked'}
        </div>
        <button onClick={() => setOpen(true)} style={btnSecondary()}>{displaySelected ? 'Change…' : 'Search MYOB…'}</button>
        {displaySelected && (
          <button onClick={() => onSelect(null)} style={btnSecondary()}>Clear</button>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{display:'flex', gap:8, marginBottom:8}}>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder || "Search by code or name (any account type)…"}
          style={inputStyle()}
        />
        {!forceOpen && (
          <button onClick={() => setOpen(false)} style={btnSecondary()}>Close</button>
        )}
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:480, overflowY:'auto', background: T.bg3,
      }}>
        {loading && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching MYOB…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
            {query ? 'No matching accounts.' : 'Showing top accounts. Refine with a query.'}
          </div>
        )}
        {!loading && results.map((a, i) => (
          <div
            key={a.uid}
            onClick={() => { onSelect(a); if (!forceOpen) setOpen(false) }}
            style={{
              padding:'10px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'80px 1fr 110px', gap:10, alignItems:'center',
            }}
          >
            <span style={{fontFamily:'monospace', color:T.text}}>{a.displayId}</span>
            <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.name}</span>
            <span style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em', textAlign:'right'}}>{a.type}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkshopJobSection({
  invoice, linkedJob, canEdit,
  pickerOpen, pickerQuery, pickerResults, pickerLoading, linkBusy,
  onOpenPicker, onClosePicker, onPickerQueryChange, onPickJob, onUnlink,
}: {
  invoice: InvoiceRow
  linkedJob: JobInfo | null
  canEdit: boolean
  pickerOpen: boolean
  pickerQuery: string
  pickerResults: JobInfo[]
  pickerLoading: boolean
  linkBusy: boolean
  onOpenPicker: () => void
  onClosePicker: () => void
  onPickerQueryChange: (q: string) => void
  onPickJob: (jobNumber: string) => void
  onUnlink: () => void
}) {
  const poStatus = invoice.po_check_status
  const manual = invoice.linked_job_match_method === 'manual'

  let headline: { color: string; text: string }
  if (linkedJob) {
    if (manual) headline = { color: T.green, text: '✅ Linked (manual)' }
    else        headline = { color: T.green, text: '✅ Linked (auto by PO)' }
  } else if (poStatus === 'unmatched') {
    headline = { color: T.amber, text: `⚠️ PO ${invoice.po_number} doesn't match any open job` }
  } else if (poStatus === 'no-po-on-invoice' && invoice.via_capricorn) {
    headline = { color: T.text3, text: 'No PO on invoice (Capricorn-routed)' }
  } else if (poStatus === 'no-po-on-invoice') {
    headline = { color: T.text3, text: 'No PO on invoice' }
  } else {
    headline = { color: T.text3, text: 'PO check not run' }
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Workshop Job (MD)</div>
        {canEdit && !pickerOpen && (
          <div style={{display:'flex', gap:8}}>
            {linkedJob && (
              <button onClick={onUnlink} disabled={linkBusy} style={btnSecondary()}>
                {linkBusy ? 'Unlinking…' : 'Unlink'}
              </button>
            )}
            <button onClick={onOpenPicker} disabled={linkBusy} style={btnSecondary()}>
              {linkedJob ? 'Change…' : 'Find job…'}
            </button>
          </div>
        )}
        {canEdit && pickerOpen && (
          <button onClick={onClosePicker} style={btnSecondary()}>Close picker</button>
        )}
      </div>

      <div style={{fontSize:12, color: headline.color, marginBottom: linkedJob || pickerOpen ? 10 : 0}}>
        {headline.text}
      </div>

      {linkedJob && !pickerOpen && (
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
          <Field label="Job #"        value={linkedJob.job_number} mono/>
          <Field label="Status"       value={linkedJob.status}/>
          <Field label="Customer"     value={linkedJob.customer_name}/>
          <Field label="Vehicle"      value={linkedJob.vehicle}/>
          <Field label="Job type"     value={linkedJob.job_type}/>
          <Field label="Platform"     value={linkedJob.vehicle_platform}/>
          <Field label="Opened"       value={linkedJob.opened_date}/>
          <Field label="Quoted total" value={fmtMoney(linkedJob.estimated_total)} mono align="right"/>
        </div>
      )}

      {pickerOpen && (
        <div style={{marginTop:8}}>
          <input
            autoFocus
            value={pickerQuery}
            onChange={e => onPickerQueryChange(e.target.value)}
            placeholder="Search by job # / customer / vehicle…"
            style={{
              width:'100%', boxSizing:'border-box',
              background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
              padding:'10px 12px', borderRadius:6,
              fontSize: 16, fontFamily:'inherit', outline:'none',
              marginBottom:10,
            }}
          />
          <div style={{
            border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
            maxHeight:300, overflowY:'auto', background: T.bg3,
          }}>
            {pickerLoading && (
              <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching…</div>
            )}
            {!pickerLoading && pickerResults.length === 0 && (
              <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
                {pickerQuery ? 'No matching jobs.' : 'Type to search…'}
              </div>
            )}
            {!pickerLoading && pickerResults.map((j, i) => (
              <div
                key={`${j.job_number}-${i}`}
                onClick={() => !linkBusy && onPickJob(j.job_number)}
                style={{
                  padding:'10px 12px',
                  borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                  cursor: linkBusy ? 'wait' : 'pointer',
                  fontSize: 12,
                  display:'grid', gridTemplateColumns:'80px 1fr 1fr 90px', gap:10, alignItems:'center',
                }}
              >
                <span style={{fontFamily:'monospace', color:T.text}}>{j.job_number}</span>
                <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.customer_name || '—'}</span>
                <span style={{color:T.text3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.vehicle || '—'}</span>
                <span style={{color:T.text3, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em'}}>{j.status || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function LinesTable({
  lines, invoiceDefaultAccountCode, editable,
  onChange, onRemove, onPickAccount, onApplySuggestion,
}: {
  lines: LineRow[]
  invoiceDefaultAccountCode: string | null
  editable: boolean
  onChange: (id: string, patch: Partial<LineRow>) => void
  onRemove: (id: string) => void
  onPickAccount: (lineId: string) => void
  onApplySuggestion: (l: LineRow) => void
}) {
  if (lines.length === 0) {
    return <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>No line items.</div>
  }
  return (
    <div style={{overflowX:'auto', WebkitOverflowScrolling:'touch'}}>
      <table style={{width:'100%', borderCollapse:'collapse', fontSize:12, minWidth: 720}}>
        <thead>
          <tr style={{borderBottom:`1px solid ${T.border}`}}>
            <th style={lh(36)}>#</th>
            <th style={lh(120)}>Part</th>
            <th style={lh()}>Description</th>
            <th style={{...lh(60), textAlign:'right'}}>Qty</th>
            <th style={lh(50)}>UoM</th>
            <th style={{...lh(80), textAlign:'right'}}>Unit ex</th>
            <th style={{...lh(80), textAlign:'right'}}>Total ex</th>
            <th style={lh(56)}>Tax</th>
            <th style={lh(170)}>Account</th>
            {editable && <th style={lh(40)}/>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
              <td style={ld()}>{l.line_no}</td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.part_number || ''} onChange={v => onChange(l.id, { part_number: v || null })}/>
                  : (l.part_number || <span style={{color:T.text3}}>—</span>)}
              </td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.description} onChange={v => onChange(l.id, { description: v })}/>
                  : l.description}
              </td>
              <td style={{...ld(), textAlign:'right'}}>
                {editable
                  ? <Inp value={l.qty?.toString() || ''} onChange={v => onChange(l.id, { qty: v === '' ? null : Number(v) || null })} alignRight/>
                  : (l.qty ?? '—')}
              </td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.uom || ''} onChange={v => onChange(l.id, { uom: v || null })}/>
                  : (l.uom || <span style={{color:T.text3}}>—</span>)}
              </td>
              <td style={{...ld(), textAlign:'right', fontFamily:'monospace'}}>
                {editable
                  ? <Inp value={l.unit_price_ex_gst?.toString() || ''} onChange={v => onChange(l.id, { unit_price_ex_gst: v === '' ? null : Number(v) || null })} alignRight/>
                  : fmtMoney(l.unit_price_ex_gst)}
              </td>
              <td style={{...ld(), textAlign:'right', fontFamily:'monospace'}}>
                {editable
                  ? <Inp value={l.line_total_ex_gst?.toString() || ''} onChange={v => onChange(l.id, { line_total_ex_gst: Number(v) || 0 })} alignRight/>
                  : fmtMoney(l.line_total_ex_gst)}
              </td>
              <td style={ld()}>
                {editable ? (
                  <select
                    value={l.tax_code}
                    onChange={e => onChange(l.id, { tax_code: e.target.value })}
                    style={{background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, padding:'4px 6px', borderRadius:4, fontSize:12, fontFamily:'inherit'}}
                  >
                    {['GST','FRE','CAP','EXP','GNR','ITS','N-T'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : l.tax_code}
              </td>
              <td style={ld()}>
                <AccountCell
                  line={l}
                  invoiceDefaultAccountCode={invoiceDefaultAccountCode}
                  editable={editable}
                  onPickAccount={onPickAccount}
                  onApplySuggestion={onApplySuggestion}
                />
              </td>
              {editable && (
                <td style={ld()}>
                  <button onClick={() => onRemove(l.id)} style={{background:'none', border:'none', color:T.red, cursor:'pointer', fontSize:18, padding:'4px 8px'}}>×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AccountCell({
  line, invoiceDefaultAccountCode, editable, onPickAccount, onApplySuggestion,
}: {
  line: LineRow
  invoiceDefaultAccountCode: string | null
  editable: boolean
  onPickAccount: (lineId: string) => void
  onApplySuggestion: (l: LineRow) => void
}) {
  const source = line.account_source || 'unset'
  const hasSuggestion = !line.account_uid && !!line.suggested_account_uid

  return (
    <div style={{display:'flex', flexDirection:'column', gap:4}}>
      {editable ? (
        <button
          onClick={() => onPickAccount(line.id)}
          title={line.account_name || (line.account_code ? '' : `Default: ${invoiceDefaultAccountCode || 'none'}`)}
          style={{
            background: T.bg3, border:`1px solid ${T.border2}`,
            color: line.account_code ? T.text : T.text3,
            padding:'6px 10px', borderRadius:4,
            fontSize:12, fontFamily: line.account_code ? 'monospace' : 'inherit',
            cursor:'pointer', textAlign:'left',
            width:'100%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
            minHeight: 32,
          }}
        >
          {line.account_code || `Default${invoiceDefaultAccountCode ? ` (${invoiceDefaultAccountCode})` : ''}`}
        </button>
      ) : (
        <span title={line.account_name || ''} style={{
          fontSize:11,
          color: line.account_code ? T.text : T.text3,
          fontFamily: line.account_code ? 'monospace' : 'inherit',
        }}>
          {line.account_code || `Default${invoiceDefaultAccountCode ? ` (${invoiceDefaultAccountCode})` : ''}`}
        </span>
      )}

      {source === 'rule' && <span style={badgeStyle(T.teal)}>🔁 Rule</span>}
      {source === 'history-strong' && <span style={badgeStyle(T.teal)}>🔁 Auto</span>}
      {source === 'manual' && <span style={badgeStyle(T.text3)}>✋ Manual</span>}

      {hasSuggestion && (
        <div style={{
          display:'flex', alignItems:'center', gap:6,
          fontSize:10, color:T.amber,
          background:`${T.amber}10`, border:`1px solid ${T.amber}30`,
          padding:'3px 6px', borderRadius:3,
          width:'100%',
        }}>
          <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'monospace'}}>
            💡 {line.suggested_account_code}
          </span>
          {editable && (
            <button
              onClick={() => onApplySuggestion(line)}
              style={{
                background:'transparent', border:'none', color:T.amber,
                fontSize:10, cursor:'pointer', padding:'0 2px',
                fontFamily:'inherit', whiteSpace:'nowrap',
              }}
              title={line.suggested_account_name || ''}
            >
              Use →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize:9, color,
    background:`${color}15`, border:`1px solid ${color}40`,
    padding:'1px 5px', borderRadius:3,
    width:'fit-content',
    textTransform:'uppercase', letterSpacing:'0.04em', fontWeight:500,
  }
}

function Field({ label, value, mono, align, emphasised }: { label: string; value: string | number | null | undefined; mono?: boolean; align?: 'right'; emphasised?: boolean }) {
  return (
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:2}}>{label}</div>
      <div style={{
        fontSize: emphasised ? 14 : 12,
        fontWeight: emphasised ? 600 : 400,
        color: value !== null && value !== undefined && value !== '' ? T.text : T.text3,
        fontFamily: mono ? 'monospace' : 'inherit',
        textAlign: align,
      }}>{value !== null && value !== undefined && value !== '' ? String(value) : '—'}</div>
    </div>
  )
}

function Inp({ value, onChange, alignRight }: { value: string; onChange: (v: string) => void; alignRight?: boolean }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width:'100%', boxSizing:'border-box',
        background:T.bg3, border:`1px solid ${T.border2}`, color:T.text,
        padding:'5px 8px', borderRadius:4,
        fontSize:13, fontFamily:'inherit', outline:'none',
        textAlign: alignRight ? 'right' : 'left',
      }}
    />
  )
}

function TriagePill({ status }: { status: string }) {
  const conf = status === 'green'  ? { c: T.green,  label: '🟢 GREEN' } :
               status === 'yellow' ? { c: T.amber,  label: '🟡 YELLOW' } :
               status === 'red'    ? { c: T.red,    label: '🔴 RED' } :
                                     { c: T.text3,  label: 'PENDING' }
  return <span style={{display:'inline-block', padding:'3px 9px', borderRadius:3, background:`${conf.c}15`, border:`1px solid ${conf.c}40`, color:conf.c, fontSize:10, fontWeight:600, letterSpacing:'0.05em'}}>{conf.label}</span>
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    parsing: T.text3, pending_review: T.text2, ready: T.blue,
    posted: T.green, rejected: T.text3, escalated: T.amber, error: T.red,
  }
  const c = map[status] || T.text3
  return <span style={{display:'inline-block', padding:'3px 9px', borderRadius:3, background:`${c}15`, border:`1px solid ${c}40`, color:c, fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.04em'}}>{status.replace('_',' ')}</span>
}

function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return `$${Number(n).toFixed(2)}`
}

function btnPrimary(): React.CSSProperties {
  return {
    background:T.blue, color:'#fff', border:'none',
    padding:'7px 14px', borderRadius:5, fontSize:12, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
  }
}
function btnSecondary(): React.CSSProperties {
  return {
    background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
    padding:'7px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
  }
}
function lh(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'8px 10px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function ld(): React.CSSProperties {
  return { padding:'8px 10px', verticalAlign:'top' }
}

function trimToNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null
  const t = String(s).trim()
  return t ? t : null
}
function parseNumOrNull(s: string | null | undefined): number | null {
  if (s === null || s === undefined) return null
  const t = String(s).trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
