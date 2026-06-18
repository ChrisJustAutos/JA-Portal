// lib/b2b-distributor-myob.ts
//
// Helpers to keep a B2B distributor's MYOB card info in sync with MYOB.
//
// Why: when a distributor is created we snapshot the MYOB card's DisplayID
// (Card ID) once. If the card had no Card ID then, MYOB returns "*None"; and if
// the Card ID is added/changed in MYOB later, the stored snapshot goes stale.
// These helpers re-read the live DisplayID (and name) from MYOB so the
// distributor list/detail always show the current Card ID and linked-card names.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'

// MYOB uses "*None" as the placeholder DisplayID for a card with no Card ID.
export function displayIdMissing(v: string | null | undefined): boolean {
  const s = String(v ?? '').trim().toLowerCase()
  return s === '' || s === '*none'
}

export interface CardSummary { uid: string; display_id: string; name: string }

// Fetch DisplayID + name for a set of MYOB customer UIDs (JAWS file).
// Best-effort: cards that fail to load are simply omitted from the map.
export async function fetchCardSummaries(uids: string[]): Promise<Map<string, CardSummary>> {
  const out = new Map<string, CardSummary>()
  const unique = Array.from(new Set(uids.filter(u => typeof u === 'string' && u.length > 0)))
  if (unique.length === 0) return out

  const conn = await getConnection('JAWS')
  if (!conn) return out

  let next = 0
  const worker = async () => {
    while (next < unique.length) {
      const uid = unique[next++]
      try {
        const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Contact/Customer/${encodeURIComponent(uid)}`)
        if (r.status === 200 && r.data) {
          const d = r.data
          const name = (d.CompanyName || '').trim() || [d.FirstName, d.LastName].filter(Boolean).join(' ').trim() || ''
          const raw = String(d.DisplayID || '').trim()
          out.set(uid, { uid, display_id: displayIdMissing(raw) ? '' : raw, name })
        }
      } catch { /* best effort */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, () => worker()))
  return out
}

// Re-sync the stored primary DisplayID for one distributor against MYOB, and
// return resolved info for the primary + linked cards (for the detail UI).
// Writes back to the DB only when the live primary DisplayID actually differs.
export async function resyncDistributorMyob(
  c: SupabaseClient,
  dist: { id: string; myob_primary_customer_uid: string; myob_primary_customer_display_id: string | null; myob_linked_customer_uids: string[] | null },
): Promise<{ primary_display_id: string | null; linked: CardSummary[] }> {
  const linkedUids = Array.isArray(dist.myob_linked_customer_uids) ? dist.myob_linked_customer_uids : []
  const summaries = await fetchCardSummaries([dist.myob_primary_customer_uid, ...linkedUids])

  const primary = dist.myob_primary_customer_uid ? summaries.get(dist.myob_primary_customer_uid) : undefined
  let primaryDisplayId = dist.myob_primary_customer_display_id

  // If MYOB now has a real Card ID and it differs from what we stored, persist it.
  if (primary && primary.display_id && primary.display_id !== dist.myob_primary_customer_display_id) {
    primaryDisplayId = primary.display_id
    await c.from('b2b_distributors')
      .update({ myob_primary_customer_display_id: primary.display_id })
      .eq('id', dist.id)
  }

  const linked = linkedUids.map(uid => summaries.get(uid) || { uid, display_id: '', name: '' })
  return { primary_display_id: primaryDisplayId, linked }
}
