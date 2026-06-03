// pages/api/b2b/notifications/index.ts
// Distributor notification bell.
//   GET    — { unread, notifications:[...latest 50] }
//   PATCH  — mark read: { id } one · { all:true } everything
//   DELETE — remove: { id } one · { all:true } everything

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth } from '../../../../lib/b2bAuthServer'

export const config = { maxDuration: 10 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  if (req.method === 'GET') {
    const [{ data: list, error }, { count }] = await Promise.all([
      c.from('b2b_notifications').select('id, title, body, href, created_at, read_at')
        .eq('b2b_user_id', user.id).order('created_at', { ascending: false }).limit(50),
      c.from('b2b_notifications').select('id', { count: 'exact', head: true })
        .eq('b2b_user_id', user.id).is('read_at', null),
    ])
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ unread: count || 0, notifications: list || [] })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'PATCH') {
    let q = c.from('b2b_notifications').update({ read_at: new Date().toISOString() })
      .eq('b2b_user_id', user.id).is('read_at', null)
    if (body.all === true) { /* all */ }
    else if (body.id) q = q.eq('id', String(body.id))
    else return res.status(400).json({ error: 'id or all:true required' })
    const { error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    let q = c.from('b2b_notifications').delete().eq('b2b_user_id', user.id)
    if (body.all === true) { /* all */ }
    else if (body.id) q = q.eq('id', String(body.id))
    else return res.status(400).json({ error: 'id or all:true required' })
    const { error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})
