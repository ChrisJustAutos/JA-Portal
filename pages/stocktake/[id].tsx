// pages/stocktake/[id].tsx
//
// Detail page for a single stocktake upload:
//   • Top-line counts + status
//   • If parsed/failed: "Run Match" button to dispatch the GH Action
//   • If matching/pushing: live progress (polls every 3s)
//     — If stuck > 5 min, Delete button surfaces (worker likely crashed)
//   • If matched: preview table with matched/unmatched + "Push to MD" button
//   • If completed: link to the MD stocktake + summary

import { useState, useEffect, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

const MD_BASE = 'https://www.mechanicdesk.com.au'

// If a row stays in matching/pushing longer than this, we treat it as
// stuck (the GH Action worker probably crashed before it could PATCH
// status to 'failed') and allow deletion with a warning.
const STUCK_THRESHOLD_MIN = 5

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:stocktakes')
}

interface MatchEntry {
  row_number: number
  sku: string
  qty: number
  sheet_name?: string
  status: 'matched' | 'not_found' | 'ambiguous' | 'error'
  md_stock_id?: number
  md_stock_name?: string
  md_stock_number?: string
  md_current_qty?: number
  candidates?: Array<{ id: number; stock_number: string; name: string }>
  error?: string
}

interface Upload {
  id: string
  uploaded_at: string
  filename: string
  status: string
  total_rows: number | null
  parsed_rows: any[] | null
  parse_warnings: string[] | null
  matched_at: string | null
  matched_count: number | null
  unmatched_count: number | null
  match_results: MatchEntry[] | null
  push_started_at: string | null
  push_completed_at: string | null
  pushed_count: number | null
  push_errors: any[] | null
  github_run_id: string | null
  mechanicdesk_stocktake_id: string | null
  mechanicdesk_sheet_id: string | null
  mechanicdesk_stocktake_was_created: boolean | null
  notes: string | null
}

interface SessionUser {
  id: string; email: string; role: UserRole; displayName: string | null;
  visibleTabs?: string[] | null;
}

/**
 * Returns minutes since the active phase started, or null if the row
 * isn't in an active phase. For matching: uses uploaded_at (match dispatches
 * within seconds of upload). For pushing: uses push_started_at.
 */
function getActiveMinutes(u: Upload): number | null {
  if (u.status === 'matching') {
    const t = new Date(u.uploaded_at).getTime()
    if (!isFinite(t)) return null
    return (Date.now() - t) / 60000
  }
  if (u.status === 'pushing' && u.push_started_at) {
    const t = new Date(u.push_started_at).getTime()
    if (!isFinite(t)) return null
    return (Date.now() - t) / 60000
  }
  return null
}

