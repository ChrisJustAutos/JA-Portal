// pages/stocktake/index.tsx
//
// Stocktake landing page:
//   • Drag-and-drop XLSX upload card at the top
//   • List of past uploads with status, click into one to see preview/push
//   • Per-row Delete button (admin/manager) — DB only, never touches MD
//
// Workflow:
//   1. Drop XLSX → POST /api/stocktake/upload → redirect to /stocktake/{id}
//   2. On the detail page, run match → review → push

import { useState, useEffect, useRef, useCallback } from 'react'
import Head from 'next/head'
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
  pushed_count: number | null
  mechanicdesk_stocktake_id: string | null
  push_completed_at: string | null
  uploaded_by_name: string | null
}

interface SessionUser {
  id: string; email: string; role: UserRole; displayName: string | null;
  visibleTabs?: string[] | null;
}

// Convert an ArrayBuffer to a base64 string. We chunk-loop instead of using
// String.fromCharCode(...new Uint8Array(buf)) because:
//   1. tsconfig target=es5 forbids spreading typed arrays
//   2. Spreading a 10MB file would stack-overflow even if it did compile
//      (each byte becomes an argument to fromCharCode)
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000  // 32KB — safely under most JS engines' arg-count limits
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    // Cast to any to satisfy es5 target (fromCharCode accepts a number[] but
    // we're passing a Uint8Array slice which is iterable at runtime).
    binary += String.fromCharCode.apply(null, slice as any)
  }
  return btoa(binary)
}

