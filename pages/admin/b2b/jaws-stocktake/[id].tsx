// pages/admin/b2b/jaws-stocktake/[id].tsx
//
// Detail page for a single JAWS stocktake upload (B2B admin section):
//   • Top-line counts + status
//   • parsed/failed → "Run match" (resolves SKUs against MYOB JAWS, in-process)
//   • matching → live progress (polls every 3s; the synchronous match request
//     returns the finished row directly)
//   • matched → variance table (counted vs MYOB on-hand) + coverage (in-stock
//     MYOB items not counted) + CSV export
//
// Report-only: nothing is ever written to MYOB.

import { useState, useEffect, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../../lib/authServer'
import { UserRole, roleHasPermission } from '../../../../lib/permissions'
import { T, alpha } from '../../../../lib/ui/theme'
import { money } from '../../../../lib/ui/format'
import { useConfirm } from '../../../../components/ui/Feedback'

const STUCK_THRESHOLD_MIN = 5

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:b2b')
}

interface MatchEntry {
  row_number: number
  sku: string
  qty: number
  sheet_name?: string
  status: 'matched' | 'not_found'
  myob_name?: string
  myob_number?: string
  myob_current_qty?: number
  myob_available?: number
  myob_buy_price?: number
  sheet_bin?: string
  sheet_location?: string
}

interface CoverageItem { number: string; name: string; available: number; buy_price: number; value: number }
interface CoverageData {
  total: number
  counted: number
  uncounted_count: number
  uncounted_value: number
  uncounted: CoverageItem[]
  truncated?: boolean
  source?: string
}

interface Upload {
  id: string
  uploaded_at: string
  filename: string
  status: string
  total_rows: number | null
  parsed_rows: any[] | null
  parse_warnings: string[] | null
  notes: string | null
  matched_at: string | null
  matched_count: number | null
  unmatched_count: number | null
  match_results: MatchEntry[] | null
  completed_at?: string | null
  completed_by?: string | null
  coverage_at?: string | null
  in_stock_total?: number | null
  in_stock_uncounted?: number | null
  coverage?: CoverageData | null
}

interface SessionUser {
  id: string; email: string; role: UserRole; displayName: string | null;
  visibleTabs?: string[] | null;
}

function getActiveMinutes(u: Upload): number | null {
  if (u.status !== 'matching') return null
  const t = new Date(u.uploaded_at).getTime()
  if (!isFinite(t)) return null
  return (Date.now() - t) / 60000
}

/** Counted − MYOB on-hand for a matched row, or null when not comparable. */
function rowVariance(r: MatchEntry): number | null {
  if (r.status !== 'matched') return null
  if (typeof r.myob_current_qty !== 'number') return null
  return r.qty - r.myob_current_qty
}

