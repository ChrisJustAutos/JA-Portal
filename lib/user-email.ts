// lib/user-email.ts
// Resolve a staff member's configured Reply-To address (user_profiles
// .reply_to_email, migration 128). Outbound staff emails (quotes, POs, tax
// invoices, CRM emails) pass this as the Reply-To so customer replies route to
// the staff member's shared inbox. Returns null when unset/blank — callers fall
// back to a document/business default or the global RESEND_REPLY_TO.

import { SupabaseClient } from '@supabase/supabase-js'

export async function getUserReplyTo(db: SupabaseClient, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null
  try {
    const { data } = await db.from('user_profiles').select('reply_to_email').eq('id', userId).maybeSingle()
    const v = (data as any)?.reply_to_email
    const s = v == null ? '' : String(v).trim()
    return s ? s : null
  } catch {
    return null
  }
}