export default function StocktakeIndexPage({ user }: { user: SessionUser }) {
  const router = useRouter()
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const canEdit = roleHasPermission(user.role, 'edit:stocktakes')

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/stocktake/list')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setUploads(d.uploads || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function deleteUpload(u: UploadRow) {
    if (deletingId) return
    if (u.status === 'matching' || u.status === 'pushing') {
      setError(`Cannot delete "${u.filename}" while ${u.status} — wait for the GitHub Action to finish or fail first.`)
      return
    }
    const mdNote = u.mechanicdesk_stocktake_id
      ? `\n\nThe Mechanics Desk stocktake (${u.mechanicdesk_stocktake_id}) will NOT be deleted — only the portal record. Delete it manually in MD if needed.`
      : ''
    if (!confirm(`Delete portal record for "${u.filename}"?${mdNote}\n\nThis cannot be undone.`)) return
    setDeletingId(u.id); setError('')
    try {
      const r = await fetch(`/api/stocktake/${u.id}`, { method: 'DELETE' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Delete failed')
      // Optimistic local removal so the UI updates immediately
      setUploads(prev => prev.filter(x => x.id !== u.id))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => { load() }, [])

  // Grid template — adds a 70px column for the Delete button when the user can edit
  const gridCols = canEdit
    ? '1fr 110px 110px 110px 110px 130px 70px'
    : '1fr 110px 110px 110px 110px 130px'

  return (
    <>
      <Head><title>Stocktake — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="stocktake" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'baseline', gap:12, marginBottom:6}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Stocktake</h1>
            <span style={{fontSize:11, color:T.text3}}>
              Upload an XLSX to push counts into Mechanics Desk
            </span>
          </div>
          <p style={{margin:'0 0 20px 0', fontSize:12, color:T.text3, maxWidth:780, lineHeight:1.6}}>
            Drop a spreadsheet with SKU/Product Code and Counted Quantity columns. Portal will resolve each SKU against
            Mechanics Desk, show you a preview, then push the counts to either an existing in-progress stocktake or a new one.
            <strong style={{color:T.text2}}> You always confirm and finalise the stocktake manually in MD.</strong>
          </p>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {canEdit && <UploadCard onUploaded={(id) => router.push(`/stocktake/${id}`)} />}

          <div style={{marginTop:30}}>
            <h2 style={{margin:'0 0 12px 0', fontSize:14, fontWeight:600, color:T.text2, textTransform:'uppercase', letterSpacing:'0.05em'}}>
              Recent uploads
            </h2>
            {loading ? (
              <div style={{padding:20, textAlign:'center', color:T.text3}}>Loading…</div>
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
                  <div style={{textAlign:'right'}}>Pushed</div>
                  <div>Uploaded</div>
                  {canEdit && <div></div>}
                </div>
                {uploads.map(u => {
                  const isDeleting = deletingId === u.id
                  const cannotDelete = u.status === 'matching' || u.status === 'pushing'
                  return (
                    <div key={u.id} style={{display:'grid', gridTemplateColumns:gridCols, gap:12, padding:'10px 14px', borderBottom:`1px solid ${T.border}`, fontSize:12, alignItems:'center', opacity: isDeleting ? 0.4 : 1, transition:'opacity 0.15s'}}>
                      <div
                        onClick={() => router.push(`/stocktake/${u.id}`)}
                        style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', cursor:'pointer'}}>
                        <div style={{color:T.text}}>{u.filename}</div>
                        {u.uploaded_by_name && <div style={{fontSize:10, color:T.text3, marginTop:2}}>by {u.uploaded_by_name}</div>}
                      </div>
                      <div onClick={() => router.push(`/stocktake/${u.id}`)} style={{cursor:'pointer'}}><StatusBadge status={u.status}/></div>
                      <div onClick={() => router.push(`/stocktake/${u.id}`)} style={{textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>{u.total_rows ?? '—'}</div>
                      <div onClick={() => router.push(`/stocktake/${u.id}`)} style={{textAlign:'right', color:u.matched_count != null ? T.text2 : T.text3, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>
                        {u.matched_count != null ? `${u.matched_count}/${(u.matched_count || 0) + (u.unmatched_count || 0)}` : '—'}
                      </div>
                      <div onClick={() => router.push(`/stocktake/${u.id}`)} style={{textAlign:'right', color:u.pushed_count != null ? T.text2 : T.text3, fontVariantNumeric:'tabular-nums', cursor:'pointer'}}>
                        {u.pushed_count != null ? u.pushed_count : '—'}
                      </div>
                      <div onClick={() => router.push(`/stocktake/${u.id}`)} style={{color:T.text3, fontSize:11, cursor:'pointer'}}>{fmtRelative(u.uploaded_at)}</div>
                      {canEdit && (
                        <div style={{textAlign:'right'}}>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteUpload(u) }}
                            disabled={isDeleting || cannotDelete}
                            title={cannotDelete ? `Cannot delete while ${u.status}` : 'Delete portal record (does not delete MD stocktake)'}
                            style={{
                              padding:'4px 10px', borderRadius:4, fontSize:11, fontFamily:'inherit',
                              background:'transparent',
                              color: (isDeleting || cannotDelete) ? T.text3 : T.red,
                              border: `1px solid ${(isDeleting || cannotDelete) ? T.border2 : T.red + '40'}`,
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
    matched:   { label: 'Matched',   color: T.amber },
    pushing:   { label: 'Pushing…',  color: T.blue },
    completed: { label: 'Completed', color: T.green },
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
    if (!/\.xlsx?$/i.test(file.name)) {
      setError('File must be .xlsx or .xls')
      return
    }
    if (file.size > 10_000_000) {
      setError('File too large (>10MB)')
      return
    }
    setUploading(true); setError('')
    try {
      const arrBuf = await file.arrayBuffer()
      const base64 = arrayBufferToBase64(arrBuf)
      const r = await fetch('/api/stocktake/upload', {
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
        borderRadius: 12,
        padding: '40px 30px',
        textAlign: 'center',
        transition: 'background 0.15s, border-color 0.15s',
        cursor: uploading ? 'default' : 'pointer',
      }}
      onClick={() => !uploading && fileInputRef.current?.click()}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{display:'none'}}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleFile(f)
        }}/>
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
