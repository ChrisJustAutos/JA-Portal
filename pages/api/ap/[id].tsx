// pages/ap/[id].tsx
// AP Invoice Detail — PDF preview, line editor, MD job link, MYOB preset
// picker, approve/reject actions, delete, save.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { GetServerSideProps } from 'next'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

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

interface PageProps {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

export default function APDetailPage({ user }: PageProps) {
  const router = useRouter()
  const id = router.query.id as string | undefined
  const [data, setData] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingLines, setEditingLines] = useState<LineRow[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  // Job picker state
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerResults, setPickerResults] = useState<JobInfo[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)

  // Supplier preset form state
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
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (id) fetchData() }, [id])

  // ── Job picker effects + handlers ──
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

  // ── Approve (push to MYOB) ──
  async function approveAndPost() {
    if (!id || !data) return
    const inv = data.invoice
    const summary =
      `Post bill to MYOB ${inv.myob_company_file}?\n\n` +
      `Supplier:  ${inv.resolved_supplier_name || '(not set)'}\n` +
      `Account:   ${inv.resolved_account_code || '(not set)'}\n` +
      `Subtotal:  ${fmtMoney(inv.subtotal_ex_gst)}\n` +
      `GST:       ${fmtMoney(inv.gst_amount)}\n` +
      `Total:     ${fmtMoney(inv.total_inc_gst)}\n` +
      `Inv #:     ${inv.invoice_number}\n` +
      `Date:      ${inv.invoice_date}\n` +
      (inv.via_capricorn && inv.capricorn_reference ? `Capricorn: ${inv.capricorn_reference}\n` : '') +
      (inv.linked_job_number ? `Job:       ${inv.linked_job_number}\n` : '') +
      `\nThis writes a Service Bill to MYOB.`
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
      setActionMessage({ kind: 'ok', text: `✅ Posted to MYOB${json.myobBillUid ? ` — bill UID ${json.myobBillUid}` : ''}` })
      await fetchData()
    } catch (e: any) {
      setActionMessage({ kind: 'err', text: `❌ ${e?.message || String(e)}` })
      await fetchData()  // Pull updated myob_post_error
    } finally {
      setApproving(false)
    }
  }

  // ── Reject (no MYOB write) ──
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

  function startEdit() {
    if (!data) return
    setEditingLines(data.lines.map(l => ({ ...l })))
  }
  function cancelEdit() {
    setEditingLines(null)
    setSaveMessage(null)
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
      },
    ])
  }
  function removeLine(lineId: string) {
    if (!editingLines) return
    setEditingLines(editingLines.filter(l => l.id !== lineId))
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
  const canApprove = canEdit && data
                  && !isTerminal
                  && data.invoice.triage_status !== 'red'
                  && !!data.invoice.resolved_supplier_uid
                  && !!data.invoice.resolved_account_uid
  const approveBlockedReason =
    !data ? '' :
    isPosted   ? 'Already posted' :
    isRejected ? 'Invoice rejected' :
    data.invoice.triage_status === 'red' ? 'Triage RED — fix issues' :
    !data.invoice.resolved_supplier_uid ? 'No MYOB supplier mapped' :
    !data.invoice.resolved_account_uid  ? 'No default account mapped' :
    ''

  return (
    <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:"'DM Sans', system-ui, sans-serif"}}>
      <PortalSidebar
        activeId="ap"
        currentUserRole={user.role}
        currentUserVisibleTabs={user.visibleTabs}
        currentUserName={user.displayName || user.email}
        currentUserEmail={user.email}
      />

      <div style={{flex:1, padding:'20px 28px', overflow:'auto'}}>
        <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:14}}>
          <button
            onClick={() => router.push('/ap')}
            style={{background:'none', border:'none', color:T.text2, cursor:'pointer', fontSize:13, fontFamily:'inherit', padding:0}}
          >← Back to AP list</button>
          <span style={{fontSize:12, color:T.text3}}>·</span>
          <span style={{fontSize:13, color:T.text}}>
            {data?.invoice.vendor_name_parsed || 'Loading…'}
            {data?.invoice.invoice_number ? ` — ${data.invoice.invoice_number}` : ''}
          </span>
          {data && canEdit && !isPosted && (
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
          <div style={{display:'grid', gridTemplateColumns:'minmax(0, 5fr) minmax(0, 7fr)', gap:18}}>
            {/* LEFT: PDF preview */}
            <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden', height:'calc(100vh - 110px)', display:'flex', flexDirection:'column'}}>
              <div style={{padding:'10px 14px', borderBottom:`1px solid ${T.border2}`, fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>
                PDF · {data.invoice.pdf_filename || 'unnamed'}
              </div>
              {data.pdfUrl ? (
                <iframe src={data.pdfUrl} style={{flex:1, border:'none', background:'#fff'}} title="invoice pdf"/>
              ) : (
                <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:T.text3, fontSize:12}}>
                  PDF not available (storage failed?)
                </div>
              )}
            </div>

            {/* RIGHT: data + lines */}
            <div style={{display:'flex', flexDirection:'column', gap:14, height:'calc(100vh - 110px)', overflow:'auto'}}>

              {/* Triage banner + actions */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', gap:12, marginBottom: data.invoice.triage_reasons && data.invoice.triage_reasons.length > 0 ? 8 : 10}}>
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
                    {data.invoice.triage_reasons.map((r, i) => (
                      <span key={i} style={{
                        fontSize:10, fontFamily:'monospace',
                        padding:'2px 8px', borderRadius:3,
                        background: r.startsWith('RED:') ? `${T.red}15` : r.startsWith('YELLOW:') ? `${T.amber}15` : `${T.text3}15`,
                        color: r.startsWith('RED:') ? T.red : r.startsWith('YELLOW:') ? T.amber : T.text3,
                        border: `1px solid ${r.startsWith('RED:') ? T.red : r.startsWith('YELLOW:') ? T.amber : T.text3}40`,
                      }}>{r}</span>
                    ))}
                  </div>
                )}

                {/* Action row */}
                {!isTerminal && canEdit && (
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
                {isPosted && (
                  <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`, fontSize:11, color:T.green, display:'flex', alignItems:'center', gap:10}}>
                    <span>✅ Posted to MYOB {data.invoice.myob_posted_at ? new Date(data.invoice.myob_posted_at).toLocaleString() : ''}</span>
                    {data.invoice.myob_bill_uid && (
                      <span style={{fontFamily:'monospace', color:T.text3}}>
                        · UID {data.invoice.myob_bill_uid.substring(0, 8)}…
                      </span>
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

              {/* Header data */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:10}}>Invoice</div>
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
              </div>

              {/* Workshop Job (MD) */}
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

              {/* MYOB mapping (with preset picker) */}
              <MyobMappingSection
                invoice={data.invoice}
                canEdit={canEdit && !isTerminal}
                presetOpen={presetOpen}
                onOpenPreset={() => setPresetOpen(true)}
                onClosePreset={() => setPresetOpen(false)}
                onPresetSaved={async () => { setPresetOpen(false); await fetchData() }}
              />

              {/* Lines */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10}}>
                  <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Line items ({editingLines?.length ?? data.lines.length})</div>
                  <div style={{display:'flex', gap:8}}>
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
                  editable={editingLines !== null}
                  onChange={updateLine}
                  onRemove={removeLine}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── MYOB mapping section ─────────────────────────────────────────────────
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
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10}}>
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
              Click "Change…" to pick the account and save the preset.
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

// ── Supplier preset form ─────────────────────────────────────────────────
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
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12}}>
        <FormRow label="Match pattern (case-insensitive substring of parsed vendor name)">
          <input
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            placeholder="e.g. REPCO"
            style={inputStyle()}
          />
        </FormRow>
        <FormRow label={`Company file`}>
          <div style={{fontSize:12, color:T.text2, paddingTop:6}}>{invoice.myob_company_file}</div>
        </FormRow>
      </div>

      <FormRow label="MYOB supplier">
        <SupplierTypeahead
          companyFile={invoice.myob_company_file}
          selected={supplier}
          onSelect={setSupplier}
          initialQuery={(invoice.vendor_name_parsed || '').trim()}
        />
      </FormRow>

      <FormRow label="Default account (Expense + CostOfSales)">
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
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4}}>{label}</div>
      {children}
    </div>
  )
}

function inputStyle(): React.CSSProperties {
  return {
    width:'100%',
    background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
    padding:'7px 10px', borderRadius:5, fontSize:12, fontFamily:'inherit', outline:'none',
  }
}

// ── Reusable typeaheads ──────────────────────────────────────────────────
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
      <div style={{display:'flex', gap:8, alignItems:'center'}}>
        <div style={{flex:1, fontSize:12, color: selected ? T.text : T.text3}}>
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
              padding:'8px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'center',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = T.bg4)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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

function AccountTypeahead({
  companyFile, selected, onSelect,
}: {
  companyFile: 'VPS' | 'JAWS'
  selected: MyobAccount | null
  onSelect: (a: MyobAccount | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<MyobAccount[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '40' })
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
      <div style={{display:'flex', gap:8, alignItems:'center'}}>
        <div style={{flex:1, fontSize:12, color: selected ? T.text : T.text3}}>
          {selected ? (
            <>
              <span style={{fontFamily:'monospace'}}>{selected.displayId}</span>
              {selected.name && <span style={{marginLeft:8, color:T.text2}}>{selected.name}</span>}
            </>
          ) : 'No account picked'}
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
          placeholder="Search by code or name (e.g. 5-1100, parts, freight)…"
          style={inputStyle()}
        />
        <button onClick={() => setOpen(false)} style={btnSecondary()}>Close</button>
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:280, overflowY:'auto', background: T.bg3,
      }}>
        {loading && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching MYOB…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
            {query ? 'No matching accounts.' : 'Showing top expense + cost-of-sales accounts. Refine with a query.'}
          </div>
        )}
        {!loading && results.map((a, i) => (
          <div
            key={a.uid}
            onClick={() => { onSelect(a); setOpen(false) }}
            style={{
              padding:'8px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'80px 1fr 90px', gap:10, alignItems:'center',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = T.bg4)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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

// ── Workshop Job section ────────────────────────────
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
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10}}>
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
              width:'100%', background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
              padding:'8px 12px', borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none',
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
                  padding:'9px 12px',
                  borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                  cursor: linkBusy ? 'wait' : 'pointer',
                  fontSize: 12,
                  display:'grid', gridTemplateColumns:'80px 1fr 1fr 90px', gap:10, alignItems:'center',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = T.bg4)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
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

// ── Lines table ──────────────────────────────────────────────────────────
function LinesTable({
  lines, editable, onChange, onRemove,
}: {
  lines: LineRow[]
  editable: boolean
  onChange: (id: string, patch: Partial<LineRow>) => void
  onRemove: (id: string) => void
}) {
  if (lines.length === 0) {
    return <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>No line items.</div>
  }
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%', borderCollapse:'collapse', fontSize:12}}>
        <thead>
          <tr style={{borderBottom:`1px solid ${T.border}`}}>
            <th style={lh(36)}>#</th>
            <th style={lh(120)}>Part</th>
            <th style={lh()}>Description</th>
            <th style={{...lh(60), textAlign:'right'}}>Qty</th>
            <th style={lh(60)}>UoM</th>
            <th style={{...lh(80), textAlign:'right'}}>Unit ex</th>
            <th style={{...lh(80), textAlign:'right'}}>Total ex</th>
            <th style={lh(60)}>Tax</th>
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
                    style={{background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, padding:'3px 4px', borderRadius:4, fontSize:11, fontFamily:'inherit'}}
                  >
                    {['GST','FRE','CAP','EXP','GNR','ITS','N-T'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : l.tax_code}
              </td>
              {editable && (
                <td style={ld()}>
                  <button onClick={() => onRemove(l.id)} style={{background:'none', border:'none', color:T.red, cursor:'pointer', fontSize:14}}>×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Small UI bits ──
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
        width:'100%', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text,
        padding:'3px 6px', borderRadius:4, fontSize:11, fontFamily:'inherit', outline:'none',
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
    padding:'5px 11px', borderRadius:5, fontSize:11, fontWeight:500, fontFamily:'inherit', cursor:'pointer',
  }
}
function btnSecondary(): React.CSSProperties {
  return {
    background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
    padding:'5px 11px', borderRadius:5, fontSize:11, fontFamily:'inherit', cursor:'pointer',
  }
}
function lh(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'7px 8px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function ld(): React.CSSProperties {
  return { padding:'7px 8px', verticalAlign:'top' }
}
