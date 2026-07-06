// pages/api/settings/coaching-rubrics.ts
// Coaching rubric management (Settings → Coaching). Admin only.
//   GET  — all rubric rows (full: prompt_template, company_context, call_types)
//   PUT  — { version, patch: { description?, company_context?, prompt_template?, call_types? } }
//   POST — { action: 'activate',  version }                 → single active rubric
//        — { action: 'duplicate', version, new_version }    → copy as a new (inactive) version
//
// NOTE: until the FreePBX worker's analysis loop is turned off, the ACTIVE
// rubric is consumed by the worker — the UI warns before edits to it.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 30 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const EDITABLE = ['description', 'company_context', 'prompt_template', 'call_types'] as const

function validCallTypes(ct: any): string | null {
  if (ct == null) return null
  if (!Array.isArray(ct)) return 'call_types must be an array'
  for (const t of ct) {
    if (!t || typeof t !== 'object') return 'each call type must be an object'
    if (!t.id || typeof t.id !== 'string' || !/^[a-z0-9_]+$/.test(t.id)) return `call type id "${t.id}" must be snake_case`
    if (typeof t.label !== 'string' || !t.label.trim()) return `call type "${t.id}" needs a label`
    if (typeof t.scoreable !== 'boolean') return `call type "${t.id}" needs scoreable true/false`
    if (t.scoreable) {
      if (!Array.isArray(t.dimensions) || t.dimensions.length === 0) return `scoreable type "${t.id}" needs dimensions`
      for (const d of t.dimensions) {
        if (!d.id || !/^[a-z0-9_]+$/.test(d.id)) return `dimension id "${d?.id}" in "${t.id}" must be snake_case`
        if (typeof d.weight !== 'number' || d.weight <= 0) return `dimension "${d.id}" in "${t.id}" needs a positive weight`
        if (typeof d.label !== 'string' || !d.label.trim()) return `dimension "${d.id}" in "${t.id}" needs a label`
      }
    }
  }
  return null
}

export default withAuth(null, async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('coaching_rubrics')
      .select('version, description, is_active, prompt_template, company_context, dimensions, call_types')
      .order('version')
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ rubrics: data || [] })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'PUT') {
    const version = String(body.version || '').trim()
    if (!version) return res.status(400).json({ error: 'version required' })
    const patch: Record<string, any> = {}
    for (const k of EDITABLE) if (k in (body.patch || {})) patch[k] = body.patch[k]
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' })
    if ('call_types' in patch) {
      const err = validCallTypes(patch.call_types)
      if (err) return res.status(400).json({ error: err })
    }
    const { error } = await db.from('coaching_rubrics').update(patch).eq('version', version)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'POST') {
    const action = String(body.action || '')
    const version = String(body.version || '').trim()
    if (!version) return res.status(400).json({ error: 'version required' })

    if (action === 'activate') {
      // Single active rubric: deactivate all, then activate the target.
      const { error: e1 } = await db.from('coaching_rubrics').update({ is_active: false }).eq('is_active', true)
      if (e1) return res.status(500).json({ error: e1.message })
      const { error: e2 } = await db.from('coaching_rubrics').update({ is_active: true }).eq('version', version)
      if (e2) return res.status(500).json({ error: e2.message })
      return res.status(200).json({ ok: true })
    }

    if (action === 'duplicate') {
      const newVersion = String(body.new_version || '').trim()
      if (!newVersion) return res.status(400).json({ error: 'new_version required' })
      const { data: src, error: e1 } = await db.from('coaching_rubrics')
        .select('description, prompt_template, company_context, dimensions, call_types')
        .eq('version', version).maybeSingle()
      if (e1 || !src) return res.status(404).json({ error: e1?.message || 'source rubric not found' })
      const { error: e2 } = await db.from('coaching_rubrics').insert({
        version: newVersion, is_active: false,
        description: `Copy of ${version}. ${src.description || ''}`.trim(),
        prompt_template: src.prompt_template, company_context: src.company_context,
        dimensions: src.dimensions, call_types: src.call_types,
      })
      if (e2) return res.status(500).json({ error: e2.message })
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: `unknown action "${action}"` })
  }

  return res.status(405).json({ error: 'Method not allowed' })
})
