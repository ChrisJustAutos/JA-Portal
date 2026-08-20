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
//
// Alloy restyle 2026-08-12: kit pills/cards/buttons; variance over/short/exact
// colouring is data semantics and maps onto A.warn/A.bad/neutral unchanged.

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
import { A, RADIUS, SHADOW, Btn, btnStyle, cardStyle, Banner, PageTitle, StatusPill } from '../../../../components/b2b/ui'

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

// Dense filter/search controls — Alloy filled look at staff density.
const denseInp: React.CSSProperties = { padding: '6px 24px 6px 10px', borderRadius: RADIUS.sm, fontSize: 12.5, width: 190, background: T.bg3, color: T.text, border: '1px solid transparent', fontFamily: 'inherit', outline: 'none' }
const pillToggle = (on: boolean, color: string = A.accent): React.CSSProperties => ({
  padding: '5px 12px', borderRadius: RADIUS.pill, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
  border: '1px solid transparent', background: on ? alpha(color, '1a') : 'transparent', color: on ? color : T.text2, whiteSpace: 'nowrap',
})

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
            <Link href="/admin/b2b/jaws-stocktake" style={{fontSize:12.5, color:A.accent, textDecoration:'none'}}>← Back to all uploads</Link>
          </div>

          {!upload ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>{error || 'Loading…'}</div>
          ) : (
            <>
              <PageTitle
                sub={
                  <span style={{display:'inline-flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
                    <UploadStatusPill status={upload.status}/>
                    {isStuck && <StatusPill color={A.warn}>Stuck {Math.round(activeMin!)}m</StatusPill>}
                    {hasSheetNames && sheetNames.length > 1 && <StatusPill color={A.accent}>{sheetNames.length} tabs</StatusPill>}
                  </span>
                }
                action={showDelete ? (
                  <button onClick={runDelete} disabled={deleting}
                    title={isStuck ? `Stuck in matching for ${Math.round(activeMin!)} min — likely crashed. Click to delete.` : 'Delete this upload (nothing in MYOB is affected)'}
                    className="al-press al-focus al-ghost"
                    style={{ ...btnStyle('ghost', 'sm', deleting), color: deleting ? T.text3 : (isStuck ? A.warn : A.bad) }}>
                    {deleting ? 'Deleting…' : (isStuck ? 'Delete (stuck)' : 'Delete')}
                  </button>
                ) : undefined}>
                <span style={{fontFamily:'ui-monospace, monospace'}}>{upload.filename}</span>
              </PageTitle>

              {error && <div style={{marginBottom:12}}><Banner tone="error" onDismiss={() => setError('')}>{error}</Banner></div>}

              {/* ── Top tile row ─────────────────────────────────── */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12, marginBottom:20}}>
                <Tile label="Total rows" value={String(upload.total_rows ?? '—')}/>
                <Tile label="Matched"  value={String(upload.matched_count ?? '—')} highlight={(upload.matched_count || 0) > 0 ? A.good : undefined}/>
                <Tile label="Unmatched" value={String(upload.unmatched_count ?? '—')} highlight={(upload.unmatched_count || 0) > 0 ? A.warn : undefined}/>
                <Tile label="Uncounted in-stock" value={String(upload.in_stock_uncounted ?? '—')} highlight={(upload.in_stock_uncounted || 0) > 0 ? A.warn : undefined}/>
              </div>

              {/* ── Action panel ─────────────────────────────────── */}
              <ActionPanel upload={upload} canEdit={canEdit} actionInFlight={actionInFlight}
                onMatch={runMatch} onComplete={() => setCompletion('complete')} onReopen={() => setCompletion('reopen')} />

              {/* ── Per-sheet breakdown ──────────────────────────── */}
              {hasSheetNames && sheetSummary.length > 1 && (
                <div style={{...cardStyle(true), padding: '12px 14px', marginBottom:14}}>
                  <div style={{fontSize:12, color:T.text2, fontWeight:650, marginBottom:8}}>Per-sheet breakdown</div>
                  <div style={{display:'flex', flexWrap:'wrap', gap:'4px 14px'}}>
                    {sheetSummary.map(s => (
                      <div key={s.sheet} style={{fontSize:12, color:T.text2, fontFamily:'monospace'}}>
                        <span style={{color:T.text}}>{s.sheet}</span>
                        <span style={{color:T.text3}}> · </span>
                        <span style={{color:A.good}}>{s.matched} matched</span>
                        {s.unmatched > 0 && (<><span style={{color:T.text3}}> · </span><span style={{color:A.warn}}>{s.unmatched} unmatched</span></>)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Parse warnings ───────────────────────────────── */}
              {upload.parse_warnings && upload.parse_warnings.length > 0 && (
                <div style={{marginBottom:14}}>
                  <Banner tone="warn">
                    <div style={{fontSize:12.5, fontWeight:600, marginBottom:4}}>Parse warnings</div>
                    {upload.parse_warnings.slice(0, 5).map((w, i) => (<div key={i} style={{fontSize:12, color:T.text2, marginTop:2}}>· {w}</div>))}
                    {upload.parse_warnings.length > 5 && (<div style={{fontSize:12, color:T.text3, marginTop:2}}>… and {upload.parse_warnings.length - 5} more</div>)}
                  </Banner>
                </div>
              )}

              {/* ── Count vs system reconciliation ───────────────── */}
              {comparison && (
                <div style={{...cardStyle(true), padding: '12px 14px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, marginBottom:14}}>
                  <div style={{fontSize:12, color:T.text2, fontWeight:650, marginRight:2}}>Count vs MYOB</div>
                  <StatusPill color={A.good}>{comparison.exact} exact</StatusPill>
                  <StatusPill color={A.bad}>{comparison.short} short</StatusPill>
                  <StatusPill color={A.warn}>{comparison.over} over</StatusPill>
                  {comparison.unknown > 0 && <StatusPill color={T.text3}>{comparison.unknown} no system qty</StatusPill>}
                  <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:12}}>
                    <div style={{fontSize:12.5, color:T.text2}}>
                      Net variance:{' '}
                      <strong style={{color: comparison.netUnits === 0 ? T.text2 : comparison.netUnits > 0 ? A.warn : A.bad, fontVariantNumeric:'tabular-nums'}}>
                        {comparison.netUnits > 0 ? `+${comparison.netUnits}` : comparison.netUnits}
                      </strong>{' '}units
                    </div>
                    {comparison.discrepancies > 0 && (
                      <button onClick={() => setFilter('variance')} className="al-press al-focus"
                        style={{padding:'6px 14px', borderRadius:RADIUS.pill, fontSize:12, fontFamily:'inherit', fontWeight:600,
                          background: filter === 'variance' ? A.warn : alpha(A.warn, '1a'),
                          color: filter === 'variance' ? '#fff' : A.warn,
                          border:'1px solid transparent', cursor:'pointer'}}>
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
                    <h2 style={{margin:0, fontSize:14, fontWeight:650, color:T.text2}}>Match results</h2>
                    <div style={{display:'flex', gap:6, alignItems:'center', flexWrap:'wrap'}}>
                      <div style={{ position:'relative' }}>
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU / name / bin…" style={denseInp} />
                        {search && <button onClick={() => setSearch('')} title="Clear" style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:13, lineHeight:1, padding:0, fontFamily:'inherit' }}>×</button>}
                      </div>
                      {hasSheetNames && sheetNames.length > 1 && (
                        <select value={sheetFilter} onChange={e => setSheetFilter(e.target.value)}
                          style={{ padding:'6px 10px', borderRadius:RADIUS.sm, fontSize:12.5, background:T.bg3, color:T.text, border:'1px solid transparent', fontFamily:'inherit', cursor:'pointer', outline:'none' }}>
                          <option value="all">All sheets</option>
                          {sheetNames.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                      {(['all', 'matched', 'unmatched', 'variance'] as const).map(f => (
                        <button key={f} onClick={() => setFilter(f)} className="al-press al-focus" style={pillToggle(filter === f)}>
                          {f}
                        </button>
                      ))}
                      <span style={{width:1, height:18, background:T.border2, margin:'0 2px'}}/>
                      <div style={{ position:'relative' }}>
                        <button onClick={() => setColsOpen(o => !o)} title="Choose which columns to export"
                          className="al-press al-focus al-ghost" style={{ ...btnStyle('ghost', 'sm'), fontSize: 12 }}>
                          Columns ({exportCols.length}) ▾
                        </button>
                        {colsOpen && (
                          <div onMouseLeave={() => setColsOpen(false)} style={{ position:'absolute', top:'100%', right:0, zIndex:20, marginTop:4, background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:RADIUS.sm + 2, padding:'8px 10px', width:200, boxShadow:SHADOW.md }}>
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                              <button onClick={() => setExportCols(MATCH_COLS.map(c => c.key))} style={{ background:'none', border:'none', color:T.text3, fontSize:12, cursor:'pointer', fontFamily:'inherit', padding:0 }}>All</button>
                              <button onClick={() => setExportCols([])} style={{ background:'none', border:'none', color:T.text3, fontSize:12, cursor:'pointer', fontFamily:'inherit', padding:0 }}>None</button>
                            </div>
                            {MATCH_COLS.map(c => (
                              <label key={c.key} style={{ display:'flex', alignItems:'center', gap:7, padding:'3px 0', fontSize:12.5, cursor:'pointer', color:T.text2 }}>
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
                        className="al-press al-focus al-ghost"
                        style={{ ...btnStyle('ghost', 'sm', filteredResults.length === 0 || exportCols.length === 0), fontSize: 12,
                          color: (filteredResults.length === 0 || exportCols.length === 0) ? T.text3 : A.accent }}>
                        Download CSV ({filteredResults.length})
                      </button>
                    </div>
                  </div>

                  <div style={cardStyle(false)}>
                    <div style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 90px 110px' : '60px 130px 1fr 80px 90px 90px 110px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:12, color:T.text2, fontWeight:650}}>
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
                      <div style={{padding:20, textAlign:'center', fontSize:12.5, color:T.text3}}>No results in this filter.</div>
                    ) : filteredResults.map((r, i) => (
                      <div key={i} style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 90px 110px' : '60px 130px 1fr 80px 90px 90px 110px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12.5, alignItems:'center'}}>
                        <div style={{color:T.text3, fontFamily:'monospace', fontVariantNumeric:'tabular-nums'}}>{r.row_number}</div>
                        {hasSheetNames && (
                          <div style={{color:T.text2, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:12}}>{r.sheet_name || '—'}</div>
                        )}
                        <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:12}}>{r.sku}</div>
                        <div style={{color:T.text2, fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                          {r.status === 'matched' ? (
                            <>
                              {r.myob_name || '—'}
                              {r.myob_number && r.myob_number !== r.sku && (<span style={{color:T.text3, marginLeft:6, fontFamily:'monospace'}}>· {r.myob_number}</span>)}
                            </>
                          ) : (<span style={{color:A.warn}}>Not in MYOB</span>)}
                        </div>
                        <div style={{textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{r.qty}</div>
                        <div style={{textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums'}}>{r.myob_current_qty ?? '—'}</div>
                        {(() => {
                          const v = rowVariance(r)
                          if (v === null) return <div style={{textAlign:'right', color:T.text3}}>—</div>
                          const col = v === 0 ? T.text3 : v > 0 ? A.warn : A.bad
                          return <div style={{textAlign:'right', color:col, fontVariantNumeric:'tabular-nums', fontWeight: v === 0 ? 400 : 600}}>{v > 0 ? `+${v}` : v}</div>
                        })()}
                        <div><MatchStatusPill status={r.status}/></div>
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
  const panel = (border: string, bg?: string): React.CSSProperties => ({
    background: bg || T.bg2, border: `1px solid ${border}`, borderRadius: RADIUS.sm + 2,
    padding: '14px 16px', marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
  })

  if (status === 'completed') {
    return (
      <div style={panel(alpha(A.good, '40'), alpha(A.good, '10'))}>
        <div>
          <div style={{fontSize:13, color:A.good, fontWeight:600}}>✓ Stocktake complete</div>
          <div style={{fontSize:12, color:T.text3, marginTop:4}}>
            Closed out{upload.completed_at ? ` ${new Date(upload.completed_at).toLocaleString('en-AU')}` : ''}. The figures below are kept for reference.
          </div>
        </div>
        {canEdit && (<Btn variant="secondary" size="sm" onClick={onReopen} disabled={actionInFlight}>{actionInFlight ? 'Reopening…' : 'Reopen'}</Btn>)}
      </div>
    )
  }

  if (status === 'matching') {
    return (
      <div style={{...panel(alpha(A.accent, '40')), justifyContent:'flex-start'}}>
        <Spinner/>
        <div style={{fontSize:13, color:A.accent, fontWeight:600}}>Resolving SKUs against MYOB (JAWS)…</div>
        <div style={{fontSize:12, color:T.text3}}>Reading the whole inventory — can take up to a couple of minutes for a big catalogue.</div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div style={panel(alpha(A.bad, '40'), alpha(A.bad, '10'))}>
        <div>
          <div style={{fontSize:13, color:A.bad, fontWeight:600}}>Match failed</div>
          {upload.notes && <div style={{fontSize:12, color:T.text3, marginTop:4}}>{upload.notes}</div>}
        </div>
        {canEdit && (<Btn size="sm" onClick={onMatch} disabled={actionInFlight}>{actionInFlight ? 'Restarting…' : 'Retry match'}</Btn>)}
      </div>
    )
  }

  if (status === 'parsed') {
    return (
      <div style={panel(T.border2)}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>Run match against MYOB</div>
          <div style={{fontSize:12, color:T.text3, marginTop:4}}>Resolves each SKU against the JAWS inventory and computes variance + coverage. Read-only — nothing is written to MYOB.</div>
        </div>
        {canEdit && (<Btn size="sm" onClick={onMatch} disabled={actionInFlight}>{actionInFlight ? 'Matching…' : 'Run match'}</Btn>)}
      </div>
    )
  }

  if (status === 'matched') {
    const matched = upload.matched_count || 0
    const unmatched = upload.unmatched_count || 0
    return (
      <div style={panel(matched > 0 ? alpha(A.good, '40') : T.border2)}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>Review the variance</div>
          <div style={{fontSize:12, color:T.text3, marginTop:4}}>
            <strong style={{color:A.good}}>{matched} matched</strong>
            {unmatched > 0 && <>, <strong style={{color:A.warn}}>{unmatched} not in MYOB</strong></>}
            . Check the count-vs-MYOB strip and coverage below, export CSV, then make any adjustment by hand in MYOB.
          </div>
        </div>
        {canEdit && (
          <div style={{display:'flex', gap:8, flexShrink:0}}>
            <Btn variant="secondary" size="sm" onClick={onMatch} disabled={actionInFlight}>Re-match</Btn>
            <Btn size="sm" onClick={onComplete} disabled={actionInFlight}>{actionInFlight ? 'Saving…' : 'Mark complete'}</Btn>
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
      <span style={{ width:18, height:18, flex:'0 0 auto', borderRadius:'50%', border:`2px solid ${alpha(A.accent, '33')}`, borderTopColor:A.accent, display:'inline-block', animation:'ja-spin 0.8s linear infinite' }} />
      <style>{`@keyframes ja-spin { to { transform: rotate(360deg) } }`}</style>
    </>
  )
}

function UploadStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    parsed:    { label: 'Parsed',    color: T.text3 },
    matching:  { label: 'Matching…', color: A.accent },
    matched:   { label: 'Matched',   color: A.warn },
    completed: { label: 'Completed', color: A.good },
    failed:    { label: 'Failed',    color: A.bad },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return <StatusPill color={e.color}>{e.label}</StatusPill>
}

function MatchStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    matched:   { label: 'Matched',   color: A.good },
    not_found: { label: 'Not found', color: A.warn },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return <StatusPill color={e.color}>{e.label}</StatusPill>
}

function Tile({ label, value, highlight }: { label: string; value: string; highlight?: string }) {
  return (
    <div style={{...cardStyle(true), padding: '12px 14px', borderLeft: highlight ? `3px solid ${highlight}` : `1px solid ${T.border}`}}>
      <div style={{fontSize:12, color:T.text3, fontWeight:650}}>{label}</div>
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
        <h2 style={{margin:0, fontSize:14, fontWeight:650, color:T.text2}}>Coverage vs in-stock</h2>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          {items.length > 0 && (
            <div style={{ position:'relative' }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search item # / name…" style={denseInp} />
              {search && <button onClick={() => setSearch('')} title="Clear" style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:13, lineHeight:1, padding:0, fontFamily:'inherit' }}>×</button>}
            </div>
          )}
          {items.length > 0 && (
            <button onClick={() => downloadCoverageCsv(filtered, filename)}
              className="al-press al-focus al-ghost"
              style={{ ...btnStyle('ghost', 'sm'), fontSize: 12, color: A.accent }}>
              Download CSV ({q ? filtered.length : coverage.uncounted_count})
            </button>
          )}
        </div>
      </div>

      <div style={{...cardStyle(true), padding: '12px 14px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, marginBottom:items.length ? 12 : 0, border:`1px solid ${allCounted ? alpha(A.good, '40') : alpha(A.warn, '40')}`}}>
        <div style={{fontSize:12, color:T.text2, fontWeight:650, marginRight:2}}>MYOB (JAWS)</div>
        <StatusPill color={T.text2}>{coverage.total} in stock</StatusPill>
        <StatusPill color={A.good}>{coverage.counted} counted</StatusPill>
        <StatusPill color={allCounted ? A.good : A.warn}>{coverage.uncounted_count} not counted</StatusPill>
        <div style={{marginLeft:'auto', fontSize:12.5, color:T.text2}}>
          {allCounted
            ? <span style={{color:A.good, fontWeight:600}}>✓ Every in-stock item was counted</span>
            : <>Uncounted value: <strong style={{color:A.warn, fontVariantNumeric:'tabular-nums'}}>{money(coverage.uncounted_value)}</strong> <span style={{color:T.text3}}>at buy price</span></>}
        </div>
      </div>

      {items.length > 0 && (
        <div style={cardStyle(false)}>
          <div style={{display:'grid', gridTemplateColumns:GRID, gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:12, color:T.text2, fontWeight:650}}>
            <div>Item #</div><div>Name</div><div style={{textAlign:'right'}}>On hand</div><div style={{textAlign:'right'}}>Buy</div><div style={{textAlign:'right'}}>Value</div>
          </div>
          {shown.length === 0 ? (
            <div style={{padding:16, textAlign:'center', fontSize:12.5, color:T.text3}}>No items match “{search}”.</div>
          ) : shown.map((it, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:GRID, gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12.5, alignItems:'center'}}>
              <div style={{color:T.text, fontFamily:'monospace', fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.number || '—'}</div>
              <div style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.name || '—'}</div>
              <div style={{textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums'}}>{it.available}</div>
              <div style={{textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums'}}>{money(it.buy_price)}</div>
              <div style={{textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums'}}>{money(it.value)}</div>
            </div>
          ))}
          {filtered.length > DISPLAY && (
            <div style={{padding:'10px 14px', textAlign:'center', fontSize:12.5}}>
              <button onClick={() => setOpen(o => !o)} className="al-press" style={{background:'transparent', border:'none', color:A.accent, cursor:'pointer', fontSize:12.5, fontWeight:600, fontFamily:'inherit'}}>
                {open ? 'Show fewer' : `Show all ${filtered.length}${(!q && coverage.truncated) ? ' (stored)' : ''}`}
              </button>
              {!q && coverage.truncated && <div style={{fontSize:12, color:T.text3, marginTop:4}}>List capped at {items.length}; download CSV for the stored set.</div>}
            </div>
          )}
        </div>
      )}
      {coverageAt && <div style={{fontSize:12, color:T.text3, marginTop:6}}>Checked {new Date(coverageAt).toLocaleString('en-AU')} · counted from the uploaded sheet · in stock = MYOB on-hand qty &gt; 0</div>}
    </div>
  )
}
