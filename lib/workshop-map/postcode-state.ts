// lib/workshop-map/postcode-state.ts
// AU postcode → state. Map payload points carry only a postcode, so both the
// dashboard and the PDF export derive state from this one table — they used to
// hold separate copies, which is how a range fix reaches only one of them.
// Ranges are the standard allocations including the PO-box blocks.

export function pcState(pc: string): string {
  const n = parseInt(pc, 10)
  if (!Number.isFinite(n)) return '?'
  if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return 'ACT'
  if ((n >= 1000 && n <= 2599) || (n >= 2619 && n <= 2899) || (n >= 2921 && n <= 2999)) return 'NSW'
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return 'VIC'
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return 'QLD'
  if (n >= 5000 && n <= 5999) return 'SA'
  if (n >= 6000 && n <= 6999) return 'WA'
  if (n >= 7000 && n <= 7999) return 'TAS'
  if (n >= 800 && n <= 999) return 'NT'
  return '?'
}
