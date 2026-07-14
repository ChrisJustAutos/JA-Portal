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

// Punctuation/space-insensitive form: "A-OK Security" → "aoksecurity". Cards
// are often entered without the punctuation the invoice uses ("AOK").
const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export async function tryAutoMatchSupplier(
  vendorName: string | null,
  abn: string | null,
  companyFile: CompanyFileLabel,
  searchFn: typeof searchSuppliers = searchSuppliers,  // injectable for tests
): Promise<AutoMatchResult | null> {
  // Build a search query that's likely to surface candidates without being
  // too narrow. MYOB's substringof is case-sensitive on some endpoints, so
  // we throw a few bites at it: empty query (top suppliers, only useful
  // with ABN match), then first-word query, then full name.
  const candidates = await collectCandidates(vendorName, companyFile, 80, searchFn)

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
    const targetNorm = normalizeName(vendorName)
    const nameMatches = candidates.filter(c => {
      const nm = c.name.toLowerCase()
      if (nm === target || nm.includes(target) || target.includes(nm)) return true
      // Punctuation-insensitive fallback ("A-OK Security" vs card "AOK").
      // Prefix-only — a short card name must start the vendor name (or vice
      // versa), so it can't match inside an unrelated longer word. Min 3 chars
      // keeps single-letter cards from matching everything.
      const cardNorm = normalizeName(c.name)
      if (cardNorm.length < 3 || targetNorm.length < 3) return false
      return cardNorm.startsWith(targetNorm) || targetNorm.startsWith(cardNorm)
    })
    if (nameMatches.length === 1) {
      return { matchedBy: 'name', supplier: nameMatches[0] }
    }
    if (nameMatches.length > 1) {
      // Tie-breakers before declaring ambiguity:
      // 1. A card whose name EXACTLY equals the vendor name (normalized) wins.
      const exact = nameMatches.filter(c => normalizeName(c.name) === targetNorm)
      if (exact.length === 1) return { matchedBy: 'name', supplier: exact[0] }
      // 2. Among cards that PREFIX the vendor name, the most specific
      //    (longest) unique one wins — resolves supplier families like
      //    "Digital Nomads" vs "Digital Nomads HQ" for vendor
      //    "Digital Nomads HQ Pty Ltd". Cards the vendor name doesn't start
      //    with don't compete here.
      const prefixes = nameMatches.filter(c => {
        const n = normalizeName(c.name)
        return n.length >= 3 && targetNorm.startsWith(n)
      })
      if (prefixes.length) {
        const maxLen = Math.max(...prefixes.map(c => normalizeName(c.name).length))
        const longest = prefixes.filter(c => normalizeName(c.name).length === maxLen)
        if (longest.length === 1) return { matchedBy: 'name', supplier: longest[0] }
      }
      console.warn(`[automatch] ambiguous: "${vendorName}" matched ${nameMatches.length} cards: ${nameMatches.map(c => c.name).join(' | ')}`)
      return null
    }
    // 0 matches — log the candidate pool so misses are diagnosable from
    // runtime logs (names only, capped).
    console.warn(`[automatch] no match for "${vendorName}" among ${candidates.length} candidates: ${candidates.slice(0, 12).map(c => c.name).join(' | ')}`)
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
  searchFn: typeof searchSuppliers = searchSuppliers,
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
      push(await searchFn(companyFile, tokens, 50))
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
        push(await searchFn(companyFile, firstWord, 50))
      } catch (e: any) { /* ignore */ }
      // Punctuation-stripped bite: an invoice's "A-OK" never surfaces a card
      // entered as "AOK" via substring search — query the stripped form too.
      const stripped = firstWord.replace(/[^A-Za-z0-9]+/g, '')
      if (stripped && stripped !== firstWord && stripped.length >= 2) {
        try {
          push(await searchFn(companyFile, stripped, 50))
        } catch (e: any) { /* ignore */ }
      }
      // Reverse-drift bites: the stripped bite can't surface a card that has
      // MORE punctuation than the invoice — "Steves" never substring-matches
      // a card entered "Steve's". Two extra queries put such cards in the
      // pool (the normalized name match then does the precise comparison):
      //   a. a short prefix of the first word ("stev" hits both spellings)
      if (stripped.length >= 5) {
        try {
          push(await searchFn(companyFile, stripped.slice(0, 4), 50))
        } catch (e: any) { /* ignore */ }
      }
      //   b. the next distinctive word ("mobile") — catches drift anywhere
      //      in the first word, skipping generic company-suffix tokens
      const STOP_TOKENS = new Set(['pty', 'ltd', 'limited', 'the', 'and', 'group', 'aust', 'australia', 'trading'])
      const nextWord = trimmed.split(/\s+/).slice(1)
        .map(w => w.replace(/[^A-Za-z0-9]+/g, ''))
        .find(w => w.length >= 4 && !STOP_TOKENS.has(w.toLowerCase()))
      if (nextWord) {
        try {
          push(await searchFn(companyFile, nextWord, 50))
        } catch (e: any) { /* ignore */ }
      }
    }
  }

  return out
}
