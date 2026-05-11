// pages/ap/index.tsx
// AP Invoice Processor — triage list with upload, filters, description
// column, per-row + bulk Approve, and Pull from Inbox.
//
// Approval rules (UX side; the API enforces too):
//   - Per-row Approve is offered when the invoice's triage is GREEN and
//     status is not already 'posted' or 'rejected'. Anything else is
//     either still being triaged or has been finalised.
//   - Bulk Approve operates on selected approvable rows. Non-approvable
//     rows can't be ticked.
//
// **Bulk approve batching:** the client chunks selectedApprovableIds into
// batches of BULK_BATCH_SIZE (3) and POSTs each batch sequentially to
// /api/ap/bulk-approve. This keeps each backend call short enough to
// finish well within Vercel's serverless function time budget — even if
// each invoice takes 15-20s for POST + PDF attach, three at a time is
// ~60s max per call. Progress is shown to the user as batches complete.
//
// **Adopted-on-dup:** when MYOB already has a bill matching the same
// SupplierInvoiceNumber + Supplier UID, the backend now adopts that
// existing UID and marks the invoice as posted (rather than throwing
// "Duplicate in MYOB"). The UI surfaces this with a `↷ adopted` label so
// the operator can tell apart freshly-posted bills from reconciled ones.
//
// **Mobile (Phase 1):** below 768px the dense data table is replaced with
// a stack of `InvoiceCard`s. Each card shows triage + vendor + invoice #
// + total + (when approvable) a big tappable Approve button. The desktop
// table layout is untouched on >=768px.
//
// **Statement reconcile (May 2026):** a button in the header navigates to
// /ap/statement where users upload a supplier statement PDF and get back
// a list of which lines exist in MYOB and which are missing/mismatched.
// Gated to canEdit since the underlying API requires edit:supplier_invoices.

