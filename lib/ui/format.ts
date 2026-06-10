// lib/ui/format.ts
// Shared formatters — replaces the money()/fmtDate()/round2() copies that were
// re-declared across ~25 pages and libs. All client-safe (no env access).

// ── Numbers / currency ───────────────────────────────────────────────────

export const round2 = (n: number) => Math.round(n * 100) / 100

/** "$1,234.56" — the standard currency formatter (2dp, thousands separators). */
export const money = (n: any) =>
  `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "$1234.56" — plain 2dp, no separators (matches the older inline money()). */
export const money2 = (n: any) => `$${(Number(n) || 0).toFixed(2)}`

/** Abbreviated currency for KPI tiles: "$1.2M", "$45k", "$980". */
export const moneyAbbrev = (n: any) => {
  const v = Number(n) || 0
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`
  if (a >= 10_000) return `${sign}$${Math.round(a / 1000)}k`
  if (a >= 1_000) return `${sign}$${(a / 1000).toFixed(1)}k`
  return `${sign}$${Math.round(a)}`
}

export const fmtPct = (n: any, dp = 1) => `${(Number(n) || 0).toFixed(dp)}%`

// ── Dates (en-AU; Brisbane wall-clock comes from lib/workshop.ts helpers) ──

/** "5 Jun 26" — compact list-row date. */
export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

/** "5 Jun 2026" — full-year variant for headers/detail rows. */
export const fmtDateLong = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

/** "5 Jun, 14:32" — date + 24h time. */
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'

/** "YYYY-MM-DD" date (no time) rendered like fmtDateLong, anchored to Brisbane. */
export const fmtYmd = (ymd: string | null | undefined) =>
  ymd ? new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', year: 'numeric' }) : '—'

// ── CSV ──────────────────────────────────────────────────────────────────

/** RFC-4180-ish escape: quote when the value contains comma/quote/newline. */
export function csvEscape(v: any): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
