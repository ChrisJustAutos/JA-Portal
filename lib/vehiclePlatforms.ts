// lib/vehiclePlatforms.ts
// Shared vehicle platform detection. Used by the Mechanics Desk job report
// parser (forecast) and the MYOB vehicle sales classifier (actuals).
//
// Two-stage matching:
//   1. Look for an explicit platform code (VDJ79, FJA300 etc) in any of the
//      provided text fields — typically a Mechanics Desk "Job Type" string or
//      a MYOB invoice-line Description.
//   2. Fall back to looser heuristics on the Vehicle text field ("Land Cruiser
//      300 SVX" → FJA300) which is only populated for jobs, not MYOB invoices.
//
// Order matters — the more specific patterns must come first so "VDJ200" isn't
// caught by the generic "VDJ" fallback.

export const PLATFORM_FROM_TEXT: { re: RegExp; label: string }[] = [
  { re: /\bVDJ200\b/i,   label: 'VDJ200' },
  { re: /\bVDJ79\b/i,    label: 'VDJ79'  },
  { re: /\bVDJ76\b/i,    label: 'VDJ76'  },
  { re: /\bVDJ70\*?/i,   label: 'VDJ70*' },
  { re: /\bFJA300\b/i,   label: 'FJA300' },
  { re: /\bFJA250\b/i,   label: 'FJA250' },
  { re: /\bGDJ250\b/i,   label: 'GDJ250' },
  { re: /\bGDJ79\b/i,    label: 'GDJ79'  },
  { re: /\bGDJ70\*?/i,   label: 'GDJ70*' },
  { re: /\b1GD\b/i,      label: 'Hilux 1GD' },
]

// Vehicle-text fallback. Matches model numbers in phrases like "Land Cruiser
// 79 BB" (requires letters after "79" to avoid catching rego plates like
// "DRS 76"). Only useful when you have the full vehicle description.
export const PLATFORM_FROM_VEHICLE: { re: RegExp; label: string }[] = [
  { re: /Land\s*Cruiser\s*300\b/i,     label: 'FJA300' },
  { re: /Land\s*Cruiser\s*250\b/i,     label: 'FJA250' },
  { re: /Land\s*Cruiser\s*200\b/i,     label: 'VDJ200' },
  { re: /Land\s*Cruiser\s*79\s+[A-Z]/i, label: 'VDJ79' },
  { re: /\bHilux\b/i,                  label: 'Hilux'  },
]

// Match against text fields in order. Returns the first platform code found,
// or null if none matched. Used where Vehicle fallback does not apply (MYOB
// invoice lines don't have a Vehicle field).
export function detectPlatformFromText(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue
    for (const p of PLATFORM_FROM_TEXT) {
      if (p.re.test(text)) return p.label
    }
  }
  return null
}

// Detection with Vehicle fallback — used by the job-report parser where the
// Vehicle column is available as a secondary signal.
export function detectPlatformWithVehicleFallback(
  primaryType: string | null | undefined,
  vehicleText: string | null | undefined,
): string | null {
  const fromType = detectPlatformFromText(primaryType)
  if (fromType) return fromType
  if (vehicleText) {
    for (const p of PLATFORM_FROM_VEHICLE) {
      if (p.re.test(vehicleText)) return p.label
    }
  }
  return null
}

// Given an array of text snippets (e.g. all line descriptions on an invoice),
// return the SET of distinct platforms mentioned. Used for invoice-level
// classification where a single invoice may legitimately touch one vehicle
// platform (so we pick that one) or multiple (we flag as Mixed).
export function detectAllPlatformsFromTexts(texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (!text) continue
    for (const p of PLATFORM_FROM_TEXT) {
      if (p.re.test(text)) found.add(p.label)
    }
  }
  return Array.from(found)
}
