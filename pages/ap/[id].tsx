// pages/ap/[id].tsx
// AP Invoice Detail — PDF preview, line editor with per-line account picker,
// MD job link, MYOB preset picker, approve/reject/unpost actions, delete.
//
// June 2026 — structural refactor: the inline section components
// (HeaderEditForm, MyobMappingSection, SupplierTypeahead, AccountTypeahead,
// AccountPickerModal, PaymentSection, WorkshopJobSection, LinesTable and the
// small primitives) now live under components/ap/. This file is the
// orchestrator: state, data fetching and the page layout.
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
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { useIsMobile } from '../../lib/useIsMobile'
import { T } from '../../lib/ui/theme'
import { useToast, useConfirm, usePrompt } from '../../components/ui/Feedback'
import {
  InvoiceRow, PaymentAccount, LineRow, JobInfo, HeaderEditable,
  signedAmount, fmtMoney, btnPrimary, btnSecondary,
} from '../../components/ap/shared'
import { Field } from '../../components/ap/Primitives'
import { StatusCard } from '../../components/ap/StatusCard'
import { HeaderEditForm } from '../../components/ap/HeaderEditForm'
import { MyobMappingSection } from '../../components/ap/MyobMappingSection'
import { AccountPickerModal } from '../../components/ap/AccountPickerModal'
import { PaymentSection } from '../../components/ap/PaymentSection'
import { WorkshopJobSection } from '../../components/ap/WorkshopJobSection'
import { LinesTable } from '../../components/ap/LinesTable'

interface DetailResponse {
  invoice: InvoiceRow
  lines: LineRow[]
  pdfUrl: string | null
  linkedJob: JobInfo | null
}

interface PageProps {
  user: PortalUserSSR
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

export default function APDetailPage({ user }: PageProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const toast = useToast()
  const confirmDialog = useConfirm()
  const promptDialog = usePrompt()
  const id = router.query.id as string | undefined
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingLines, setEditingLines] = useState<LineRow[] | null>(null)
  // Lines ticked for partial-merge. Only meaningful while editingLines !== null.
  // Cleared on enter-edit, cancel, save, and after any merge.
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(() => new Set())
  const [editingHeader, setEditingHeader] = useState<HeaderEditable | null>(null)
  const [savingHeader, setSavingHeader] = useState(false)
  const [headerMessage, setHeaderMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [unposting, setUnposting] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [accountPickerLineId, setAccountPickerLineId] = useState<string | null>(null)
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerResults, setPickerResults] = useState<JobInfo[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)

