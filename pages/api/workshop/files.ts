// pages/api/workshop/files.ts
// Job/vehicle/customer file attachments (workshop-files private bucket).
//   GET    ?booking_id=|vehicle_id=|customer_id=        — list metadata rows
//   GET    ?id=&url=1[&w=320]                           — signed download URL (1h; optional image transform)
//   POST   {mode:'sign', file_name, mime_type, size_bytes, booking_id?…}   — one-time signed UPLOAD token
//   POST   {mode:'record', path, file_name, mime_type, size_bytes, …}      — persist metadata after upload
//   DELETE ?id=                                         — remove object + row
// Uploads go client → storage directly via the signed token, dodging
// Vercel's ~4.5 MB body cap (phone photos routinely exceed it).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { logWorkshopActivity } from '../../../lib/workshop-activity'

export const config = { maxDuration: 15 }

const BUCKET = 'workshop-files'
const MAX_BYTES = 25 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function safeExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '')
  return m ? m[1].toLowerCase() : 'bin'
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const id = String(req.query.id || '').trim()
    if (id && String(req.query.url || '')) {
      const { data: row } = await db.from('workshop_files').select('storage_path, mime_type').eq('id', id).maybeSingle()
      if (!row) return res.status(404).json({ error: 'File not found' })
      const w = Number(req.query.w) || 0
      let signed: { signedUrl: string } | null = null
      if (w && String(row.mime_type || '').startsWith('image/')) {
        // Image transforms need a paid storage plan — fall back to the raw file.
        const t = await db.storage.from(BUCKET).createSignedUrl(row.storage_path, 3600, { transform: { width: w } } as any)
        signed = t.data || null
      }
      if (!signed) {
        const r = await db.storage.from(BUCKET).createSignedUrl(row.storage_path, 3600)
        if (r.error || !r.data) return res.status(500).json({ error: r.error?.message || 'Could not sign URL' })
        signed = r.data
      }
      return res.status(200).json({ url: signed.signedUrl })
    }

    const bookingId = String(req.query.booking_id || '').trim()
    const vehicleId = String(req.query.vehicle_id || '').trim()
    const customerId = String(req.query.customer_id || '').trim()
    if (!bookingId && !vehicleId && !customerId) return res.status(400).json({ error: 'booking_id, vehicle_id or customer_id required' })
    let qy = db.from('workshop_files')
      .select('id, booking_id, vehicle_id, customer_id, file_name, mime_type, size_bytes, uploaded_by_name, created_at')
      .order('created_at', { ascending: false }).limit(300)
    if (bookingId) qy = qy.eq('booking_id', bookingId)
    else if (vehicleId) qy = qy.eq('vehicle_id', vehicleId)
    else qy = qy.eq('customer_id', customerId)
    const { data, error } = await qy
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ files: data || [] })
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const mode = String(body.mode || '')
    const fileName = String(body.file_name || '').trim()
    const mime = String(body.mime_type || '').toLowerCase()
    const size = Number(body.size_bytes) || 0

    if (mode === 'sign') {
      if (!fileName) return res.status(400).json({ error: 'file_name required' })
      if (!ALLOWED_MIME.has(mime)) return res.status(400).json({ error: `File type not allowed (${mime || 'unknown'})` })
      if (size > MAX_BYTES) return res.status(400).json({ error: 'File too large (max 25 MB)' })
      const anchor = body.booking_id ? `booking/${body.booking_id}` : body.vehicle_id ? `vehicle/${body.vehicle_id}` : body.customer_id ? `customer/${body.customer_id}` : null
      if (!anchor) return res.status(400).json({ error: 'booking_id, vehicle_id or customer_id required' })
      const path = `${anchor}/${crypto.randomUUID()}.${safeExt(fileName)}`
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path)
      if (error || !data) return res.status(500).json({ error: error?.message || 'Could not create upload token' })
      return res.status(200).json({ path: data.path, token: data.token })
    }

    if (mode === 'record') {
      const path = String(body.path || '').trim()
      if (!path || !fileName) return res.status(400).json({ error: 'path and file_name required' })
      // When attaching to a booking, also stamp its vehicle/customer so the
      // vehicle + customer pages see job photos for free.
      let vehicleId = body.vehicle_id || null, customerId = body.customer_id || null
      if (body.booking_id && (!vehicleId || !customerId)) {
        const { data: b } = await db.from('workshop_bookings').select('vehicle_id, customer_id').eq('id', body.booking_id).maybeSingle()
        vehicleId = vehicleId || b?.vehicle_id || null
        customerId = customerId || b?.customer_id || null
      }
      const { data: row, error } = await db.from('workshop_files').insert({
        booking_id: body.booking_id || null, vehicle_id: vehicleId, customer_id: customerId,
        file_name: fileName.slice(0, 200), storage_path: path, mime_type: mime || null,
        size_bytes: size || null, uploaded_by: user.id, uploaded_by_name: user.displayName || user.email,
      }).select('id, booking_id, vehicle_id, customer_id, file_name, mime_type, size_bytes, uploaded_by_name, created_at').single()
      if (error) return res.status(500).json({ error: error.message })
      await logWorkshopActivity(db, {
        action: 'created', entity: 'file', entity_id: row.id, entity_label: fileName.slice(0, 120),
        detail: body.booking_id ? 'File uploaded to job' : vehicleId ? 'File uploaded to vehicle' : 'File uploaded to customer',
        actor_id: user.id, actor_name: user.displayName || user.email,
      })
      return res.status(201).json({ ok: true, file: row })
    }

    return res.status(400).json({ error: "mode must be 'sign' or 'record'" })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    const id = String(req.query.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { data: row } = await db.from('workshop_files').select('id, storage_path, file_name').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'File not found' })
    await db.storage.from(BUCKET).remove([row.storage_path]).catch(() => null) // best-effort
    const { error } = await db.from('workshop_files').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    await logWorkshopActivity(db, {
      action: 'deleted', entity: 'file', entity_id: id, entity_label: row.file_name,
      actor_id: user.id, actor_name: user.displayName || user.email,
    })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'GET, POST or DELETE only' })
})
