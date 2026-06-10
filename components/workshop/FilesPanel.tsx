// components/workshop/FilesPanel.tsx
// Photos & document attachments for a job / vehicle / customer. Shared by the
// job card Files tab and the vehicle detail page. Upload path: ask
// /api/workshop/files for a one-time signed upload token (service role), the
// browser uploads straight to Supabase Storage with it (no Vercel body-size
// cap), then records the metadata row. Images are downscaled client-side
// (max ~2000px JPEG) before upload; downloads use short-lived signed URLs.

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSupabase } from '../../lib/supabaseClient'

const T = {
  bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}

interface WorkshopFile {
  id: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  uploaded_by_name: string | null
  created_at: string
}

const isImg = (m?: string | null) => !!m && m.startsWith('image/') && !/heic|heif/.test(m)
const fmtSize = (b?: number | null) => {
  const n = Number(b) || 0
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

// Downscale big photos before upload (max edge 2000px, JPEG 0.85). Non-images
// and small images pass through untouched; HEIC can't be canvas-decoded
// everywhere so it passes through too.
async function maybeDownscale(file: File): Promise<{ blob: Blob; name: string; mime: string }> {
  const asIs = { blob: file as Blob, name: file.name, mime: file.type }
  if (!file.type.startsWith('image/') || /heic|heif|gif/.test(file.type) || file.size < 600 * 1024) return asIs
  try {
    const bmp = await createImageBitmap(file)
    const maxEdge = 2000
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    if (scale >= 1) { bmp.close(); return asIs }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bmp.close(); return asIs }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return asIs
    return { blob, name: file.name.replace(/\.[A-Za-z0-9]+$/, '') + '.jpg', mime: 'image/jpeg' }
  } catch { return asIs }
}

export default function FilesPanel({ bookingId, vehicleId, customerId, canEdit }: {
  bookingId?: string | null; vehicleId?: string | null; customerId?: string | null; canEdit: boolean
}) {
  const [files, setFiles] = useState<WorkshopFile[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const anchor = bookingId ? `booking_id=${bookingId}` : vehicleId ? `vehicle_id=${vehicleId}` : customerId ? `customer_id=${customerId}` : ''

  const load = useCallback(async () => {
    if (!anchor) { setLoading(false); return }
    try {
      const r = await fetch(`/api/workshop/files?${anchor}`)
      if (r.ok) setFiles((await r.json()).files || [])
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [anchor])

  useEffect(() => { load() }, [load])

  // Lazy signed thumbnail URLs for images.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      for (const f of files) {
        if (!isImg(f.mime_type) || thumbs[f.id]) continue
        try {
          const r = await fetch(`/api/workshop/files?id=${f.id}&url=1&w=360`)
          if (!r.ok) continue
          const d = await r.json()
          if (!cancelled && d.url) setThumbs(t => ({ ...t, [f.id]: d.url }))
        } catch { /* skip */ }
      }
    })()
    return () => { cancelled = true }
  }, [files]) // eslint-disable-line react-hooks/exhaustive-deps

  async function uploadFiles(list: FileList | null) {
    if (!list || !list.length) return
    setErr('')
    const items = Array.from(list)
    for (let i = 0; i < items.length; i++) {
      setBusy(items.length > 1 ? `Uploading ${i + 1}/${items.length}…` : 'Uploading…')
      try {
        const { blob, name, mime } = await maybeDownscale(items[i])
        const signRes = await fetch('/api/workshop/files', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'sign', file_name: name, mime_type: mime, size_bytes: blob.size, booking_id: bookingId || null, vehicle_id: vehicleId || null, customer_id: customerId || null }),
        })
        const sign = await signRes.json()
        if (!signRes.ok) throw new Error(sign.error || 'Could not start upload')
        const up = await getSupabase().storage.from('workshop-files').uploadToSignedUrl(sign.path, sign.token, blob, { contentType: mime })
        if (up.error) throw new Error(up.error.message || 'Upload failed')
        const recRes = await fetch('/api/workshop/files', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'record', path: sign.path, file_name: name, mime_type: mime, size_bytes: blob.size, booking_id: bookingId || null, vehicle_id: vehicleId || null, customer_id: customerId || null }),
        })
        if (!recRes.ok) throw new Error((await recRes.json()).error || 'Could not save file record')
      } catch (e: any) {
        setErr(`${items[i].name}: ${e?.message || 'upload failed'}`)
        break
      }
    }
    setBusy('')
    if (inputRef.current) inputRef.current.value = ''
    await load()
  }

  async function openFile(f: WorkshopFile) {
    try {
      const r = await fetch(`/api/workshop/files?id=${f.id}&url=1`)
      const d = await r.json()
      if (r.ok && d.url) window.open(d.url, '_blank')
    } catch { /* ignore */ }
  }

  async function deleteFile(f: WorkshopFile, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Delete ${f.file_name}? This can't be undone.`)) return
    const r = await fetch(`/api/workshop/files?id=${f.id}`, { method: 'DELETE' })
    if (r.ok) await load()
  }

  const images = files.filter(f => isImg(f.mime_type))
  const docs = files.filter(f => !isImg(f.mime_type))

  return (
    <div style={{ padding: 16 }}>
      {canEdit && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <input ref={inputRef} type="file" multiple
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
            onChange={e => uploadFiles(e.target.files)} style={{ display: 'none' }} />
          <button onClick={() => inputRef.current?.click()} disabled={!!busy} style={{
            padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
            background: `${T.blue}1e`, color: T.blue, border: `1px solid ${T.blue}55`,
          }}>{busy || '📷 Add photos / files'}</button>
          <span style={{ fontSize: 10, color: T.text3 }}>Images, PDF, Word/Excel · max 25 MB · photos are downscaled automatically</span>
          {err && <span style={{ fontSize: 11, color: T.red }}>{err}</span>}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.text3 }}>Loading files…</div>
      ) : files.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.text3 }}>No photos or documents yet.</div>
      ) : (
        <>
          {images.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10, marginBottom: docs.length ? 16 : 0 }}>
              {images.map(f => (
                <div key={f.id} onClick={() => openFile(f)} title={`${f.file_name} · ${fmtSize(f.size_bytes)} · ${f.uploaded_by_name || ''}`}
                  style={{ position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', border: `1px solid ${T.border2}`, background: T.bg3, cursor: 'pointer' }}>
                  {thumbs[f.id]
                    ? <img src={thumbs[f.id]} alt={f.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 22 }}>🖼</div>}
                  {canEdit && (
                    <button onClick={e => deleteFile(f, e)} title="Delete" style={{
                      position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 4, border: 'none',
                      background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 12, cursor: 'pointer', lineHeight: 1,
                    }}>×</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {docs.map(f => (
            <div key={f.id} onClick={() => openFile(f)} style={{
              display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 6,
              border: `1px solid ${T.border}`, marginBottom: 6, cursor: 'pointer', background: T.bg3,
            }}>
              <span style={{ fontSize: 16 }}>{/pdf/.test(f.mime_type || '') ? '📄' : /heic|heif/.test(f.mime_type || '') ? '🖼' : '📎'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name}</div>
                <div style={{ fontSize: 10, color: T.text3 }}>{fmtSize(f.size_bytes)} · {f.uploaded_by_name || 'unknown'} · {new Date(f.created_at).toLocaleDateString('en-AU')}</div>
              </div>
              {canEdit && (
                <button onClick={e => deleteFile(f, e)} title="Delete" style={{
                  padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
                  background: 'transparent', color: T.text3, border: `1px solid ${T.text3}55`, cursor: 'pointer',
                }}>×</button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