import { useState, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/router'
import { GetServerSideProps } from 'next'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'
import { useIsMobile } from '../../lib/useIsMobile'

const BULK_BATCH_SIZE = 3

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface InvoiceRow {
  id: string
  source: 'email' | 'upload'
  received_at: string
  pdf_filename: string | null
  vendor_name_parsed: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  subtotal_ex_gst: number | null
  gst_amount: number | null
  total_inc_gst: number | null
  via_capricorn: boolean
  capricorn_reference: string | null
  parse_confidence: 'high' | 'medium' | 'low' | null
  resolved_supplier_uid: string | null
  resolved_supplier_name: string | null
  resolved_account_code: string | null
  payment_account_uid: string | null
  payment_account_code: string | null
  payment_account_name: string | null
  triage_status: 'pending' | 'green' | 'yellow' | 'red'
  triage_reasons: string[] | null
  status: 'parsing' | 'pending_review' | 'ready' | 'posted' | 'rejected' | 'escalated' | 'error'
  myob_company_file: 'VPS' | 'JAWS'
  myob_bill_uid: string | null
  myob_posted_at: string | null
  line_summary: string | null
}

interface ListResponse {
  invoices: InvoiceRow[]
  total: number
  limit: number
  offset: number
  counts: {
    red: number; yellow: number; green: number
    pending: number; ready: number; posted: number
  }
}

interface PageProps {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

function isApprovable(inv: InvoiceRow): boolean {
  return inv.triage_status === 'green'
      && inv.status !== 'posted'
      && inv.status !== 'rejected'
}

// Spend Money (no-supplier) eligibility: invoice has no supplier
// mapped but does have a payment/clearing account selected, and
// hasn't been posted/rejected yet. Triage doesn't have to be green
// since the typical reason for no-supplier rows being non-green is
// "supplier not mapped" — and Spend Money explicitly doesn't need one.
function isSpendMoneyEligible(inv: InvoiceRow): boolean {
  return !inv.resolved_supplier_uid
      && !!inv.payment_account_uid
      && inv.status !== 'posted'
      && inv.status !== 'rejected'
}

export default function APListPage({ user }: PageProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [triageFilter, setTriageFilter] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [uploadMessage, setUploadMessage] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [bulkApproving, setBulkApproving] = useState(false)
  const [approveMessage, setApproveMessage] = useState<string | null>(null)

  const [pulling, setPulling] = useState(false)
  const [pullMessage, setPullMessage] = useState<string | null>(null)

  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  async function fetchData() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (triageFilter) params.set('triage', triageFilter)
      if (search.trim()) params.set('q', search.trim())
      const res = await fetch(`/api/ap?${params.toString()}`, { credentials: 'same-origin' })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const json: ListResponse = await res.json()
      setData(json)
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [statusFilter, triageFilter])
  useEffect(() => {
    const t = setTimeout(fetchData, 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    if (!data) return
    const visible = new Set(data.invoices.map(i => i.id))
    let changed = false
    const next = new Set<string>()
    selectedIds.forEach(id => {
      if (visible.has(id)) next.add(id)
      else changed = true
    })
    if (changed) setSelectedIds(next)
  }, [data])

  const approvableVisibleIds = useMemo(
    () => new Set((data?.invoices || []).filter(isApprovable).map(i => i.id)),
    [data]
  )
  const selectedApprovableIds = useMemo(
    () => Array.from(selectedIds).filter(id => approvableVisibleIds.has(id)),
    [selectedIds, approvableVisibleIds]
  )

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds(prev => {
      const allSelected = approvableVisibleIds.size > 0
        && Array.from(approvableVisibleIds).every(id => prev.has(id))
      if (allSelected) return new Set()
      return new Set(approvableVisibleIds)
    })
  }

  async function handleFile(file: File) {
    if (!file) return
    setUploading(true)
    setUploadMessage(null)
    try {
      const buf = await file.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      const chunkSize = 32 * 1024
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
        binary += String.fromCharCode.apply(null, slice as any)
      }
      const pdfBase64 = btoa(binary)

      const res = await fetch('/api/ap/upload', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64, filename: file.name }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setUploadMessage(`✅ Uploaded "${file.name}" — vendor: ${json.extraction?.vendor?.name || 'unknown'}, total: $${json.extraction?.totalIncGst?.toFixed(2) || '?'}`)
      fetchData()
      if (json.invoiceId) {
        setTimeout(() => router.push(`/ap/${json.invoiceId}`), 800)
      }
    } catch (e: any) {
      setUploadMessage(`❌ Upload failed: ${e?.message || e}`)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(inv: InvoiceRow, e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    const label = `${inv.vendor_name_parsed || 'this invoice'} ${inv.invoice_number || ''}`.trim()
    const ok = confirm(`Delete ${label}?\n\nThis permanently removes the invoice, its lines, and the PDF. This cannot be undone.`)
    if (!ok) return
    setDeletingId(inv.id)
    try {
      const res = await fetch(`/api/ap/${inv.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      if (data) {
        setData({ ...data, invoices: data.invoices.filter(i => i.id !== inv.id), total: Math.max(0, data.total - 1) })
      }
      fetchData()
    } catch (err: any) {
      alert('Delete failed: ' + (err?.message || err))
    } finally {
      setDeletingId(null)
    }
  }

  async function handleApproveOne(inv: InvoiceRow, e: React.MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    setApprovingId(inv.id)
    setApproveMessage(null)
    try {
      const res = await fetch(`/api/ap/${inv.id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)

      const billUidShort = (json.myobBillUid || '').substring(0, 8)
      const att = json.attachmentStatus
      const attLabel = att === 'attached' ? '📎 PDF attached'
                     : att === 'adopted'  ? `↷ Already in MYOB (#${json.adoptedBillNumber || '?'}) — adopted as posted`
                     : att === 'failed'   ? `⚠️ PDF attach failed: ${json.attachmentError || ''}`
                     : att === 'no-pdf'   ? '(no PDF on file)'
                     : '(attachment skipped)'
      const verb = json.adopted ? 'Reconciled' : 'Posted'
      setApproveMessage(`✅ ${verb} "${inv.vendor_name_parsed} ${inv.invoice_number}" — bill ${billUidShort}… · ${attLabel}`)
      fetchData()
    } catch (err: any) {
      setApproveMessage(`❌ ${inv.vendor_name_parsed} ${inv.invoice_number}: ${err?.message || err}`)
    } finally {
      setApprovingId(null)
    }
  }

  async function handleBulkApprove() {
    if (selectedApprovableIds.length === 0) return
    const ok = confirm(`Approve & post ${selectedApprovableIds.length} invoice(s) to MYOB?\n\nProcessed in batches of ${BULK_BATCH_SIZE} to stay within timeout limits. Progress shown as each batch completes.`)
    if (!ok) return

    setBulkApproving(true)
    setApproveMessage(null)

    const allIds = [...selectedApprovableIds]
    const batches: string[][] = []
    for (let i = 0; i < allIds.length; i += BULK_BATCH_SIZE) {
      batches.push(allIds.slice(i, i + BULK_BATCH_SIZE))
    }

    let totalSucceeded = 0
    let totalFailed = 0
    let totalAttached = 0
    let totalAttachFail = 0
    let totalAdopted = 0
    let processedSoFar = 0
    const allFails: any[] = []
    let firstError: string | null = null

    try {
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]
        setApproveMessage(`⏳ Batch ${i + 1}/${batches.length} (${processedSoFar}/${allIds.length} done)…`)

        try {
          const res = await fetch('/api/ap/bulk-approve', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceIds: batch }),
          })
          const json = await res.json().catch(() => ({}))

          if (!res.ok) {
            if (!firstError) firstError = json.error || `HTTP ${res.status}`
            totalFailed += batch.length
          } else {
            const s = json.summary || {}
            totalSucceeded  += (s.succeeded  || 0)
            totalFailed     += (s.failed     || 0)
            totalAttached   += (s.attached   || 0)
            totalAttachFail += (s.attachFail || 0)
            const adopted = (json.results || []).filter((r: any) => r.ok && r.attachmentStatus === 'adopted')
            totalAdopted += adopted.length
            const fails = (json.results || []).filter((r: any) => !r.ok)
            allFails.push(...fails)
          }
        } catch (e: any) {
          if (!firstError) firstError = e?.message || String(e)
          totalFailed += batch.length
        }

        processedSoFar += batch.length
      }

      const parts = [`✅ Posted ${totalSucceeded}/${allIds.length}`]
      if (totalAdopted > 0)    parts.push(`↷ ${totalAdopted} adopted`)
      if (totalAttached > 0)   parts.push(`📎 ${totalAttached} attached`)
      if (totalAttachFail > 0) parts.push(`⚠️ ${totalAttachFail} attach failed`)
      if (totalFailed > 0)     parts.push(`❌ ${totalFailed} failed`)
      const summaryMsg = parts.join(' · ')

      if (firstError && totalSucceeded === 0) {
        setApproveMessage(`❌ Bulk approve failed: ${firstError}`)
      } else {
        setApproveMessage(summaryMsg)
      }

      if (allFails.length > 0) {
        console.error('Bulk approve failures:', allFails)
      }

      setSelectedIds(new Set())
      fetchData()
    } catch (err: any) {
      setApproveMessage(`❌ Bulk approve failed: ${err?.message || err}`)
    } finally {
      setBulkApproving(false)
    }
  }

  async function handlePullInbox() {
    setPulling(true)
    setPullMessage(null)
    try {
      const res = await fetch('/api/ap/pull-inbox', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceDays: 30 }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const parts = [json.error, json.detail].filter(Boolean)
        const mailboxNote = json.mailbox ? ` (mailbox: ${json.mailbox})` : ''
        throw new Error((parts.join(' — ') || `HTTP ${res.status}`) + mailboxNote)
      }

      const s = json.summary
      const parts = [`📥 Scanned ${s.scanned}`]
      if (s.ingested > 0)   parts.push(`✅ ${s.ingested} ingested`)
      if (s.duplicates > 0) parts.push(`↷ ${s.duplicates} already done`)
      if (s.skipped > 0)    parts.push(`◌ ${s.skipped} skipped`)
      if (s.failed > 0)     parts.push(`❌ ${s.failed} failed`)
      setPullMessage(parts.join(' · '))

      if (s.failed > 0) {
        const fails = (json.results || []).filter((r: any) => r.status === 'failed')
        console.error('Pull failures:', fails)
      }

      fetchData()
    } catch (err: any) {
      setPullMessage(`❌ Pull failed: ${err?.message || err}`)
    } finally {
      setPulling(false)
    }
  }

  const headerCheckboxState: 'unchecked' | 'partial' | 'checked' =
    approvableVisibleIds.size === 0 ? 'unchecked'
    : Array.from(approvableVisibleIds).every(id => selectedIds.has(id)) ? 'checked'
    : selectedApprovableIds.length > 0 ? 'partial'
    : 'unchecked'

  // Mobile-aware container padding — leaner on phones.
  const pagePad = isMobile ? '14px 14px 80px' : '24px 32px'

  return (
    <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:"'DM Sans', system-ui, sans-serif"}}>
      <PortalSidebar
        activeId="ap"
        currentUserRole={user.role}
        currentUserVisibleTabs={user.visibleTabs}
        currentUserName={user.displayName || user.email}
        currentUserEmail={user.email}
      />

      <div style={{flex:1, padding: pagePad, overflow:'auto'}}>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:6, gap:10, flexWrap:'wrap'}}>
          <h1 style={{fontSize: isMobile ? 18 : 22, fontWeight:600, margin:0}}>AP Invoices</h1>
          {!isMobile && <div style={{fontSize:11, color:T.text3}}>VPS · supplier invoices via email + manual upload</div>}
        </div>
        {!isMobile && (
          <div style={{fontSize:12, color:T.text3, marginBottom:18}}>Triage incoming invoices, edit lines, and post to MYOB.</div>
        )}

        {data && (
          <div style={{
            background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10,
            padding: isMobile ? '12px 14px' : '14px 18px',
            marginBottom:14,
            display:'flex', flexWrap:'wrap',
            gap: isMobile ? 16 : 24,
            alignItems:'center',
          }}>
            <Stat n={data.counts.red}     label="Red"     color={T.red}/>
            <Stat n={data.counts.yellow}  label="Yellow"  color={T.amber}/>
            <Stat n={data.counts.green}   label="Green"   color={T.green}/>
            {!isMobile && (
              <>
                <span style={{flex:1}}/>
                <Stat n={data.counts.pending} label="Pending review" color={T.text2}/>
                <Stat n={data.counts.ready}   label="Ready"          color={T.blue}/>
                <Stat n={data.counts.posted}  label="Posted"         color={T.text3}/>
              </>
            )}
          </div>
        )}

        {/* Filter bar — pills wrap on mobile, search and action buttons go full-width below */}
        <div style={{display:'flex', flexWrap:'wrap', gap:8, alignItems:'center', marginBottom:14}}>
          <Pill active={statusFilter===''}                 onClick={()=>setStatusFilter('')}                  label="All"/>
          <Pill active={statusFilter==='pending_review'}   onClick={()=>setStatusFilter('pending_review')}    label="Pending"/>
          <Pill active={statusFilter==='ready'}            onClick={()=>setStatusFilter('ready')}             label="Ready"/>
          <Pill active={statusFilter==='posted'}           onClick={()=>setStatusFilter('posted')}            label="Posted"/>
          {!isMobile && <Pill active={statusFilter==='rejected'} onClick={()=>setStatusFilter('rejected')} label="Rejected"/>}
          <span style={{width: isMobile ? 4 : 14}}/>
          <Pill active={triageFilter==='red'}    onClick={()=>setTriageFilter(triageFilter==='red'?'':'red')}     label="🔴"   color={T.red}/>
          <Pill active={triageFilter==='yellow'} onClick={()=>setTriageFilter(triageFilter==='yellow'?'':'yellow')} label="🟡" color={T.amber}/>
          <Pill active={triageFilter==='green'}  onClick={()=>setTriageFilter(triageFilter==='green'?'':'green')}   label="🟢" color={T.green}/>
          {!isMobile && <span style={{flex:1}}/>}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search vendor / invoice #…"
            style={{
              background: T.bg2, border: `1px solid ${T.border2}`, color: T.text,
              padding: '8px 12px', borderRadius: 6,
              fontSize: 16,                              // 16px prevents iOS zoom-on-focus
              fontFamily:'inherit',
              minWidth: isMobile ? 0 : 240,
              flex: isMobile ? '1 1 100%' : '0 1 auto',
              outline:'none',
            }}
          />
          {canEdit && (
            <>
              <button
                onClick={() => router.push('/ap/statement')}
                title="Cross-check a supplier statement against MYOB"
                style={{
                  background:'transparent', color:T.text, border:`1px solid ${T.border2}`,
                  padding: isMobile ? '10px 14px' : '8px 12px',
                  borderRadius:6,
                  fontSize: isMobile ? 13 : 12,
                  fontFamily:'inherit',
                  cursor:'pointer',
                  flex: isMobile ? '1 1 0' : '0 0 auto',
                }}
              >
                📊 Statement
              </button>
              <button
                disabled={pulling}
                onClick={handlePullInbox}
                title="Fetch new invoices from accounts@ inbox"
                style={{
                  background:'transparent', color:T.text, border:`1px solid ${T.border2}`,
                  padding: isMobile ? '10px 14px' : '8px 12px',
                  borderRadius:6,
                  fontSize: isMobile ? 13 : 12,
                  fontFamily:'inherit',
                  cursor: pulling ? 'wait' : 'pointer', opacity: pulling ? 0.6 : 1,
                  flex: isMobile ? '1 1 0' : '0 0 auto',
                }}
              >
                {pulling ? 'Pulling…' : '📥 Pull Inbox'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                style={{display:'none'}}
              />
              <button
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                style={{
                  background: T.blue, color: '#fff', border:'none',
                  padding: isMobile ? '10px 14px' : '8px 14px',
                  borderRadius: 6,
                  fontSize: isMobile ? 13 : 12,
                  fontWeight: 500, fontFamily:'inherit',
                  cursor: uploading ? 'wait' : 'pointer',
                  opacity: uploading ? 0.6 : 1,
                  flex: isMobile ? '1 1 0' : '0 0 auto',
                }}
              >
                {uploading ? 'Uploading…' : '+ Upload PDF'}
              </button>
            </>
          )}
        </div>

        {canEdit && selectedApprovableIds.length > 0 && (
          <div style={{
            background:`${T.green}10`, border:`1px solid ${T.green}40`, borderRadius:7,
            padding: isMobile ? '10px 12px' : '8px 12px',
            marginBottom:10,
            display:'flex', gap:10, alignItems:'center', flexWrap:'wrap',
            fontSize:12,
          }}>
            <span style={{color:T.green, fontWeight:500}}>
              {selectedApprovableIds.length} selected
            </span>
            <button
              onClick={handleBulkApprove}
              disabled={bulkApproving}
              style={{
                background: T.green, color:'#fff', border:'none',
                padding: isMobile ? '9px 14px' : '6px 12px',
                borderRadius:5, fontSize:12, fontWeight:500, fontFamily:'inherit',
                cursor: bulkApproving ? 'wait' : 'pointer', opacity: bulkApproving ? 0.6 : 1,
                flex: isMobile ? '1 1 100%' : '0 0 auto',
              }}
            >
              {bulkApproving ? 'Posting to MYOB…' : `✓ Approve & Post ${selectedApprovableIds.length}`}
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkApproving}
              style={{
                background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
                padding:'7px 11px', borderRadius:5, fontSize:11, fontFamily:'inherit',
                cursor: bulkApproving ? 'wait' : 'pointer',
              }}
            >
              Clear selection
            </button>
            {!isMobile && selectedApprovableIds.length > BULK_BATCH_SIZE && (
              <span style={{color:T.text3, fontSize:11}}>
                · processed in batches of {BULK_BATCH_SIZE}
              </span>
            )}
          </div>
        )}

        {pullMessage && <Banner kind={pullMessage.startsWith('❌') ? 'err' : 'ok'}>{pullMessage}</Banner>}
        {approveMessage && <Banner kind={approveMessage.startsWith('❌') ? 'err' : approveMessage.startsWith('⏳') ? 'info' : 'ok'}>{approveMessage}</Banner>}
        {uploadMessage && <Banner kind={uploadMessage.startsWith('❌') ? 'err' : 'ok'}>{uploadMessage}</Banner>}

        {error && (
          <div style={{background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:7, padding:10, color:T.red, fontSize:12, marginBottom:12}}>
            <strong>Failed to load:</strong> {error}
          </div>
        )}

        {/* ─── MOBILE: card stack ─── */}
        {isMobile && (
          <div style={{display:'flex', flexDirection:'column', gap:10}}>
            {loading && !data && (
              <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</div>
            )}
            {data && data.invoices.length === 0 && (
              <div style={{
                background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10,
                padding:30, textAlign:'center', color:T.text3, fontSize:12,
              }}>No invoices match the current filters.</div>
            )}
            {data && data.invoices.map(inv => (
              <InvoiceCard
                key={inv.id}
                inv={inv}
                isSelected={selectedIds.has(inv.id)}
                isApproving={approvingId === inv.id}
                isDeleting={deletingId === inv.id}
                bulkApproving={bulkApproving}
                canEdit={canEdit}
                onToggleSelect={() => toggleSelect(inv.id)}
                onApprove={(e) => handleApproveOne(inv, e)}
                onDelete={(e) => handleDelete(inv, e)}
              />
            ))}
          </div>
        )}

        {/* ─── DESKTOP: table ─── */}
        {!isMobile && (
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%', borderCollapse:'collapse', minWidth: 1280}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                    {canEdit && (
                      <th style={th(36)}>
                        <HeaderCheckbox
                          state={headerCheckboxState}
                          disabled={approvableVisibleIds.size === 0}
                          onClick={toggleSelectAll}
                        />
                      </th>
                    )}
                    <th style={th(80)}>Triage</th>
                    <th style={th(110)}>Received</th>
                    <th style={th()}>Vendor</th>
                    <th style={th()}>Description</th>
                    <th style={th(140)}>Invoice #</th>
                    <th style={th(90)}>Inv Date</th>
                    <th style={th()}>Supplier (MYOB)</th>
                    <th style={{...th(110), textAlign:'right'}}>Total inc GST</th>
                    <th style={th(110)}>Status</th>
                    {canEdit && <th style={th(90)}>Approve</th>}
                    {canEdit && <th style={th(40)}/>}
                  </tr>
                </thead>
                <tbody>
                  {loading && !data && (
                    <tr><td colSpan={canEdit ? 12 : 9} style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</td></tr>
                  )}
                  {data && data.invoices.length === 0 && (
                    <tr><td colSpan={canEdit ? 12 : 9} style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>No invoices match the current filters.</td></tr>
                  )}
                  {data && data.invoices.map((inv, i) => {
                    const isDeletingThis = deletingId === inv.id
                    const isApprovingThis = approvingId === inv.id
                    const isPosted = inv.status === 'posted'
                    const approvable = isApprovable(inv)
                    const isSelected = selectedIds.has(inv.id)
                    return (
                      <tr
                        key={inv.id}
                        onClick={() => router.push(`/ap/${inv.id}`)}
                        style={{
                          borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                          cursor: 'pointer',
                          opacity: isDeletingThis ? 0.4 : 1,
                          background: isSelected ? `${T.green}08` : 'transparent',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = isSelected ? `${T.green}12` : T.bg3)}
                        onMouseLeave={e => (e.currentTarget.style.background = isSelected ? `${T.green}08` : 'transparent')}
                      >
                        {canEdit && (
                          <td style={{...td(), padding:'10px 6px', textAlign:'center'}} onClick={e => e.stopPropagation()}>
                            {approvable ? (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelect(inv.id)}
                                style={{cursor:'pointer'}}
                              />
                            ) : (
                              <span style={{color:T.text3, fontSize:11}}>—</span>
                            )}
                          </td>
                        )}
                        <td style={td()}><TriagePill status={inv.triage_status}/></td>
                        <td style={{...td(), fontSize:11, color:T.text3, fontFamily:'monospace', whiteSpace:'nowrap'}}>
                          {fmtDateTime(inv.received_at)}
                        </td>
                        <td style={td()}>
                          <div style={{fontSize:13, color:T.text}}>{inv.vendor_name_parsed || <span style={{color:T.text3}}>—</span>}</div>
                          {inv.via_capricorn && (
                            <div style={{fontSize:10, color:T.amber, marginTop:2}}>via Capricorn{inv.capricorn_reference ? ` ${inv.capricorn_reference}` : ''}</div>
                          )}
                        </td>
                        <td style={{...td(), fontSize:12, color:T.text2, maxWidth: 260}}>
                          {inv.line_summary ? (
                            <span title={inv.line_summary}>{inv.line_summary}</span>
                          ) : (
                            <span style={{color:T.text3, fontStyle:'italic'}}>—</span>
                          )}
                        </td>
                        <td style={{...td(), fontFamily:'monospace', fontSize:12}}>
                          {inv.invoice_number || <span style={{color:T.text3}}>—</span>}
                        </td>
                        <td style={{...td(), fontSize:11, color:T.text2, whiteSpace:'nowrap'}}>{inv.invoice_date || '—'}</td>
                        <td style={td()}>
                          {inv.resolved_supplier_name ? (
                            <div>
                              <div style={{fontSize:12, color:T.text}}>{inv.resolved_supplier_name}</div>
                              <div style={{fontSize:10, color:T.text3, fontFamily:'monospace', marginTop:2}}>{inv.resolved_account_code || ''}</div>
                            </div>
                          ) : (
                            <span style={{fontSize:11, color:T.text3, fontStyle:'italic'}}>not mapped</span>
                          )}
                        </td>
                        <td style={{...td(), textAlign:'right', fontFamily:'monospace', fontSize:13, fontWeight:500}}>
                          {inv.total_inc_gst !== null ? `$${Number(inv.total_inc_gst).toFixed(2)}` : '—'}
                        </td>
                        <td style={td()}>
                          <StatusPill status={inv.status}/>
                        </td>
                        {canEdit && (
                          <td style={{...td(), textAlign:'center', padding:'8px 6px'}} onClick={e => e.stopPropagation()}>
                            {approvable ? (
                              <button
                                onClick={(e) => handleApproveOne(inv, e)}
                                disabled={isApprovingThis || bulkApproving}
                                title="Post this invoice to MYOB"
                                style={{
                                  background: T.green, color:'#fff', border:'none',
                                  padding:'4px 10px', borderRadius:4, fontSize:11, fontWeight:500, fontFamily:'inherit',
                                  cursor: (isApprovingThis || bulkApproving) ? 'wait' : 'pointer',
                                  opacity: (isApprovingThis || bulkApproving) ? 0.5 : 1,
                                  whiteSpace:'nowrap',
                                }}
                              >
                                {isApprovingThis ? '…' : '✓ Approve'}
                              </button>
                            ) : isSpendMoneyEligible(inv) ? (
                              <button
                                onClick={(e) => handleApproveOne(inv, e)}
                                disabled={isApprovingThis || bulkApproving}
                                title={`Push as Spend Money (no supplier) — clears to ${inv.payment_account_code || ''} ${inv.payment_account_name || ''}`.trim()}
                                style={{
                                  background: T.purple, color:'#fff', border:'none',
                                  padding:'4px 10px', borderRadius:4, fontSize:11, fontWeight:500, fontFamily:'inherit',
                                  cursor: (isApprovingThis || bulkApproving) ? 'wait' : 'pointer',
                                  opacity: (isApprovingThis || bulkApproving) ? 0.5 : 1,
                                  whiteSpace:'nowrap',
                                }}
                              >
                                {isApprovingThis ? '…' : '$ Spend Money'}
                              </button>
                            ) : (
                              <span style={{color:T.text3, fontSize:11}}>—</span>
                            )}
                          </td>
                        )}
                        {canEdit && (
                          <td style={{...td(), textAlign:'center', padding:'8px 6px'}} onClick={e => e.stopPropagation()}>
                            {isPosted ? (
                              <span title="Posted invoices can't be deleted" style={{color:T.text3, fontSize:14}}>—</span>
                            ) : (
                              <button
                                onClick={(e) => handleDelete(inv, e)}
                                disabled={isDeletingThis}
                                title="Delete invoice + PDF"
                                style={{
                                  background:'none', border:'none',
                                  color: isDeletingThis ? T.text3 : T.text2,
                                  cursor: isDeletingThis ? 'wait' : 'pointer',
                                  fontSize:16, padding:'2px 6px', borderRadius:4,
                                  fontFamily:'inherit',
                                }}
                                onMouseEnter={e => { if (!isDeletingThis) (e.currentTarget.style.color = T.red) }}
                                onMouseLeave={e => { if (!isDeletingThis) (e.currentTarget.style.color = T.text2) }}
                              >
                                {isDeletingThis ? '…' : '×'}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {data && (
          <div style={{marginTop:10, fontSize:11, color:T.text3, textAlign: isMobile ? 'center' : 'right'}}>
            {data.invoices.length} of {data.total} {data.total === 1 ? 'invoice' : 'invoices'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Mobile invoice card ──────────────────────────────────────────────────
function InvoiceCard({
  inv, isSelected, isApproving, isDeleting, bulkApproving, canEdit,
  onToggleSelect, onApprove, onDelete,
}: {
  inv: InvoiceRow
  isSelected: boolean
  isApproving: boolean
  isDeleting: boolean
  bulkApproving: boolean
  canEdit: boolean
  onToggleSelect: () => void
  onApprove: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}) {
  const router = useRouter()
  const approvable = isApprovable(inv)
  const isPosted = inv.status === 'posted'

  return (
    <div
      onClick={() => router.push(`/ap/${inv.id}`)}
      style={{
        background: isSelected ? `${T.green}08` : T.bg2,
        border: `1px solid ${isSelected ? `${T.green}40` : T.border}`,
        borderRadius: 10,
        padding: '14px 14px',
        opacity: isDeleting ? 0.5 : 1,
        cursor: 'pointer',
      }}
    >
      {/* Top row: triage + status + select checkbox */}
      <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:10}}>
        <TriagePill status={inv.triage_status}/>
        <StatusPill status={inv.status}/>
        <span style={{flex:1}}/>
        {canEdit && approvable && (
          <label
            onClick={e => e.stopPropagation()}
            style={{display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.text3, cursor:'pointer'}}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelect}
              style={{cursor:'pointer', width:18, height:18}}
            />
            Select
          </label>
        )}
      </div>

      {/* Vendor */}
      <div style={{fontSize:15, color:T.text, fontWeight:500, marginBottom:2}}>
        {inv.vendor_name_parsed || <span style={{color:T.text3}}>(unknown vendor)</span>}
      </div>
      {inv.via_capricorn && (
        <div style={{fontSize:11, color:T.amber, marginBottom:6}}>
          via Capricorn{inv.capricorn_reference ? ` ${inv.capricorn_reference}` : ''}
        </div>
      )}

      {/* Invoice # + date */}
      <div style={{fontSize:12, color:T.text2, fontFamily:'monospace', marginBottom:8}}>
        {inv.invoice_number || '—'}
        {inv.invoice_date && <span style={{color:T.text3}}> · {inv.invoice_date}</span>}
      </div>

      {/* Total — biggest element on the card */}
      <div style={{fontSize:22, fontWeight:600, fontFamily:'monospace', color:T.text, marginBottom:8, fontVariantNumeric:'tabular-nums'}}>
        {inv.total_inc_gst !== null ? `$${Number(inv.total_inc_gst).toFixed(2)}` : '—'}
      </div>

      {/* Line summary (truncated) */}
      {inv.line_summary && (
        <div style={{
          fontSize:11, color:T.text3, marginBottom:10, lineHeight:1.4,
          display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical',
          overflow:'hidden',
        }}>
          {inv.line_summary}
        </div>
      )}

      {/* Supplier mapped */}
      {inv.resolved_supplier_name ? (
        <div style={{fontSize:11, color:T.text3, marginBottom:10}}>
          → {inv.resolved_supplier_name}
          {inv.resolved_account_code && (
            <span style={{fontFamily:'monospace', marginLeft:6}}>{inv.resolved_account_code}</span>
          )}
        </div>
      ) : (
        <div style={{fontSize:11, color:T.amber, marginBottom:10, fontStyle:'italic'}}>
          ⚠ supplier not mapped
        </div>
      )}

      {/* Action footer */}
      {canEdit && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            display:'flex', gap:10, alignItems:'center',
            paddingTop:10, borderTop:`1px solid ${T.border}`,
          }}
        >
          {approvable ? (
            <button
              onClick={onApprove}
              disabled={isApproving || bulkApproving}
              style={{
                flex:1,
                background: T.green, color:'#fff', border:'none',
                padding:'12px 14px', borderRadius:6,
                fontSize:14, fontWeight:600, fontFamily:'inherit',
                cursor: (isApproving || bulkApproving) ? 'wait' : 'pointer',
                opacity: (isApproving || bulkApproving) ? 0.5 : 1,
              }}
            >
              {isApproving ? 'Posting…' : '✓ Approve & Post'}
            </button>
          ) : isSpendMoneyEligible(inv) ? (
            <button
              onClick={onApprove}
              disabled={isApproving || bulkApproving}
              title={`Push as Spend Money (no supplier) — clears to ${inv.payment_account_code || ''} ${inv.payment_account_name || ''}`.trim()}
              style={{
                flex:1,
                background: T.purple, color:'#fff', border:'none',
                padding:'12px 14px', borderRadius:6,
                fontSize:14, fontWeight:600, fontFamily:'inherit',
                cursor: (isApproving || bulkApproving) ? 'wait' : 'pointer',
                opacity: (isApproving || bulkApproving) ? 0.5 : 1,
              }}
            >
              {isApproving ? 'Posting…' : '$ Push as Spend Money'}
            </button>
          ) : (
            <span style={{flex:1, fontSize:11, color:T.text3, fontStyle:'italic'}}>
              {isPosted ? 'Already posted' : 'Not approvable yet'}
            </span>
          )}
          {!isPosted && (
            <button
              onClick={onDelete}
              disabled={isDeleting}
              title="Delete invoice"
              style={{
                background:'transparent', border:`1px solid ${T.border2}`,
                color: isDeleting ? T.text3 : T.text2,
                width: 44, height: 44,
                borderRadius:6, fontSize:18, fontFamily:'inherit',
                cursor: isDeleting ? 'wait' : 'pointer',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}
            >
              {isDeleting ? '…' : '🗑'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── UI primitives ──────────────────────────────────────────────────────

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{display:'flex', alignItems:'baseline', gap:6}}>
      <span style={{fontSize:22, fontWeight:600, color, fontVariantNumeric:'tabular-nums'}}>{n}</span>
      <span style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

function Pill({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? (color ? `${color}25` : 'rgba(255,255,255,0.07)') : 'transparent',
        border: `1px solid ${active ? (color || T.border2) : T.border}`,
        color: active ? (color || T.text) : T.text2,
        padding: '7px 12px',
        borderRadius: 6,
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}

function TriagePill({ status }: { status: string }) {
  const conf = status === 'green'  ? { c: T.green,  label: '🟢 GREEN' } :
               status === 'yellow' ? { c: T.amber,  label: '🟡 YELLOW' } :
               status === 'red'    ? { c: T.red,    label: '🔴 RED' } :
                                     { c: T.text3,  label: '— PENDING' }
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:3,
      background: `${conf.c}15`, border:`1px solid ${conf.c}40`,
      color: conf.c, fontSize:10, fontWeight:600, letterSpacing:'0.05em', whiteSpace:'nowrap',
    }}>{conf.label}</span>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    parsing: T.text3, pending_review: T.text2, ready: T.blue,
    posted: T.green, rejected: T.text3, escalated: T.amber, error: T.red,
  }
  const c = map[status] || T.text3
  return (
    <span style={{
      display:'inline-block', padding:'2px 8px', borderRadius:3,
      background:`${c}15`, border:`1px solid ${c}40`, color:c,
      fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.04em', whiteSpace:'nowrap',
    }}>{status.replace('_',' ')}</span>
  )
}

function Banner({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: React.ReactNode }) {
  const c = kind === 'err' ? T.red : kind === 'info' ? T.blue : T.green
  return (
    <div style={{
      background:`${c}15`, border:`1px solid ${c}40`, borderRadius:7,
      padding:10, marginBottom:12, fontSize:12, color:c,
    }}>{children}</div>
  )
}

function HeaderCheckbox({
  state, disabled, onClick,
}: { state: 'unchecked' | 'partial' | 'checked'; disabled: boolean; onClick: () => void }) {
  return (
    <input
      type="checkbox"
      ref={el => { if (el) el.indeterminate = state === 'partial' }}
      checked={state === 'checked'}
      onChange={() => { if (!disabled) onClick() }}
      disabled={disabled}
      title="Select all approvable invoices on this page"
      style={{cursor: disabled ? 'not-allowed' : 'pointer'}}
    />
  )
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-AU', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })
  } catch { return iso }
}

function th(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'10px 12px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function td(): React.CSSProperties {
  return { padding:'11px 12px', verticalAlign:'top' }
}
