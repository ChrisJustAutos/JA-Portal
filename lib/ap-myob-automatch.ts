// lib/ap-myob-automatch.ts
// Auto-match a parsed AP invoice's vendor against MYOB suppliers.
//
// Strategy (in order of confidence):
//   1. ABN exact match  — deterministic. If the parsed invoice has an ABN
//      and any MYOB supplier card has the same ABN, we pick that supplier.
//   2. Name single-match — if exactly ONE supplier matches the parsed vendor
//      name (substring, case-insensitive), use it. Two or more = ambiguous,
//      bail out and let the user pick.
//
// If a supplier is matched, we also harvest the supplier's BuyingDetails
// .ExpenseAccount as the suggested default account. Most MYOB supplier cards
// have one — saves the user a click.
//
// Returns null when no confident match — caller falls back to the manual
// preset picker.

import { searchSuppliers, CompanyFileLabel, MyobSupplierLite } from './ap-myob-lookup'

export interface AutoMatchResult {
  matchedBy: 'abn' | 'name'
  supplier: MyobSupplierLite
}

const NAME_QUERY_TOKENS = 2  // search MYOB with the first N words of the vendor name

export async function tryAutoMatchSupplier(
  vendorName: string | null,
  abn: string | null,
  companyFile: CompanyFileLabel,
): Promise<AutoMatchResult | null> {
  // Build a search query that's likely to surface candidates without being
  // too narrow. MYOB's substringof is case-sensitive on some endpoints, so
  // we throw a few bites at it: empty query (top suppliers, only useful
  // with ABN match), then first-word query, then full name.
  const candidates = await collectCandidates(vendorName, companyFile)

  // ── 1. ABN match wins ──
  if (abn) {
    const abnDigits = abn.replace(/\D/g, '')
    if (abnDigits.length === 11) {
      const exact = candidates.find(c => c.abn === abnDigits)
      if (exact) return { matchedBy: 'abn', supplier: exact }
    }
  }

  // ── 2. Single-name match ──
  if (vendorName && vendorName.trim()) {
    const target = vendorName.toLowerCase().trim()
    const nameMatches = candidates.filter(c => {
      const nm = c.name.toLowerCase()
      return nm === target || nm.includes(target) || target.includes(nm)
    })
    if (nameMatches.length === 1) {
      return { matchedBy: 'name', supplier: nameMatches[0] }
    }
    // 2+ matches = ambiguous, intentionally skip
  }

  return null
}

/**
 * Collect candidate suppliers by trying multiple queries (full name,
 * first word, empty). De-duplicate by UID. Cap total candidates so we
 * don't pull the entire supplier book on every call.
 */
async function collectCandidates(
  vendorName: string | null,
  companyFile: CompanyFileLabel,
  cap: number = 80,
): Promise<MyobSupplierLite[]> {
  const seen = new Set<string>()
  const out: MyobSupplierLite[] = []

  const push = (rows: MyobSupplierLite[]) => {
    for (const r of rows) {
      if (seen.has(r.uid)) continue
      seen.add(r.uid)
      out.push(r)
      if (out.length >= cap) break
    }
  }

  // Try full name (or first N tokens) as a substring query
  const trimmed = (vendorName || '').trim()
  if (trimmed) {
    try {
      const tokens = trimmed.split(/\s+/).slice(0, NAME_QUERY_TOKENS).join(' ')
      push(await searchSuppliers(companyFile, tokens, 50))
    } catch (e: any) {
      console.error('automatch: name search failed:', e?.message)
    }
  }

  // First-word fallback (MYOB substringof is case-sensitive — capitalised
  // word often produces different results than lowercase)
  if (out.length < cap && trimmed) {
    const firstWord = trimmed.split(/\s+/)[0]
    if (firstWord && firstWord.length >= 2) {
      try {
        push(await searchSuppliers(companyFile, firstWord, 50))
      } catch (e: any) { /* ignore */ }
    }
  }

  return out
}