export default function JawsStocktakeDetailPage({ user }: { user: SessionUser }) {
  const router = useRouter()
  const confirmDialog = useConfirm()
  const id = router.query.id as string | undefined

  const [upload, setUpload] = useState<Upload | null>(null)
  const [error, setError] = useState('')
  const [actionInFlight, setActionInFlight] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [filter, setFilter] = useState<'all' | 'matched' | 'unmatched' | 'variance'>('all')
  const [sheetFilter, setSheetFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [exportCols, setExportCols] = useState<string[]>(MATCH_COLS.map(c => c.key))
  const [colsOpen, setColsOpen] = useState(false)

  const canEdit = roleHasPermission(user.role, 'edit:b2b_catalogue')
  const isPolling = upload && upload.status === 'matching'

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/b2b/admin/jaws-stocktake/${id}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setUpload(d)
      setError('')
    } catch (e: any) { setError(e.message) }
  }, [id])

  useEffect(() => { load() }, [load])

  // Poll while matching — recovers the result if the user reloaded mid-run.
  useEffect(() => {
    if (!isPolling) return
    const i = setInterval(load, 3000)
    return () => clearInterval(i)
  }, [isPolling, load])

  async function runMatch() {
    if (!id || actionInFlight) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/b2b/admin/jaws-stocktake/${id}/match`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Match failed')
      setUpload(d)   // the match request returns the finished row directly
    } catch (e: any) { setError(e.message); await load() }
    finally { setActionInFlight(false) }
  }

  async function setCompletion(action: 'complete' | 'reopen') {
    if (!id || actionInFlight) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/b2b/admin/jaws-stocktake/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Update failed')
      setUpload(d)
    } catch (e: any) { setError(e.message) }
    finally { setActionInFlight(false) }
  }

  async function runDelete() {
    if (!id || deleting || !upload) return

    const activeMin = getActiveMinutes(upload)
    const isActive = upload.status === 'matching'
    const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN

    let confirmTitle = `Delete "${upload.filename}"?`
    let confirmBody = 'This cannot be undone. Nothing in MYOB is affected.'
    if (isStuck) {
      confirmTitle = 'Delete this stuck record?'
      confirmBody = `"${upload.filename}" appears stuck in "matching" for ${Math.round(activeMin!)} minutes — the match likely crashed.\n\nThis cannot be undone.`
    }
    if (!(await confirmDialog({ title: confirmTitle, message: confirmBody, danger: true }))) return

    setDeleting(true); setError('')
    try {
      const r = await fetch(`/api/b2b/admin/jaws-stocktake/${id}?force=${isStuck ? '1' : '0'}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Delete failed')
      router.push('/admin/b2b/jaws-stocktake')
    } catch (e: any) {
      setError(e.message)
      setDeleting(false)
    }
  }

  const hasSheetNames = useMemo(() => {
    if (!upload?.match_results) return false
    return upload.match_results.some(r => r.sheet_name && r.sheet_name.length > 0)
  }, [upload])

  const sheetNames = useMemo(() => {
    if (!upload?.match_results) return [] as string[]
    const set = new Set<string>()
    for (const r of upload.match_results) if (r.sheet_name) set.add(r.sheet_name)
    return Array.from(set).sort()
  }, [upload])

  const sheetSummary = useMemo(() => {
    if (!upload?.match_results || !hasSheetNames) return [] as Array<{ sheet: string; total: number; matched: number; unmatched: number }>
    const map = new Map<string, { sheet: string; total: number; matched: number; unmatched: number }>()
    for (const r of upload.match_results) {
      const key = r.sheet_name || '(no sheet)'
      const cur = map.get(key) || { sheet: key, total: 0, matched: 0, unmatched: 0 }
      cur.total++
      if (r.status === 'matched') cur.matched++; else cur.unmatched++
      map.set(key, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.sheet.localeCompare(b.sheet))
  }, [upload, hasSheetNames])

  const filteredResults = useMemo(() => {
    if (!upload?.match_results) return []
    let rows = upload.match_results
    if (sheetFilter !== 'all') rows = rows.filter(r => r.sheet_name === sheetFilter)
    if (filter === 'matched') rows = rows.filter(r => r.status === 'matched')
    else if (filter === 'unmatched') rows = rows.filter(r => r.status !== 'matched')
    else if (filter === 'variance') rows = rows.filter(r => { const v = rowVariance(r); return v !== null && v !== 0 })
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(r => [r.sku, r.myob_number, r.myob_name, r.sheet_bin, r.sheet_location].some(v => String(v || '').toLowerCase().includes(q)))
    return rows
  }, [upload, filter, sheetFilter, search])

  const comparison = useMemo(() => {
    if (!upload?.match_results) return null
    let rows = upload.match_results.filter(r => r.status === 'matched')
    if (sheetFilter !== 'all') rows = rows.filter(r => r.sheet_name === sheetFilter)
    if (rows.length === 0) return null
    let exact = 0, over = 0, short = 0, unknown = 0, netUnits = 0
    for (const r of rows) {
      const v = rowVariance(r)
      if (v === null) { unknown++; continue }
      netUnits += v
      if (v === 0) exact++
      else if (v > 0) over++
      else short++
    }
    return { total: rows.length, exact, over, short, unknown, netUnits, discrepancies: over + short }
  }, [upload, sheetFilter])

  const activeMin = upload ? getActiveMinutes(upload) : null
  const isActive = !!upload && upload.status === 'matching'
  const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN
  const showDelete = !!upload && canEdit && (!isActive || isStuck)

  return (
    <>
      <Head><title>JAWS Stocktake — {upload?.filename || ''}</title></Head>
      <div style={{display:'flex', flexDirection:'column', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={(user as any).displayName} currentUserEmail={(user as any).email}/>
        <main className="b2b-admin-main" style={{flex:1, padding:'28px 32px', width:'100%', boxSizing:'border-box', overflow:'auto'}}>
          <B2BAdminTabs active="stocktake" />

          <div style={{marginBottom:16}}>
            <Link href="/admin/b2b/jaws-stocktake" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>← Back to all uploads</Link>
          </div>

          {!upload ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>{error || 'Loading…'}</div>
          ) : (
            <>
              <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:16, flexWrap:'wrap'}}>
                <h1 style={{margin:0, fontSize:20, fontWeight:600, fontFamily:'monospace', color:T.text}}>{upload.filename}</h1>
                <StatusBadge status={upload.status}/>
                {isStuck && (
                  <span style={{padding:'3px 8px', borderRadius:3, background:`${T.amber}22`, color:T.amber, fontSize:11, fontWeight:600, letterSpacing:'0.05em'}}>
                    ⚠ STUCK {Math.round(activeMin!)}m
                  </span>
                )}
                {hasSheetNames && sheetNames.length > 1 && (
                  <span style={{padding:'3px 8px', borderRadius:3, background:`${T.purple}22`, color:T.purple, fontSize:11, fontWeight:600, letterSpacing:'0.05em'}}>
                    {sheetNames.length} tabs
                  </span>
                )}
                {showDelete && (
                  <button onClick={runDelete} disabled={deleting}
                    title={isStuck ? `Stuck in matching for ${Math.round(activeMin!)} min — likely crashed. Click to delete.` : 'Delete this upload (nothing in MYOB is affected)'}
                    style={{
                      marginLeft:'auto', padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', background:'transparent',
                      color: deleting ? T.text3 : (isStuck ? T.amber : T.red),
                      border:`1px solid ${deleting ? T.border2 : (isStuck ? T.amber : T.red)}40`,
                      cursor: deleting ? 'default' : 'pointer',
                    }}>
                    {deleting ? 'Deleting…' : (isStuck ? 'Delete (stuck)' : 'Delete')}
                  </button>
                )}
              </div>

              {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

              {/* ── Top tile row ─────────────────────────────────── */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Total rows" value={String(upload.total_rows ?? '—')}/>
                <Tile label="Matched"  value={String(upload.matched_count ?? '—')} highlight={(upload.matched_count || 0) > 0 ? T.green : undefined}/>
                <Tile label="Unmatched" value={String(upload.unmatched_count ?? '—')} highlight={(upload.unmatched_count || 0) > 0 ? T.amber : undefined}/>
                <Tile label="Uncounted in-stock" value={String(upload.in_stock_uncounted ?? '—')} highlight={(upload.in_stock_uncounted || 0) > 0 ? T.amber : undefined}/>
              </div>

              {/* ── Action panel ─────────────────────────────────── */}
              <ActionPanel upload={upload} canEdit={canEdit} actionInFlight={actionInFlight}
                onMatch={runMatch} onComplete={() => setCompletion('complete')} onReopen={() => setCompletion('reopen')} />

              {/* ── Per-sheet breakdown ──────────────────────────── */}
              {hasSheetNames && sheetSummary.length > 1 && (
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, padding:'12px 14px', marginBottom:14}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>Per-sheet breakdown</div>
                  <div style={{display:'flex', flexWrap:'wrap', gap:'4px 14px'}}>
                    {sheetSummary.map(s => (
                      <div key={s.sheet} style={{fontSize:12, color:T.text2, fontFamily:'monospace'}}>
                        <span style={{color:T.text}}>{s.sheet}</span>
                        <span style={{color:T.text3}}> · </span>
                        <span style={{color:T.green}}>{s.matched} matched</span>
                        {s.unmatched > 0 && (<><span style={{color:T.text3}}> · </span><span style={{color:T.amber}}>{s.unmatched} unmatched</span></>)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Parse warnings ───────────────────────────────── */}
              {upload.parse_warnings && upload.parse_warnings.length > 0 && (
                <div style={{background:T.bg2, border:`1px solid ${T.amber}40`, borderRadius:8, padding:'10px 14px', marginBottom:14}}>
                  <div style={{fontSize:11, color:T.amber, fontWeight:600, marginBottom:4}}>Parse warnings</div>
                  {upload.parse_warnings.slice(0, 5).map((w, i) => (<div key={i} style={{fontSize:11, color:T.text3, marginTop:2}}>· {w}</div>))}
                  {upload.parse_warnings.length > 5 && (<div style={{fontSize:11, color:T.text3, marginTop:2}}>… and {upload.parse_warnings.length - 5} more</div>)}
                </div>
              )}

              {/* ── Count vs system reconciliation ───────────────── */}
              {comparison && (
                <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, marginBottom:14, padding:'12px 14px', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginRight:2}}>Count vs MYOB</div>
                  <Pill color={T.green} label={`${comparison.exact} exact`}/>
                  <Pill color={T.red}   label={`${comparison.short} short`}/>
                  <Pill color={T.amber} label={`${comparison.over} over`}/>
                  {comparison.unknown > 0 && <Pill color={T.text3} label={`${comparison.unknown} no system qty`}/>}
                  <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:12}}>
                    <div style={{fontSize:12, color:T.text2}}>
                      Net variance:{' '}
                      <strong style={{color: comparison.netUnits === 0 ? T.text2 : comparison.netUnits > 0 ? T.amber : T.red, fontVariantNumeric:'tabular-nums'}}>
                        {comparison.netUnits > 0 ? `+${comparison.netUnits}` : comparison.netUnits}
                      </strong>{' '}units
                    </div>
                    {comparison.discrepancies > 0 && (
                      <button onClick={() => setFilter('variance')}
                        style={{padding:'4px 12px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600,
                          background: filter === 'variance' ? T.amber : 'transparent',
                          color: filter === 'variance' ? 'var(--t-bg3)' : T.amber,
                          border:`1px solid ${T.amber}`, cursor:'pointer'}}>
                        Review {comparison.discrepancies} discrepanc{comparison.discrepancies === 1 ? 'y' : 'ies'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── Coverage vs in-stock (MYOB) ──────────────────── */}
              {upload.coverage && (
                <CoverageSection coverage={upload.coverage} coverageAt={upload.coverage_at || null} filename={upload.filename} />
              )}

              {/* ── Match results table ──────────────────────────── */}
              {upload.match_results && upload.match_results.length > 0 && (
                <div style={{marginTop:24}}>
                  <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:12, flexWrap:'wrap'}}>
                    <h2 style={{margin:0, fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>Match results</h2>
                    <div style={{display:'flex', gap:6, alignItems:'center', flexWrap:'wrap'}}>
                      <div style={{ position:'relative' }}>
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU / name / bin…"
                          style={{ padding:'4px 22px 4px 9px', borderRadius:4, fontSize:11, width:180, background:T.bg3, color:T.text, border:`1px solid ${T.border2}`, fontFamily:'inherit', outline:'none' }} />
                        {search && <button onClick={() => setSearch('')} title="Clear" style={{ position:'absolute', right:4, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:13, lineHeight:1, padding:0 }}>×</button>}
                      </div>
                      {hasSheetNames && sheetNames.length > 1 && (
                        <select value={sheetFilter} onChange={e => setSheetFilter(e.target.value)}
                          style={{ padding:'4px 10px', borderRadius:4, fontSize:11, background:T.bg3, color:T.text, border:`1px solid ${T.border2}`, fontFamily:'inherit', cursor:'pointer' }}>
                          <option value="all">All sheets</option>
                          {sheetNames.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                      {(['all', 'matched', 'unmatched', 'variance'] as const).map(f => (
                        <button key={f} onClick={() => setFilter(f)}
                          style={{ padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit',
                            background: filter === f ? T.blue : 'transparent',
                            color: filter === f ? '#fff' : T.text3,
                            border: `1px solid ${filter === f ? T.blue : T.border2}`, cursor:'pointer' }}>
                          {f}
                        </button>
                      ))}
                      <span style={{width:1, height:18, background:T.border2, margin:'0 2px'}}/>
                      <div style={{ position:'relative' }}>
                        <button onClick={() => setColsOpen(o => !o)} title="Choose which columns to export"
                          style={{ padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', background:'transparent', color:T.text2, border:`1px solid ${T.border2}`, cursor:'pointer' }}>
                          Columns ({exportCols.length}) ▾
                        </button>
                        {colsOpen && (
                          <div onMouseLeave={() => setColsOpen(false)} style={{ position:'absolute', top:'100%', right:0, zIndex:20, marginTop:4, background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:6, padding:'8px 10px', width:200, boxShadow:'0 10px 30px rgba(0,0,0,0.5)' }}>
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                              <button onClick={() => setExportCols(MATCH_COLS.map(c => c.key))} style={{ background:'none', border:'none', color:T.text3, fontSize:10, cursor:'pointer', fontFamily:'inherit', padding:0 }}>All</button>
                              <button onClick={() => setExportCols([])} style={{ background:'none', border:'none', color:T.text3, fontSize:10, cursor:'pointer', fontFamily:'inherit', padding:0 }}>None</button>
                            </div>
                            {MATCH_COLS.map(c => (
                              <label key={c.key} style={{ display:'flex', alignItems:'center', gap:7, padding:'3px 0', fontSize:12, cursor:'pointer', color:T.text2 }}>
                                <input type="checkbox" checked={exportCols.includes(c.key)} onChange={() => setExportCols(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key])} style={{ margin:0 }} />
                                {c.label}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                      <button onClick={() => downloadMatchCsv(filteredResults, filter, upload.filename, exportCols)}
                        disabled={filteredResults.length === 0 || exportCols.length === 0}
                        title={`Download the "${filter}" results (${filteredResults.length} rows) as CSV`}
                        style={{ padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600, background:'transparent',
                          color: (filteredResults.length === 0 || exportCols.length === 0) ? T.text3 : T.blue,
                          border:`1px solid ${(filteredResults.length === 0 || exportCols.length === 0) ? T.border2 : T.blue + '55'}`,
                          cursor: (filteredResults.length === 0 || exportCols.length === 0) ? 'default' : 'pointer' }}>
                        ↓ CSV ({filteredResults.length})
                      </button>
                    </div>
                  </div>

                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                    <div style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 90px 110px' : '60px 130px 1fr 80px 90px 90px 110px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      <div>Row</div>
                      {hasSheetNames && <div>Sheet</div>}
                      <div>SKU</div>
                      <div>MYOB Match</div>
                      <div style={{textAlign:'right'}}>Counted</div>
                      <div style={{textAlign:'right'}}>System</div>
                      <div style={{textAlign:'right'}}>Variance</div>
                      <div>Status</div>
                    </div>
                    {filteredResults.length === 0 ? (
                      <div style={{padding:20, textAlign:'center', fontSize:12, color:T.text3}}>No results in this filter.</div>
                    ) : filteredResults.map((r, i) => (
                      <div key={i} style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 90px 110px' : '60px 130px 1fr 80px 90px 90px 110px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                        <div style={{color:T.text3, fontFamily:'monospace'}}>{r.row_number}</div>
                        {hasSheetNames && (
                          <div style={{color:T.text2, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:11}}>{r.sheet_name || '—'}</div>
                        )}
                        <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.sku}</div>
                        <div style={{color:T.text2, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                          {r.status === 'matched' ? (
                            <>
                              {r.myob_name || '—'}
                              {r.myob_number && r.myob_number !== r.sku && (<span style={{color:T.text3, marginLeft:6, fontFamily:'monospace'}}>· {r.myob_number}</span>)}
                            </>
                          ) : (<span style={{color:T.amber}}>Not in MYOB</span>)}
                        </div>
                        <div style={{textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{r.qty}</div>
                        <div style={{textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums'}}>{r.myob_current_qty ?? '—'}</div>
                        {(() => {
                          const v = rowVariance(r)
                          if (v === null) return <div style={{textAlign:'right', color:T.text3}}>—</div>
                          const col = v === 0 ? T.text3 : v > 0 ? T.amber : T.red
                          return <div style={{textAlign:'right', color:col, fontVariantNumeric:'tabular-nums', fontWeight: v === 0 ? 400 : 600}}>{v > 0 ? `+${v}` : v}</div>
                        })()}
                        <div><MatchStatusBadge status={r.status}/></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </>
  )
}

function ActionPanel({ upload, canEdit, actionInFlight, onMatch, onComplete, onReopen }: {
  upload: Upload; canEdit: boolean; actionInFlight: boolean
  onMatch: () => void; onComplete: () => void; onReopen: () => void
}) {
  const status = upload.status

  if (status === 'completed') {
    return (
      <div style={{background:`${T.green}10`, border:`1px solid ${T.green}40`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.green, fontWeight:600}}>✓ Stocktake complete</div>
          <div style={{fontSize:11, color:T.text3, marginTop:4}}>
            Closed out{upload.completed_at ? ` ${new Date(upload.completed_at).toLocaleString('en-AU')}` : ''}. The figures below are kept for reference.
          </div>
        </div>
        {canEdit && (<button onClick={onReopen} disabled={actionInFlight} style={{...btnStyle(T.text3, actionInFlight), background:'transparent', border:`1px solid ${T.border2}`, color:T.text2}}>{actionInFlight ? 'Reopening…' : 'Reopen'}</button>)}
      </div>
    )
  }

  if (status === 'matching') {
    return (
      <div style={{background:T.bg2, border:`1px solid ${T.blue}40`, borderRadius:8, padding:'12px 16px', marginBottom:14, display:'flex', alignItems:'center', gap:12}}>
        <Spinner/>
        <div style={{fontSize:13, color:T.blue, fontWeight:600}}>Resolving SKUs against MYOB (JAWS)…</div>
        <div style={{fontSize:11, color:T.text3}}>Reading the whole inventory — can take up to a couple of minutes for a big catalogue.</div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div style={{background:`${T.red}10`, border:`1px solid ${T.red}40`, borderRadius:8, padding:'12px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.red, fontWeight:600}}>Match failed</div>
          {upload.notes && <div style={{fontSize:11, color:T.text3, marginTop:4}}>{upload.notes}</div>}
        </div>
        {canEdit && (<button onClick={onMatch} disabled={actionInFlight} style={btnStyle(T.blue, actionInFlight)}>{actionInFlight ? 'Restarting…' : 'Retry match'}</button>)}
      </div>
    )
  }

  if (status === 'parsed') {
    return (
      <div style={{background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>Run match against MYOB</div>
          <div style={{fontSize:11, color:T.text3, marginTop:4}}>Resolves each SKU against the JAWS inventory and computes variance + coverage. Read-only — nothing is written to MYOB.</div>
        </div>
        {canEdit && (<button onClick={onMatch} disabled={actionInFlight} style={btnStyle(T.blue, actionInFlight)}>{actionInFlight ? 'Matching…' : 'Run match'}</button>)}
      </div>
    )
  }

  if (status === 'matched') {
    const matched = upload.matched_count || 0
    const unmatched = upload.unmatched_count || 0
    return (
      <div style={{background:T.bg2, border:`1px solid ${matched > 0 ? `${T.green}40` : T.border2}`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>Review the variance</div>
          <div style={{fontSize:11, color:T.text3, marginTop:4}}>
            <strong style={{color:T.green}}>{matched} matched</strong>
            {unmatched > 0 && <>, <strong style={{color:T.amber}}>{unmatched} not in MYOB</strong></>}
            . Check the count-vs-MYOB strip and coverage below, export CSV, then make any adjustment by hand in MYOB.
          </div>
        </div>
        {canEdit && (
          <div style={{display:'flex', gap:8, flexShrink:0}}>
            <button onClick={onMatch} disabled={actionInFlight} style={{...btnStyle(T.text3, actionInFlight), background:'transparent', border:`1px solid ${T.border2}`, color:T.text2}}>Re-match</button>
            <button onClick={onComplete} disabled={actionInFlight} style={btnStyle(T.green, actionInFlight)}>{actionInFlight ? 'Saving…' : 'Mark complete'}</button>
          </div>
        )}
      </div>
    )
  }

  return null
}

function Spinner() {
  return (
    <>
      <span style={{ width:18, height:18, flex:'0 0 auto', borderRadius:'50%', border:`2px solid ${alpha(T.blue, '33')}`, borderTopColor:T.blue, display:'inline-block', animation:'ja-spin 0.8s linear infinite' }} />
      <style>{`@keyframes ja-spin { to { transform: rotate(360deg) } }`}</style>
    </>
  )
}

function btnStyle(color: string, disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px', borderRadius: 6, border: 'none',
    background: disabled ? T.bg4 : color, color: '#fff',
    fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit', opacity: disabled ? 0.5 : 1,
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    parsed:    { label: 'Parsed',    color: T.text3 },
    matching:  { label: 'Matching…', color: T.blue },
    matched:   { label: 'Matched',   color: T.amber },
    completed: { label: 'Completed', color: T.green },
    failed:    { label: 'Failed',    color: T.red },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return (
    <span style={{padding:'3px 10px', borderRadius:3, background:`${e.color}22`, color:e.color, fontSize:11, fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase'}}>{e.label}</span>
  )
}

function MatchStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    matched:   { label: 'Matched',   color: T.green },
    not_found: { label: 'Not found', color: T.amber },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return (<span style={{padding:'2px 6px', borderRadius:3, background:`${e.color}22`, color:e.color, fontSize:10, fontWeight:600}}>{e.label}</span>)
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span style={{display:'inline-flex', alignItems:'center', gap:6, padding:'3px 9px', borderRadius:20, background:alpha(color, '1a'), border:`1px solid ${alpha(color, '40')}`, fontSize:11, fontWeight:600, color}}>
      <span style={{width:6, height:6, borderRadius:'50%', background:color}}/>
      {label}
    </span>
  )
}

function Tile({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderLeft: highlight ? `3px solid ${highlight}` : `1px solid ${T.border}`, borderRadius:10, padding:'12px 14px'}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>{label}</div>
      <div style={{fontSize:22, fontWeight:700, color:T.text, fontVariantNumeric:'tabular-nums', marginTop:4, lineHeight:1.1}}>{value}</div>
    </div>
  )
}

function downloadCoverageCsv(items: CoverageItem[], filename: string) {
  const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const header = ['Item Number', 'Name', 'On Hand Qty', 'Buy Price', 'Value (qty x buy)']
  const lines = [header.join(',')]
  for (const it of items) lines.push([esc(it.number), esc(it.name), it.available, it.buy_price, it.value].join(','))
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename.replace(/\.xlsx?$/i, '')}-uncounted-instock.csv`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const MATCH_COLS: { key: string; label: string; get: (r: MatchEntry) => any }[] = [
  { key: 'row', label: 'Row', get: r => r.row_number },
  { key: 'sheet', label: 'Sheet', get: r => r.sheet_name || '' },
  { key: 'sku', label: 'SKU', get: r => r.sku },
  { key: 'myob_match', label: 'MYOB Match', get: r => r.myob_name || '' },
  { key: 'myob_number', label: 'MYOB Item #', get: r => r.myob_number || '' },
  { key: 'bin', label: 'Bin', get: r => r.sheet_bin || '' },
  { key: 'location', label: 'Location', get: r => r.sheet_location || '' },
  { key: 'counted', label: 'Counted', get: r => r.qty },
  { key: 'system', label: 'System Qty', get: r => (r.myob_current_qty != null ? r.myob_current_qty : '') },
  { key: 'variance', label: 'Variance', get: r => { const v = rowVariance(r); return v != null ? v : '' } },
  { key: 'status', label: 'Status', get: r => r.status },
]

function downloadMatchCsv(rows: MatchEntry[], label: string, filename: string, cols: string[]) {
  const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const sel = MATCH_COLS.filter(c => cols.includes(c.key))
  if (sel.length === 0) return
  const lines = [sel.map(c => esc(c.label)).join(',')]
  for (const r of rows) lines.push(sel.map(c => esc(c.get(r))).join(','))
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename.replace(/\.xlsx?$/i, '')}-${label}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Coverage: which in-stock MYOB (JAWS) items weren't in the counted sheet.
function CoverageSection({ coverage, coverageAt, filename }: {
  coverage: CoverageData; coverageAt: string | null; filename: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const items = coverage.uncounted || []
  const q = search.trim().toLowerCase()
  const filtered = q ? items.filter(it => [it.number, it.name].some(v => String(v || '').toLowerCase().includes(q))) : items
  const DISPLAY = 200
  const shown = open ? filtered : filtered.slice(0, DISPLAY)
  const allCounted = coverage.uncounted_count === 0
  const GRID = '160px 1fr 80px 90px 100px'

  return (
    <div style={{marginTop:24}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:12, flexWrap:'wrap'}}>
        <h2 style={{margin:0, fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>Coverage vs in-stock</h2>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          {items.length > 0 && (
            <div style={{ position:'relative' }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search item # / name…"
                style={{ padding:'4px 22px 4px 9px', borderRadius:4, fontSize:11, width:180, background:T.bg3, color:T.text, border:`1px solid ${T.border2}`, fontFamily:'inherit', outline:'none' }} />
              {search && <button onClick={() => setSearch('')} title="Clear" style={{ position:'absolute', right:4, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:13, lineHeight:1, padding:0 }}>×</button>}
            </div>
          )}
          {items.length > 0 && (
            <button onClick={() => downloadCoverageCsv(filtered, filename)}
              style={{padding:'4px 12px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600, background:'transparent', color:T.blue, border:`1px solid ${T.blue}55`, cursor:'pointer'}}>
              ↓ Download CSV ({q ? filtered.length : coverage.uncounted_count})
            </button>
          )}
        </div>
      </div>

      <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, marginBottom:items.length ? 12 : 0, padding:'12px 14px', background:T.bg2, border:`1px solid ${allCounted ? T.green + '40' : T.amber + '40'}`, borderRadius:8}}>
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginRight:2}}>MYOB (JAWS)</div>
        <Pill color={T.text2} label={`${coverage.total} in stock`}/>
        <Pill color={T.green} label={`${coverage.counted} counted`}/>
        <Pill color={allCounted ? T.green : T.amber} label={`${coverage.uncounted_count} not counted`}/>
        <div style={{marginLeft:'auto', fontSize:12, color:T.text2}}>
          {allCounted
            ? <span style={{color:T.green, fontWeight:600}}>✓ Every in-stock item was counted</span>
            : <>Uncounted value: <strong style={{color:T.amber, fontVariantNumeric:'tabular-nums'}}>{money(coverage.uncounted_value)}</strong> <span style={{color:T.text3}}>at buy price</span></>}
        </div>
      </div>

      {items.length > 0 && (
        <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
          <div style={{display:'grid', gridTemplateColumns:GRID, gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
            <div>Item #</div><div>Name</div><div style={{textAlign:'right'}}>On hand</div><div style={{textAlign:'right'}}>Buy</div><div style={{textAlign:'right'}}>Value</div>
          </div>
          {shown.length === 0 ? (
            <div style={{padding:16, textAlign:'center', fontSize:12, color:T.text3}}>No items match “{search}”.</div>
          ) : shown.map((it, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:GRID, gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
              <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.number || '—'}</div>
              <div style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.name || '—'}</div>
              <div style={{textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums'}}>{it.available}</div>
              <div style={{textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums'}}>{money(it.buy_price)}</div>
              <div style={{textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums'}}>{money(it.value)}</div>
            </div>
          ))}
          {filtered.length > DISPLAY && (
            <div style={{padding:'10px 14px', textAlign:'center', fontSize:12}}>
              <button onClick={() => setOpen(o => !o)} style={{background:'transparent', border:'none', color:T.blue, cursor:'pointer', fontSize:12, fontFamily:'inherit'}}>
                {open ? 'Show fewer' : `Show all ${filtered.length}${(!q && coverage.truncated) ? ' (stored)' : ''}`}
              </button>
              {!q && coverage.truncated && <div style={{fontSize:10, color:T.text3, marginTop:4}}>List capped at {items.length}; download CSV for the stored set.</div>}
            </div>
          )}
        </div>
      )}
      {coverageAt && <div style={{fontSize:10, color:T.text3, marginTop:6}}>Checked {new Date(coverageAt).toLocaleString('en-AU')} · counted from the uploaded sheet · in stock = MYOB on-hand qty &gt; 0</div>}
    </div>
  )
}
