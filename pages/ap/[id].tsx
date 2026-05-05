// pages/ap/[id].tsx
// AP Invoice Detail — PDF preview alongside parsed data, line editor, save.
//
// Round 2 scope:
//   - View parsed invoice + PDF
//   - Edit line items (description, qty, price, tax code)
//   - Save edits (re-runs triage)
// Round 3 will add:
//   - Supplier preset picker (MYOB lookup)
//   - Approve → push to MYOB
//   - Reject / Escalate buttons

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

interface DetailResponse {
  invoice: InvoiceRow
  lines: LineRow[]
  pdfUrl: string | null
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
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

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

              {/* Triage banner */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', gap:12, marginBottom: data.invoice.triage_reasons && data.invoice.triage_reasons.length > 0 ? 8 : 0}}>
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
                  <div style={{display:'flex', flexWrap:'wrap', gap:6}}>
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

              {/* Resolved supplier */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:10}}>MYOB mapping ({data.invoice.myob_company_file})</div>
                {data.invoice.resolved_supplier_name ? (
                  <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
                    <Field label="Supplier"        value={data.invoice.resolved_supplier_name}/>
                    <Field label="Default account" value={`${data.invoice.resolved_account_code || '—'}`} mono/>
                  </div>
                ) : (
                  <div style={{fontSize:12, color:T.amber}}>
                    Supplier not mapped. {canEdit ? 'Set a preset to enable approval (Round 3 — coming soon).' : 'Ask an admin to set the preset.'}
                  </div>
                )}
              </div>

              {/* Lines */}
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
                <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10}}>
                  <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Line items ({editingLines?.length ?? data.lines.length})</div>
                  <div style={{display:'flex', gap:8}}>
                    {editingLines === null && canEdit && (
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
function Field({ label, value, mono, align, emphasised }: { label: string; value: string | null | undefined; mono?: boolean; align?: 'right'; emphasised?: boolean }) {
  return (
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:2}}>{label}</div>
      <div style={{
        fontSize: emphasised ? 14 : 12,
        fontWeight: emphasised ? 600 : 400,
        color: value ? T.text : T.text3,
        fontFamily: mono ? 'monospace' : 'inherit',
        textAlign: align,
      }}>{value ?? '—'}</div>
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

function fmtMoney(n: number | null): string {
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
