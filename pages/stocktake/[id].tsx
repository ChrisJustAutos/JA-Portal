// pages/stocktake/[id].tsx
//
// Detail page for a single stocktake upload:
//   • Top-line counts + status
//   • If parsed/failed: "Run Match" button to dispatch the GH Action
//   • If matching/pushing: live progress (polls every 3s)
//     — If stuck > 5 min, Delete button surfaces (worker likely crashed)
//   • If matched: preview table with matched/unmatched + counted-vs-system
//     variance (compare counts to MD on-hand for manual checking) + "Push to MD"
//   • If completed: link to the MD stocktake + summary

import { useState, useEffect, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'
import { T, alpha } from '../../lib/ui/theme'
import { money } from '../../lib/ui/format'
import { useConfirm } from '../../components/ui/Feedback'

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
  md_bin?: string
  md_location?: string
  sheet_bin?: string       // bin from the uploaded count sheet (preferred over md_bin)
  sheet_location?: string
  candidates?: Array<{ id: number; stock_number: string; name: string }>
  error?: string
  count_source?: 'md_stocktake'  // Count came from the live MD stocktake entry (recheck)
  added_from_md?: boolean        // Row was counted in MD, not in our uploaded sheet
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
  coverage_at?: string | null
  in_stock_total?: number | null
  in_stock_uncounted?: number | null
  coverage?: CoverageData | null
}

interface CoverageItem { stock_number: string; name: string; available: number; buy_price: number; value: number; bin?: string | null; location?: string | null }
interface CoverageData {
  total: number
  counted: number
  uncounted_count: number
  uncounted_value: number
  uncounted: CoverageItem[]
  truncated?: boolean
  source?: string
}

interface SessionUser {
  id: string; email: string; role: UserRole; displayName: string | null;
  visibleTabs?: string[] | null;
}

