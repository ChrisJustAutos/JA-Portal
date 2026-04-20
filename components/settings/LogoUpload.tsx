// components/settings/LogoUpload.tsx
// Drag-and-drop logo uploader for the General Settings tab.
//
// Flow:
//   1. User drops a file or picks via file input
//   2. Client-side validation (type, size, dimensions)
//   3. Upload directly to Supabase Storage via the client SDK
//      (uses user's JWT; RLS policies ensure they can only write to their own folder)
//   4. Get public URL, save to user_preferences.company_logo_url via PATCH
//   5. Show preview + delete button
//
// The user-logos Supabase bucket is configured with:
//   - public reads (so <img src=...> works)
//   - RLS write access restricted to each user's own folder
//   - 5MB file size limit enforced at storage level
//   - Allowed MIME types: image/png, image/jpeg, image/svg+xml

import { useState, useRef, useCallback } from 'react'
import { getSupabase } from '../../lib/supabaseClient'
import { usePreferences } from '../../lib/preferences'

const T = {
  bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml']
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg']
const MAX_SIZE_BYTES = 5 * 1024 * 1024  // 5 MB

interface ValidationError {
  message: string
}

function validateFile(file: File): ValidationError | null {
  if (!ALLOWED_TYPES.includes(file.type.toLowerCase())) {
    return { message: `File type "${file.type || 'unknown'}" is not allowed. Use PNG, JPG or SVG.` }
  }
  if (file.size > MAX_SIZE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return { message: `File is ${mb} MB. Maximum size is 5 MB.` }
  }
  if (file.size === 0) {
    return { message: 'File appears to be empty.' }
  }
  return null
}

// Extract extension from filename or fall back to MIME type mapping
function getExtension(file: File): string {
  const nameExt = file.name.split('.').pop()?.toLowerCase()
  if (nameExt && ALLOWED_EXTENSIONS.includes(nameExt)) return nameExt === 'jpeg' ? 'jpg' : nameExt
  // Fallback from MIME
  if (file.type === 'image/png') return 'png'
  if (file.type === 'image/svg+xml') return 'svg'
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') return 'jpg'
  return 'png'  // safe default
}

interface LogoUploadProps {
  saving?: boolean
  onSaveStart?: () => void
  onSaveEnd?: () => void
}

export default function LogoUpload({ onSaveStart, onSaveEnd }: LogoUploadProps) {
  const { prefs, update } = usePreferences()
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [successFlash, setSuccessFlash] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const currentLogoUrl = prefs.company_logo_url

  // The URL already contains a timestamp in the filename (logo-{ts}.{ext})
  // so the browser won't serve a stale cached copy across uploads.
  const displayUrl = currentLogoUrl

  const handleFile = useCallback(async (file: File) => {
    setError(null)

    // Client-side validation
    const validationError = validateFile(file)
    if (validationError) {
      setError(validationError.message)
      return
    }

    setUploading(true)
    setUploadProgress(0)
    onSaveStart?.()

    try {
      const supabase = getSupabase()
      // Get current user (needed to build the storage path)
      const { data: { user }, error: userErr } = await supabase.auth.getUser()
      if (userErr || !user) {
        throw new Error('You must be signed in to upload a logo.')
      }

      const ext = getExtension(file)
      // Include timestamp in filename to avoid caching issues and allow gradual cleanup
      const fileName = `logo-${Date.now()}.${ext}`
      const storagePath = `${user.id}/${fileName}`

      // Upload with upsert=true so re-uploads overwrite cleanly.
      // Supabase storage enforces bucket policies: size limit, MIME type, RLS path.
      const { error: uploadErr } = await supabase.storage
        .from('user-logos')
        .upload(storagePath, file, {
          cacheControl: '3600',
          upsert: true,
          contentType: file.type,
        })

      if (uploadErr) {
        throw new Error(uploadErr.message || 'Upload failed. Please try again.')
      }

      setUploadProgress(80)

      // Get the public URL for the uploaded file
      const { data: { publicUrl } } = supabase.storage
        .from('user-logos')
        .getPublicUrl(storagePath)

      // Best-effort cleanup: try to remove any previous logo for this user.
      // Don't block on failure — stale files are harmless in a public bucket.
      try {
        const { data: list } = await supabase.storage
          .from('user-logos')
          .list(user.id, { limit: 20 })
        if (list) {
          const toDelete = list
            .filter(f => f.name !== fileName)
            .map(f => `${user.id}/${f.name}`)
          if (toDelete.length > 0) {
            await supabase.storage.from('user-logos').remove(toDelete)
          }
        }
      } catch { /* silent — cleanup is best-effort */ }

      setUploadProgress(95)

      // Save URL to user preferences
      await update({ company_logo_url: publicUrl })

      setUploadProgress(100)
      setSuccessFlash(true)
      setTimeout(() => setSuccessFlash(false), 2000)
    } catch (e: any) {
      setError(e?.message || 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
      setUploadProgress(0)
      onSaveEnd?.()
    }
  }, [update, onSaveStart, onSaveEnd])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
  }, [])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // Reset so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [handleFile])

  const handleRemove = useCallback(async () => {
    if (!currentLogoUrl) return
    setError(null)
    setUploading(true)
    onSaveStart?.()
    try {
      const supabase = getSupabase()
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        // Remove all files in the user's folder
        const { data: list } = await supabase.storage
          .from('user-logos')
          .list(user.id, { limit: 20 })
        if (list && list.length > 0) {
          const toDelete = list.map(f => `${user.id}/${f.name}`)
          await supabase.storage.from('user-logos').remove(toDelete)
        }
      }
      await update({ company_logo_url: null })
    } catch (e: any) {
      setError(e?.message || 'Could not remove logo.')
    } finally {
      setUploading(false)
      onSaveEnd?.()
    }
  }, [currentLogoUrl, update, onSaveStart, onSaveEnd])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Preview pane if logo exists */}
      {displayUrl && !uploading && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: 12, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8,
        }}>
          <div style={{
            width: 64, height: 64, background: '#fff', borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', flexShrink: 0,
          }}>
            <img
              src={displayUrl}
              alt="Company logo"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>
              Current logo
              {successFlash && <span style={{ marginLeft: 8, color: T.green, fontWeight: 400 }}>✓ saved</span>}
            </div>
            <div style={{ fontSize: 10, color: T.text3, marginTop: 3, wordBreak: 'break-all' }}>
              {currentLogoUrl?.split('/').slice(-2).join('/')}
            </div>
          </div>
          <button
            onClick={handleRemove}
            disabled={uploading}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: `1px solid ${T.border2}`, background: 'transparent',
              color: T.red, fontSize: 11, cursor: uploading ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Remove
          </button>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !uploading && fileInputRef.current?.click()}
        style={{
          padding: 20,
          background: dragging ? `${T.blue}10` : T.bg3,
          border: `2px dashed ${dragging ? T.blue : T.border2}`,
          borderRadius: 8,
          cursor: uploading ? 'wait' : 'pointer',
          textAlign: 'center',
          transition: 'all 0.15s ease',
        }}
      >
        {uploading ? (
          <div>
            <div style={{ fontSize: 12, color: T.text, marginBottom: 8 }}>Uploading…</div>
            <div style={{
              width: '100%', height: 4, background: T.bg4, borderRadius: 2, overflow: 'hidden',
            }}>
              <div style={{
                width: `${uploadProgress}%`, height: '100%',
                background: T.blue, transition: 'width 0.2s ease',
              }}/>
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>
              {displayUrl ? 'Replace logo' : 'Upload a logo'}
            </div>
            <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>
              Drag and drop, or click to browse · PNG, JPG, SVG · Max 5 MB
            </div>
          </>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/svg+xml"
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 6,
          background: `${T.red}15`, border: `1px solid ${T.red}40`,
          color: T.red, fontSize: 11,
        }}>
          {error}
        </div>
      )}
    </div>
  )
}
