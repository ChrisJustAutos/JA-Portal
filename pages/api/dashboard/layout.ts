// pages/api/dashboard/layout.ts
//
// Multi-layout dashboard persistence. A user can save many named layouts and
// switch between them. Exactly one is marked active.
//
// GET ?key=overview
//   → Returns the active layout (or default if user has none saved yet):
//     { id, name, widgets, global_date_range, is_active, is_default }
//
// GET ?key=overview&list=1
//   → Returns list of all saved layouts for this user (no widget data):
//     { layouts: [{ id, name, is_active, updated_at }], active_id }
//
// POST ?key=overview
//   body: { id?, name?, widgets, global_date_range, global_date_from?, global_date_to?, activate? }
//   → id+name unset → creates new layout (unique name enforced per user)
//   → id set → updates that specific layout
//   → activate=true → marks this layout as the active one (deactivates others)
//
// POST ?key=overview&action=activate
//   body: { id }
//   → Marks layout `id` as active (deactivates others), no widget update
//
// POST ?key=overview&action=rename
//   body: { id, name }
//   → Rename a saved layout
//
// DELETE ?key=overview&id=<layoutId>
//   → Delete a named layout. If it was active, revert to default on next load.
//
// DELETE ?key=overview  (no id)
//   → Delete ALL user's layouts for this dashboard — reverts to default.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth, getSessionUser } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const user = await getSessionUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    const dashboardKey = String(req.query.key || 'overview')
    const action       = String(req.query.action || '')

    if (req.method === 'GET') {
      // List mode
      if (req.query.list === '1') {
        const { data, error } = await sb()
          .from('dashboard_layouts')
          .select('id, name, is_active, updated_at')
          .eq('user_id', user.id)
          .eq('dashboard_key', dashboardKey)
          .order('name', { ascending: true })
        if (error) { res.status(500).json({ error: error.message }); return }
        const active = (data || []).find((l: any) => l.is_active)
        res.status(200).json({ layouts: data || [], active_id: active?.id || null })
        return
      }

      // Single mode — return active layout or default
      const { data: active } = await sb()
        .from('dashboard_layouts')
        .select('*')
        .eq('user_id', user.id)
        .eq('dashboard_key', dashboardKey)
        .eq('is_active', true)
        .maybeSingle()

      if (active) {
        res.status(200).json({
          id: active.id,
          name: active.name,
          widgets: active.widgets || [],
          global_date_range: active.global_date_range,
          global_date_from: active.global_date_from,
          global_date_to: active.global_date_to,
          is_active: true,
          is_default: false,
        })
        return
      }

      // Fall back to shared default
      const { data: def } = await sb()
        .from('dashboard_defaults')
        .select('widgets')
        .eq('dashboard_key', dashboardKey)
        .maybeSingle()
      res.status(200).json({
        id: null,
        name: 'Default',
        widgets: def?.widgets || [],
        global_date_range: 'today',
        global_date_from: null,
        global_date_to: null,
        is_active: false,
        is_default: true,
      })
      return
    }

    if (req.method === 'POST') {
      const body = req.body || {}

      // Action: activate a specific layout
      if (action === 'activate') {
        const id = body.id
        if (!id) { res.status(400).json({ error: 'id required' }); return }
        // Deactivate all, then activate the target. Two-step to avoid
        // violating the partial unique index mid-transaction.
        const { error: e1 } = await sb().from('dashboard_layouts').update({ is_active: false })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('is_active', true)
        if (e1) { res.status(500).json({ error: e1.message }); return }
        const { error: e2 } = await sb().from('dashboard_layouts').update({ is_active: true })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('id', id)
        if (e2) { res.status(500).json({ error: e2.message }); return }
        res.status(200).json({ ok: true })
        return
      }

      // Action: rename a layout
      if (action === 'rename') {
        const id = body.id
        const name = String(body.name || '').trim()
        if (!id || !name) { res.status(400).json({ error: 'id and name required' }); return }
        const { error } = await sb().from('dashboard_layouts')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('id', id)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.status(200).json({ ok: true })
        return
      }

      // Default: save/create/update a layout
      const id = body.id || null
      const name = String(body.name || 'My dashboard').trim().substring(0, 80)
      const widgets = Array.isArray(body.widgets) ? body.widgets : []
      const global_date_range = body.global_date_range || 'today'
      const global_date_from = body.global_date_from || null
      const global_date_to = body.global_date_to || null
      const shouldActivate = body.activate !== false  // default true

      let targetId = id

      if (id) {
        // Update existing
        const { error } = await sb().from('dashboard_layouts')
          .update({
            widgets, global_date_range, global_date_from, global_date_to,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('id', id)
        if (error) { res.status(500).json({ error: error.message }); return }
      } else {
        // Insert new. If name already exists for this user+dashboard, suffix it.
        const { data: existing } = await sb().from('dashboard_layouts')
          .select('name').eq('user_id', user.id).eq('dashboard_key', dashboardKey)
        const existingNames = new Set((existing || []).map((r: any) => r.name))
        let finalName = name
        let suffix = 2
        while (existingNames.has(finalName)) finalName = `${name} (${suffix++})`

        const { data: inserted, error } = await sb().from('dashboard_layouts')
          .insert({
            user_id: user.id,
            dashboard_key: dashboardKey,
            name: finalName,
            widgets, global_date_range, global_date_from, global_date_to,
            is_active: false,  // activate below to satisfy unique index
          })
          .select('id')
          .single()
        if (error) { res.status(500).json({ error: error.message }); return }
        targetId = inserted.id
      }

      if (shouldActivate && targetId) {
        await sb().from('dashboard_layouts').update({ is_active: false })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('is_active', true)
        await sb().from('dashboard_layouts').update({ is_active: true })
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('id', targetId)
      }

      res.status(200).json({ ok: true, id: targetId })
      return
    }

    if (req.method === 'DELETE') {
      const id = req.query.id ? String(req.query.id) : null
      if (id) {
        const { error } = await sb().from('dashboard_layouts')
          .delete()
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey).eq('id', id)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.status(200).json({ ok: true })
      } else {
        // Nuke all — revert to default
        const { error } = await sb().from('dashboard_layouts')
          .delete()
          .eq('user_id', user.id).eq('dashboard_key', dashboardKey)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.status(200).json({ ok: true, message: 'All layouts reset to default' })
      }
      return
    }

    res.status(405).end()
  })
}
