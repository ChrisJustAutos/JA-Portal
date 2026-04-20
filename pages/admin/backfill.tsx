// pages/admin/backfill.tsx
// Admin page for backfilling Orders ↔ Quotes Connect column.
// Workflow: Upload MD export → Dry Run → Review plan → Execute (batched).

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

const STATUS_LABELS: Record<string, string> = {
  matched: 'Matched',
  matched_ambiguous: 'Ambiguous (multi)',
  no_quote_for_email: 'No quote for email',
  no_email_in_md: 'No email in MD',
  job_not_in_md: 'Job not in MD',
  no_job_in_name: 'No job# in name',
  already_linked: 'Already linked',
  skipped_invoice: 'Invoice/merch',
}
const STATUS_COLOURS: Record<string, string> = {
  matched: T.green, matched_ambiguous: T.amber,
  no_quote_for_email: T.red, no_email_in_md: T.red,
  job_not_in_md: T.text3, no_job_in_name: T.text3,
  already_linked: T.blue, skipped_invoice: T.text3,
}

interface Run {
  id: string
  created_at: string
  status: string
  md_filename: string | null
  md_row_count: number
  summary: any
  error_message: string | null
  matched_at: string | null
  executed_at: string | null
}

interface Match {
  id: number
  order_id: string
  order_name: string
  order_date: string | null
  job_number: string | null
  md_rep: string | null
  md_email_norm: string | null
  match_status: string
  matched_quote_id: string | null
  matched_quote_name: string | null
  matched_quote_date: string | null
  matched_quote_status: string | null
  days_before_order: number | null
  alternatives_count: number
  execute_status: string | null
  execute_error: string | null
}

