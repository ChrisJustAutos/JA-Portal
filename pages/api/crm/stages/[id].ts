// pages/api/crm/stages/[id].ts
// PATCH  — update label/color/on_board/is_won/is_lost (edit:crm).
//          Guards: at least one won stage and one lost stage must remain.
// DELETE — archive (never hard-delete; leads reference the key). Requires
//          ?move_to=<stage key>: re-stages live leads and rewrites automation
//          trigger_stage / cancel_on_stages references before archiving.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { invalidateStagesCache } from '../../../../lib/crm'

export const config = { maxDuration: 15 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('view:crm', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  const db = sb()
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const { data: stage } = await db.from('crm_pipeline_stages').select('*').eq('id', id).maybeSingle()
  if (!stage) return res.status(404).json({ error: 'Stage not found' })

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: any = {}
    if ('label' in body && String(body.label).trim()) patch.label = String(body.label).trim()
    if ('color' in body && body.color) patch.color = String(body.color)
    if ('on_board' in body) patch.on_board = !!body.on_board
    for (const flag of ['is_won', 'is_lost'] as const) {
      if (flag in body) {
        const next = !!body[flag]
        if (!next && stage[flag]) {
          // Don't allow removing the LAST won/lost stage — reports + automations rely on them.
          const { data: others } = await db.from('crm_pipeline_stages').select('id').eq(flag, true).neq('id', id).is('archived_at', null)
          if (!others || others.length === 0) return res.status(409).json({ error: `At least one ${flag === 'is_won' ? 'Won' : 'Lost'} stage must remain.` })
        }
        patch[flag] = next
        if (flag === 'is_won' && next) patch.is_lost = false
        if (flag === 'is_lost' && next) patch.is_won = false
      }
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No patchable fields' })
    const { error } = await db.from('crm_pipeline_stages').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    invalidateStagesCache()
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const moveTo = String(req.query.move_to || '').trim()
    if (!moveTo) return res.status(400).json({ error: 'move_to stage key required' })
    if (moveTo === stage.key) return res.status(400).json({ error: 'move_to must be a different stage' })
    const { data: target } = await db.from('crm_pipeline_stages').select('id, key').eq('key', moveTo).is('archived_at', null).maybeSingle()
    if (!target) return res.status(400).json({ error: `Target stage "${moveTo}" not found` })
    if (stage.is_won || stage.is_lost) {
      const flag = stage.is_won ? 'is_won' : 'is_lost'
      const { data: others } = await db.from('crm_pipeline_stages').select('id').eq(flag, true).neq('id', id).is('archived_at', null)
      if (!others || others.length === 0) return res.status(409).json({ error: 'Cannot archive the last Won/Lost stage.' })
    }

    // Re-stage live leads, then rewrite automation references to the old key.
    await db.from('crm_leads').update({ stage: moveTo }).eq('stage', stage.key).is('deleted_at', null)
    await db.from('crm_automations').update({ trigger_stage: moveTo }).eq('trigger_stage', stage.key)
    const { data: autos } = await db.from('crm_automations').select('id, cancel_on_stages').contains('cancel_on_stages', [stage.key])
    for (const a of autos || []) {
      const next = Array.from(new Set((a.cancel_on_stages || []).map((s: string) => s === stage.key ? moveTo : s)))
      await db.from('crm_automations').update({ cancel_on_stages: next }).eq('id', a.id)
    }
    const { error } = await db.from('crm_pipeline_stages').update({ archived_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    invalidateStagesCache()
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'PATCH, DELETE')
  return res.status(405).json({ error: 'PATCH or DELETE only' })
})
