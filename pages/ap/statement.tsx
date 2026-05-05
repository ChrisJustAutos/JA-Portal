// pages/ap/statement.tsx
// Statement reconciliation — upload a supplier statement PDF, get back a
// list showing which lines exist in MYOB, which are missing, and which
// have amount/date mismatches.
//
// Flow:
//   1. User picks company file (VPS/JAWS)
//   2. User picks supplier from MYOB (typeahead, case-insensitive)
//   3. User drops the statement PDF
//   4. Click Reconcile → POST /api/ap/statement/match
//   5. UI renders: summary banner, filter pills, results table, orphan
//      bills section, CSV export
//
// Nothing is persisted server-side — single-shot reconciliation. Re-upload
// to redo. Keeps schema overhead low while we validate the workflow.

import { useState, useEffect, useRef, useMemo } from 'react'
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

type CompanyFile = 'VPS' | 'JAWS'

interface MyobSupplier {
  uid: string
  displayId: string | null
  name: string
  abn: string | null
  isIndividual: boolean
}

type StatementLineType = 'invoice' | 'payment' | 'credit' | 'unknown'

interface StatementLine {
  date: string | null
  reference: string | null
  invoiceNumber: string | null
  description: string | null
  amount: number | null
  type: StatementLineType
}

interface ParsedStatement {
  supplier: { name: string | null; abn: string | null }
  statementDate: string | null
  periodFrom: string | null
  periodTo: string | null
  openingBalance: number | null
  closingBalance: number | null
  totalDue: number | null
  lines: StatementLine[]
  parseConfidence: 'high' | 'medium' | 'low'
}

type MatchStatus =
  | 'matched' | 'amount-mismatch' | 'date-mismatch'
  | 'in-portal-pending' | 'rejected-in-portal' | 'missing' | 'skipped'

interface MyobBillSummary {
  uid: string
  number: string | null
  date: string | null
  totalAmount: number | null
  supplierInvoiceNumber: string | null
}

interface PortalInvoiceSummary {
  id: string
  status: string
  invoiceNumber: string | null
  invoiceDate: string | null
  totalIncGst: number | null
  myobBillUid: string | null
}

interface MatchResult {
  line: StatementLine
  status: MatchStatus
  myobBill: MyobBillSummary | null
  portalInvoice: PortalInvoiceSummary | null
  amountDelta: number | null
  dateDeltaDays: number | null
  notes: string | null
}

interface OrphanBill extends MyobBillSummary {
  reason: 'in-myob-not-on-statement'
}

interface MatchSummary {
  total: number
  invoiceLines: number
  matched: number
  amountMismatch: number
  dateMismatch: number
  missing: number
  inPortalPending: number
  rejected: number
  skipped: number
  orphans: number
}

interface ReconcileResponse {
  ok: true
  statement: ParsedStatement
  match: {
    results: MatchResult[]
    orphans: OrphanBill[]
    summary: MatchSummary
    windowFrom: string
    windowTo: string
    myobBillCount: number
    myobBillCountForSupplier: number
  }
  supplier: { uid: string; name: string }
  companyFile: CompanyFile
  filename: string
  parseCost: { model: string; inputTokens: number; outputTokens: number; microUsd: number }
  warning?: string
}

interface PageProps {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export const getServerSideProps: GetServerSideProps<PageProps> = async (ctx) => {
  return requirePageAuth(ctx, 'view:supplier_invoices') as any
}

type FilterKey = 'all' | 'issues' | 'matched' | 'missing' | 'mismatch' | 'pending' | 'skipped'

export default function StatementReconcilePage({ user }: PageProps) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const canEdit = roleHasPermission(user.role, 'edit:supplier_invoices')

  const [companyFile, setCompanyFile] = useState<CompanyFile>('VPS')
  const [supplier, setSupplier] = useState<MyobSupplier | null>(null)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ReconcileResponse | null>(null)
  const [filter, setFilter] = useState<FilterKey>('issues')
  const fileRef = useRef<HTMLInputElement>(null)

