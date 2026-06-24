// pages/api/workshop/letters/logo.ts
// GET    — stream the current letterhead logo (for the settings preview)
// POST   { dataUrl } — upload a new logo (admin); stored in workshop-letters/config
// DELETE — remove the logo (admin); letters fall back to the text header

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getLetterAutomation, setAutomation } from '../../../../lib/workshop-letters'

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } }

const BUCKET = 'workshop-letters'
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return createClient(url!, key!, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method === 'GET') {
    const cfg = await getLetterAutomation()
    if (!cfg.logo_path) return res.status(404).end()
    const { data } = await admin().storage.from(BUCKET).download(cfg.logo_path)
    if (!data) return res.status(404).end()
    const ext = (cfg.logo_path.split('.').pop() || 'png').toLowerCase()
    res.setHeader('Content-Type', ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).send(Buffer.from(await data.arrayBuffer()))
  }

  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) } catch { return res.status(400).json({ error: 'Bad JSON' }) }
    const m = String(body.dataUrl || '').match(/^data:(image\/(png|jpe?g|gif));base64,(.+)$/)
    if (!m) return res.status(400).json({ error: 'Expected a PNG/JPG/GIF data URL' })
    const mime = m[1], ext = m[2] === 'jpeg' ? 'jpg' : m[2], buf = Buffer.from(m[3], 'base64')
    if (buf.length > 6_000_000) return res.status(400).json({ error: 'Logo too large (max ~6MB)' })
    // New filename each upload → busts the render cache.
    const path = `config/letterhead-${Date.now()}.${ext}`
    const up = await admin().storage.from(BUCKET).upload(path, buf, { contentType: mime, upsert: true })
    if (up.error) return res.status(500).json({ error: up.error.message })
    await setAutomation({ logo_path: path })
    return res.status(200).json({ ok: true, logo_path: path })
  }

  if (req.method === 'DELETE') {
    const cfg = await getLetterAutomation()
    if (cfg.logo_path) { try { await admin().storage.from(BUCKET).remove([cfg.logo_path]) } catch { /* ignore */ } }
    await setAutomation({ logo_path: null })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
})