export default function BackfillPage() {
  const router = useRouter()
  const [run, setRun] = useState<Run | null>(null)
  const [matches, setMatches] = useState<Match[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [running, setRunning] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [skipIds, setSkipIds] = useState<Set<number>>(new Set())
  const [warnings, setWarnings] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const PAGE_SIZE = 100

  // Load run from URL (?runId=)
  useEffect(() => {
    const rid = router.query.runId as string | undefined
    if (rid && (!run || run.id !== rid)) {
      loadRun(rid, '', '', 0)
    }
  }, [router.query.runId])

  const loadRun = useCallback(async (runId: string, status: string, searchStr: string, off: number) => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (searchStr) params.set('search', searchStr)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(off))
      const r = await fetch(`/api/backfill/runs/${runId}?${params}`)
      if (r.status === 401) { router.push('/login'); return }
      if (!r.ok) throw new Error(`Load failed: ${r.status}`)
      const data = await r.json()
      setRun(data.run)
      setMatches(data.matches)
      setTotalCount(data.totalCount)
      setError('')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [router])

  async function handleUpload(file: File) {
    if (!file) return
    setUploading(true)
    setError('')
    setWarnings([])
    try {
      const reader = new FileReader()
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string
          resolve(result.split(',')[1])  // strip data: prefix
        }
        reader.onerror = () => reject(new Error('File read failed'))
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/backfill/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentBase64 }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(err.error || 'Upload failed')
      }
      const data = await r.json()
      if (data.warnings?.length) setWarnings(data.warnings)
      router.push(`/admin/backfill?runId=${data.runId}`, undefined, { shallow: true })
      await loadRun(data.runId, '', '', 0)
    } catch (e: any) { setError(e.message) }
    finally { setUploading(false) }
  }

  async function runDryRun() {
    if (!run) return
    setRunning(true)
    setError('')
    try {
      const r = await fetch('/api/backfill/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Dry run failed' }))
        throw new Error(err.error || 'Dry run failed')
      }
      await loadRun(run.id, statusFilter, search, 0)
    } catch (e: any) { setError(e.message) }
    finally { setRunning(false) }
  }

  // Execute loop — processes batches until remaining=0
  async function runExecute() {
    if (!run) return
    if (!confirm(`This will link ${run.summary?.executeEligible || 0} orders to their matched quotes in Monday.com. Proceed?`)) return
    setExecuting(true)
    setError('')
    try {
      let remaining = 1  // force first iteration
      while (remaining > 0) {
        const r = await fetch(`/api/backfill/runs/${run.id}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batchSize: 25, skipIds: Array.from(skipIds) }),
        })
        if (!r.ok) {
          const err = await r.json().catch(() => ({ error: 'Execute failed' }))
          throw new Error(err.error || 'Execute failed')
        }
        const data = await r.json()
        remaining = data.remaining ?? 0
        // Refresh view
        await loadRun(run.id, statusFilter, search, offset)
        // Clear the skip set after first batch (the backend applied them)
        if (skipIds.size > 0) setSkipIds(new Set())
      }
    } catch (e: any) { setError(e.message) }
    finally { setExecuting(false) }
  }

  function toggleSkip(id: number) {
    setSkipIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const filterCount = (status: string) => run?.summary?.byMatchStatus?.[status] ?? 0

  // Pagination helpers
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const goPage = (newOffset: number) => {
    setOffset(newOffset)
    if (run) loadRun(run.id, statusFilter, search, newOffset)
  }
  const applyFilter = (status: string) => {
    setStatusFilter(status)
    setOffset(0)
    if (run) loadRun(run.id, status, search, 0)
  }
  const applySearch = (s: string) => {
    setSearch(s)
    setOffset(0)
    if (run) loadRun(run.id, statusFilter, s, 0)
  }

  return (
    <>
      <Head><title>Backfill — Orders ↔ Quotes</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        <PortalSidebar activeId="reports"/>
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:600}}>Backfill — Orders ↔ Quotes</div>
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(167,139,250,0.12)',color:T.purple,border:'1px solid rgba(167,139,250,0.2)'}}>Admin</span>
            <div style={{flex:1}}/>
            {run && (
              <span style={{fontSize:11,color:T.text3}}>
                Run {run.id.slice(0,8)}… · {run.md_row_count} MD jobs · status <strong style={{color:T.text2}}>{run.status}</strong>
              </span>
            )}
          </div>

          <div style={{flex:1,overflowY:'auto',padding:20}}>
            {error && <div style={{background:'rgba(240,78,78,0.1)',border:`1px solid ${T.red}40`,borderRadius:8,padding:12,marginBottom:16,color:T.red,fontSize:12}}>{error}</div>}
            {warnings.map((w,i) => (
              <div key={i} style={{background:'rgba(245,166,35,0.1)',border:`1px solid ${T.amber}40`,borderRadius:8,padding:10,marginBottom:10,color:T.amber,fontSize:12}}>⚠ {w}</div>
            ))}

            {/* Step 1: Upload */}
            {!run && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20,marginBottom:16}}>
                <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>Step 1 — Upload Mechanics Desk export</div>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.6,marginBottom:14}}>
                  Export your jobs from Mechanics Desk (XLS/XLSX/CSV). Required columns: <code style={{color:T.teal}}>Job Number</code>, <code style={{color:T.teal}}>Customer Email</code>, <code style={{color:T.teal}}>Created By</code>.
                  Optional: <code>Customer Phone</code>, <code>Created Date</code>.
                </div>
                <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv"
                  onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])}
                  disabled={uploading}
                  style={{fontSize:12,color:T.text2}}/>
                {uploading && <div style={{fontSize:11,color:T.text3,marginTop:8}}>Uploading & parsing…</div>}
              </div>
            )}

            {/* Step 2: Dry run */}
            {run && run.status === 'draft' && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20,marginBottom:16}}>
                <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>Step 2 — Dry run</div>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.6,marginBottom:14}}>
                  Fetches all Monday orders in the default window (Jan–Dec 2026) and all quotes from the 5 rep boards, then matches them. No mutations yet.
                  <br/>This takes 30–90 seconds.
                </div>
                <button onClick={runDryRun} disabled={running}
                  style={{padding:'8px 16px',borderRadius:6,border:`1px solid ${T.accent}`,background:T.accent,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>
                  {running ? 'Matching…' : 'Run Dry Run'}
                </button>
              </div>
            )}

            {run && run.status === 'matching' && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:20,marginBottom:16,color:T.text2,fontSize:12}}>
                Matching in progress… (refresh in a minute)
              </div>
            )}

            {/* Summary bar */}
            {run && (run.status === 'ready' || run.status === 'executing' || run.status === 'executed' || run.status === 'failed') && run.summary && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16,marginBottom:16}}>
                <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}>
                  <div style={{fontSize:13,fontWeight:600}}>Match plan</div>
                  <div style={{fontSize:11,color:T.text3}}>{run.summary.ordersInPeriod} orders · {run.summary.executeEligible} eligible to link</div>
                  <div style={{flex:1}}/>
                  <button onClick={() => run && window.open(`/api/backfill/runs/${run.id}/csv`, '_blank')}
                    style={{padding:'5px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer'}}>
                    Download CSV
                  </button>
                  {run.status === 'ready' && (
                    <button onClick={runExecute} disabled={executing}
                      style={{padding:'6px 14px',borderRadius:5,border:`1px solid ${T.green}`,background:T.green,color:'#fff',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                      {executing ? 'Executing…' : `Execute ${run.summary.executeEligible} links`}
                    </button>
                  )}
                  {run.status === 'executing' && (
                    <button onClick={runExecute} disabled={executing}
                      style={{padding:'6px 14px',borderRadius:5,border:`1px solid ${T.amber}`,background:T.amber,color:'#000',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                      {executing ? 'Executing…' : 'Resume Execute'}
                    </button>
                  )}
                </div>

                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:8}}>
                  {Object.entries(STATUS_LABELS).map(([k, label]) => {
                    const n = filterCount(k)
                    const colour = STATUS_COLOURS[k]
                    const active = statusFilter === k
                    return (
                      <button key={k} onClick={() => applyFilter(active ? '' : k)}
                        style={{
                          padding:'8px 10px',borderRadius:6,
                          border:`1px solid ${active?colour:T.border2}`,
                          background:active?colour+'20':T.bg3,
                          cursor:'pointer',textAlign:'left',fontFamily:'inherit',
                        }}>
                        <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:.5}}>{label}</div>
                        <div style={{fontSize:18,fontWeight:700,color:colour,marginTop:2}}>{n}</div>
                      </button>
                    )
                  })}
                </div>

                {run.status === 'executed' && run.summary.executeSuccess !== undefined && (
                  <div style={{marginTop:12,padding:10,borderRadius:6,background:'rgba(52,199,123,0.08)',border:`1px solid ${T.green}40`,fontSize:12}}>
                    ✓ Executed — {run.summary.executeSuccess} success, {run.summary.executeFailed} failed, {run.summary.executeSkipped} skipped
                  </div>
                )}
              </div>
            )}

            {/* Review table */}
            {run && matches.length > 0 && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
                <div style={{padding:'10px 14px',display:'flex',alignItems:'center',gap:10,borderBottom:`1px solid ${T.border}`}}>
                  <input placeholder="Search order / job# / email…"
                    value={search} onChange={e => applySearch(e.target.value)}
                    style={{flex:1,padding:'6px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:T.bg3,color:T.text,fontSize:12,fontFamily:'inherit'}}/>
                  <div style={{fontSize:11,color:T.text3}}>
                    {totalCount.toLocaleString()} rows · page {page}/{totalPages}
                  </div>
                  <button disabled={offset <= 0} onClick={() => goPage(Math.max(0, offset - PAGE_SIZE))}
                    style={{padding:'4px 10px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:offset>0?'pointer':'not-allowed',opacity:offset>0?1:.4}}>‹</button>
                  <button disabled={offset + PAGE_SIZE >= totalCount} onClick={() => goPage(offset + PAGE_SIZE)}
                    style={{padding:'4px 10px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:offset+PAGE_SIZE<totalCount?'pointer':'not-allowed',opacity:offset+PAGE_SIZE<totalCount?1:.4}}>›</button>
                </div>
                <div style={{maxHeight:'60vh',overflowY:'auto'}}>
                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                    <thead style={{position:'sticky',top:0,background:T.bg3,zIndex:1}}>
                      <tr style={{textAlign:'left',color:T.text3,fontSize:10,textTransform:'uppercase',letterSpacing:.5}}>
                        <th style={{padding:'8px 10px',width:30}}>Skip</th>
                        <th style={{padding:'8px 10px'}}>Order</th>
                        <th style={{padding:'8px 10px'}}>Job#</th>
                        <th style={{padding:'8px 10px'}}>Rep</th>
                        <th style={{padding:'8px 10px'}}>Email</th>
                        <th style={{padding:'8px 10px'}}>Status</th>
                        <th style={{padding:'8px 10px'}}>Matched quote</th>
                        <th style={{padding:'8px 10px'}}>Days</th>
                        <th style={{padding:'8px 10px'}}>Alts</th>
                        <th style={{padding:'8px 10px'}}>Exec</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matches.map(m => {
                        const executable = m.match_status === 'matched' || m.match_status === 'matched_ambiguous'
                        const skipped = skipIds.has(m.id)
                        return (
                          <tr key={m.id} style={{borderTop:`1px solid ${T.border}`,opacity:skipped?.4:1}}>
                            <td style={{padding:'6px 10px',textAlign:'center'}}>
                              {executable && m.execute_status === 'pending' && (
                                <input type="checkbox" checked={skipped} onChange={() => toggleSkip(m.id)} title="Skip this match"/>
                              )}
                            </td>
                            <td style={{padding:'6px 10px',color:T.text,maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={m.order_name}>
                              {m.order_name}
                              <div style={{fontSize:10,color:T.text3}}>{m.order_date || '—'}</div>
                            </td>
                            <td style={{padding:'6px 10px',fontFamily:'monospace',color:T.text2}}>{m.job_number || '—'}</td>
                            <td style={{padding:'6px 10px',color:T.text2}}>{m.md_rep || '—'}</td>
                            <td style={{padding:'6px 10px',color:T.text3,fontSize:10,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={m.md_email_norm||''}>{m.md_email_norm || '—'}</td>
                            <td style={{padding:'6px 10px'}}>
                              <span style={{padding:'2px 6px',borderRadius:4,fontSize:10,background:(STATUS_COLOURS[m.match_status]||T.text3)+'20',color:STATUS_COLOURS[m.match_status]||T.text3}}>
                                {STATUS_LABELS[m.match_status] || m.match_status}
                              </span>
                            </td>
                            <td style={{padding:'6px 10px',color:T.text2,maxWidth:260,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={m.matched_quote_name||''}>
                              {m.matched_quote_name || '—'}
                              {m.matched_quote_date && <div style={{fontSize:10,color:T.text3}}>{m.matched_quote_date} · {m.matched_quote_status}</div>}
                            </td>
                            <td style={{padding:'6px 10px',color:m.days_before_order!==null && m.days_before_order<0 ? T.amber : T.text2,fontFamily:'monospace'}}>
                              {m.days_before_order !== null ? m.days_before_order : '—'}
                            </td>
                            <td style={{padding:'6px 10px',color:T.text3,fontFamily:'monospace'}}>{m.alternatives_count || ''}</td>
                            <td style={{padding:'6px 10px'}}>
                              {m.execute_status === 'success' && <span style={{color:T.green,fontSize:10}}>✓ linked</span>}
                              {m.execute_status === 'failed' && <span style={{color:T.red,fontSize:10}} title={m.execute_error||''}>✗ {(m.execute_error||'').slice(0,30)}</span>}
                              {m.execute_status === 'skipped' && <span style={{color:T.text3,fontSize:10}}>skipped</span>}
                              {m.execute_status === 'pending' && <span style={{color:T.text3,fontSize:10}}>pending</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {run && !loading && matches.length === 0 && run.status === 'ready' && (
              <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:30,textAlign:'center',color:T.text3,fontSize:12}}>
                No rows match the current filter.
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'admin:settings')
}
