// pages/api/b2b/notifications/push-subscribe.ts
// Store / remove / list the current DISTRIBUTOR user's Web Push subscriptions.
//   GET    — { count }  (diagnostic: is this device registered?)
//   POST   { endpoint, keys:{ p256dh, auth } } — upsert
//   DELETE { endpoint } — remove
// Distributor auth (ja-b2b-* cookies), stored in b2b_push_subscriptions.

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
    const { data } = await c.from('b2b_push_subscriptions').select('id').eq('b2b_user_id', user.id)
    return res.status(200).json({ count: (data || []).length })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const endpoint = String(body.endpoint || '')
    const p256dh = String(body?.keys?.p256dh || '')
    const auth = String(body?.keys?.auth || '')
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint + keys required' })
    const { error } = await c.from('b2b_push_subscriptions').upsert({
      b2b_user_id: user.id,
      endpoint, p256dh, auth,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' })
    if (error) return res.status(500).json({ error: error.message })
    // Prune this user's endpoints not seen in 30 days (live devices re-register
    // on every app open) so retired/dead devices don't pile up.
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    c.from('b2b_push_subscriptions').delete().eq('b2b_user_id', user.id).lt('last_used_at', cutoff).then(() => {}, () => {})
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const endpoint = String(body.endpoint || '')
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' })
    await c.from('b2b_push_subscriptions').delete().eq('endpoint', endpoint)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'GET, POST or DELETE only' })
})