  const canRun = !!supplier && !!pdfFile && !running && canEdit

  async function handleFile(file: File) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are supported.')
      setPdfFile(null)
      return
    }
    if (file.size > 4 * 1024 * 1024) {
      setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 4 MB.`)
      setPdfFile(null)
      return
    }
    setError(null)
    setPdfFile(file)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer.files?.[0]
    if (f) handleFile(f)
  }

  async function reconcile() {
    if (!supplier || !pdfFile) return
    setRunning(true)
    setError(null)
    setResult(null)
    setProgress('Reading PDF…')
    try {
      const buf = await pdfFile.arrayBuffer()
      const bytes = new Uint8Array(buf)
      // ES5-safe base64: chunked String.fromCharCode.apply (same pattern
      // used by the AP upload page — fixes "Maximum call stack size
      // exceeded" on larger files).
      let binary = ''
      const chunkSize = 32 * 1024
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
        binary += String.fromCharCode.apply(null, slice as any)
      }
      const pdfBase64 = btoa(binary)

      setProgress(`Parsing statement & querying MYOB ${companyFile}…`)
      const res = await fetch('/api/ap/statement/match', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64,
          filename: pdfFile.name,
          companyFile,
          supplier: { uid: supplier.uid, name: supplier.name },
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setResult(json as ReconcileResponse)
      setFilter('issues')
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  function exportCsv() {
    if (!result) return
    const rows: string[][] = [
      ['Status', 'Date', 'Invoice #', 'Description', 'Statement Amount', 'MYOB Amount', 'Amount Delta', 'Date Delta (days)', 'MYOB Bill #', 'MYOB Date', 'Portal Status', 'Notes'],
    ]
    for (const r of result.match.results) {
      rows.push([
        statusLabel(r.status),
        r.line.date || '',
        r.line.invoiceNumber || r.line.reference || '',
        r.line.description || '',
        r.line.amount !== null ? String(r.line.amount) : '',
        r.myobBill?.totalAmount !== null && r.myobBill?.totalAmount !== undefined ? String(r.myobBill.totalAmount) : '',
        r.amountDelta !== null ? String(r.amountDelta) : '',
        r.dateDeltaDays !== null ? String(r.dateDeltaDays) : '',
        r.myobBill?.number || '',
        r.myobBill?.date || '',
        r.portalInvoice?.status || '',
        r.notes || '',
      ])
    }
    if (result.match.orphans.length > 0) {
      rows.push([])
      rows.push(['ORPHAN BILLS — in MYOB but not on statement'])
      rows.push(['MYOB Bill #', 'Date', 'Supplier Inv #', 'Total Amount', 'UID'])
      for (const o of result.match.orphans) {
        rows.push([
          o.number || '',
          o.date || '',
          o.supplierInvoiceNumber || '',
          o.totalAmount !== null ? String(o.totalAmount) : '',
          o.uid,
        ])
      }
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().substring(0, 10)
    a.download = `statement-reconcile-${result.supplier.name.replace(/[^A-Za-z0-9]/g, '_')}-${stamp}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const filtered = useMemo(() => {
    if (!result) return []
    const all = result.match.results
    switch (filter) {
      case 'all':       return all
      case 'matched':   return all.filter(r => r.status === 'matched')
      case 'missing':   return all.filter(r => r.status === 'missing' || r.status === 'rejected-in-portal')
      case 'mismatch':  return all.filter(r => r.status === 'amount-mismatch' || r.status === 'date-mismatch')
      case 'pending':   return all.filter(r => r.status === 'in-portal-pending')
      case 'skipped':   return all.filter(r => r.status === 'skipped')
      case 'issues':
      default:
        return all.filter(r => r.status !== 'matched' && r.status !== 'skipped')
    }
  }, [result, filter])

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
        <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:8, flexWrap:'wrap'}}>
          <button
            onClick={() => router.push('/ap')}
            style={{background:'none', border:'none', color:T.text2, cursor:'pointer', fontSize: isMobile ? 14 : 13, fontFamily:'inherit', padding:0}}
          >← Back to AP</button>
        </div>
        <h1 style={{fontSize: isMobile ? 18 : 22, fontWeight:600, margin:'0 0 4px 0'}}>Statement reconciliation</h1>
        <div style={{fontSize:12, color:T.text3, marginBottom:18}}>
          Upload a supplier statement and we'll cross-check every invoice against MYOB. Nothing is saved — close the page and the result is gone.
        </div>

        {/* ─── Form ─── */}
        <div style={{
          background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10,
          padding: isMobile ? 14 : 18, marginBottom:14,
          display:'flex', flexDirection:'column', gap:14,
        }}>
          <div style={{display:'grid', gridTemplateColumns: isMobile ? '1fr' : '180px 1fr', gap:14, alignItems:'start'}}>
            <FormRow label="Company file">
              <div style={{display:'flex', gap:6}}>
                <CompanyChip active={companyFile === 'VPS'}  onClick={() => setCompanyFile('VPS')}  label="VPS"/>
                <CompanyChip active={companyFile === 'JAWS'} onClick={() => setCompanyFile('JAWS')} label="JAWS"/>
              </div>
            </FormRow>
            <FormRow label="MYOB supplier">
              <SupplierTypeahead
                companyFile={companyFile}
                selected={supplier}
                onSelect={setSupplier}
              />
            </FormRow>
          </div>

          <FormRow label="Statement PDF">
            <div
              onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              style={{
                background: T.bg3,
                border: `1.5px dashed ${pdfFile ? T.green + '60' : T.border2}`,
                borderRadius: 8,
                padding: isMobile ? '18px 14px' : '22px 18px',
                textAlign:'center',
                cursor:'pointer',
                fontSize: 13,
                color: pdfFile ? T.text : T.text3,
              }}
            >
              {pdfFile ? (
                <>
                  <div style={{fontWeight:500, color:T.text, marginBottom:4}}>📄 {pdfFile.name}</div>
                  <div style={{fontSize:11, color:T.text3}}>
                    {(pdfFile.size / 1024).toFixed(0)} KB · click or drop another to replace
                  </div>
                </>
              ) : (
                <>
                  <div style={{marginBottom:4}}>Drop a PDF here, or click to choose</div>
                  <div style={{fontSize:11, color:T.text3}}>Max 4 MB · PDF only</div>
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
              style={{display:'none'}}
            />
          </FormRow>

          <div style={{display:'flex', gap:10, alignItems:'center', flexWrap:'wrap'}}>
            <button
              onClick={reconcile}
              disabled={!canRun}
              style={{
                background: canRun ? T.blue : T.bg4,
                color: canRun ? '#fff' : T.text3,
                border:'none',
                padding: isMobile ? '12px 18px' : '10px 18px',
                borderRadius:6, fontSize:13, fontWeight:600, fontFamily:'inherit',
                cursor: canRun ? 'pointer' : 'not-allowed',
                opacity: running ? 0.7 : 1,
                flex: isMobile ? '1 1 100%' : '0 0 auto',
              }}
            >
              {running ? (progress || 'Working…') : 'Reconcile against MYOB'}
            </button>
            {pdfFile && !running && (
              <button
                onClick={() => { setPdfFile(null); setResult(null); setError(null); if (fileRef.current) fileRef.current.value = '' }}
                style={{
                  background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
                  padding:'9px 14px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
                }}
              >
                Reset
              </button>
            )}
          </div>

          {!canEdit && (
            <div style={{fontSize:11, color:T.amber}}>
              You don't have edit permission — viewing only. Reconcile is admin/manager only.
            </div>
          )}
        </div>

        {error && (
          <div style={{
            background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:7,
            padding:10, marginBottom:14, fontSize:12, color:T.red,
          }}>
            <strong>Failed:</strong> {error}
          </div>
        )}

        {/* ─── Results ─── */}
        {result && <ResultsPanel
          result={result}
          filter={filter}
          setFilter={setFilter}
          filtered={filtered}
          onExportCsv={exportCsv}
          isMobile={isMobile}
        />}
      </div>
    </div>
  )
}

