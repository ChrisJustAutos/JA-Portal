// pages/api/groups/mutate.ts
// POST: apply mutations to grouping tables.
// Body: { action, payload }
// Supported actions:
//   - setAlias:        { myob_name, canonical_name }
//   - deleteAlias:     { myob_name }
//   - createGroup:     { dimension, name, color?, sort_order? }
//   - updateGroup:     { id, name?, color?, sort_order? }
//   - deleteGroup:     { id }
//   - addMember:       { group_id, canonical_name }
//   - removeMember:    { group_id, canonical_name }
//   - setMembers:      { group_id, canonical_names: string[] }  // replace all members

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { invalidateGroupingCache } from '../../../lib/distGroups'

function getSb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  // Portal cookie auth
  const cookie = req.cookies['ja_portal_auth']
  const pw = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (!cookie) return res.status(401).json({ error: 'Unauthenticated' })
  try {
    if (Buffer.from(cookie, 'base64').toString('utf8') !== pw) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }
  } catch {
    return res.status(401).json({ error: 'Unauthenticated' })
  }

  const { action, payload } = req.body || {}
  if (!action) return res.status(400).json({ error: 'action required' })

  try {
    const sb = getSb()
    let result: any = null

    switch (action) {
      case 'setAlias': {
        const { myob_name, canonical_name } = payload || {}
        if (!myob_name || !canonical_name) return res.status(400).json({ error: 'myob_name and canonical_name required' })
        const { data, error } = await sb.from('dist_aliases')
          .upsert({ myob_name, canonical_name, updated_at: new Date().toISOString() }, { onConflict: 'myob_name' })
          .select()
        if (error) throw error
        result = data
        break
      }
      case 'deleteAlias': {
        const { myob_name } = payload || {}
        if (!myob_name) return res.status(400).json({ error: 'myob_name required' })
        const { error } = await sb.from('dist_aliases').delete().eq('myob_name', myob_name)
        if (error) throw error
        result = { deleted: true }
        break
      }
      case 'createGroup': {
        const { dimension, name, color, sort_order } = payload || {}
        if (!dimension || !name) return res.status(400).json({ error: 'dimension and name required' })
        const { data, error } = await sb.from('dist_groups')
          .insert({ dimension, name, color: color || null, sort_order: sort_order ?? 0 })
          .select().single()
        if (error) throw error
        result = data
        break
      }
      case 'updateGroup': {
        const { id, name, color, sort_order } = payload || {}
        if (!id) return res.status(400).json({ error: 'id required' })
        const patch: any = { updated_at: new Date().toISOString() }
        if (name !== undefined) patch.name = name
        if (color !== undefined) patch.color = color
        if (sort_order !== undefined) patch.sort_order = sort_order
        const { data, error } = await sb.from('dist_groups').update(patch).eq('id', id).select().single()
        if (error) throw error
        result = data
        break
      }
      case 'deleteGroup': {
        const { id } = payload || {}
        if (!id) return res.status(400).json({ error: 'id required' })
        const { error } = await sb.from('dist_groups').delete().eq('id', id)
        if (error) throw error
        result = { deleted: true }
        break
      }
      case 'addMember': {
        const { group_id, canonical_name } = payload || {}
        if (!group_id || !canonical_name) return res.status(400).json({ error: 'group_id and canonical_name required' })
        const { data, error } = await sb.from('dist_group_members')
          .upsert({ group_id, canonical_name }, { onConflict: 'group_id,canonical_name' })
          .select()
        if (error) throw error
        result = data
        break
      }
      case 'removeMember': {
        const { group_id, canonical_name } = payload || {}
        if (!group_id || !canonical_name) return res.status(400).json({ error: 'group_id and canonical_name required' })
        const { error } = await sb.from('dist_group_members').delete().eq('group_id', group_id).eq('canonical_name', canonical_name)
        if (error) throw error
        result = { deleted: true }
        break
      }
      case 'setMembers': {
        const { group_id, canonical_names } = payload || {}
        if (!group_id || !Array.isArray(canonical_names)) return res.status(400).json({ error: 'group_id and canonical_names[] required' })
        // Delete all existing members of this group, then insert new list
        const { error: delErr } = await sb.from('dist_group_members').delete().eq('group_id', group_id)
        if (delErr) throw delErr
        if (canonical_names.length > 0) {
          const rows = canonical_names.map((cn: string) => ({ group_id, canonical_name: cn }))
          const { error: insErr } = await sb.from('dist_group_members').insert(rows)
          if (insErr) throw insErr
        }
        result = { count: canonical_names.length }
        break
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` })
    }

    invalidateGroupingCache()
    res.status(200).json({ success: true, result })
  } catch (e: any) {
    console.error('mutate error:', e)
    res.status(500).json({ error: e.message || 'Mutation failed' })
  }
}
