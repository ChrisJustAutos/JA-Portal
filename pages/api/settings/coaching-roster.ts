// pages/api/settings/coaching-roster.ts
// Advisor roster CRUD (Settings → Coaching). Admin only.
// The roster maps transcript names ("you're speaking with Kaleb") to Slack ids
// for call attribution — extensions are hot-desked hints, not identities.
//   GET    — list
//   POST   — { name, aliases?, slack_user_id?, extensions?, active? } → create
//   PUT    — { id, patch } → update
//   DELETE — { id }

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 15 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const strArr = (v: any): string[] =>
  Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []

export default withAuth(null, async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('call_advisor_roster')
      .select('id, name, aliases, slack_user_id, extensions, active')
      .order('name')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ roster: data || [] })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const name = String(body.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { error } = await db.from('call_advisor_roster').insert({
      name,
      aliases: strArr(body.aliases),
      slack_user_id: String(body.slack_user_id || '').trim() || null,
      extensions: strArr(body.extensions),
      active: body.active !== false,
    })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'PUT') {
    const id = String(body.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const p = body.patch || {}
    const patch: Record<string, any> = {}
    if ('name' in p) patch.name = String(p.name || '').trim()
    if ('aliases' in p) patch.aliases = strArr(p.aliases)
    if ('slack_user_id' in p) patch.slack_user_id = String(p.slack_user_id || '').trim() || null
    if ('extensions' in p) patch.extensions = strArr(p.extensions)
    if ('active' in p) patch.active = !!p.active
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' })
    if ('name' in patch && !patch.name) return res.status(400).json({ error: 'name cannot be empty' })
    const { error } = await db.from('call_advisor_roster').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const id = String(body.id || '').trim()
    if (!id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('call_advisor_roster').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
})
