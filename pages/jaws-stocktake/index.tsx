// pages/jaws-stocktake/index.tsx
//
// JAWS stocktake landing page:
//   • Drag-and-drop XLSX upload card
//   • List of past uploads with status — click into one to match & review
//   • Per-row Delete (admin/manager) — DB only, never touches MYOB
//
// Workflow:
//   1. Drop XLSX → POST /api/jaws-stocktake/upload → redirect to /jaws-stocktake/{id}
//   2. On the detail page, Run match → review variance + coverage → export CSV.
//      Any adjustment is made by hand in MYOB (this feature is report-only).

import { useState, useEffect, useRef, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import InventoryTabs from '../../components/InventoryTabs'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole, roleHasPermission } from '../../lib/permissions'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../../components/ui'
import { useConfirm } from '../../components/ui/Feedback'

// If a row stays in 'matching' longer than this, the in-process match likely
// crashed/timed out before flipping status — allow deletion with a warning.
const STUCK_THRESHOLD_MIN = 5

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:stocktakes')
}

interface UploadRow {
  id: string
  uploaded_at: string
  filename: string
  status: string
  total_rows: number | null
  matched_count: number | null
  unmatched_count: number | null
  in_stock_uncounted: number | null
  matched_at: string | null
  uploaded_by_name: string | null
}

interface SessionUser {
  id: string; email: string; role: UserRole; displayName: string | null;
  visibleTabs?: string[] | null;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, slice as any)
  }
  return btoa(binary)
}

// Minutes since 'matching' started (anchored on uploaded_at — match dispatches
// within seconds of upload), or null when not matching.
function getActiveMinutes(u: UploadRow): number | null {
  if (u.status !== 'matching') return null
  const t = new Date(u.uploaded_at).getTime()
  if (!isFinite(t)) return null
  return (Date.now() - t) / 60000
}

