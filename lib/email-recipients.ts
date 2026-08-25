// lib/email-recipients.ts
//
// Turn whatever is sitting in an accounting system's "Email" field into a list
// of addresses a mail provider will accept.
//
// MYOB (and Xero) treat that field as free text, so a supplier or customer card
// routinely holds several addresses in one box:
//
//   "sales@example.com; accounts@example.com"
//   "sales@example.com, Bob <bob@example.com>"
//   "Sales Dept <sales@example.com>"
//   "sales@example.com (orders)"
//
// Resend needs ONE valid address per array entry and rejects the whole send
// otherwise, with:
//   422 validation_error — Invalid `to` field. The email address needs to
//   follow the `email@example.com` or `Name <email@example.com>` format.
//
// That is what killed the MPI AUTOMOTIVE drop-ship PO on 2026-08-25: the same
// supplier had received one fine on 6 August, then their MYOB card changed to a
// multi-address value and every PO email to them failed. The address was never
// wrong — the field just held more than one.
//
// Splitting on ; and , is safe here because neither is legal in the address
// part of an email, and a display name containing a comma ("Smith, Bob
// <bob@x.com>") still yields the address itself from the bracketed half.

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/

/**
 * Extract every usable address from a free-text email field.
 * Returns bare addresses (display names dropped), de-duplicated, order kept.
 * Never throws; an unusable value yields an empty array.
 */
export function parseEmailList(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const piece of String(raw).split(/[;,]/)) {
    let v = piece.trim()
    if (!v) continue
    // "Name <addr>" → addr. Also catches a bare "<addr>".
    const bracket = v.match(/<([^<>]+)>/)
    if (bracket) v = bracket[1].trim()
    // Trailing notes people add: "addr (orders)" / "addr - accounts"
    v = v.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+[-–].*$/, '').trim()
    // A leading display name with no brackets: "Sales sales@x.com"
    if (!EMAIL_RE.test(v) && /\s/.test(v)) {
      const last = v.split(/\s+/).pop() || ''
      if (EMAIL_RE.test(last)) v = last
    }
    if (!EMAIL_RE.test(v)) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

/** True when the field holds something but nothing usable came out of it. */
export function hasUnusableEmail(raw: string | null | undefined): boolean {
  return !!String(raw || '').trim() && parseEmailList(raw).length === 0
}