  const [presetOpen, setPresetOpen] = useState(false)
  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([])
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentRetrying, setPaymentRetrying] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [clearingError, setClearingError] = useState(false)
  const [togglingCredit, setTogglingCredit] = useState(false)

  async function toggleCreditNote() {
    if (!id || !data) return
    const next = !data.invoice.is_credit_note
    if (next && !(await confirmDialog({
      title: 'Mark this invoice as a CREDIT NOTE?',
      message: 'When approved, it will post to MYOB as a Bill with negative totals and (if "Mark as refunded" is ticked) auto-credit the clearing account as a Pay Refund.',
    }))) return
    if (!next && !(await confirmDialog({
      title: 'Remove credit note flag?',
      message: 'The invoice will be treated as a regular bill again — Approve will post a positive Bill and Pay Bills.',
    }))) return
    setTogglingCredit(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_credit_note: next }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `Toggle failed: ${e?.message || e}` })
    } finally {
      setTogglingCredit(false)
    }
  }

  async function clearErrors() {
    if (!id) return
    setClearingError(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myob_post_error: null, myob_payment_error: null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `Clear failed: ${e?.message || e}` })
    } finally {
      setClearingError(false)
    }
  }

  async function refreshInvoice() {
    if (!id) return
    setRefreshing(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/refresh`, {
        method: 'POST', credentials: 'same-origin',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)

      const parts: string[] = []
      parts.push(`Triage: ${json.triage?.status?.toUpperCase() || '?'}`)
      if (json.myobMatch) {
        parts.push(`MYOB has bill #${json.myobMatch.number || '?'}`)
        if (json.adoptedBillUid) parts.push('— adopted into this row')
      } else {
        parts.push('no MYOB match')
      }
      if (json.myobCheckError) parts.push(`(MYOB check failed: ${json.myobCheckError})`)
      setActionMessage({ kind: 'ok', text: '🔄 Refreshed — ' + parts.join(' · ') })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ Refresh failed: ${e?.message || e}` })
    } finally {
      setRefreshing(false)
    }
  }

  async function retryPayment() {
    if (!id) return
    setPaymentRetrying(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/retry-payment`, {
        method: 'POST', credentials: 'same-origin',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setActionMessage({ kind: 'ok', text: `✅ Payment applied — UID ${String(json.paymentUid || '').substring(0, 8)}…` })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ Retry failed: ${e?.message || e}` })
    } finally {
      setPaymentRetrying(false)
    }
  }

  // Fetch the active clearing accounts for this invoice's company file so
  // the "Mark as paid" dropdown has its options. Refetches when the
  // company file flips (rare). Failures are silent — empty list just
  // leaves the dropdown empty.
  useEffect(() => {
    if (!data?.invoice.myob_company_file) return
    const cf = data.invoice.myob_company_file
    fetch(`/api/ap/payment-accounts?company=${cf}&active=1`, { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : { accounts: [] })
      .then(j => setPaymentAccounts(j.accounts || []))
      .catch(() => setPaymentAccounts([]))
  }, [data?.invoice.myob_company_file])

  // Auto-select the Capricorn-default payment account on first view of a
  // via_capricorn invoice that doesn't yet have a payment account picked.
  // Best-effort: failures are silent. Re-runs only when the invoice ID
  // changes or the accounts list arrives.
  useEffect(() => {
    if (!data || !canEdit) return
    const inv = data.invoice
    if (inv.status === 'posted' || inv.status === 'rejected') return
    if (inv.payment_account_uid) return
    if (!inv.via_capricorn) return
    const cap = paymentAccounts.find(a => a.is_default_for_capricorn)
    if (!cap) return
    void setPaymentAccountOnInvoice({
      uid: cap.account_uid, code: cap.account_code, name: cap.account_name,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.invoice.id, paymentAccounts.length])

  async function setPaymentAccountOnInvoice(acc: { uid: string; code: string; name: string } | null) {
    if (!id) return
    setPaymentSaving(true)
    try {
      const res = await fetch(`/api/ap/${id}`, {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_account_uid:  acc?.uid  ?? null,
          payment_account_code: acc?.code ?? null,
          payment_account_name: acc?.name ?? null,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `Save payment account failed: ${e?.message || e}` })
    } finally {
      setPaymentSaving(false)
    }
  }

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
      setSelectedLineIds(new Set())
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
      toast('Link failed: ' + (e?.message || e), 'error')
    } finally {
      setLinkBusy(false)
    }
  }

  async function deleteInvoice() {
    if (!id || !data) return
    const label = `${data.invoice.vendor_name_parsed || 'this invoice'} ${data.invoice.invoice_number || ''}`.trim()
    const ok = await confirmDialog({
      title: `Delete ${label}?`,
      message: 'This permanently removes the invoice, its lines, and the PDF. This cannot be undone.',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/ap/${id}`, { method: 'DELETE', credentials: 'same-origin' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      router.push('/ap')
    } catch (e: any) {
      toast('Delete failed: ' + (e?.message || e), 'error')
      setDeleting(false)
    }
  }

  async function approveAndPost() {
    if (!id || !data) return
    const inv = data.invoice
    const isCN = inv.is_credit_note
    const isSpendMoney = !inv.resolved_supplier_uid && !!inv.payment_account_uid
    const total = inv.total_inc_gst != null ? Number(inv.total_inc_gst) : 0
    const heading = isSpendMoney
      ? `Post as SPEND MONEY to MYOB ${inv.myob_company_file}? (no supplier card)`
      : isCN
        ? `Post CREDIT NOTE to MYOB ${inv.myob_company_file}?`
        : `Post bill to MYOB ${inv.myob_company_file}?`
    const summary =
      (isSpendMoney
        ? `Spend from: ${inv.payment_account_code || ''} ${inv.payment_account_name || ''}\n`
        : `Supplier:  ${inv.resolved_supplier_name || '(not set)'}\n`) +
      `Account:   ${inv.resolved_account_code || '(per-line)'}\n` +
      `Total:     ${fmtMoney(isCN ? -total : total)}${isCN ? '   (negative bill)' : ''}\n` +
      `Inv #:     ${inv.invoice_number}\n` +
      `Date:      ${inv.invoice_date}\n` +
      (inv.via_capricorn && inv.capricorn_reference ? `Capricorn: ${inv.capricorn_reference}\n` : '') +
      (inv.linked_job_number ? `Job:       ${inv.linked_job_number}\n` : '') +
      (!isSpendMoney && inv.payment_account_uid
        ? `${isCN ? 'Refund to:' : 'Pay from: '} ${inv.payment_account_code || ''} ${inv.payment_account_name || ''} (auto-applied)\n`
        : '')
    if (!(await confirmDialog({ title: heading, message: summary }))) return
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

  async function setTriageOverride() {
    if (!id) return
    const reason = await promptDialog({
      title: 'Override triage to GREEN',
      label: 'Reason? (audit-logged; optional but recommended)',
    })
    if (reason === null) return // user cancelled
    setOverriding(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/triage-override`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setActionMessage({ kind: 'ok', text: '✅ Triage overridden to GREEN' })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ Override failed: ${e?.message || e}` })
    } finally {
      setOverriding(false)
    }
  }

  async function clearTriageOverride() {
    if (!id) return
    if (!(await confirmDialog({ title: 'Clear triage override and let triage recompute naturally?' }))) return
    setOverriding(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/ap/${id}/triage-override`, {
        method: 'DELETE', credentials: 'same-origin',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setActionMessage({ kind: 'ok', text: 'Override cleared' })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ Clear failed: ${e?.message || e}` })
    } finally {
      setOverriding(false)
    }
  }

  async function rejectInvoice() {
    if (!id) return
    const reason = await promptDialog({
      title: 'Reason for rejecting this invoice?',
      label: 'Will be stored on the record. Required.',
    })
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
      `Vendor:  ${inv.vendor_name_parsed || '?'}\n` +
      `Inv #:   ${inv.invoice_number || '?'}\n` +
      `Total:   ${fmtMoney(inv.total_inc_gst)}\n` +
      (inv.myob_bill_uid ? `MYOB UID: ${inv.myob_bill_uid.substring(0, 8)}…\n` : '') +
      `\n` +
      `Use this when the bill has been deleted in MYOB and you need to re-enter it.\n\n` +
      `The invoice will go back to pending_review. When you re-approve, the system\n` +
      `will check MYOB first — if the bill still exists it'll just re-link, otherwise\n` +
      `it'll create a fresh one.`
    if (!(await confirmDialog({ title: 'Un-post this invoice?', message: confirmMsg }))) return

    const reason = await promptDialog({
      title: 'Reason for un-posting?',
      label: 'Optional, stored as audit note',
      defaultValue: 'Bill deleted in MYOB',
    })
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
    // Pre-flip signs for credit notes so the editor mirrors what the user
    // sees in the read-only card. saveHeader takes Math.abs to write the
    // magnitude back to the DB (sign lives on the is_credit_note flag).
    const flip = (v: number | null) => v == null ? '' : String(signedAmount(Number(v), inv.is_credit_note))
    setEditingHeader({
      vendor_name_parsed: inv.vendor_name_parsed || '',
      vendor_abn:         inv.vendor_abn || '',
      invoice_number:     inv.invoice_number || '',
      invoice_date:       (inv.invoice_date || '').substring(0, 10),
      po_number:          inv.po_number || '',
      due_date:           (inv.due_date || '').substring(0, 10),
      subtotal_ex_gst:    flip(inv.subtotal_ex_gst),
      gst_amount:         flip(inv.gst_amount),
      total_inc_gst:      flip(inv.total_inc_gst),
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
      // Credit notes are stored as positive magnitudes — sign lives on the
      // is_credit_note flag. Take Math.abs to strip whatever sign the user
      // typed (or that the pre-flipped form fed in).
      const isCN = data?.invoice.is_credit_note === true
      const absMoney = (s: string) => {
        const n = parseNumOrNull(s)
        if (n == null) return null
        return isCN ? Math.abs(n) : n
      }
      const body: Record<string, any> = {
        vendor_name_parsed: trimToNull(editingHeader.vendor_name_parsed),
        vendor_abn:         trimToNull(editingHeader.vendor_abn),
        invoice_number:     trimToNull(editingHeader.invoice_number),
        invoice_date:       trimToNull(editingHeader.invoice_date),
        po_number:          trimToNull(editingHeader.po_number),
        due_date:           trimToNull(editingHeader.due_date),
        subtotal_ex_gst:    absMoney(editingHeader.subtotal_ex_gst),
        gst_amount:         absMoney(editingHeader.gst_amount),
        total_inc_gst:      absMoney(editingHeader.total_inc_gst),
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
    // Pre-flip the line numbers for credit-note display so the editor
    // matches the read-only view. saveLines re-applies Math.abs to write
    // positive magnitudes back to the DB.
    const isCN = data.invoice.is_credit_note === true
    const flip = (n: number | null | undefined) => {
      if (n == null) return n ?? null
      return isCN ? -Number(n) : Number(n)
    }
    setEditingLines(data.lines.map(l => ({
      ...l,
      unit_price_ex_gst: flip(l.unit_price_ex_gst),
      line_total_ex_gst: flip(l.line_total_ex_gst) ?? 0,
      gst_amount:        flip(l.gst_amount),
    })))
    setSelectedLineIds(new Set())
  }
  function toggleLineSelected(lineId: string) {
    setSelectedLineIds(prev => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }
  function cancelEdit() {
    setEditingLines(null)
    setSelectedLineIds(new Set())
    setSaveMessage(null)
    setAccountPickerLineId(null)
  }
  function updateLine(lineId: string, patch: Partial<LineRow>) {
    if (!editingLines) return
    setEditingLines(editingLines.map(l => l.id === lineId ? { ...l, ...patch } : l))
  }
  // Collapse the given lines into a single line, in-place. Useful for
  // invoices where the parser produced many tiny rows that really
  // should book against a single account, or where a few lines (e.g.
  // freight + handling) belong together but the rest are fine as-is.
  // Description is the concatenation; totals are summed; account taken
  // from the first selected line that has one (preserves a manual
  // pick); tax_code from the majority of the selected lines.
  async function mergeLines(idsToMerge: string[]) {
    if (!editingLines || !data) return
    const idSet = new Set(idsToMerge)
    const subset = editingLines.filter(l => idSet.has(l.id))
    if (subset.length < 2) return

    const isAll = subset.length === editingLines.length
    const ok = await confirmDialog(isAll
      ? {
          title: `Merge all ${subset.length} lines into one?`,
          message: 'Descriptions will be joined, line totals summed, qty cleared. Account is taken from the first line that has one. You can still tweak before saving.',
        }
      : {
          title: `Merge ${subset.length} selected lines into one?`,
          message: 'Descriptions will be joined, line totals summed, qty cleared. Account is taken from the first selected line that has one. Other lines are left as-is. You can still tweak before saving.',
        })
    if (!ok) return

    const total = subset.reduce((s, l) => s + Number(l.line_total_ex_gst || 0), 0)
    const description = subset
      .map(l => [l.part_number, l.description].filter(Boolean).join(' '))
      .map(s => s.trim())
      .filter(Boolean)
      .join(' · ')
      .slice(0, 4000)

    // Tax code = majority vote among the selected lines, default GST.
    const taxCounts = new Map<string, number>()
    for (const l of subset) {
      const tc = (l.tax_code || 'GST').toUpperCase()
      taxCounts.set(tc, (taxCounts.get(tc) || 0) + 1)
    }
    const taxCode = Array.from(taxCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'GST'

    // Account = first selected line that has one. Prefer manual picks.
    const withAccount = subset.find(l => !!l.account_uid && l.account_source === 'manual')
                     ?? subset.find(l => !!l.account_uid)
    const merged: LineRow = {
      id: `new-${Date.now()}`,
      invoice_id: data.invoice.id,
      // Renumbered below — placeholder for now.
      line_no: 0,
      part_number: null,
      description: description || '(merged line)',
      qty: null,
      uom: null,
      unit_price_ex_gst: total,
      line_total_ex_gst: total,
      gst_amount: null,
      tax_code: taxCode,
      account_uid:    withAccount?.account_uid    ?? null,
      account_code:   withAccount?.account_code   ?? null,
      account_name:   withAccount?.account_name   ?? null,
      account_source: withAccount?.account_uid    ? 'manual' : 'unset',
      suggested_account_uid:  null,
      suggested_account_code: null,
      suggested_account_name: null,
    }

    // Rebuild the list: put the merged row at the position of the first
    // selected line, drop the rest of the selection. Then renumber the
    // whole list 1..N so line_no stays contiguous and predictable.
    const firstIdx = editingLines.findIndex(l => idSet.has(l.id))
    const next: LineRow[] = []
    let inserted = false
    editingLines.forEach((l, i) => {
      if (idSet.has(l.id)) {
        if (!inserted && i === firstIdx) {
          next.push(merged)
          inserted = true
        }
        // Otherwise drop this selected line.
      } else {
        next.push(l)
      }
    })
    const renumbered = next.map((l, i) => ({ ...l, line_no: i + 1 }))
    setEditingLines(renumbered)
    setSelectedLineIds(new Set())
    setAccountPickerLineId(null)
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
      // Credit notes are stored as positive magnitudes; the user has been
      // editing negative-displayed values so flip back to abs on save.
      const isCN = data?.invoice.is_credit_note === true
      const absNum = (n: number | null | undefined) => {
        if (n == null) return n ?? null
        return isCN ? Math.abs(n) : n
      }
      const payload = editingLines.map(l => ({
        line_no: l.line_no,
        part_number: l.part_number,
        description: l.description,
        qty: l.qty,
        uom: l.uom,
        unit_price_ex_gst: absNum(l.unit_price_ex_gst),
        line_total_ex_gst: absNum(l.line_total_ex_gst) ?? 0,
        gst_amount: absNum(l.gst_amount),
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
  // Approve path:
  //   - supplier mapped              → posts as Service Bill
  //   - no supplier + payment account → posts as Spend Money (no supplier needed)
  //   - no supplier + no payment acct → blocked
  const willPostAsSpendMoney = !!data && !data.invoice.resolved_supplier_uid && !!data.invoice.payment_account_uid
  const canApprove = canEdit && data
                  && !isTerminal
                  && data.invoice.triage_status !== 'red'
                  && (!!data.invoice.resolved_supplier_uid || !!data.invoice.payment_account_uid)
                  && hasAccountFallbackOrPerLine
                  && !(willPostAsSpendMoney && data.invoice.is_credit_note)
  const approveBlockedReason =
    !data ? '' :
    isPosted   ? 'Already posted' :
    isRejected ? 'Invoice rejected' :
    data.invoice.triage_status === 'red' ? 'Triage RED — fix issues' :
    (!data.invoice.resolved_supplier_uid && !data.invoice.payment_account_uid)
      ? 'No MYOB supplier mapped — either map a supplier or pick a clearing account under "Mark as paid" to post as Spend Money'
      : !hasAccountFallbackOrPerLine ? 'Some lines have no account and no default account is set'
      : (willPostAsSpendMoney && data.invoice.is_credit_note)
        ? 'No-supplier credit notes cannot be posted as Spend Money — assign a supplier or handle in MYOB'
        : ''

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
    <div style={{display:'flex', flexDirection:'column', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:"'DM Sans', system-ui, sans-serif"}}>
      <PortalTopBar
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
          {data && canEdit && !isMobile && (
            <>
              <span style={{flex:1}}/>
              <button
                onClick={refreshInvoice}
                disabled={refreshing}
                title="Re-run triage, dup checks, line resolver and look up MYOB for an existing bill with this supplier-invoice-number"
                style={{
                  background:'transparent',
                  border:`1px solid ${T.border2}`,
                  color: T.text2,
                  padding:'5px 11px', borderRadius:5,
                  fontSize:11, fontFamily:'inherit',
                  cursor: refreshing ? 'wait' : 'pointer',
                  opacity: refreshing ? 0.6 : 1,
                }}
              >
                {refreshing ? 'Refreshing…' : '🔄 Refresh'}
              </button>
              {!isPosted && (
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
              )}
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

              <StatusCard
                invoice={data.invoice}
                canEdit={canEdit}
                isMobile={isMobile}
                isTerminal={isTerminal}
                isPosted={isPosted}
                isRejected={isRejected}
                approving={approving}
                rejecting={rejecting}
                overriding={overriding}
                unposting={unposting}
                clearingError={clearingError}
                canApprove={!!canApprove}
                approveBlockedReason={approveBlockedReason}
                willPostAsSpendMoney={willPostAsSpendMoney}
                actionMessage={actionMessage}
                onClearErrors={clearErrors}
                onClearTriageOverride={clearTriageOverride}
                onSetTriageOverride={setTriageOverride}
                onReject={rejectInvoice}
                onApprove={approveAndPost}
                onUnpost={unpostInvoice}
              />

              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
                  <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Invoice</div>
                  <div style={{display:'flex', gap:8, flexWrap:'wrap'}}>
                    {canEdit && !isTerminal && (
                      <button
                        onClick={toggleCreditNote}
                        disabled={togglingCredit}
                        title={data.invoice.is_credit_note
                          ? 'Currently flagged as a credit note (totals shown as negative). Click to unmark.'
                          : 'Flag this document as a credit note. Totals will display as negative; when approved it posts to MYOB as a negative Bill and auto-credits the clearing account.'}
                        style={{
                          background: data.invoice.is_credit_note ? `${T.red}20` : 'transparent',
                          border:`1px solid ${data.invoice.is_credit_note ? T.red : T.border2}`,
                          color: data.invoice.is_credit_note ? T.red : T.text2,
                          padding:'5px 11px', borderRadius:5,
                          fontSize:11, fontFamily:'inherit', fontWeight: data.invoice.is_credit_note ? 600 : 400,
                          cursor: togglingCredit ? 'wait' : 'pointer',
                          opacity: togglingCredit ? 0.6 : 1,
                        }}>
                        {togglingCredit
                          ? '…'
                          : data.invoice.is_credit_note
                            ? '✓ Credit note'
                            : 'Mark as credit note'}
                      </button>
                    )}
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
                      <Field label="Subtotal"      value={fmtMoney(signedAmount(data.invoice.subtotal_ex_gst, data.invoice.is_credit_note))} mono align="right"/>
                      <Field label="GST"           value={fmtMoney(signedAmount(data.invoice.gst_amount, data.invoice.is_credit_note))}      mono align="right"/>
                      <Field label="Total inc GST" value={fmtMoney(signedAmount(data.invoice.total_inc_gst, data.invoice.is_credit_note))}   mono align="right" emphasised/>
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

              <PaymentSection
                invoice={data.invoice}
                accounts={paymentAccounts}
                canEdit={canEdit && !isTerminal}
                canRetry={canEdit}
                busy={paymentSaving}
                retryBusy={paymentRetrying}
                onChange={setPaymentAccountOnInvoice}
                onRetryPayment={retryPayment}
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
                        {selectedLineIds.size >= 2 && (
                          <button
                            onClick={() => mergeLines(Array.from(selectedLineIds))}
                            title="Combine the ticked lines into one (descriptions joined, totals summed); leaves the rest alone"
                            style={btnSecondary()}>
                            ⇊ Merge selected ({selectedLineIds.size})
                          </button>
                        )}
                        {editingLines.length >= 2 && (
                          <button
                            onClick={() => mergeLines(editingLines.map(l => l.id))}
                            title="Combine ALL lines into one (descriptions joined, totals summed)"
                            style={btnSecondary()}>
                            ⇊ Merge into one
                          </button>
                        )}
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
                  lines={editingLines ?? (
                    data.invoice.is_credit_note
                      ? data.lines.map(l => ({
                          ...l,
                          unit_price_ex_gst: l.unit_price_ex_gst != null ? -Number(l.unit_price_ex_gst) : null,
                          line_total_ex_gst: l.line_total_ex_gst != null ? -Number(l.line_total_ex_gst) : 0,
                          gst_amount:        l.gst_amount != null ? -Number(l.gst_amount) : null,
                        }))
                      : data.lines
                  )}
                  invoiceDefaultAccountCode={data.invoice.resolved_account_code}
                  editable={editingLines !== null}
                  selectedIds={selectedLineIds}
                  onToggleSelect={toggleLineSelected}
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
          {data.invoice.triage_override === 'green' ? (
            <button
              onClick={clearTriageOverride}
              disabled={overriding || approving || rejecting}
              style={{
                flex: '0 0 auto',
                background:'transparent', border:`1px solid ${T.amber}60`, color:T.amber,
                padding:'12px 12px', borderRadius:8,
                fontSize:13, fontFamily:'inherit',
                cursor: overriding ? 'wait' : 'pointer',
                opacity: overriding ? 0.6 : 1,
                minHeight: 48,
              }}>
              {overriding ? '…' : 'Clear OR'}
            </button>
          ) : data.invoice.triage_status !== 'red' && data.invoice.triage_status !== 'green' && (
            <button
              onClick={setTriageOverride}
              disabled={overriding || approving || rejecting}
              style={{
                flex: '0 0 auto',
                background:'transparent', border:`1px solid ${T.green}60`, color:T.green,
                padding:'12px 12px', borderRadius:8,
                fontSize:13, fontFamily:'inherit',
                cursor: overriding ? 'wait' : 'pointer',
                opacity: overriding ? 0.6 : 1,
                minHeight: 48,
              }}>
              {overriding ? '…' : '→ 🟢'}
            </button>
          )}
          <button
            onClick={rejectInvoice}
            disabled={rejecting || approving || overriding}
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
