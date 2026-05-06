// lib/b2b-settings.ts
//
// Loads b2b_settings (singleton row) with auto-resolve of MYOB JAWS tax
// code UIDs on first use. Mirrors the pattern in lib/ap-myob-bill.ts.
//
// What MUST be configured manually before checkout works:
//   - myob_card_fee_account_uid   (an Income or Other-Income account in MYOB)
//
// What auto-resolves on first checkout (cached in DB):
//   - myob_jaws_gst_tax_code_uid
//   - myob_jaws_fre_tax_code_uid

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'

const SETTINGS_ID = 'singleton'
const TAX_CODE_TTL_MS = 30 * 24 * 3600 * 1000  // 30 days

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface B2BSettings {
  card_fee_percent: number
  card_fee_fixed: number
  myob_jaws_gst_tax_code_uid: string | null
  myob_jaws_fre_tax_code_uid: string | null
  myob_card_fee_account_uid: string | null
  myob_card_fee_account_code: string | null
  myob_default_freight_account_uid: string | null
  slack_new_order_webhook_url: string | null
  tax_codes_refreshed_at: string | null
}

export async function loadSettings(): Promise<B2BSettings> {
  const c = sb()
  const { data, error } = await c
    .from('b2b_settings')
    .select('*')
    .eq('id', SETTINGS_ID)
    .maybeSingle()
  if (error) throw new Error(`b2b_settings load failed: ${error.message}`)
  if (!data) throw new Error('b2b_settings row missing')
  return data as any
}

/**
 * Returns JAWS GST + FRE tax code UIDs, fetching from MYOB if not cached
 * or if cache is older than 30 days.
 */
export async function ensureJawsTaxCodes(): Promise<{ gstUid: string; freUid: string }> {
  const settings = await loadSettings()

  const refreshedAt = settings.tax_codes_refreshed_at
    ? new Date(settings.tax_codes_refreshed_at).getTime()
    : 0
  const stale = Date.now() - refreshedAt > TAX_CODE_TTL_MS
  let gstUid = settings.myob_jaws_gst_tax_code_uid
  let freUid = settings.myob_jaws_fre_tax_code_uid

  if (gstUid && freUid && !stale) {
    return { gstUid, freUid }
  }

  // Refresh from MYOB JAWS
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('JAWS MYOB connection not configured')

  const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/GeneralLedger/TaxCode`, {
    query: { '$top': 200 },
  })
  if (result.status !== 200) {
    throw new Error(`MYOB tax code fetch failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 200)}`)
  }
  const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []

  // Match by Code field (e.g. "GST", "FRE")
  for (const it of items) {
    const code = String(it.Code || '').toUpperCase()
    if (code === 'GST' && it.UID) gstUid = it.UID
    if (code === 'FRE' && it.UID) freUid = it.UID
  }

  if (!gstUid) throw new Error('MYOB JAWS does not have a tax code with Code="GST"')
  if (!freUid) throw new Error('MYOB JAWS does not have a tax code with Code="FRE"')

  await sb()
    .from('b2b_settings')
    .update({
      myob_jaws_gst_tax_code_uid: gstUid,
      myob_jaws_fre_tax_code_uid: freUid,
      tax_codes_refreshed_at: new Date().toISOString(),
    })
    .eq('id', SETTINGS_ID)

  return { gstUid, freUid }
}

/**
 * Validates that all MYOB-side settings required for checkout are configured.
 * Throws a descriptive error if anything is missing — surfaces to the
 * distributor as "Checkout temporarily unavailable" with a helpful detail
 * for staff.
 */
export async function assertCheckoutConfigured(): Promise<{
  cardFeeAccountUid: string
  gstTaxCodeUid: string
  freTaxCodeUid: string
  cardFeePct: number
  cardFeeFixed: number
}> {
  const settings = await loadSettings()
  if (!settings.myob_card_fee_account_uid) {
    throw new Error(
      'Checkout misconfigured: b2b_settings.myob_card_fee_account_uid is not set. ' +
      'Staff must pick a MYOB JAWS income account for the card surcharge line.',
    )
  }
  const taxCodes = await ensureJawsTaxCodes()
  return {
    cardFeeAccountUid: settings.myob_card_fee_account_uid,
    gstTaxCodeUid: taxCodes.gstUid,
    freTaxCodeUid: taxCodes.freUid,
    cardFeePct:    Number(settings.card_fee_percent || 0.017),
    cardFeeFixed:  Number(settings.card_fee_fixed   || 0.30),
  }
}
