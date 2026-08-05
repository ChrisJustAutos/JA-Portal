// lib/accounting/post-ap-invoice.ts
//
// PILOT seam for the MYOB → Xero migration: the AP invoice-posting path.
//
// Callers that used to call postFoundInvoiceToMyob (lib/ap-myob-bill.ts)
// directly now call postApInvoice(companyFile, args). The provider switch
// (lib/accounting-provider.ts, integration_settings-backed) decides where
// the bill lands:
//
//   'myob' (the default) → delegate STRAIGHT THROUGH to postFoundInvoiceToMyob.
//                          Behaviour is byte-identical to before this seam.
//   'xero'               → translate the same inputs into a Xero ACCPAY
//                          invoice via XeroAdapter, resolving the MYOB-keyed
//                          supplier/accounts through the migration mapping
//                          tables (xero_contact_map / xero_account_map,
//                          migration 183).
//
// Translation is HONEST: anything the MYOB path does that the Xero path
// can't faithfully reproduce yet returns { posted:false, reason:'not yet
// supported on xero: …' } instead of approximating. Known gaps:
//   - supplier CREDIT NOTES (MYOB posts a negative bill; Xero needs an
//     ACCPAYCREDIT with its own duplicate-adopt — not built yet)
//   - journal memo / Capricorn reference narration (Xero ACCPAY has no
//     memo field on the adapter; the reference carries the invoice number)
//
// NOTE on the adapter import: lib/accounting/types.ts and the concrete
// XeroAdapter (lib/accounting/xero-adapter.ts) were authored to the same
// contract on parallel branches and have NOT been reconciled yet — the
// concrete class's method signatures (findContact(query) etc.) differ from
// the neutral types.ts ones (findContact(kind, query)). Going through
// getAccountingAdapter()'s `as AccountingAdapter` cast would typecheck
// against types.ts but break at runtime, so this file imports XeroAdapter
// directly and calls its real signatures. THE SWITCH is still honoured via
// accountingProvider(companyFile, 'AP'). Once xero-adapter.ts is reconciled
// to './types', switch this file to getAccountingAdapter.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { accountingProvider } from '../accounting-provider'
import { postFoundInvoiceToMyob, FoundInvoicePostResult } from '../ap-myob-bill'
import { CompanyFileLabel, getSupplierByUid } from '../ap-myob-lookup'
import { recordPostedLineHistory, resolveLineAccount } from '../ap-line-resolver'
import { XeroAdapter } from './xero-adapter'

/** Same shape as postFoundInvoiceToMyob's args (companyFile included —
 *  existing call sites pass one object). The leading companyFile parameter
 *  is authoritative for provider resolution and is spread over args on the
 *  MYOB delegate so the two can never disagree. */
export type PostApInvoiceArgs = Parameters<typeof postFoundInvoiceToMyob>[0]

const GST_RATE = 0.10
// Mirrors MAX_LINE_NUDGE in lib/ap-myob-bill.ts — the most we'll silently
// absorb by nudging the largest line so the line sum matches the stated
// invoice total. Beyond this is a genuine extraction discrepancy.
const MAX_LINE_NUDGE = 1.00

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function postApInvoice(
  companyFile: CompanyFileLabel,
  args: PostApInvoiceArgs,
): Promise<FoundInvoicePostResult> {
  const provider = await accountingProvider(companyFile, 'AP')

  if (provider !== 'xero') {
    // MYOB (the default) — straight delegation, result returned unchanged.
    return postFoundInvoiceToMyob({ ...args, companyFile })
  }

  return postFoundInvoiceToXero(companyFile, args)
}

// ── Xero translation ────────────────────────────────────────────────────
//
// Mirrors postFoundInvoiceToMyob step for step:
//   1. Confidence gates (identical wording — ap-statement-resolve retries on
//      /sum|total|nudge|cannot post/i, so the reconciliation-failure reason
//      must keep saying "Cannot post: … sum to … total …").
//   2. Working-line synthesis when the invoice carried no line detail.
//   3. Per-line coding: override → rule/strong-history → dominant weak
//      history → supplier-card default → AP_FALLBACK_EXPENSE_ACCOUNT.
//      Coding stays MYOB-KEYED during the migration (rules/history/supplier
//      cards all live against MYOB uids) — the resulting MYOB account
//      DisplayIDs are then resolved to Xero codes via xero_account_map.
//      Any unmapped account → posted:false (never guess an account).
//   4. Contact: xero_contact_map first; else find-by-name in Xero (mapping
//      row inserted); else create the contact (mapping row inserted).
//   5. Inclusive line build + largest-line cent nudge to the stated total,
//      then adapter.createBill (which duplicate-adopts on reference+total,
//      the counterpart of MYOB smart-adopt) with the PDF attached
//      best-effort.
//   6. Line→account history recorded (MYOB-keyed) so smart coding keeps
//      learning across the pilot.