// ── Results panel ──────────────────────────────────────────────────────

function ResultsPanel({
  result, filter, setFilter, filtered, onExportCsv, isMobile,
}: {
  result: ReconcileResponse
  filter: FilterKey
  setFilter: (k: FilterKey) => void
  filtered: MatchResult[]
  onExportCsv: () => void
  isMobile: boolean
}) {
  const s = result.match.summary
  const stmt = result.statement

  const issues = s.missing + s.amountMismatch + s.dateMismatch + s.rejected + s.inPortalPending
  const allClear = issues === 0 && s.invoiceLines > 0

  return (
    <div style={{display:'flex', flexDirection:'column', gap:14}}>

      {/* Statement header summary */}
      <div style={{
        background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10,
        padding: isMobile ? 14 : 18,
      }}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', flexWrap:'wrap', gap:10, marginBottom:8}}>
          <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>
            Statement summary
          </div>
          <div style={{fontSize:11, color:T.text3}}>
            {result.companyFile} · supplier: <span style={{color:T.text2}}>{result.supplier.name}</span>
          </div>
        </div>
        <div style={{display:'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(5, 1fr)', gap: isMobile ? 10 : 14}}>
          <Field label="Statement date" value={stmt.statementDate || '—'} mono/>
          <Field label="Period"         value={stmt.periodFrom && stmt.periodTo ? `${stmt.periodFrom} → ${stmt.periodTo}` : '—'} mono/>
          <Field label="Lines"          value={String(stmt.lines.length)}/>
          <Field label="Closing balance" value={stmt.closingBalance !== null ? `$${stmt.closingBalance.toFixed(2)}` : '—'} mono align="right"/>
          <Field label="Total due"       value={stmt.totalDue !== null ? `$${stmt.totalDue.toFixed(2)}` : '—'} mono align="right" emphasised/>
        </div>
        <div style={{marginTop:10, fontSize:11, color:T.text3}}>
          MYOB lookup window: <span style={{fontFamily:'monospace', color:T.text2}}>{result.match.windowFrom} → {result.match.windowTo}</span>
          {' · '}
          {result.match.myobBillCountForSupplier} bills for this supplier in window
          {' · '}
          parse confidence: <span style={{color: stmt.parseConfidence === 'high' ? T.green : stmt.parseConfidence === 'medium' ? T.amber : T.red}}>{stmt.parseConfidence}</span>
        </div>
        {result.warning && (
          <div style={{
            marginTop:10, fontSize:11, color:T.amber,
            background:`${T.amber}10`, border:`1px solid ${T.amber}30`,
            padding:'6px 10px', borderRadius:5,
          }}>{result.warning}</div>
        )}
      </div>

      {/* Summary banner */}
      <div style={{
        background: allClear ? `${T.green}10` : T.bg2,
        border: `1px solid ${allClear ? `${T.green}40` : T.border}`,
        borderRadius: 10,
        padding: isMobile ? '14px 14px' : '14px 18px',
      }}>
        <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap: isMobile ? 14 : 22}}>
          <SumStat n={s.invoiceLines}    label="Invoice lines" color={T.text}/>
          <SumStat n={s.matched}         label="Matched"       color={T.green}/>
          <SumStat n={s.missing}         label="Missing"       color={T.red}/>
          <SumStat n={s.amountMismatch}  label="Amount Δ"      color={T.amber}/>
          <SumStat n={s.dateMismatch}    label="Date Δ"        color={T.amber}/>
          <SumStat n={s.inPortalPending} label="In portal"     color={T.blue}/>
          <SumStat n={s.rejected}        label="Rejected"      color={T.text3}/>
          <SumStat n={s.orphans}         label="Orphans"       color={T.purple}/>
          <span style={{flex:1}}/>
          <button
            onClick={onExportCsv}
            style={{
              background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
              padding:'8px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
            }}
          >📥 CSV</button>
        </div>
        {allClear && (
          <div style={{marginTop:8, fontSize:12, color:T.green}}>
            ✅ All invoice lines on the statement matched MYOB cleanly. No action needed.
          </div>
        )}
      </div>

      {/* Filter pills */}
      <div style={{display:'flex', flexWrap:'wrap', gap:6, alignItems:'center'}}>
        <FilterPill k="issues"   current={filter} setFilter={setFilter} label={`Issues (${s.missing + s.amountMismatch + s.dateMismatch + s.rejected + s.inPortalPending})`}/>
        <FilterPill k="missing"  current={filter} setFilter={setFilter} label={`Missing (${s.missing + s.rejected})`}      color={T.red}/>
        <FilterPill k="mismatch" current={filter} setFilter={setFilter} label={`Mismatch (${s.amountMismatch + s.dateMismatch})`} color={T.amber}/>
        <FilterPill k="pending"  current={filter} setFilter={setFilter} label={`In portal (${s.inPortalPending})`}    color={T.blue}/>
        <FilterPill k="matched"  current={filter} setFilter={setFilter} label={`Matched (${s.matched})`}              color={T.green}/>
        <FilterPill k="skipped"  current={filter} setFilter={setFilter} label={`Skipped (${s.skipped})`}              color={T.text3}/>
        <FilterPill k="all"      current={filter} setFilter={setFilter} label={`All (${s.total})`}/>
      </div>

      {/* Results table */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%', borderCollapse:'collapse', minWidth: isMobile ? 720 : 0}}>
            <thead>
              <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                <th style={th(120)}>Status</th>
                <th style={th(90)}>Date</th>
                <th style={th(140)}>Invoice #</th>
                <th style={th()}>Description</th>
                <th style={{...th(100), textAlign:'right'}}>Statement</th>
                <th style={{...th(100), textAlign:'right'}}>MYOB</th>
                <th style={{...th(80),  textAlign:'right'}}>Δ</th>
                <th style={th()}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{padding:24, textAlign:'center', color:T.text3, fontSize:12}}>
                    No rows match this filter.
                  </td>
                </tr>
              )}
              {filtered.map((r, i) => (
                <tr key={i} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
                  <td style={td()}>
                    <StatusPill status={r.status}/>
                    {r.portalInvoice && (
                      <a
                        href={`/ap/${r.portalInvoice.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{display:'block', marginTop:3, fontSize:10, color:T.blue, textDecoration:'none'}}
                      >open in portal ↗</a>
                    )}
                  </td>
                  <td style={{...td(), fontSize:11, color:T.text2, fontFamily:'monospace', whiteSpace:'nowrap'}}>{r.line.date || '—'}</td>
                  <td style={{...td(), fontFamily:'monospace', fontSize:12}}>{r.line.invoiceNumber || r.line.reference || '—'}</td>
                  <td style={{...td(), fontSize:12, color:T.text2, maxWidth:220}}>
                    <span title={r.line.description || ''}>{truncate(r.line.description, 60) || '—'}</span>
                  </td>
                  <td style={{...td(), fontFamily:'monospace', fontSize:12, textAlign:'right', whiteSpace:'nowrap'}}>
                    {r.line.amount !== null ? `$${Math.abs(r.line.amount).toFixed(2)}` : '—'}
                  </td>
                  <td style={{...td(), fontFamily:'monospace', fontSize:12, textAlign:'right', whiteSpace:'nowrap'}}>
                    {r.myobBill?.totalAmount !== null && r.myobBill?.totalAmount !== undefined ? `$${Number(r.myobBill.totalAmount).toFixed(2)}` : '—'}
                  </td>
                  <td style={{
                    ...td(), fontFamily:'monospace', fontSize:11, textAlign:'right',
                    color: r.amountDelta !== null && Math.abs(r.amountDelta) > 0.05 ? T.amber : T.text3,
                    whiteSpace:'nowrap',
                  }}>
                    {r.amountDelta !== null ? (r.amountDelta > 0 ? '+' : '') + r.amountDelta.toFixed(2) : '—'}
                  </td>
                  <td style={{...td(), fontSize:11, color:T.text3, lineHeight:1.4}}>
                    {r.notes || (r.status === 'matched' ? '' : '—')}
                    {r.dateDeltaDays !== null && Math.abs(r.dateDeltaDays) > 0 && r.status !== 'date-mismatch' && (
                      <span style={{color:T.text3}}> · date Δ {r.dateDeltaDays}d</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Orphans */}
      {result.match.orphans.length > 0 && (
        <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
          <div style={{padding:'12px 16px', borderBottom:`1px solid ${T.border2}`, display:'flex', alignItems:'center', gap:8}}>
            <span style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>
              Orphan bills · {result.match.orphans.length}
            </span>
            <span style={{fontSize:10, color:T.text3}}>— in MYOB for this supplier in the window but not on the statement</span>
          </div>
          <div style={{overflowX:'auto'}}>
            <table style={{width:'100%', borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${T.border}`}}>
                  <th style={th(120)}>MYOB Bill #</th>
                  <th style={th(100)}>Date</th>
                  <th style={th()}>Supplier Inv #</th>
                  <th style={{...th(110), textAlign:'right'}}>Total inc GST</th>
                </tr>
              </thead>
              <tbody>
                {result.match.orphans.map((o, i) => (
                  <tr key={o.uid} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
                    <td style={{...td(), fontFamily:'monospace', fontSize:12}}>{o.number || '—'}</td>
                    <td style={{...td(), fontSize:11, color:T.text2, fontFamily:'monospace'}}>{o.date || '—'}</td>
                    <td style={{...td(), fontFamily:'monospace', fontSize:12}}>{o.supplierInvoiceNumber || '—'}</td>
                    <td style={{...td(), fontFamily:'monospace', fontSize:12, textAlign:'right'}}>
                      {o.totalAmount !== null ? `$${Number(o.totalAmount).toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer with cost */}
      <div style={{fontSize:10, color:T.text3, textAlign:'right', padding:'4px 0'}}>
        Parsed via {result.parseCost.model} · {result.parseCost.inputTokens.toLocaleString()} in / {result.parseCost.outputTokens.toLocaleString()} out · ~${(result.parseCost.microUsd / 1_000_000).toFixed(3)} USD
      </div>
    </div>
  )
}

// ── Supplier typeahead (inlined; same shape as the one in /ap/[id]) ────

function SupplierTypeahead({
  companyFile, selected, onSelect,
}: {
  companyFile: CompanyFile
  selected: MyobSupplier | null
  onSelect: (s: MyobSupplier | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
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

  // Reset selected when company file changes — the chosen UID won't be
  // valid against the other company file.
  useEffect(() => { onSelect(null) /* eslint-disable-line react-hooks/exhaustive-deps */ }, [companyFile])

  if (!open) {
    return (
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <div style={{flex:1, fontSize:13, color: selected ? T.text : T.text3, minWidth:0}}>
          {selected ? selected.name : 'No supplier picked'}
          {selected?.abn && <span style={{color:T.text3, marginLeft:8, fontFamily:'monospace', fontSize:11}}>ABN {selected.abn}</span>}
        </div>
        <button
          onClick={() => setOpen(true)}
          style={{
            background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
            padding:'7px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
          }}
        >{selected ? 'Change…' : 'Search MYOB…'}</button>
        {selected && (
          <button
            onClick={() => onSelect(null)}
            style={{
              background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
              padding:'7px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
            }}
          >Clear</button>
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
          style={{
            width:'100%', boxSizing:'border-box',
            background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
            padding:'9px 12px', borderRadius:5,
            fontSize:16, fontFamily:'inherit', outline:'none',
          }}
        />
        <button
          onClick={() => setOpen(false)}
          style={{
            background:'transparent', color:T.text2, border:`1px solid ${T.border2}`,
            padding:'7px 12px', borderRadius:5, fontSize:12, fontFamily:'inherit', cursor:'pointer',
          }}
        >Close</button>
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:300, overflowY:'auto', background: T.bg3,
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
              cursor:'pointer', fontSize: 12,
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

// ── UI primitives ──────────────────────────────────────────────────────

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{minWidth:0}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6}}>{label}</div>
      {children}
    </div>
  )
}

function CompanyChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? T.blue : 'transparent',
        color: active ? '#fff' : T.text2,
        border: `1px solid ${active ? T.blue : T.border2}`,
        padding:'8px 16px', borderRadius:6,
        fontSize:13, fontWeight: active ? 600 : 400, fontFamily:'inherit',
        cursor:'pointer',
      }}
    >{label}</button>
  )
}

function SumStat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{display:'flex', alignItems:'baseline', gap:6}}>
      <span style={{fontSize:20, fontWeight:600, color, fontVariantNumeric:'tabular-nums'}}>{n}</span>
      <span style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

function FilterPill({
  k, current, setFilter, label, color,
}: { k: FilterKey; current: FilterKey; setFilter: (k: FilterKey) => void; label: string; color?: string }) {
  const active = current === k
  return (
    <button
      onClick={() => setFilter(k)}
      style={{
        background: active ? (color ? `${color}25` : 'rgba(255,255,255,0.07)') : 'transparent',
        border: `1px solid ${active ? (color || T.border2) : T.border}`,
        color: active ? (color || T.text) : T.text2,
        padding: '6px 11px',
        borderRadius: 5,
        fontSize: 11,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  )
}

function StatusPill({ status }: { status: MatchStatus }) {
  const conf = statusConfig(status)
  return (
    <span style={{
      display:'inline-block', padding:'3px 8px', borderRadius:3,
      background:`${conf.c}15`, border:`1px solid ${conf.c}40`, color: conf.c,
      fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.04em', whiteSpace:'nowrap',
    }}>{conf.label}</span>
  )
}

function statusConfig(status: MatchStatus): { c: string; label: string } {
  switch (status) {
    case 'matched':            return { c: T.green,  label: '✓ Matched' }
    case 'amount-mismatch':    return { c: T.amber,  label: '$ Mismatch' }
    case 'date-mismatch':      return { c: T.amber,  label: '📅 Date Δ' }
    case 'in-portal-pending':  return { c: T.blue,   label: 'In Portal' }
    case 'rejected-in-portal': return { c: T.text3,  label: 'Rejected' }
    case 'missing':            return { c: T.red,    label: '✗ Missing' }
    case 'skipped':            return { c: T.text3,  label: 'Skipped' }
  }
}

function statusLabel(status: MatchStatus): string {
  return statusConfig(status).label
}

function Field({ label, value, mono, align, emphasised }: { label: string; value: string; mono?: boolean; align?: 'right'; emphasised?: boolean }) {
  return (
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:2}}>{label}</div>
      <div style={{
        fontSize: emphasised ? 14 : 12,
        fontWeight: emphasised ? 600 : 400,
        color: T.text,
        fontFamily: mono ? 'monospace' : 'inherit',
        textAlign: align,
      }}>{value}</div>
    </div>
  )
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ''
  if (s.length <= n) return s
  return s.substring(0, n - 1) + '…'
}

function csvEscape(s: string): string {
  if (s == null) return ''
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function th(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'10px 12px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function td(): React.CSSProperties {
  return { padding:'10px 12px', verticalAlign:'top' }
}