export default function JawsStocktakeIndexPage({ user }: { user: SessionUser }) {
  const router = useRouter()
  const confirmDialog = useConfirm()
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [, setNow] = useState(0)

  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/jaws-stocktake/list')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setUploads(d.uploads || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function deleteUpload(u: UploadRow) {
    if (deletingId) return

    const activeMin = getActiveMinutes(u)
    const isActive = u.status === 'matching'
    const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN

    if (isActive && !isStuck) {
      const remaining = activeMin !== null ? Math.max(1, Math.ceil(STUCK_THRESHOLD_MIN - activeMin)) : STUCK_THRESHOLD_MIN
      setError(`Cannot delete "${u.filename}" while matching. If genuinely stuck, the option appears after ~${remaining} more minute(s).`)
      return
    }

    let confirmTitle = `Delete "${u.filename}"?`
    let confirmBody = 'This cannot be undone. Nothing in MYOB is affected.'
    if (isStuck) {
      confirmTitle = 'Delete this stuck record?'
      confirmBody = `"${u.filename}" appears stuck in "matching" for ${Math.round(activeMin!)} minutes — the match likely crashed.\n\nThis cannot be undone.`
    }
    if (!(await confirmDialog({ title: confirmTitle, message: confirmBody, danger: true }))) return

    setDeletingId(u.id); setError('')
    try {
      const r = await fetch(`/api/jaws-stocktake/${u.id}?force=${isStuck ? '1' : '0'}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Delete failed')
      setUploads(prev => prev.filter(x => x.id !== u.id))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const i = setInterval(() => setNow(n => n + 1), 30_000)
    return () => clearInterval(i)
  }, [])

  const gridCols = canEdit
    ? '1fr 110px 90px 110px 120px 130px 70px'
    : '1fr 110px 90px 110px 120px 130px'

  return (
    <>
      <Head><title>JAWS Stocktake — Just Autos</title></Head>
      <div style={{display:'flex', flexDirection:'column', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={(user as any).displayName} currentUserEmail={(user as any).email}/>
        <WorkshopTabs active="inventory" role={user.role} />
        <InventoryTabs active="stocktake_jaws" role={user.role} />
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'baseline', gap:12, marginBottom:6}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>JAWS Stocktake</h1>
            <span style={{fontSize:11, color:T.text3}}>
              Upload an XLSX to compare counts against MYOB (JAWS)
            </span>
          </div>
          <p style={{margin:'0 0 20px 0', fontSize:12, color:T.text3, maxWidth:820, lineHeight:1.6}}>
            Drop a spreadsheet with SKU/Product Code and Counted Quantity columns. Portal resolves each SKU against
            MYOB (JAWS) inventory and shows you the per-line variance against on-hand, plus a coverage check of in-stock
            items that weren't counted. <strong style={{color:T.text2}}>Report-only — nothing is written to MYOB; make any adjustment in MYOB yourself.</strong>
          </p>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {canEdit && <UploadCard onUploaded={(id) => router.push(`/jaws-stocktake/${id}`)} />}

          <div style={{marginTop:30}}>
            <h2 style={{margin:'0 0 12px 0', fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>
              Recent uploads
            </h2>
            {loading ? (
              <SkeletonRows rows={8}/>
            ) : uploads.length === 0 ? (
              <div style={{padding:20, textAlign:'center', color:T.text3, fontSize:13, background:T.bg2, borderRadius:8, border:`1px dashed ${T.border2}`}}>
                No uploads yet.
              </div>
            ) : (
              <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
                <div style={{display:'grid', gridTemplateColumns:gridCols, gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, background:T.bg3, fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                  <div>File</div>
                  <div>Status</div>
                  <div style={{textAlign:'right'}}>Rows</div>
                  <div style={{textAlign:'right'}}>Matched</div>
                  <div style={{textAlign:'right'}}>Uncounted</div>
                  <div>Uploaded</div>
                  {canEdit && <div></div>}
                </div>
                {uploads.map(u => {
                  const isDeleting = deletingId === u.id
                  const isActive = u.status === 'matching'
                  const activeMin = getActiveMinutes(u)
                  const isStuck = isActive && activeMin !== null && activeMin > STUCK_THRESHOLD_MIN
                  const cannotDelete = isActive && !isStuck

                  let deleteTitle = 'Delete this upload (nothing in MYOB is affected)'
                  if (isStuck) {
                    deleteTitle = `Stuck in "matching" for ${Math.round(activeMin!)} min — likely crashed. Click to delete.`
                  } else if (cannotDelete) {
                    const remaining = activeMin !== null ? Math.max(1, Math.ceil(STUCK_THRESHOLD_MIN - activeMin)) : STUCK_THRESHOLD_MIN
                    deleteTitle = `Cannot delete while matching. If genuinely stuck, retry in ~${remaining} min.`
                  }
                  const deleteColor = isStuck ? T.amber : T.red

                  return (
                    <div key={u.id} style={{display:'grid', gridTemplateColumns:gridCols, gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center', opacity: isDeleting ? 0.4 : 1, transition:'opacity 0.15s'}}>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor:'pointer'}}>
                        <div style={{color:T.text}}>{u.filename}</div>
                        {u.uploaded_by_name && <div style={{fontSize:10, color:T.text3, marginTop:2}}>by {u.uploaded_by_name}</div>}
                      </div>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{cursor:'pointer'}}>
                        <StatusBadge status={u.status}/>
                        {isStuck && (
                          <div style={{fontSize:9, color:T.amber, marginTop:3, fontWeight:600}}>⚠ stuck {Math.round(activeMin!)}m</div>
                        )}
                      </div>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>{u.total_rows ?? '—'}</div>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{textAlign:'right', color:u.matched_count != null ? T.text2 : T.text3, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>
                        {u.matched_count != null ? `${u.matched_count}/${(u.matched_count || 0) + (u.unmatched_count || 0)}` : '—'}
                      </div>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{textAlign:'right', color:u.in_stock_uncounted != null ? (u.in_stock_uncounted > 0 ? T.amber : T.green) : T.text3, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>
                        {u.in_stock_uncounted != null ? u.in_stock_uncounted : '—'}
                      </div>
                      <div onClick={() => router.push(`/jaws-stocktake/${u.id}`)} style={{color:T.text3, fontSize:11, cursor:'pointer'}}>{fmtRelative(u.uploaded_at)}</div>
                      {canEdit && (
                        <div style={{textAlign:'right'}}>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteUpload(u) }}
                            disabled={isDeleting || cannotDelete}
                            title={deleteTitle}
                            style={{
                              padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit',
                              background:'transparent',
                              color: (isDeleting || cannotDelete) ? T.text3 : deleteColor,
                              border: `1px solid ${(isDeleting || cannotDelete) ? T.border2 : deleteColor + '40'}`,
                              cursor: (isDeleting || cannotDelete) ? 'default' : 'pointer',
                            }}>
                            {isDeleting ? '…' : 'Delete'}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    parsed:    { label: 'Parsed',    color: T.text3 },
    matching:  { label: 'Matching…', color: T.blue },
    matched:   { label: 'Matched',   color: T.green },
    failed:    { label: 'Failed',    color: T.red },
  }
  const e = map[status] || { label: status, color: T.text3 }
  return (
    <span style={{padding:'3px 8px', borderRadius:3, background:`${e.color}22`, color:e.color, fontSize:10, fontWeight:600, letterSpacing:'0.05em', textTransform:'uppercase'}}>
      {e.label}
    </span>
  )
}

function UploadCard({ onUploaded }: { onUploaded: (id: string) => void }) {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback(async (file: File) => {
    if (!/\.xlsx?$/i.test(file.name)) { setError('File must be .xlsx or .xls'); return }
    if (file.size > 10_000_000) { setError('File too large (>10MB)'); return }
    setUploading(true); setError('')
    try {
      const arrBuf = await file.arrayBuffer()
      const base64 = arrayBufferToBase64(arrBuf)
      const r = await fetch('/api/jaws-stocktake/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, file_base64: base64 }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Upload failed')
      onUploaded(d.upload_id)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }, [onUploaded])

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) handleFile(f)
      }}
      style={{
        background: dragOver ? `${T.blue}15` : T.bg2,
        border: `2px dashed ${dragOver ? T.blue : T.border2}`,
        borderRadius: 12, padding: '40px 30px', textAlign: 'center',
        transition: 'background 0.15s, border-color 0.15s',
        cursor: uploading ? 'default' : 'pointer',
      }}
      onClick={() => !uploading && fileInputRef.current?.click()}>
      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" style={{display:'none'}}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}/>
      <div style={{fontSize:32, marginBottom:12, opacity:0.6}}>📄</div>
      <div style={{fontSize:14, fontWeight:600, color:T.text, marginBottom:6}}>
        {uploading ? 'Parsing…' : 'Drop XLSX here, or click to browse'}
      </div>
      <div style={{fontSize:11, color:T.text3}}>
        Spreadsheet should have SKU/Product Code and Counted Quantity columns
      </div>
      {error && <div style={{marginTop:14, fontSize:12, color:T.red}}>{error}</div>}
    </div>
  )
}

function fmtRelative(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!isFinite(ts)) return '—'
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })
}