async function postFoundInvoiceToXero(
  companyFile: CompanyFileLabel,
  args: PostApInvoiceArgs,
): Promise<FoundInvoicePostResult> {
  const c = sb()
  const { supplierUid, supplierName, extracted, statementAmount } = args
  const invoiceNumber = extracted.invoiceNumber
  const isCredit = extracted.isCreditNote === true
  const totalRaw = extracted.totals.totalIncGst
  const total = totalRaw == null ? null : Math.abs(totalRaw)

  // ── Confidence gates (identical to the MYOB path) ──
  if (!invoiceNumber) return { posted: false, reason: 'no invoice number parsed' }
  if (!extracted.invoiceDate) return { posted: false, reason: 'no invoice date parsed' }
  if (total == null) return { posted: false, reason: 'no invoice total parsed' }
  if (!(total > 0)) return { posted: false, reason: `invoice total is ${total} — refusing to auto-post a zero-value bill` }
  if (totalRaw != null && totalRaw < 0 && !isCredit) return { posted: false, reason: `negative total ($${totalRaw.toFixed(2)}) but not marked as a credit note — enter manually` }
  if (extracted.parseConfidence === 'low' && !args.acceptLowConfidence) return { posted: false, reason: 'low parse confidence' }
  if (statementAmount != null && Math.abs(Math.abs(statementAmount) - total) > 0.05) {
    return { posted: false, reason: `amount mismatch (statement $${Math.abs(statementAmount).toFixed(2)} vs invoice $${total.toFixed(2)})` }
  }

  // ── Xero-side gate: credit notes not translated yet ──
  if (isCredit) {
    return { posted: false, reason: 'not yet supported on xero: supplier credit notes (need ACCPAYCREDIT with duplicate-adopt) — enter manually' }
  }

  // ── Working line list (synthesise one line if the invoice had no detail) ──
  interface WLine { description: string; lineTotalExGst: number; taxCode: string; partNumber: string | null }
  const rawLines = extracted.lineItems || []
  let wlines: WLine[]
  if (rawLines.length > 0) {
    wlines = rawLines.map(li => ({
      description: [li.partNumber, li.description].filter(Boolean).join(' — ') || 'AP line',
      lineTotalExGst: li.lineTotalExGst ?? 0,
      taxCode: li.taxCode || 'GST',
      partNumber: li.partNumber,
    }))
  } else {
    const subRaw = extracted.totals.subtotalExGst ?? round2(total / (1 + GST_RATE))
    wlines = [{ description: `Invoice ${invoiceNumber}`, lineTotalExGst: Math.abs(subRaw), taxCode: 'GST', partNumber: null }]
  }

  // Neutral tax codes only — the MYOB path throws on anything else; mirror.
  for (const l of wlines) {
    const code = (l.taxCode || 'GST').toUpperCase()
    if (code !== 'GST' && code !== 'FRE') {
      return { posted: false, reason: `Unsupported tax code "${code}" — supported: GST, FRE` }
    }
  }

  // ── Coding: per line, same precedence as the MYOB path ──
  const supplier = await getSupplierByUid(companyFile, supplierUid).catch(() => null)
  const defaultAcc = supplier?.defaultExpenseAccount?.uid || null
  const defaultDisplay = supplier?.defaultExpenseAccount?.displayId || null
  const defaultName = supplier?.defaultExpenseAccount?.name || 'supplier default'

  // uid → MYOB DisplayID via the accounts cache (rules/history/overrides
  // carry uids; the Xero map is keyed by DisplayID).
  const displayCache = new Map<string, string | null>()
  async function displayForUid(uid: string): Promise<string | null> {
    if (displayCache.has(uid)) return displayCache.get(uid) || null
    const { data } = await c.from('myob_accounts_cache')
      .select('display_id')
      .eq('myob_company_file', companyFile).eq('uid', uid).maybeSingle()
    const display = data?.display_id ? String(data.display_id) : null
    displayCache.set(uid, display)
    return display
  }

  let fallbackAcc: { uid: string; name: string; display: string } | null = null
  async function fallbackAccount(): Promise<{ uid: string; name: string; display: string } | null> {
    if (fallbackAcc) return fallbackAcc
    const displayId = (process.env.AP_FALLBACK_EXPENSE_ACCOUNT || '5-1000').trim()
    if (!displayId) return null
    const { data } = await c.from('myob_accounts_cache')
      .select('uid, display_id, name')
      .eq('myob_company_file', companyFile).eq('display_id', displayId).maybeSingle()
    if (data?.uid) fallbackAcc = { uid: data.uid, name: `${data.display_id} ${data.name || ''}`.trim(), display: String(data.display_id) }
    return fallbackAcc
  }

  interface CodedLine { uid: string; name: string; display: string | null }
  const coded: CodedLine[] = []
  let usedSmart = false
  const override = args.accountUidOverride || null
  for (const l of wlines) {
    if (override) {
      coded.push({ uid: override.uid, name: override.name, display: await displayForUid(override.uid) })
      usedSmart = true
      continue
    }
    const r = await resolveLineAccount(c, {
      supplier_uid: supplierUid, myob_company_file: companyFile,
      description: l.description, part_number: l.partNumber,
      attachment_name: args.pdfFilename || null,
    })
    // Same dominance rule as the MYOB path: weak history must be ≥80% agreed.
    let pick: CodedLine | null = null
    if (r.account_uid) {
      pick = { uid: r.account_uid, name: r.account_name || 'account', display: r.account_code || null }
    } else if (r.suggested_account_uid) {
      const dominant = r.source !== 'history-weak'
        || !r.history_total_count
        || (r.history_bill_count || 0) / r.history_total_count >= 0.8
      if (dominant) pick = { uid: r.suggested_account_uid, name: r.suggested_account_name || 'account', display: r.suggested_account_code || null }
    }
    if (pick) {
      if (!pick.display) pick.display = await displayForUid(pick.uid)
      coded.push(pick)
      usedSmart = true
    } else if (defaultAcc) {
      coded.push({ uid: defaultAcc, name: defaultName, display: defaultDisplay || await displayForUid(defaultAcc) })
    } else {
      const fb = await fallbackAccount()
      if (!fb) return { posted: false, reason: `line "${l.description.slice(0, 40)}" couldn't be coded and the supplier card has no default account` }
      coded.push({ uid: fb.uid, name: `${fb.name} (fallback)`, display: fb.display })
    }
  }
  const coding: 'supplier-default' | 'smart-lines' = usedSmart ? 'smart-lines' : 'supplier-default'
  const counts = new Map<string, number>()
  for (const cl of coded) counts.set(cl.name, (counts.get(cl.name) || 0) + 1)
  const codingDetail = Array.from(counts.entries()).map(([n, ct]) => (ct > 1 ? `${n} ×${ct}` : n)).join(', ')

  // Every coded line needs a MYOB DisplayID before it can map to Xero.
  const noDisplay = coded.find(cl => !cl.display)
  if (noDisplay) {
    return { posted: false, reason: `couldn't resolve a MYOB account DisplayID for "${noDisplay.name}" (uid ${noDisplay.uid.slice(0, 8)}…) — myob_accounts_cache may be stale` }
  }

  // ── MYOB DisplayID → Xero account code via xero_account_map ──
  const wantedDisplays = Array.from(new Set(coded.map(cl => cl.display as string)))
  const { data: mapRows, error: mapErr } = await c.from('xero_account_map')
    .select('myob_display_id, xero_account_code')
    .eq('entity', companyFile).in('myob_display_id', wantedDisplays)
  if (mapErr) return { posted: false, reason: `xero_account_map lookup failed: ${mapErr.message}` }
  const accountMap = new Map<string, string>()
  for (const row of mapRows || []) accountMap.set(String(row.myob_display_id), String(row.xero_account_code))
  const missing = wantedDisplays.filter(d => !accountMap.get(d))
  if (missing.length > 0) {
    return { posted: false, reason: `xero account mapping missing: ${missing.join(', ')}` }
  }

  // ── Contact: xero_contact_map → find by name → create (map either way) ──
  const adapter = new XeroAdapter(companyFile)
  let contactId: string | null = null
  {
    const { data: cm, error: cmErr } = await c.from('xero_contact_map')
      .select('xero_contact_id')
      .eq('entity', companyFile).eq('myob_uid', supplierUid).maybeSingle()
    if (cmErr) return { posted: false, reason: `xero_contact_map lookup failed: ${cmErr.message}` }
    contactId = cm?.xero_contact_id || null
  }
  if (!contactId) {
    const name = supplierName || supplier?.name || null
    if (!name) return { posted: false, reason: 'supplier has no name on record — cannot find/create the Xero contact' }
    try {
      const found = await adapter.findContact({ kind: 'supplier', name, ...(supplier?.abn ? { abn: supplier.abn } : {}) })
      if (found) {
        contactId = found.id
      } else {
        const created = await adapter.createContact({
          kind: 'supplier', name,
          ...(supplier?.abn ? { abn: supplier.abn } : {}),
          ...(supplier?.email ? { email: supplier.email } : {}),
        })
        contactId = created.id
      }
    } catch (e: any) {
      return { posted: false, reason: `Xero contact resolve failed: ${(e?.message || String(e)).slice(0, 200)}` }
    }
    // Record the mapping so re-posts hit the same Xero contact. Best-effort —
    // the bill can still post if the mapping write fails.
    try {
      const { error: upErr } = await c.from('xero_contact_map').upsert(
        { entity: companyFile, myob_uid: supplierUid, xero_contact_id: contactId, contact_name: name },
        { onConflict: 'entity,myob_uid' },
      )
      if (upErr) console.error(`[post-ap-invoice] xero_contact_map upsert failed for ${supplierUid}: ${upErr.message}`)
    } catch (e: any) {
      console.error(`[post-ap-invoice] xero_contact_map upsert failed for ${supplierUid}: ${e?.message || e}`)
    }
  }

  // ── Inclusive line build + largest-line cent nudge (mirrors the MYOB
  //    tax-inclusive path so the bill total matches the invoice to the cent) ──
  interface XLine { description: string; amount: number; accountCode: string; taxType: string }
  const xlines: XLine[] = wlines.map((l, i) => {
    const rate = (l.taxCode || 'GST').toUpperCase() === 'FRE' ? 0 : GST_RATE
    return {
      description: l.description,
      amount: round2(Number(l.lineTotalExGst || 0) * (1 + rate)),
      accountCode: accountMap.get(coded[i].display as string) as string,
      taxType: (l.taxCode || 'GST').toUpperCase(),
    }
  })
  const headerTotal = round2(total)
  let lineSum = round2(xlines.reduce((s, l) => s + l.amount, 0))
  const delta = round2(headerTotal - lineSum)
  if (delta !== 0) {
    if (Math.abs(delta) > MAX_LINE_NUDGE) {
      // Wording matters: ap-statement-resolve retries collapsed-to-total on
      // /sum|total|nudge|cannot post/i.
      return { posted: false, reason: `Cannot post: inc-GST line items sum to $${lineSum.toFixed(2)} but invoice total is $${headerTotal.toFixed(2)} (delta $${delta.toFixed(2)}).` }
    }
    let maxIdx = 0
    for (let i = 1; i < xlines.length; i++) if (Math.abs(xlines[i].amount) > Math.abs(xlines[maxIdx].amount)) maxIdx = i
    xlines[maxIdx].amount = round2(xlines[maxIdx].amount + delta)
    lineSum = round2(xlines.reduce((s, l) => s + l.amount, 0))
    console.log(`AP xero:${invoiceNumber}: nudged line ${maxIdx} by ${delta.toFixed(2)} — line sum now ${lineSum.toFixed(2)} matches invoice total ${headerTotal.toFixed(2)}`)
  }

  // ── Post (createBill duplicate-adopts on reference + total ±5c, then
  //    attaches the PDF best-effort — both mirror the MYOB path) ──
  let result: { id: string; reference: string; adopted?: boolean }
  try {
    result = await adapter.createBill({
      contactId,
      reference: String(invoiceNumber),
      dateIso: extracted.invoiceDate,
      lines: xlines,
      attachment: { name: args.pdfFilename, bytes: args.pdfBytes },
    })
  } catch (e: any) {
    return { posted: false, reason: `Xero post error: ${(e?.message || String(e)).slice(0, 200)}` }
  }

  if (result.adopted) {
    return { posted: true, billUid: result.id, adopted: true, adoptedBillNumber: result.reference || null, coding, codingDetail }
  }

  // Learn line→account history (MYOB-keyed) so smart coding keeps improving
  // through the pilot. Best-effort, same as the MYOB path.
  try {
    await recordPostedLineHistory(c, {
      supplier_uid: supplierUid,
      supplier_name: supplierName,
      myob_company_file: companyFile,
      lines: wlines.map((l, i) => ({ description: l.description, account_uid: coded[i].uid, account_code: coded[i].display || '', account_name: coded[i].name })).filter(l => l.account_uid && l.description),
    })
  } catch (e: any) { console.error(`[post-ap-invoice] recordPostedLineHistory failed: ${e?.message || e}`) }

  // NOTE: billUid carries the Xero InvoiceID here — provider-native opaque id
  // (callers persist it into their existing *bill_uid columns; the provider
  // switch records which side minted it by virtue of the AP module setting).
  return { posted: true, billUid: result.id, adopted: false, coding, codingDetail }
}
