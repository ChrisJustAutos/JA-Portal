// pages/api/crm/stages/index.ts
// Editable pipeline stages (crm_pipeline_stages, migration 097).
//   GET              — all stages (incl. archived) + crm_settings (view:crm)
//   POST             — create a stage { label, color? } (edit:crm)
//   PATCH            — { order: [id,…] } reorder, and/or { settings: {…} }
//                      to update crm_settings (edit:crm)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getPipelineStages, invalidateStagesCache, getCrmSettings } from '../../../../lib/crm'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'stage'
}

export default withAuth('view:crm', async (req, res, user) => {
  const db = sb()

  if (req.method === 'GET') {
    const [stages, settings] = await Promise.all([getPipelineStages(db, { fresh: true }), getCrmSettings(db)])
    return res.status(200).json({ stages, settings })
  }

  if (!roleHasPermission(user.role, 'edit:crm')) return res.status(403).json({ error: 'Forbidden' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'POST') {
    const label = String(body.label || '').trim()
    if (!label) return res.status(400).json({ error: 'label required' })
    // Unique key from the label; suffix on collision.
    const base = slugify(label)
    let key = base
    for (let i = 2; i < 20; i++) {
      const { data } = await db.from('crm_pipeline_stages').select('id').eq('key', key).maybeSingle()
      if (!data) break
      key = `${base}_${i}`
    }
    const { data: last } = await db.from('crm_pipeline_stages').select('sort_order').order('sort_order', { ascending: false }).limit(1)
    const { data, error } = await db.from('crm_pipeline_stages').insert({
      key, label, color: body.color || '#4f8ef7',
      sort_order: ((last?.[0]?.sort_order as number) || 0) + 1,
      on_board: body.on_board !== false,
    }).select('*').single()
    if (error) return res.status(500).json({ error: error.message })
    invalidateStagesCache()
    return res.status(201).json({ ok: true, stage: data })
  }

  if (req.method === 'PATCH') {
    if (Array.isArray(body.order)) {
      for (let i = 0; i < body.order.length; i++) {
        await db.from('crm_pipeline_stages').update({ sort_order: i + 1 }).eq('id', body.order[i])
      }
    }
    if (body.settings && typeof body.settings === 'object') {
      const patch: any = { updated_at: new Date().toISOString() }
      if ('quote_stage_map' in body.settings) patch.quote_stage_map = body.settings.quote_stage_map
      if ('sync_lead_value' in body.settings) patch.sync_lead_value = !!body.settings.sync_lead_value
      await db.from('crm_settings').update(patch).eq('id', 'singleton')
    }
    invalidateStagesCache()
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, POST, PATCH')
  return res.status(405).json({ error: 'GET, POST or PATCH only' })
})
