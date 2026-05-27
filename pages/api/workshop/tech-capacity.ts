// pages/api/workshop/tech-capacity.ts
// GET   — { capacity: { <ext>: dailyHours } } for the diary lane load bars.
// PATCH — { technician_ext, daily_hours } upsert one lane's capacity (admin).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    // Capacity now lives on workshop_technicians (per-lane daily_hours).
    const { data, error } = await db.from('workshop_technicians').select('code, daily_hours')
    if (error) return res.status(500).json({ error: error.message })
    const capacity: Record<string, number> = {}
    for (const r of data || []) capacity[String((r as any).code)] = Number((r as any).daily_hours)
    return res.status(200).json({ capacity })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const ext = String(body.technician_ext || '').trim()
    if (!ext) return res.status(400).json({ error: 'technician_ext required' })
    const hours = Math.max(0, Number(body.daily_hours) || 0)
    const { error } = await db.from('workshop_technicians').update({ daily_hours: hours, updated_at: new Date().toISOString() }).eq('code', ext)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})
