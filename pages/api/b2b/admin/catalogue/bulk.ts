// pages/api/b2b/admin/catalogue/bulk.ts
// POST /api/b2b/admin/catalogue/bulk
//   body: { updates: Array<{ id: string, patch: {...} }> }
//
// Applies focused per-item patches to many catalogue rows in one call. Used by
// the "Bulk edit" modal on the catalogue page. The client computes each row's
// patch (so percentage price adjustments resolve to concrete values), and this
// endpoint validates + writes each. Only a safe subset of fields is bulk-editable.
//
// Permission: edit:b2b_catalogue.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const NUMERIC_FIELDS = ['trade_price_ex_gst', 'inbound_freight_cost_ex_gst'] as const
const PACKAGING_VALUES = ['box', 'pallet', 'other'] as const
// trade_price must be >= 0 and non-null; the surcharges are nullable (null clears).
const REQUIRED_NUMERIC = new Set<string>(['trade_price_ex_gst'])

export const config = { maxDuration: 60 }

function cleanPatch(raw: any): { patch: Record<string, any> } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'patch must be an object' }
  const patch: Record<string, any> = {}

  if ('b2b_visible' in raw) {
    if (typeof raw.b2b_visible !== 'boolean') return { error: 'b2b_visible must be boolean' }
    patch.b2b_visible = raw.b2b_visible
  }
  if ('manual_handling' in raw) {
    if (typeof raw.manual_handling !== 'boolean') return { error: 'manual_handling must be boolean' }
    patch.manual_handling = raw.manual_handling
  }
  if ('is_drop_ship' in raw) {
    if (typeof raw.is_drop_ship !== 'boolean') return { error: 'is_drop_ship must be boolean' }
    patch.is_drop_ship = raw.is_drop_ship
  }
  for (const k of NUMERIC_FIELDS) {
    if (k in raw) {
      const v = raw[k]
      if (v === null || v === '') {
        if (REQUIRED_NUMERIC.has(k)) return { error: `${k} cannot be empty` }
        patch[k] = null
      } else {
        const n = Number(v)
        if (!isFinite(n) || n < 0) return { error: `${k} must be a non-negative number` }
        patch[k] = n
      }
    }
  }
  if ('freight_packaging' in raw) {
    const v = raw.freight_packaging
    if (v === null || v === '') patch.freight_packaging = null
    else if (typeof v !== 'string' || !(PACKAGING_VALUES as readonly string[]).includes(v)) {
      return { error: `freight_packaging must be one of ${PACKAGING_VALUES.join(', ')} or null` }
    } else patch.freight_packaging = v
  }

  if (Object.keys(patch).length === 0) return { error: 'patch has no editable fields' }
  return { patch }
}

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const updates: any[] = Array.isArray(body.updates) ? body.updates : []
  if (updates.length === 0) return res.status(400).json({ error: 'No updates supplied' })
  if (updates.length > 1000) return res.status(400).json({ error: 'Too many updates (max 1000)' })

  // Validate everything up-front; reject the whole batch on any bad row so the
  // operation is all-or-nothing from the caller's perspective.
  const clean: Array<{ id: string; patch: Record<string, any> }> = []
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i]
    const id = String(u?.id || '').trim()
    if (!id) return res.status(400).json({ error: `updates[${i}] missing id` })
    const r = cleanPatch(u?.patch)
    if ('error' in r) return res.status(400).json({ error: `updates[${i}] (${id}): ${r.error}` })
    clean.push({ id, patch: r.patch })
  }

  const c = sb()
  let updated = 0
  const failures: Array<{ id: string; error: string }> = []
  // Per-row updates (patches may differ per row, e.g. percentage price changes).
  for (const u of clean) {
    const { error } = await c.from('b2b_catalogue').update(u.patch).eq('id', u.id)
    if (error) failures.push({ id: u.id, error: error.message })
    else updated++
  }

  return res.status(200).json({ ok: failures.length === 0, updated, failed: failures.length, failures })
})
