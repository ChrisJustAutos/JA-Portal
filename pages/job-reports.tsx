// pages/job-reports.tsx
// Manage the Mechanics Desk job report that feeds PO→job matching.
// Upload new CSV/XLSX exports, see history of uploads, browse the current job set.

import { useState, useEffect, useCallback, useRef } from 'react'
import Head from 'next/head'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { UserRole } from '../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:supplier_invoices')
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'2-digit' })
}
function fmtDateTime(s: string): string {
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString('en-AU', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' })
}

export default function JobReportsPage({ user }: { user: { id: string, email: string, role: UserRole, name: string } }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<any | null>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // Run history
  const [runs, setRuns] = useState<any[]>([])

  // Current jobs
  const [currentRun, setCurrentRun] = useState<any | null>(null)
  const [currentJobs, setCurrentJobs] = useState<any[]>([])
  const [currentTotal, setCurrentTotal] = useState(0)
  const [jobsPage, setJobsPage] = useState(1)
  const pageSize = 50
  const [q, setQ] = useState('')

  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch('/api/job-reports/list')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setRuns(d.runs || [])
    } catch (e: any) { setError(e.message) }
  }, [])

  const loadCurrent = useCallback(async () => {
    try {
      const p = new URLSearchParams({ current: '1', q, page: String(jobsPage), pageSize: String(pageSize) })
      const r = await fetch(`/api/job-reports/list?${p.toString()}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setCurrentRun(d.run || null)
      setCurrentJobs(d.jobs || [])
      setCurrentTotal(d.total || 0)
    } catch (e: any) { setError(e.message) }
  }, [q, jobsPage])

  useEffect(() => { loadRuns() }, [loadRuns])
  useEffect(() => { loadCurrent() }, [loadCurrent])

  async function onFileChange(files: FileList | null) {
    if (!files || files.length === 0) return
    const file = files[0]
    const validExts = ['.csv', '.xlsx', '.xls', '.tsv', '.txt']
    if (!validExts.some(ext => file.name.toLowerCase().endsWith(ext))) {
      setError('Upload a CSV or XLSX file from Mechanics Desk'); return
    }
    setUploading(true); setError(''); setInfo(''); setUploadResult(null)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const s = String(reader.result)
          resolve(s.split(',')[1] || s)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/job-reports/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, file_base64: base64 }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      setUploadResult(d)
      setInfo(`Loaded ${d.job_count} jobs. ${d.rematched_invoices || 0} pending invoice${d.rematched_invoices === 1 ? '' : 's'} newly matched to jobs.`)
      await loadRuns()
      setJobsPage(1)
      await loadCurrent()
    } catch (e: any) { setError(e.message) }
    finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const totalPages = Math.max(1, Math.ceil(currentTotal / pageSize))

  return (
    <>
      <Head><title>Job Reports — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="job-reports" currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>
          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:6}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Job Reports</h1>
          </div>
          <p style={{margin:'0 0 16px', fontSize:13, color:T.text2, maxWidth:720, lineHeight:1.5}}>
            The job report from Mechanics Desk is the source of truth for matching supplier invoice PO numbers to live jobs.
            Upload the latest nightly export here; the portal re-matches any pending supplier invoices automatically.
          </p>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}
          {info  && <div style={{background:'rgba(52,199,123,0.1)', border:`1px solid ${T.green}40`, borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13, marginBottom:12}}>{info}</div>}

          {/* Upload card */}
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:20, marginBottom:20}}>
            <div style={{display:'flex', alignItems:'center', gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:14, fontWeight:600, marginBottom:4}}>Upload new job report</div>
                <div style={{fontSize:12, color:T.text3}}>
                  CSV or XLSX from Mechanics Desk. Needs a Job Number column; other columns (Customer, Vehicle, Status, dates) are matched by name automatically.
                </div>
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.tsv,.txt" onChange={e => onFileChange(e.target.files)} style={{display:'none'}}/>
              <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                style={{padding:'10px 18px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:13, fontWeight:600, fontFamily:'inherit', cursor: uploading ? 'wait' : 'pointer'}}>
                {uploading ? 'Uploading…' : '+ Upload CSV / XLSX'}
              </button>
            </div>

            {uploadResult && uploadResult.warnings?.length > 0 && (
              <div style={{marginTop:12, padding:10, background:`${T.amber}11`, border:`1px solid ${T.amber}40`, borderRadius:6, fontSize:11, color:T.amber}}>
                <strong>Warnings:</strong>
                <ul style={{margin:'4px 0 0 18px', padding:0}}>
                  {uploadResult.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            {uploadResult?.headerMap && (
              <div style={{marginTop:10, padding:10, background:T.bg3, borderRadius:6, fontSize:10, color:T.text3}}>
                <strong style={{color:T.text2}}>Detected columns:</strong>
                {Object.entries(uploadResult.headerMap).map(([k, v]: any) => (
                  <span key={k} style={{marginLeft:10}}>{k} → <code style={{color:T.text}}>{v}</code></span>
                ))}
              </div>
            )}
          </div>

          {/* Current job set */}
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, marginBottom:20, overflow:'hidden'}}>
            <div style={{padding:'12px 16px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
              <div>
                <div style={{fontSize:14, fontWeight:600}}>Current jobs</div>
                {currentRun && (
                  <div style={{fontSize:11, color:T.text3, marginTop:2}}>
                    {currentRun.filename} • uploaded {fmtDateTime(currentRun.uploaded_at)} • {currentRun.row_count} rows
                  </div>
                )}
                {!currentRun && <div style={{fontSize:11, color:T.amber, marginTop:2}}>No job report uploaded yet — upload one above to enable PO matching.</div>}
              </div>
              <div style={{flex:1}}/>
              <input type="text" placeholder="Search job # / customer / vehicle"
                value={q} onChange={e => { setQ(e.target.value); setJobsPage(1) }}
                style={{padding:'6px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', width:260, outline:'none'}}/>
            </div>

            {currentRun && (
              <>
                <div style={{display:'grid', gridTemplateColumns:'120px 1fr 1fr 100px 110px 110px', gap:10, padding:'8px 16px', borderBottom:`1px solid ${T.border}`, fontSize:10, color:T.text3, textTransform:'uppercase', fontWeight:600, letterSpacing:'0.05em'}}>
                  <div>Job #</div>
                  <div>Customer</div>
                  <div>Vehicle</div>
                  <div>Status</div>
                  <div>Opened</div>
                  <div>Closed</div>
                </div>
                {currentJobs.length === 0 ? (
                  <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>{q ? 'No jobs match your search.' : 'No jobs in this run.'}</div>
                ) : (
                  currentJobs.map(j => (
                    <div key={j.id} style={{display:'grid', gridTemplateColumns:'120px 1fr 1fr 100px 110px 110px', gap:10, padding:'8px 16px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                      <div style={{fontFamily:'monospace', fontWeight:500}}>{j.job_number}</div>
                      <div>{j.customer_name || '—'}</div>
                      <div style={{color:T.text2}}>{j.vehicle || '—'}</div>
                      <div><span style={{fontSize:10, padding:'2px 7px', borderRadius:8, background:T.bg3, color:T.text2, border:`1px solid ${T.border}`}}>{j.status || '—'}</span></div>
                      <div style={{color:T.text2}}>{fmtDate(j.opened_date)}</div>
                      <div style={{color:T.text2}}>{fmtDate(j.closed_date)}</div>
                    </div>
                  ))
                )}
                {totalPages > 1 && (
                  <div style={{padding:'10px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', fontSize:11, color:T.text3}}>
                    <div>Page {jobsPage} of {totalPages} — {currentTotal} jobs</div>
                    <div style={{display:'flex', gap:6}}>
                      <button onClick={() => setJobsPage(p => Math.max(1, p-1))} disabled={jobsPage <= 1}
                        style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color: jobsPage <= 1 ? T.text3 : T.text2, fontSize:11, cursor: jobsPage <= 1 ? 'not-allowed' : 'pointer', fontFamily:'inherit'}}>← Prev</button>
                      <button onClick={() => setJobsPage(p => Math.min(totalPages, p+1))} disabled={jobsPage >= totalPages}
                        style={{padding:'4px 10px', borderRadius:5, border:`1px solid ${T.border2}`, background:'transparent', color: jobsPage >= totalPages ? T.text3 : T.text2, fontSize:11, cursor: jobsPage >= totalPages ? 'not-allowed' : 'pointer', fontFamily:'inherit'}}>Next →</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Upload history */}
          <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
            <div style={{padding:'12px 16px', borderBottom:`1px solid ${T.border}`, fontSize:14, fontWeight:600}}>Upload history</div>
            {runs.length === 0 ? (
              <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>No uploads yet.</div>
            ) : (
              runs.map(run => (
                <div key={run.id} style={{display:'grid', gridTemplateColumns:'160px 1fr 100px 100px 1fr', gap:12, padding:'10px 16px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                  <div style={{color:T.text2}}>{fmtDateTime(run.uploaded_at)}</div>
                  <div>{run.filename || '—'}</div>
                  <div style={{textAlign:'right', fontVariantNumeric:'tabular-nums', fontWeight:500}}>{run.row_count} rows</div>
                  <div>{run.is_current && <span style={{fontSize:10, padding:'3px 8px', borderRadius:8, background:`${T.green}22`, color:T.green, border:`1px solid ${T.green}55`, fontWeight:600, textTransform:'uppercase'}}>Current</span>}</div>
                  <div style={{color:T.text3}}>{run.notes || ''}</div>
                </div>
              ))
            )}
          </div>
        </main>
      </div>
    </>
  )
}
