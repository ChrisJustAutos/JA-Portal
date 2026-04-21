// components/settings/DataImportsTab.tsx
// Unified upload hub for admin-only data imports.
// Two cards:
//   1) Mechanics Desk Job Report (CSV / XLSX / XLS)  → POST /api/job-reports/upload
//   2) Supplier Invoice PDF                          → POST /api/supplier-invoices/intake
// Each card has drag-and-drop / file picker and shows recent upload history.

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'

const T = {
  bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return iso }
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunkSize = 0x8000  // avoid call-stack overflow on big files
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any)
  }
  return btoa(binary)
}

// ── Job Reports card ─────────────────────────────────────────────────────────
interface JobRun { id: string; uploaded_at: string; filename: string | null; row_count: number; is_current: boolean; notes: string | null }

function JobReportCard() {
  const [runs, setRuns] = useState<JobRun[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/job-reports/list')
      const d = await r.json()
      setRuns(d.runs || [])
    } catch (e: any) { /* swallow — non-fatal */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function upload(file: File) {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.name)
    if (!ok) { setMessage({ kind: 'err', text: 'File must be .csv, .xls or .xlsx' }); return }
    setUploading(true); setMessage(null)
    try {
      const file_base64 = await fileToBase64(file)
      const r = await fetch('/api/job-reports/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, file_base64 }),
      })
      const d = await r.json()
      if (!r.ok) {
        setMessage({ kind: 'err', text: d.error || 'Upload failed' })
      } else {
        const warnLine = d.warnings?.length ? ` (${d.warnings.length} warning${d.warnings.length > 1 ? 's' : ''})` : ''
        setMessage({
          kind: d.warnings?.length ? 'warn' : 'ok',
          text: `Parsed ${d.job_count} jobs${warnLine}. ${d.rematched_invoices || 0} pending invoice${(d.rematched_invoices || 0) === 1 ? '' : 's'} re-matched.`,
        })
        await load()
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Upload failed' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) upload(file)
  }

  const current = runs.find(r => r.is_current) || null

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Mechanics Desk job report</h3>
        <Link href="/jobs" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>View jobs →</Link>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        CSV, XLS, or XLSX export from Mechanics Desk. Uploading replaces the current data set.
      </div>

      {current && (
        <div style={{background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:11, display:'flex', justifyContent:'space-between', alignItems:'center'}}>
          <span style={{color:T.text2}}>Current: <strong style={{color:T.text}}>{current.filename || 'unnamed'}</strong> — {current.row_count} jobs</span>
          <span style={{color:T.text3, fontSize:10}}>{fmtDate(current.uploaded_at)}</span>
        </div>
      )}

      <div onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
           onDragLeave={() => setDragOver(false)}
           onDrop={onDrop}
           onClick={() => fileRef.current?.click()}
           style={{
             border: `2px dashed ${dragOver ? T.blue : T.border2}`,
             background: dragOver ? 'rgba(79,142,247,0.08)' : T.bg3,
             borderRadius: 8, padding: '20px 16px', textAlign:'center', cursor:'pointer',
             transition: 'all 0.15s ease',
           }}>
        <div style={{fontSize:12, color:T.text2, marginBottom:4}}>
          {uploading ? 'Uploading…' : 'Drag a file here or click to browse'}
        </div>
        <div style={{fontSize:10, color:T.text3}}>.csv · .xls · .xlsx</div>
        <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx"
               onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
               style={{display:'none'}} disabled={uploading}/>
      </div>

      {message && (
        <div style={{
          marginTop:10, padding:'8px 12px', borderRadius:6, fontSize:11,
          background: message.kind === 'ok' ? 'rgba(52,199,123,0.1)' : message.kind === 'warn' ? 'rgba(245,166,35,0.1)' : 'rgba(240,78,78,0.1)',
          border:`1px solid ${message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red}40`,
          color: message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red,
        }}>{message.text}</div>
      )}

      <div style={{marginTop:16}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>
          Recent uploads
        </div>
        {loading ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>No uploads yet.</div>
        ) : (
          <div style={{border:`1px solid ${T.border}`, borderRadius:6, maxHeight:200, overflowY:'auto'}}>
            {runs.slice(0, 10).map(r => (
              <div key={r.id} style={{display:'grid', gridTemplateColumns:'1fr auto auto', gap:10, padding:'7px 10px', borderBottom:`1px solid ${T.border}`, fontSize:11, alignItems:'center'}}>
                <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {r.filename || 'unnamed'}
                  {r.is_current && <span style={{marginLeft:8, fontSize:9, padding:'1px 6px', borderRadius:3, background:T.green, color:'#fff', fontWeight:600}}>CURRENT</span>}
                </div>
                <div style={{color:T.text2, fontVariantNumeric:'tabular-nums'}}>{r.row_count} jobs</div>
                <div style={{color:T.text3, fontSize:10}}>{fmtDate(r.uploaded_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Supplier Invoices card ───────────────────────────────────────────────────
interface SupplierInvoice { id: string; received_at: string; filename: string | null; supplier_name: string | null; status: string; invoice_number: string | null }

function SupplierInvoiceCard() {
  const [recent, setRecent] = useState<SupplierInvoice[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/supplier-invoices/list?pageSize=10')
      const d = await r.json()
      setRecent(d.invoices || [])
    } catch (e: any) { /* swallow */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function upload(file: File) {
    if (!/\.pdf$/i.test(file.name)) { setMessage({ kind: 'err', text: 'File must be a .pdf' }); return }
    setUploading(true); setMessage(null)
    try {
      const pdf_base64 = await fileToBase64(file)
      const r = await fetch('/api/supplier-invoices/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, pdf_base64, source: 'manual' }),
      })
      const d = await r.json()
      if (!r.ok) {
        setMessage({ kind: 'err', text: d.error || 'Upload failed' })
      } else {
        const matchLine = d.po_matches_job && d.matched_job
          ? ` — matched to job ${d.matched_job.job_number}${d.matched_job.customer_name ? ` (${d.matched_job.customer_name})` : ''}`
          : ' — no job match'
        const autoLine = d.auto_approved ? ' · auto-approved (paid)' : ''
        setMessage({
          kind: d.po_matches_job ? 'ok' : 'warn',
          text: `Parsed "${d.parsed?.invoice_number || '?'}"${matchLine}${autoLine}.`,
        })
        await load()
      }
    } catch (e: any) {
      setMessage({ kind: 'err', text: e.message || 'Upload failed' })
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) upload(file)
  }

  function statusPill(s: string) {
    const colors: Record<string, { bg: string; fg: string }> = {
      parsed:         { bg: 'rgba(245,166,35,0.15)', fg: T.amber },
      auto_approved:  { bg: 'rgba(52,199,123,0.15)', fg: T.green },
      approved:       { bg: 'rgba(52,199,123,0.15)', fg: T.green },
      rejected:       { bg: 'rgba(240,78,78,0.15)',  fg: T.red },
      queued_myob:    { bg: 'rgba(79,142,247,0.15)', fg: T.blue },
      pushed_to_myob: { bg: 'rgba(45,212,191,0.15)', fg: T.teal },
      push_failed:    { bg: 'rgba(240,78,78,0.15)',  fg: T.red },
    }
    const c = colors[s] || { bg: T.bg4, fg: T.text3 }
    return <span style={{fontSize:9, padding:'1px 6px', borderRadius:3, background:c.bg, color:c.fg, fontWeight:600}}>{s.toUpperCase().replace('_', ' ')}</span>
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, marginBottom:4}}>
        <h3 style={{margin:0, fontSize:14, fontWeight:600, color:T.text}}>Supplier invoice</h3>
        <Link href="/supplier-invoices" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>View queue →</Link>
      </div>
      <div style={{fontSize:11, color:T.text3, marginBottom:14}}>
        PDF invoice from a supplier. Parsed via Claude, matched to job report POs, added to the approval queue.
      </div>

      <div onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
           onDragLeave={() => setDragOver(false)}
           onDrop={onDrop}
           onClick={() => fileRef.current?.click()}
           style={{
             border: `2px dashed ${dragOver ? T.blue : T.border2}`,
             background: dragOver ? 'rgba(79,142,247,0.08)' : T.bg3,
             borderRadius: 8, padding: '20px 16px', textAlign:'center', cursor:'pointer',
             transition: 'all 0.15s ease',
           }}>
        <div style={{fontSize:12, color:T.text2, marginBottom:4}}>
          {uploading ? 'Parsing PDF…' : 'Drag a PDF here or click to browse'}
        </div>
        <div style={{fontSize:10, color:T.text3}}>.pdf · up to 20 MB</div>
        <input ref={fileRef} type="file" accept=".pdf,application/pdf"
               onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }}
               style={{display:'none'}} disabled={uploading}/>
      </div>

      {message && (
        <div style={{
          marginTop:10, padding:'8px 12px', borderRadius:6, fontSize:11,
          background: message.kind === 'ok' ? 'rgba(52,199,123,0.1)' : message.kind === 'warn' ? 'rgba(245,166,35,0.1)' : 'rgba(240,78,78,0.1)',
          border:`1px solid ${message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red}40`,
          color: message.kind === 'ok' ? T.green : message.kind === 'warn' ? T.amber : T.red,
        }}>{message.text}</div>
      )}

      <div style={{marginTop:16}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>
          Recent invoices
        </div>
        {loading ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>Loading…</div>
        ) : recent.length === 0 ? (
          <div style={{fontSize:11, color:T.text3, padding:'8px 0'}}>No invoices yet.</div>
        ) : (
          <div style={{border:`1px solid ${T.border}`, borderRadius:6, maxHeight:200, overflowY:'auto'}}>
            {recent.map(inv => (
              <div key={inv.id} style={{display:'grid', gridTemplateColumns:'1fr auto auto', gap:10, padding:'7px 10px', borderBottom:`1px solid ${T.border}`, fontSize:11, alignItems:'center'}}>
                <div style={{color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {inv.supplier_name || inv.filename || 'unknown'}
                  {inv.invoice_number && <span style={{marginLeft:6, color:T.text3}}>#{inv.invoice_number}</span>}
                </div>
                <div>{statusPill(inv.status)}</div>
                <div style={{color:T.text3, fontSize:10}}>{fmtDate(inv.received_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tab container ────────────────────────────────────────────────────────────
export default function DataImportsTab() {
  return (
    <div style={{maxWidth:1100}}>
      <div style={{marginBottom:16}}>
        <h2 style={{margin:0, fontSize:18, fontWeight:600, color:T.text}}>Data imports</h2>
        <div style={{fontSize:12, color:T.text3, marginTop:4}}>
          Upload files from external systems. Admin-only.
        </div>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(400px, 1fr))', gap:16}}>
        <JobReportCard/>
        <SupplierInvoiceCard/>
      </div>
    </div>
  )
}
