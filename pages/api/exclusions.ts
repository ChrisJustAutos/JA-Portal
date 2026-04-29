// pages/api/exclusions.ts
// Admin-only: GET + POST for distributor_report_excluded_customers.
//
// Note values are constrained (DB CHECK) to one of:
//   'Excluded' — hidden from the distributor report (staff, unwanted)
//   'Sundry'   — surfaced as a dedicated 'Sundry' group on the report
//   'Internal' — hidden (VPS intercompany, related entities)
//
// SAFE-SAVE SEMANTICS (29 Apr 2026 fix):
//   The previous implementation did `delete-all → insert-new`. If the insert
//   silently failed or the client sent an empty list, the table was left
//   empty — silently wiping the entire exclusion config. This caused 12
//   sundry/excluded customers to appear on the live report on 29 Apr.
//
//   The new flow uses a diff-based upsert:
//     1. Read the current set from the DB.
//     2. Compute three sets: to-add, to-update, to-delete.
//     3. Apply: insert new, update changed, delete removed — each in
//        separate operations with their own error handling.
//     4. If ANY operation fails, return an error with details. The DB is
//        left in its previous state for the failed operation; partial
//        progress on earlier operations is fine because each is idempotent.
//
//   An empty incoming list now requires `?confirmEmpty=1` to actually wipe.
//   Without that flag, an empty list is rejected as a probable client bug.
//
//   On successful save, also invalidate distributors_cache so the next
//   /api/distributors hit recomputes with the fresh exclusion list.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '../../lib/auth'

const VALID_NOTES = ['Excluded', 'Sundry', 'Internal'] as const
type Note = typeof VALID_NOTES[number]

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface ExcludedRow { id?: string; customer_name: string; note: Note }

async function handleGet(res: NextApiResponse) {
  const sb = sbAdmin()
  const { data, error } = await sb
    .from('distributor_report_excluded_customers')
    .select('id, customer_name, note, created_at')
    .order('customer_name')
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ excluded: data || [] })
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body || {}
  const incoming: ExcludedRow[] = Array.isArray(body.excluded) ? body.excluded : []

  // ── Validation ───────────────────────────────────────────────────
  for (const row of incoming) {
    if (!row.customer_name || !String(row.customer_name).trim()) {
      return res.status(400).json({ error: 'customer_name required on every row' })
    }
    if (!VALID_NOTES.includes(row.note)) {
      return res.status(400).json({ error: `note must be one of: ${VALID_NOTES.join(', ')}` })
    }
  }

  // ── Empty-list safety guard ──────────────────────────────────────
  // Refuse to wipe the whole list unless the client explicitly opts in.
  // This prevents a single bad save from silently nuking everything.
  if (incoming.length === 0 && req.query.confirmEmpty !== '1') {
    return res.status(400).json({
      error: 'Refusing to save an empty list. Pass ?confirmEmpty=1 if you really want to remove all exclusions.',
      hint: 'This is almost always a client bug. Check the request payload.',
    })
  }

  const sb = sbAdmin()

  // ── Read current state ───────────────────────────────────────────
  const { data: currentRows, error: readErr } = await sb
    .from('distributor_report_excluded_customers')
    .select('id, customer_name, note')
  if (readErr) {
    return res.status(500).json({ error: 'Failed to read current state: ' + readErr.message })
  }

  // Map by lowercased name for case-insensitive comparison.
  const currentByLower = new Map<string, { id: string; customer_name: string; note: Note }>()
  for (const r of currentRows || []) {
    currentByLower.set(String(r.customer_name).toLowerCase(), r as any)
  }

  // ── Dedupe incoming by lowercased name ───────────────────────────
  const incomingByLower = new Map<string, { customer_name: string; note: Note }>()
  for (const r of incoming) {
    const key = r.customer_name.trim().toLowerCase()
    if (!incomingByLower.has(key)) {
      incomingByLower.set(key, { customer_name: r.customer_name.trim(), note: r.note })
    }
  }

  // ── Compute diff ─────────────────────────────────────────────────
  const toInsert: Array<{ customer_name: string; note: Note }> = []
  const toUpdate: Array<{ id: string; customer_name: string; note: Note }> = []
  const toDeleteIds: string[] = []

  // Note: Array.from() on Map entries — for...of on a Map iterator requires
  // downlevelIteration or es2015+ target, neither of which this project has.
  Array.from(incomingByLower.entries()).forEach(([key, inc]) => {
    const cur = currentByLower.get(key)
    if (!cur) {
      toInsert.push(inc)
    } else if (cur.note !== inc.note || cur.customer_name !== inc.customer_name) {
      toUpdate.push({ id: cur.id, customer_name: inc.customer_name, note: inc.note })
    }
    // else: unchanged, skip
  })
  Array.from(currentByLower.entries()).forEach(([key, cur]) => {
    if (!incomingByLower.has(key)) {
      toDeleteIds.push(cur.id)
    }
  })

  // ── Apply ────────────────────────────────────────────────────────
  const result = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    unchanged: incomingByLower.size - toInsert.length - toUpdate.length,
    errors: [] as string[],
  }

  // Inserts
  if (toInsert.length > 0) {
    const { error } = await sb.from('distributor_report_excluded_customers').insert(toInsert)
    if (error) result.errors.push(`Insert ${toInsert.length} rows failed: ${error.message}`)
    else result.inserted = toInsert.length
  }

  // Updates — one row at a time so a single bad row doesn't fail the batch
  for (const u of toUpdate) {
    const { error } = await sb
      .from('distributor_report_excluded_customers')
      .update({ customer_name: u.customer_name, note: u.note })
      .eq('id', u.id)
    if (error) result.errors.push(`Update "${u.customer_name}" failed: ${error.message}`)
    else result.updated++
  }

  // Deletes
  if (toDeleteIds.length > 0) {
    const { error } = await sb
      .from('distributor_report_excluded_customers')
      .delete()
      .in('id', toDeleteIds)
    if (error) result.errors.push(`Delete ${toDeleteIds.length} rows failed: ${error.message}`)
    else result.deleted = toDeleteIds.length
  }

  // ── Cache invalidation ───────────────────────────────────────────
  // The distributors endpoint caches by (start_date, end_date). When the
  // exclusion list changes, those cached payloads are now stale. Clear
  // them so the next request recomputes with the new config.
  let cacheCleared = 0
  if (result.inserted + result.updated + result.deleted > 0) {
    const { error: cacheErr, count } = await sb
      .from('distributors_cache')
      .delete({ count: 'exact' })
      // Match every row — the .neq on a column that always exists is the
      // cleanest way to express "delete all" in PostgREST.
      .neq('range_key', '___never_matches___')
    if (cacheErr) {
      result.errors.push(`Cache invalidation failed: ${cacheErr.message}`)
    } else {
      cacheCleared = count || 0
    }
  }

  // ── Response ─────────────────────────────────────────────────────
  if (result.errors.length > 0) {
    return res.status(207).json({
      ok: false,
      partial: true,
      ...result,
      cacheCleared,
      message: 'Some operations failed — see errors. The DB is in a partial state.',
    })
  }

  return res.status(200).json({
    ok: true,
    ...result,
    cacheCleared,
  })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method === 'GET')  return handleGet(res)
    if (req.method === 'POST') return handlePost(req, res)
    res.status(405).json({ error: 'Method not allowed' })
  })
}