// Re-sync progress shown in the polling modal.
interface SyncState {
  kind: 'recheck' | 'refresh'
  title: string
  phase: 'running' | 'done' | 'error'
  detail: string
  startedAt: number
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

/**
 * Counted − system variance for a matched row, or null when it can't be
 * compared (row didn't match, or MD returned no on-hand qty for it).
 * Positive = more counted than the system says (overage); negative = shortage.
 */
function rowVariance(r: MatchEntry): number | null {
  if (r.status !== 'matched') return null
  if (typeof r.md_current_qty !== 'number') return null
  return r.qty - r.md_current_qty
}

export default function StocktakeDetailPage({ user }: { user: SessionUser }) {
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
  // Re-sync (recheck / refresh) shows a modal that polls until the worker
  // finishes — instead of a silent background refresh. One sync at a time.
  const [sync, setSync] = useState<SyncState | null>(null)
  const [, setSyncTick] = useState(0)   // 1s ticker so the modal's elapsed counter advances

  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')
  const isPolling = upload && (upload.status === 'matching' || upload.status === 'pushing')
  const rechecking = sync?.kind === 'recheck' && sync.phase === 'running'
  const refreshing = sync?.kind === 'refresh' && sync.phase === 'running'
  const syncing = !!sync && sync.phase === 'running'

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

  // Advance the sync modal's elapsed-time counter once a second while running.
  useEffect(() => {
    if (!syncing) return
    const i = setInterval(() => setSyncTick(t => t + 1), 1000)
    return () => clearInterval(i)
  }, [syncing])

  // Auto-close the modal a beat after a successful sync (it "clears" itself).
  // Errors stay open until the user closes them.
  useEffect(() => {
    if (sync?.phase !== 'done') return
    const t = setTimeout(() => setSync(null), 1500)
    return () => clearTimeout(t)
  }, [sync?.phase])

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
    if (!(await confirmDialog({ title: `Push ${upload.matched_count} item(s) to Mechanics Desk?`, message: 'This will add them to the active in-progress stocktake (or create a new one if none exists). The stocktake will NOT be finalised — you do that manually in MD.' }))) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/stocktake/${id}/push`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Push failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setActionInFlight(false) }
  }

  // Retry ONLY the rows that failed last push, onto the same MD sheet (no new
  // stocktake, no duplicate adds). Used to clean up a partial push — usually a
  // mid-run MD session eviction that 401'd the remaining rows.
  async function retryPushErrors() {
    if (!id || actionInFlight) return
    const n = upload?.push_errors?.length || 0
    if (!n) return
    if (!(await confirmDialog({ title: `Retry ${n} failed item(s)?`, message: 'Re-pushes only the rows that errored, onto the same Mechanics Desk stocktake sheet. Already-pushed items are not touched.' }))) return
    setActionInFlight(true); setError('')
    try {
      const r = await fetch(`/api/stocktake/${id}/push?errors_only=1`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Retry failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setActionInFlight(false) }
  }

  // Drive one of the two re-sync operations through the polling modal. The
  // worker runs in a GitHub Action; we POST to kick it off, then poll the
  // upload every 5s and watch `field` change from its pre-dispatch value to
  // know it finished. The modal stays open (showing elapsed time) until then.
  function startSync(opts: {
    kind: SyncState['kind']
    title: string
    endpoint: string
    watch: 'coverage_at' | 'matched_at'
    runningDetail: string
    doneDetail: string
  }) {
    if (!id || syncing) return
    const prev = (upload as any)?.[opts.watch] || null
    setSync({ kind: opts.kind, title: opts.title, phase: 'running', detail: 'Dispatching worker…', startedAt: Date.now() })
    ;(async () => {
      try {
        const r = await fetch(opts.endpoint, { method: 'POST' })
        const d = await r.json()
        if (!r.ok) { setSync(s => s && { ...s, phase: 'error', detail: d.error || 'Sync failed to start' }); return }
      } catch (e: any) { setSync(s => s && { ...s, phase: 'error', detail: e.message || 'Sync failed to start' }); return }
      setSync(s => s && { ...s, detail: opts.runningDetail })
      let tries = 0
      const iv = setInterval(async () => {
        tries++
        try {
          const rr = await fetch(`/api/stocktake/${id}`)
          const dd = await rr.json()
          if (rr.ok && dd[opts.watch] && dd[opts.watch] !== prev) {
            clearInterval(iv); setUpload(dd)
            setSync(s => s && { ...s, phase: 'done', detail: opts.doneDetail })
            return
          }
        } catch { /* keep polling */ }
        if (tries >= 36) {   // ~3 min
          clearInterval(iv)
          setSync(s => s && { ...s, phase: 'error', detail: 'Still running after 3 minutes — close this and the page will pick up the result shortly.' })
        }
      }, 5000)
    })()
  }

  // Sync from the LIVE MD stocktake entry (after pushing, after editing counts
  // in MD, or after staff count directly in MD). Pulls counted qty + system qty
  // back into our match results AND refreshes coverage off the same read.
  function runRecheck() {
    startSync({
      kind: 'recheck',
      title: 'Syncing counts + coverage from MD',
      endpoint: `/api/stocktake/${id}/recheck`,
      watch: 'coverage_at',
      runningDetail: 'Reading the live MechanicDesk stocktake and recomputing coverage…',
      doneDetail: 'Counts + coverage updated.',
    })
  }

  // Re-read current MD system qty for matched rows (no re-match).
  function runRefreshSystem() {
    startSync({
      kind: 'refresh',
      title: 'Refreshing system quantities',
      endpoint: `/api/stocktake/${id}/refresh`,
      watch: 'matched_at',
      runningDetail: 'Pulling current on-hand quantities from MD Stock Value…',
      doneDetail: 'System quantities updated.',
    })
  }

  async function runDelete() {
    if (!id || deleting) return
    if (!upload) return

    const activeMin = getActiveMinutes(upload)
    const isActive = upload.status === 'matching' || upload.status === 'pushing'
    const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN

    let confirmTitle = `Delete portal record for "${upload.filename}"?`
    let confirmBody = 'This cannot be undone.'
    if (isStuck) {
      confirmTitle = 'Delete this orphan portal record?'
      confirmBody = `"${upload.filename}" appears stuck in "${upload.status}" for ${Math.round(activeMin!)} minutes — the GitHub Action worker has likely crashed.\n\nThis cannot be undone.`
    } else if (upload.mechanicdesk_stocktake_id) {
      confirmBody += `\n\nNote: The Mechanics Desk stocktake (${upload.mechanicdesk_stocktake_id}) will NOT be deleted — only the portal record. Delete it manually in MD if needed.`
    }
    if (!(await confirmDialog({ title: confirmTitle, message: confirmBody, danger: true }))) return

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
    if (sheetFilter !== 'all') rows = rows.filter(r => r.sheet_name === sheetFilter)
    if (filter === 'matched') rows = rows.filter(r => r.status === 'matched')
    else if (filter === 'unmatched') rows = rows.filter(r => r.status !== 'matched')
    else if (filter === 'variance') rows = rows.filter(r => { const v = rowVariance(r); return v !== null && v !== 0 })
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(r => [r.sku, r.md_stock_number, r.md_stock_name, r.sheet_bin, r.md_bin, r.sheet_location, r.md_location].some(v => String(v || '').toLowerCase().includes(q)))
    return rows
  }, [upload, filter, sheetFilter, search])

  // Count-vs-system reconciliation across matched rows (respects the sheet
  // filter so the strip lines up with what's shown). Drives the summary
  // strip and the "review discrepancies" shortcut.
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

  // Stuck detection — recomputed on every render via the polling cycle
  const activeMin = upload ? getActiveMinutes(upload) : null
  const isActive = !!upload && (upload.status === 'matching' || upload.status === 'pushing')
  const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN
  // Show delete in any non-active state OR when actively-running but stuck
  const showDelete = !!upload && canEdit && (!isActive || isStuck)

  return (
    <>
      <Head><title>Stocktake — {upload?.filename || ''}</title></Head>
      <div style={{display:'flex', flexDirection:'column', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={(user as any).displayName} currentUserEmail={(user as any).email}/>
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="stocktake" role={user.role} />
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

              {/* ── Count vs system reconciliation ───────────────── */}
              {comparison && (
                <div style={{display:'flex', flexWrap:'wrap', alignItems:'center', gap:10, marginBottom:14, padding:'12px 14px', background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8}}>
                  <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginRight:2}}>Count vs system</div>
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

              {/* ── Coverage vs in-stock (MD Stock Value report) ── */}
              {upload.coverage && (
                <CoverageSection coverage={upload.coverage} coverageAt={upload.coverage_at || null} filename={upload.filename}
                  canRecheck={canEdit && !!upload.mechanicdesk_stocktake_id} onRecheck={runRecheck} rechecking={rechecking} busy={syncing} />
              )}

              {/* ── Match results table ──────────────────────────── */}
              {upload.match_results && upload.match_results.length > 0 && (
                <div style={{marginTop:24}}>
                  <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:12, flexWrap:'wrap'}}>
                    <h2 style={{margin:0, fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>
                      Match results
                    </h2>
                    <div style={{display:'flex', gap:6, alignItems:'center', flexWrap:'wrap'}}>
                      <div style={{ position:'relative' }}>
                        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU / name / bin…"
                          style={{ padding:'4px 22px 4px 9px', borderRadius:4, fontSize:11, width:180, background:T.bg3, color:T.text, border:`1px solid ${T.border2}`, fontFamily:'inherit', outline:'none' }} />
                        {search && <button onClick={() => setSearch('')} title="Clear" style={{ position:'absolute', right:4, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:13, lineHeight:1, padding:0 }}>×</button>}
                      </div>
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
                      {(['all', 'matched', 'unmatched', 'variance'] as const).map(f => (
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
                      {canEdit && (
                        <button onClick={runRefreshSystem} disabled={syncing} title="Re-read current MD system quantities for the matched items"
                          style={{ padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600, background:'transparent', color: syncing ? T.text3 : T.amber, border:`1px solid ${syncing ? T.border2 : T.amber + '55'}`, cursor: syncing ? 'default' : 'pointer' }}>
                          {refreshing ? '↻ Refreshing…' : '↻ Refresh system qty'}
                        </button>
                      )}
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
                      <button
                        onClick={() => downloadMatchCsv(filteredResults, filter, upload.filename, exportCols)}
                        disabled={filteredResults.length === 0 || exportCols.length === 0}
                        title={`Download the "${filter}" results (${filteredResults.length} rows) as CSV`}
                        style={{
                          padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600,
                          background:'transparent',
                          color: (filteredResults.length === 0 || exportCols.length === 0) ? T.text3 : T.blue,
                          border:`1px solid ${(filteredResults.length === 0 || exportCols.length === 0) ? T.border2 : T.blue + '55'}`,
                          cursor: (filteredResults.length === 0 || exportCols.length === 0) ? 'default' : 'pointer',
                        }}>
                        ↓ CSV ({filteredResults.length})
                      </button>
                    </div>
                  </div>

                  <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                    <div style={{display:'grid', gridTemplateColumns: hasSheetNames ? '60px 110px 130px 1fr 80px 90px 90px 110px' : '60px 130px 1fr 80px 90px 90px 110px', gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                      <div>Row</div>
                      {hasSheetNames && <div>Sheet</div>}
                      <div>SKU</div>
                      <div>MD Match</div>
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
                          <div style={{color:T.text2, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:11}}>
                            {r.sheet_name || '—'}
                          </div>
                        )}
                        <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                          {r.sku}
                          {r.added_from_md && (
                            <span title="Counted directly in MD — not in our uploaded sheet" style={{marginLeft:6, padding:'1px 5px', fontSize:9, fontWeight:700, color:T.amber, border:`1px solid ${T.amber}55`, borderRadius:3, fontFamily:'inherit'}}>MD</span>
                          )}
                        </div>
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

              {/* ── Push errors ──────────────────────────────────── */}
              {upload.push_errors && upload.push_errors.length > 0 && (
                <div style={{marginTop:20, background:T.bg2, border:`1px solid ${T.red}40`, borderRadius:8, padding:'12px 14px'}}>
                  <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:6, flexWrap:'wrap'}}>
                    <div style={{fontSize:11, color:T.red, fontWeight:600}}>{upload.push_errors.length} push error(s)</div>
                    {canEdit && upload.status !== 'pushing' && (
                      <button onClick={retryPushErrors} disabled={actionInFlight}
                        title="Re-push only the failed rows onto the same MD sheet (no duplicates)"
                        style={{padding:'4px 12px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600, background:'transparent', color: actionInFlight ? T.text3 : T.amber, border:`1px solid ${actionInFlight ? T.border2 : T.amber + '55'}`, cursor: actionInFlight ? 'default' : 'pointer'}}>
                        {actionInFlight ? 'Starting…' : `↻ Retry ${upload.push_errors.length} failed`}
                      </button>
                    )}
                  </div>
                  {upload.push_errors.slice(0, 10).map((e: any, i: number) => (
                    <div key={i} style={{fontSize:11, color:T.text3, marginTop:3, fontFamily:'monospace'}}>
                      {e.sheet_name ? `[${e.sheet_name}] ` : ''}Row {e.row_number} · SKU {e.sku} · {e.error}
                    </div>
                  ))}
                  {upload.push_errors.length > 10 && (
                    <div style={{fontSize:11, color:T.text3, marginTop:3}}>… and {upload.push_errors.length - 10} more</div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {sync && <SyncProgressModal state={sync} onClose={() => setSync(null)} />}
    </>
  )
}

// Re-sync progress modal: opens when a recheck/refresh is dispatched and polls
// (driven by the parent) until the worker finishes, then auto-closes. While
// running it can't be dismissed (the job keeps going regardless); on error it
// stays open with a Close button.
function SyncProgressModal({ state, onClose }: { state: SyncState; onClose: () => void }) {
  const running = state.phase === 'running'
  const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000))
  return (
    <div role="dialog" aria-modal="true"
      onMouseDown={e => { if (e.target === e.currentTarget && !running) onClose() }}
      style={{ position:'fixed', inset:0, zIndex:10001, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.55)', padding:16, fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <div style={{ width:'100%', maxWidth:420, background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:10, padding:'20px 22px', boxShadow:'0 12px 48px rgba(0,0,0,0.6)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12 }}>
          {running
            ? <Spinner/>
            : <span style={{ fontSize:20, lineHeight:1, color: state.phase === 'done' ? T.green : T.red }}>{state.phase === 'done' ? '✓' : '⚠'}</span>}
          <div style={{ fontSize:15, fontWeight:600, color:T.text }}>{state.title}</div>
        </div>
        <div style={{ fontSize:12, color: state.phase === 'error' ? T.red : T.text2, lineHeight:1.55, marginBottom: running ? 12 : 16 }}>
          {state.detail}
        </div>
        {running ? (
          <div style={{ fontSize:11, color:T.text3 }}>
            Polling every 5s · {elapsed}s elapsed. Runs in MD via a GitHub Action (usually 30–90s) — this window closes itself when it finishes.
          </div>
        ) : (
          <div style={{ display:'flex', justifyContent:'flex-end' }}>
            <button onClick={onClose} style={{
              padding:'8px 16px', borderRadius:6, fontSize:12, fontFamily:'inherit', fontWeight:600, cursor:'pointer',
              background: alpha(state.phase === 'done' ? T.green : T.blue, '1e'),
              color: state.phase === 'done' ? T.green : T.blue,
              border:`1px solid ${alpha(state.phase === 'done' ? T.green : T.blue, '55')}`,
            }}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <>
      <span style={{ width:18, height:18, flex:'0 0 auto', borderRadius:'50%', border:`2px solid ${alpha(T.blue, '33')}`, borderTopColor:T.blue, display:'inline-block', animation:'ja-spin 0.8s linear infinite' }} />
      <style>{`@keyframes ja-spin { to { transform: rotate(360deg) } }`}</style>
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
      <div style={{background:T.bg2, border:`1px solid ${matched > 0 ? `${T.amber}40` : T.border2}`, borderRadius:8, padding:'14px 16px', marginBottom:14, display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, flexWrap:'wrap'}}>
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
  const header = ['Stock Number', 'Name', 'Bin', 'Location', 'On Hand Qty', 'Buy Price', 'Value (qty x buy)']
  const lines = [header.join(',')]
  for (const it of items) lines.push([esc(it.stock_number), esc(it.name), esc(it.bin || ''), esc(it.location || ''), it.available, it.buy_price, it.value].join(','))
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename.replace(/\.xlsx?$/i, '')}-uncounted-instock.csv`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Selectable match-result columns. Order here is the CSV column order.
const MATCH_COLS: { key: string; label: string; get: (r: MatchEntry) => any }[] = [
  { key: 'row', label: 'Row', get: r => r.row_number },
  { key: 'sheet', label: 'Sheet', get: r => r.sheet_name || '' },
  { key: 'sku', label: 'SKU', get: r => r.sku },
  { key: 'md_match', label: 'MD Match', get: r => r.md_stock_name || '' },
  { key: 'md_stock_number', label: 'MD Stock #', get: r => r.md_stock_number || '' },
  { key: 'bin', label: 'Bin', get: r => r.sheet_bin || r.md_bin || '' },
  { key: 'location', label: 'Location', get: r => r.sheet_location || r.md_location || '' },
  { key: 'counted', label: 'Counted', get: r => r.qty },
  { key: 'system', label: 'System Qty', get: r => (r.md_current_qty != null ? r.md_current_qty : '') },
  { key: 'variance', label: 'Variance', get: r => { const v = rowVariance(r); return v != null ? v : '' } },
  { key: 'status', label: 'Status', get: r => r.status },
  { key: 'note', label: 'Note', get: r => r.status === 'ambiguous' && r.candidates ? `${r.candidates.length} candidates: ${r.candidates.map(c => c.stock_number).join(' | ')}` : (r.error || '') },
]

// Export the active filter's rows as CSV with the chosen columns.
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

// Coverage: which in-stock MD items weren't in the counted sheet. The worker
// pulls MD's in-stock universe (Stock Value report) during Run Match and diffs
// it against the count. This surfaces the gap so nothing is missed.
function CoverageSection({ coverage, coverageAt, filename, canRecheck, onRecheck, rechecking, busy }: {
  coverage: CoverageData; coverageAt: string | null; filename: string
  canRecheck: boolean; onRecheck: () => void; rechecking: boolean; busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const items = coverage.uncounted || []
  const q = search.trim().toLowerCase()
  const filtered = q ? items.filter(it => [it.stock_number, it.name, it.bin, it.location].some(v => String(v || '').toLowerCase().includes(q))) : items
  const DISPLAY = 200
  const shown = open ? filtered : filtered.slice(0, DISPLAY)
  const allCounted = coverage.uncounted_count === 0
  const GRID = '140px 1fr 80px 70px 80px 90px'

  return (
    <div style={{marginTop:24}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:10, gap:12, flexWrap:'wrap'}}>
        <h2 style={{margin:0, fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>
          Coverage vs in-stock
        </h2>
        <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
          {canRecheck && (
            <button onClick={onRecheck} disabled={busy} title="Read the live MechanicDesk stocktake — pulls counted qty + system qty back into the match results AND refreshes coverage"
              style={{padding:'4px 12px', borderRadius:4, fontSize:11, fontFamily:'inherit', fontWeight:600, background:'transparent', color: busy ? T.text3 : T.amber, border:`1px solid ${busy ? T.border2 : T.amber + '55'}`, cursor: busy ? 'default' : 'pointer'}}>
              {rechecking ? '↻ Syncing…' : '↻ Sync counts + coverage from MD'}
            </button>
          )}
          {items.length > 0 && (
            <div style={{ position:'relative' }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search stock # / name / bin…"
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
        <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600, marginRight:2}}>MD Stock Value</div>
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
            <div>Stock #</div><div>Name</div><div>Bin</div><div style={{textAlign:'right'}}>On hand</div><div style={{textAlign:'right'}}>Buy</div><div style={{textAlign:'right'}}>Value</div>
          </div>
          {shown.length === 0 ? (
            <div style={{padding:16, textAlign:'center', fontSize:12, color:T.text3}}>No items match “{search}”.</div>
          ) : shown.map((it, i) => (
            <div key={i} style={{display:'grid', gridTemplateColumns:GRID, gap:12, padding:'9px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center'}}>
              <div style={{color:T.text, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.stock_number || '—'}</div>
              <div style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.name || '—'}</div>
              <div style={{color:T.text3, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{it.bin || '—'}</div>
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
      {coverageAt && <div style={{fontSize:10, color:T.text3, marginTop:6}}>Checked {new Date(coverageAt).toLocaleString('en-AU')} · counted from {coverage.source === 'MD stocktake' ? 'the live MD stocktake' : 'the uploaded sheet'} · in stock = MD on-hand qty &gt; 0</div>}
    </div>
  )
}