export default function StocktakeDetailPage({ user }: { user: SessionUser }) {
  const router = useRouter()
  const id = router.query.id as string | undefined

  const [upload, setUpload] = useState<Upload | null>(null)
  const [error, setError] = useState('')
  const [actionInFlight, setActionInFlight] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [filter, setFilter] = useState<'all' | 'matched' | 'unmatched'>('all')
  const [sheetFilter, setSheetFilter] = useState<string>('all')

  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')
  const isPolling = upload && (upload.status === 'matching' || upload.status === 'pushing')

  const load = useCallback(async () => {
    if (!id) return
    try {
      const r = await fetch(`/api/stocktake/${id}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setUpload(d)
      setError('')
    } catch (e: any) { setError(e.message) }
  }, [id])

  useEffect(() => { load() }, [load])

  // Poll while matching or pushing. Polling itself updates getActiveMinutes
  // each cycle (3s) since `upload` is replaced, so stuck-detection refreshes
  // automatically without a separate timer.
  useEffect(() => {
    if (!isPolling) return
    const i = setInterval(load, 3000)
    return () => clearInterval(i)
  }, [isPolling, load])

  async function runMatch() {
    if (!id || actionInFlight) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/stocktake/${id}/match`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Match failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setActionInFlight(false) }
  }

  async function runPush() {
    if (!id || actionInFlight) return
    if (!upload?.matched_count) return
    if (!confirm(`Push ${upload.matched_count} item(s) to Mechanics Desk?\n\nThis will add them to the active in-progress stocktake (or create a new one if none exists). The stocktake will NOT be finalised — you do that manually in MD.`)) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/stocktake/${id}/push`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Push failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setActionInFlight(false) }
  }

  async function runDelete() {
    if (!id || deleting) return
    if (!upload) return

    const activeMin = getActiveMinutes(upload)
    const isActive = upload.status === 'matching' || upload.status === 'pushing'
    const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN

    let confirmMsg = `Delete portal record for "${upload.filename}"?\n\nThis cannot be undone.`
    if (isStuck) {
      confirmMsg = `"${upload.filename}" appears stuck in "${upload.status}" for ${Math.round(activeMin!)} minutes — the GitHub Action worker has likely crashed.\n\nDelete this orphan portal record?\n\nThis cannot be undone.`
    } else if (upload.mechanicdesk_stocktake_id) {
      confirmMsg += `\n\nNote: The Mechanics Desk stocktake (${upload.mechanicdesk_stocktake_id}) will NOT be deleted — only the portal record. Delete it manually in MD if needed.`
    }
    if (!confirm(confirmMsg)) return

    setDeleting(true); setError('')
    try {
      const r = await fetch(`/api/stocktake/${id}?force=${isStuck ? '1' : '0'}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Delete failed')
      router.push('/stocktake')
    } catch (e: any) {
      setError(e.message)
      setDeleting(false)
    }
  }

  // Multi-tab support: detect when this upload spans multiple sheets
  const hasSheetNames = useMemo(() => {
    if (!upload?.match_results) return false
    return upload.match_results.some(r => r.sheet_name && r.sheet_name.length > 0)
  }, [upload])

  const sheetNames = useMemo(() => {
    if (!upload?.match_results) return [] as string[]
    const set = new Set<string>()
    for (const r of upload.match_results) {
      if (r.sheet_name) set.add(r.sheet_name)
    }
    return Array.from(set).sort()
  }, [upload])

  // Per-sheet roll-up: { sheet, total, matched, unmatched }
  const sheetSummary = useMemo(() => {
    if (!upload?.match_results || !hasSheetNames) return [] as Array<{ sheet: string; total: number; matched: number; unmatched: number }>
    const map = new Map<string, { sheet: string; total: number; matched: number; unmatched: number }>()
    for (const r of upload.match_results) {
      const key = r.sheet_name || '(no sheet)'
      const cur = map.get(key) || { sheet: key, total: 0, matched: 0, unmatched: 0 }
      cur.total++
      if (r.status === 'matched') cur.matched++
      else cur.unmatched++
      map.set(key, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.sheet.localeCompare(b.sheet))
  }, [upload, hasSheetNames])

  const filteredResults = useMemo(() => {
    if (!upload?.match_results) return []
    let rows = upload.match_results
    if (sheetFilter !== 'all') {
      rows = rows.filter(r => r.sheet_name === sheetFilter)
    }
    if (filter === 'matched') return rows.filter(r => r.status === 'matched')
    if (filter === 'unmatched') return rows.filter(r => r.status !== 'matched')
    return rows
  }, [upload, filter, sheetFilter])

  // Stuck detection — recomputed on every render via the polling cycle
  const activeMin = upload ? getActiveMinutes(upload) : null
  const isActive = !!upload && (upload.status === 'matching' || upload.status === 'pushing')
  const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN
  // Show delete in any non-active state OR when actively-running but stuck
  const showDelete = !!upload && canEdit && (!isActive || isStuck)

  return (
    <>
      <Head><title>Stocktake — {upload?.filename || ''}</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="stocktake" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{marginBottom:16}}>
            <Link href="/stocktake" style={{fontSize:11, color:T.blue, textDecoration:'none'}}>← Back to all uploads</Link>
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
                {upload.mechanicdesk_stocktake_id && (
                  <a href={`${MD_BASE}/auto_workshop/app#/stocktakes/${upload.mechanicdesk_stocktake_id}`} target="_blank" rel="noreferrer"
                     style={{fontSize:11, color:T.blue, textDecoration:'none', padding:'3px 8px', border:`1px solid ${T.blue}40`, borderRadius:4}}>
                    Open in MD ↗
                  </a>
                )}
                {showDelete && (
                  <button
                    onClick={runDelete}
                    disabled={deleting}
                    title={isStuck
                      ? `Stuck in "${upload.status}" for ${Math.round(activeMin!)} min — worker likely crashed. Click to delete orphan record.`
                      : 'Delete portal record (does not delete the Mechanics Desk stocktake)'}
                    style={{
                      marginLeft:'auto',
                      padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit',
                      background:'transparent',
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
                <Tile label="Pushed to MD" value={String(upload.pushed_count ?? '—')} highlight={(upload.pushed_count || 0) > 0 ? T.blue : undefined}/>
              </div>

              {/* ── Action panel ─────────────────────────────────── */}
              <ActionPanel
                upload={upload}
                canEdit={canEdit}
                actionInFlight={actionInFlight}
                onMatch={runMatch}
                onPush={runPush}
              />

              {/* ── Per-sheet breakdown (multi-tab uploads only) ── */}
              {hasSheetNames && sheetSummary.length > 1 && (
                <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, padding:'12px 14px', marginBottom:14}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginBottom:8}}>Per-sheet breakdown</div>
                  <div style={{display:'flex', flexWrap:'wrap', gap:'4px 14px'}}>
                    {sheetSummary.map(s => (
                      <div key={s.sheet} style={{fontSize:12, color:T.text2, fontFamily:'monospace'}}>
                        <span style={{color:T.text}}>{s.sheet}</span>
                        <span style={{color:T.text3}}> · </span>
                        <span style={{color:T.green}}>{s.matched} matched</span>
                        {s.unmatched > 0 && (
                          <>
                            <span style={{color:T.text3}}> · </span>
                            <span style={{color:T.amber}}>{s.unmatched} unmatched</span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Parse warnings ───────────────────────────────── */}
              {upload.parse_warnings && upload.parse_warnings.length > 0 && (
                <div style={{background:T.bg2, border:`1px solid ${T.amber}40`, borderRadius:8, padding:'10px 14px', marginBottom:14}}>
                  <div style={{fontSize:11, color:T.amber, fontWeight:600, marginBottom:4}}>Parse warnings</div>
                  {upload.parse_warnings.slice(0, 5).map((w, i) => (
                    <div key={i} style={{fontSize:11, color:T.text3, marginTop:2}}>· {w}</div>
                  ))}
                  {upload.parse_warnings.length > 5 && (
                    <div style={{fontSize:11, color:T.text3, marginTop:2}}>… and {upload.parse_warnings.length - 5} more</div>
                  )}
                </div>
              )}

              {/* ── Match results table ──────────────────────────── */}
              {upload.match_results && upload.match_results.length > 0 && (
                <div style={{marginTop:24}}>
                  <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:12, flexWrap:'wrap'}}>
                    <h2 style={{margin:0, fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>
                      Match results
                    </h2>
                    <div style={{display:'flex', gap:6, alignItems:'center', flexWrap:'wrap'}}>
                      {hasSheetNames && sheetNames.length > 1 && (
                        <select
                          value={sheetFilter}
                          onChange={e => setSheetFilter(e.target.value)}
                          style={{
                            padding:'4px 10px', borderRadius:4, fontSize:11,
                            background:T.bg3, color:T.text, border:`1px solid ${T.border2}`,
                            fontFamily:'inherit', cursor:'pointer',
                          }}>
                          <option value="all">All sheets</option>
                          {sheetNames.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                      {(['all', 'matched', 'unmatched'] as const).map(f => (
                        <button key={f}
                          onClick={() => setFilter(f)}
                          style={{
                            padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit',
                            background: filter === f ? T.blue : 'transparent',
                            color: filter === f ? '#fff' : T.text3,
                            border: `1px solid ${filter === f ? T.blue : T.border2}`,
                            cursor:'pointer',
                          }}>
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                    <div style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 110px' : '60px 130px 1fr 80px 90px 110px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      <div>Row</div>
                      {hasSheetNames && <div>Sheet</div>}
                      <div>SKU</div>
                      <div>MD Match</div>
                      <div style={{textAlign:'right'}}>Counted</div>
                      <div style={{textAlign:'right'}}>System</div>
                      <div>Status</div>
                    </div>
                    {filteredResults.length === 0 ? (
                      <div style={{padding:20, textAlign:'center', fontSize:12, color:T.text3}}>No results in this filter.</div>
                    ) : filteredResults.map((r, i) => (
                      <div key={i} style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 110px' : '60px 130px 1fr 80px 90px 110px', gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
                        <div style={{color:T.text3, fontFamily:'monospace'}}>{r.row_number}</div>
                        {hasSheetNames && (
                          <div style={{color:T.text2, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:11}}>
                            {r.sheet_name || '—'}
                          </div>
                        )}
                        <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.sku}</div>
                        <div style={{color:T.text2, fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                          {r.status === 'matched' ? (
                            <>
                              {r.md_stock_name || '—'}
                              {r.md_stock_number && r.md_stock_number !== r.sku && (
                                <span style={{color:T.text3, marginLeft:6, fontFamily:'monospace'}}>· {r.md_stock_number}</span>
                              )}
                            </>
                          ) : r.status === 'ambiguous' ? (
                            <span style={{color:T.amber}}>{r.candidates?.length || 0} possible matches</span>
                          ) : r.status === 'error' ? (
                            <span style={{color:T.red}}>Error: {r.error}</span>
                          ) : (
                            <span style={{color:T.text3}}>—</span>
                          )}
                        </div>
                        <div style={{textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:500}}>{r.qty}</div>
                        <div style={{textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums'}}>{r.md_current_qty ?? '—'}</div>
                        <div><MatchStatusBadge status={r.status}/></div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Push errors ──────────────────────────────────── */}
              {upload.push_errors && upload.push_errors.length > 0 && (
                <div style={{marginTop:20, background:T.bg2, border:`1px solid ${T.red}40`, borderRadius:8, padding:'12px 14px'}}>
                  <div style={{fontSize:11, color:T.red, fontWeight:600, marginBottom:6}}>{upload.push_errors.length} push error(s)</div>
                  {upload.push_errors.slice(0, 10).map((e: any, i: number) => (
                    <div key={i} style={{fontSize:11, color:T.text3, marginTop:3, fontFamily:'monospace'}}>
                      {e.sheet_name ? `[${e.sheet_name}] ` : ''}Row {e.row_number} · SKU {e.sku} · {e.error}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </>
  )
}

function ActionPanel({ upload, canEdit, actionInFlight, onMatch, onPush }: {
  upload: Upload; canEdit: boolean; actionInFlight: boolean
  onMatch: () => void; onPush: () => void
}) {
  const status = upload.status

  if (status === 'completed') {
    return (
      <div style={{background:`${T.green}10`, border:`1px solid ${T.green}40`, borderRadius:8, padding:'12px 16px', marginBottom:14}}>
        <div style={{fontSize:13, color:T.green, fontWeight:600}}>
          ✓ Pushed {upload.pushed_count}/{upload.matched_count} items to Mechanics Desk
          {upload.mechanicdesk_stocktake_was_created && ' (created new stocktake)'}
        </div>
        <div style={{fontSize:11, color:T.text3, marginTop:4}}>
          Open the stocktake in MD and click <strong>Finish</strong> to commit the counts.
        </div>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div style={{background:`${T.red}10`, border:`1px solid ${T.red}40`, borderRadius:8, padding:'12px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.red, fontWeight:600}}>Operation failed</div>
          {upload.notes && <div style={{fontSize:11, color:T.text3, marginTop:4}}>{upload.notes}</div>}
        </div>
        {canEdit && (
          <button onClick={onMatch} disabled={actionInFlight}
            style={btnStyle(T.blue, actionInFlight)}>
            {actionInFlight ? 'Restarting…' : 'Retry match'}
          </button>
        )}
      </div>
    )
  }

  if (status === 'matching' || status === 'pushing') {
    return (
      <div style={{background:T.bg2, border:`1px solid ${T.blue}40`, borderRadius:8, padding:'12px 16px', marginBottom:14, display:'flex', alignItems:'center', gap:12}}>
        <div style={{fontSize:13, color:T.blue, fontWeight:600}}>
          {status === 'matching' ? 'Resolving SKUs against MD…' : 'Pushing items to MD…'}
        </div>
        <div style={{fontSize:11, color:T.text3}}>This page polls every 3s. GitHub Action runs typically take 30–90s.</div>
        {upload.github_run_id && (
          <a href={`https://github.com/ChrisJustAutos/JA-Portal/actions/runs/${upload.github_run_id}`} target="_blank" rel="noreferrer" style={{fontSize:11, color:T.blue, textDecoration:'none', marginLeft:'auto'}}>
            View GH run ↗
          </a>
        )}
      </div>
    )
  }

  if (status === 'parsed') {
    return (
      <div style={{background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>Step 1 — Run match (dry-run)</div>
          <div style={{fontSize:11, color:T.text3, marginTop:4}}>
            Resolves each SKU in the spreadsheet against MD's product database. Read-only — no inventory changes.
          </div>
        </div>
        {canEdit && (
          <button onClick={onMatch} disabled={actionInFlight} style={btnStyle(T.blue, actionInFlight)}>
            {actionInFlight ? 'Starting…' : 'Run Match'}
          </button>
        )}
      </div>
    )
  }

  if (status === 'matched') {
    const matched = upload.matched_count || 0
    const unmatched = upload.unmatched_count || 0
    return (
      <div style={{background:T.bg2, border:`1px solid ${matched > 0 ? T.amber : T.border2}40`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:13, color:T.text, fontWeight:600}}>
            Step 2 — Review &amp; push to MD
          </div>
          <div style={{fontSize:11, color:T.text3, marginTop:4}}>
            <strong style={{color:T.green}}>{matched} matched</strong>
            {unmatched > 0 && <>, <strong style={{color:T.amber}}>{unmatched} unmatched</strong> (won't be pushed)</>}
            . Push fills counts in an open MD stocktake (or creates one). You'll finalise it manually in MD.
          </div>
        </div>
        {canEdit && matched > 0 && (
          <div style={{display:'flex', gap:8}}>
            <button onClick={onMatch} disabled={actionInFlight} style={{...btnStyle(T.text3, actionInFlight), background:'transparent', border:`1px solid ${T.border2}`, color:T.text2}}>
              Re-match
            </button>
            <button onClick={onPush} disabled={actionInFlight} style={btnStyle(T.green, actionInFlight)}>
              {actionInFlight ? 'Starting…' : `Push ${matched} to MD`}
            </button>
          </div>
        )}
      </div>
    )
  }

  return null
}

function btnStyle(color: string, disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 6,
    border: 'none',
    background: disabled ? T.bg4 : color,
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.5 : 1,
  }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    parsed:    { label: 'Parsed',    color: T.text3 },
    matching:  { label: 'Matching…', color: T.blue },
    matched:   { label: 'Matched',   color: T.amber },
    pushing:   { label: 'Pushing…',  color: T.blue },
    completed: { label: 'Completed', color: T.green },
    failed:    { label: 'Failed',    color: T.red },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return (
    <span style={{padding:'3px 10px', borderRadius:3, background:`${e.color}22`, color:e.color, fontSize:11, fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase'}}>
      {e.label}
    </span>
  )
}

function MatchStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    matched:    { label: 'Matched',    color: T.green },
    not_found:  { label: 'Not found',  color: T.amber },
    ambiguous:  { label: 'Ambiguous',  color: T.amber },
    error:      { label: 'Error',      color: T.red },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return (
    <span style={{padding:'2px 6px', borderRadius:3, background:`${e.color}22`, color:e.color, fontSize:10, fontWeight:600}}>
      {e.label}
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
