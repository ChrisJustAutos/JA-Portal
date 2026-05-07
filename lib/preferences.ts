// lib/preferences.ts
// User preferences: types, defaults, formatters, and a React hook/provider.
//
// The `usePreferences()` hook is the canonical way for any component to read
// the current user's preferences and format currency/dates accordingly. It
// fetches from /api/preferences on mount and updates in real-time when the
// user changes settings via the General tab.
//
// All backend $ values are ex-GST (source of truth after the GST calc fix).
// When the user's pref is 'inc', we multiply by 1.1 at DISPLAY time only.
// This keeps the data layer clean and auditable.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode, createElement } from 'react'

// ── Types ────────────────────────────────────────────────────────────────

export type GstDisplay = 'inc' | 'ex'
export type Theme = 'dark' | 'light' | 'auto'
export type AccentColor = 'blue' | 'green' | 'purple' | 'amber' | 'teal'
export type ThemePreset = 'midnight' | 'ocean' | 'forest' | 'slate'
export type DateRangeKey =
  | 'this_month' | 'last_month'
  | 'this_quarter'
  | 'this_fy' | 'last_fy'
  | 'ytd'
  | 'custom'

export interface NavGroup {
  id: string
  name: string
  collapsed: boolean
  item_ids: string[]
}

export interface UserPreferences {
  gst_display: GstDisplay
  default_date_range: DateRangeKey
  auto_refresh_seconds: 0 | 300 | 900 | 3600
  timezone: string
  decimal_precision: 0 | 2
  locale: string
  theme: Theme
  accent_color: AccentColor
  theme_preset: ThemePreset
  company_logo_url: string | null
  nav_groups: NavGroup[]
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  gst_display: 'ex',
  default_date_range: 'this_month',
  auto_refresh_seconds: 0,
  timezone: 'Australia/Brisbane',
  decimal_precision: 0,
  locale: 'en-AU',
  theme: 'dark',
  accent_color: 'blue',
  theme_preset: 'midnight',
  company_logo_url: null,
  nav_groups: [],
}

// Hex values for each accent option (used both for swatches in the picker and
// for CSS variable injection at the document root).
export const ACCENT_HEX: Record<AccentColor, string> = {
  blue:   '#4f8ef7',
  green:  '#34c77b',
  purple: '#a78bfa',
  amber:  '#f5a623',
  teal:   '#2dd4bf',
}

export const ACCENT_LABELS: Record<AccentColor, string> = {
  blue:   'Blue',
  green:  'Green',
  purple: 'Purple',
  amber:  'Amber',
  teal:   'Teal',
}

// Named full-theme presets. Each pairs a background tone with a default accent
// so the picker can switch the whole look in one click.
export interface ThemePresetSpec {
  label: string
  description: string
  bg: string          // page background
  bg2: string         // panel background
  accent: AccentColor // default accent for the preset
}

export const THEME_PRESETS: Record<ThemePreset, ThemePresetSpec> = {
  midnight: { label: 'Midnight', description: 'Default — near-black with blue accents.',  bg: '#0d0f12', bg2: '#131519', accent: 'blue' },
  ocean:    { label: 'Ocean',    description: 'Cool deep-blue panels with teal accents.', bg: '#0a1220', bg2: '#101a2c', accent: 'teal' },
  forest:   { label: 'Forest',   description: 'Muted green-black with green accents.',    bg: '#0c130d', bg2: '#121a14', accent: 'green' },
  slate:    { label: 'Slate',    description: 'Warm slate with purple accents.',          bg: '#11141a', bg2: '#181c25', accent: 'purple' },
}

// Human labels for UI (alphabetical locale list kept short; extend if needed)
export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = {
  this_month:   'This month',
  last_month:   'Last month',
  this_quarter: 'This quarter',
  this_fy:      'This financial year',
  last_fy:      'Last financial year',
  ytd:          'Year-to-date (calendar)',
  custom:       'Custom (remember last used)',
}

export const REFRESH_LABELS: Record<number, string> = {
  0:    'Off',
  300:  'Every 5 minutes',
  900:  'Every 15 minutes',
  3600: 'Every hour',
}

export const TIMEZONE_OPTIONS = [
  'Australia/Brisbane',   // QLD (no DST)
  'Australia/Sydney',     // NSW/VIC/TAS/ACT (with DST)
  'Australia/Adelaide',   // SA (with DST, +30min offset)
  'Australia/Perth',      // WA (no DST)
  'Australia/Darwin',     // NT (no DST, +30min offset)
  'Australia/Hobart',     // TAS (explicit)
  'UTC',
]

export const LOCALE_OPTIONS = [
  { value: 'en-AU', label: 'English (Australia) — $51,233' },
  { value: 'en-US', label: 'English (United States) — $51,233' },
  { value: 'en-GB', label: 'English (United Kingdom) — $51,233' },
  { value: 'en-NZ', label: 'English (New Zealand) — $51,233' },
]

// ── Currency / date formatters (the critical bit) ───────────────────────

// Apply GST display preference to an ex-GST backend value.
// When pref is 'inc', we gross up by 10%. When 'ex', return as-is.
export function applyGstDisplay(amountExGst: number, pref: GstDisplay): number {
  if (pref === 'inc') return amountExGst * 1.1
  return amountExGst
}

// Format a currency amount respecting user preferences.
// IMPORTANT: Pass ex-GST values in. The formatter applies inc-GST multiplier
// only at display time.
export interface CurrencyFormatOptions {
  compact?: boolean           // e.g. $51k instead of $51,233
  showGstLabel?: boolean      // append " ex-GST" or " inc-GST" to output
  forcePrecision?: 0 | 2      // override user's decimal_precision pref
}

export function formatCurrency(
  amountExGst: number | null | undefined,
  prefs: UserPreferences,
  opts: CurrencyFormatOptions = {},
): string {
  if (amountExGst == null || isNaN(amountExGst)) return '$0'
  const displayValue = applyGstDisplay(amountExGst, prefs.gst_display)
  const precision = opts.forcePrecision ?? prefs.decimal_precision

  let formatted: string
  if (opts.compact) {
    // Compact form for tight spaces: $1.23M / $51k / $512
    if (Math.abs(displayValue) >= 1e6) {
      formatted = '$' + (displayValue / 1e6).toFixed(2) + 'M'
    } else if (Math.abs(displayValue) >= 1000) {
      formatted = '$' + Math.round(displayValue / 1000).toLocaleString(prefs.locale) + 'k'
    } else {
      formatted = '$' + Math.round(displayValue).toLocaleString(prefs.locale)
    }
  } else {
    formatted = new Intl.NumberFormat(prefs.locale, {
      style: 'currency',
      currency: 'AUD',  // hardcoded — extend later if multi-currency needed
      currencyDisplay: 'symbol',
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(displayValue)
  }

  if (opts.showGstLabel) {
    formatted += prefs.gst_display === 'inc' ? ' inc-GST' : ' ex-GST'
  }

  return formatted
}

// Format a date respecting user preferences (timezone + locale).
export function formatDate(
  iso: string | Date | null | undefined,
  prefs: UserPreferences,
  opts: { includeTime?: boolean; compact?: boolean } = {},
): string {
  if (!iso) return '—'
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (isNaN(d.getTime())) return '—'

  const base: Intl.DateTimeFormatOptions = {
    timeZone: prefs.timezone,
    day: '2-digit',
    month: opts.compact ? 'short' : 'short',
    year: opts.compact ? '2-digit' : 'numeric',
  }
  if (opts.includeTime) {
    base.hour = '2-digit'
    base.minute = '2-digit'
    base.hour12 = false
  }
  return new Intl.DateTimeFormat(prefs.locale, base).format(d)
}

// Compute the actual start/end dates for a DateRangeKey relative to `now`.
// Assumes Australian financial year (July 1 – June 30). Returns ISO date strings
// (YYYY-MM-DD) for use in SQL queries.
export function computeDateRange(key: DateRangeKey, now: Date = new Date()): { startDate: string; endDate: string } {
  const y = now.getFullYear()
  const m = now.getMonth() // 0-indexed
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  switch (key) {
    case 'this_month': {
      const start = new Date(y, m, 1)
      const end = new Date(y, m + 1, 0) // last day of month
      return { startDate: iso(start), endDate: iso(end) }
    }
    case 'last_month': {
      const start = new Date(y, m - 1, 1)
      const end = new Date(y, m, 0)
      return { startDate: iso(start), endDate: iso(end) }
    }
    case 'this_quarter': {
      const qStart = Math.floor(m / 3) * 3
      const start = new Date(y, qStart, 1)
      const end = new Date(y, qStart + 3, 0)
      return { startDate: iso(start), endDate: iso(end) }
    }
    case 'this_fy': {
      // AU FY: July 1 of (y if m>=6 else y-1) to June 30 of (y+1 if m>=6 else y)
      const fyStartYear = m >= 6 ? y : y - 1
      const start = new Date(fyStartYear, 6, 1)       // 1 July
      const end = new Date(fyStartYear + 1, 5, 30)    // 30 June
      return { startDate: iso(start), endDate: iso(end) }
    }
    case 'last_fy': {
      const fyStartYear = m >= 6 ? y - 1 : y - 2
      const start = new Date(fyStartYear, 6, 1)
      const end = new Date(fyStartYear + 1, 5, 30)
      return { startDate: iso(start), endDate: iso(end) }
    }
    case 'ytd': {
      // Calendar YTD: 1 Jan of current year to today
      const start = new Date(y, 0, 1)
      return { startDate: iso(start), endDate: iso(now) }
    }
    case 'custom':
    default:
      // Fallback to this_month so callers never get undefined
      return computeDateRange('this_month', now)
  }
}

// ── React hook + provider ────────────────────────────────────────────────

interface PreferencesContextValue {
  prefs: UserPreferences
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  update: (patch: Partial<UserPreferences>) => Promise<void>
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null)

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFERENCES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/preferences')
      if (!res.ok) {
        // 401 etc — silently fall back to defaults so public/login pages don't break
        setPrefs(DEFAULT_PREFERENCES)
        setError(null)
        return
      }
      const data = await res.json()
      if (data.preferences) setPrefs({ ...DEFAULT_PREFERENCES, ...data.preferences })
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load preferences')
      setPrefs(DEFAULT_PREFERENCES)
    } finally {
      setLoading(false)
    }
  }, [])

  const update = useCallback(async (patch: Partial<UserPreferences>) => {
    // Optimistic update
    setPrefs(cur => ({ ...cur, ...patch }))
    try {
      const res = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Save failed' }))
        throw new Error(err.error || 'Save failed')
      }
      const data = await res.json()
      if (data.preferences) setPrefs({ ...DEFAULT_PREFERENCES, ...data.preferences })
    } catch (e: any) {
      setError(e?.message || 'Could not save preferences')
      // Re-fetch to reset optimistic update on failure
      await refresh()
      throw e
    }
  }, [refresh])

  useEffect(() => { refresh() }, [refresh])

  const value = useMemo<PreferencesContextValue>(() => ({
    prefs, loading, error, refresh, update,
  }), [prefs, loading, error, refresh, update])

  return createElement(PreferencesContext.Provider, { value }, children)
}

export function usePreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext)
  if (!ctx) {
    // Fallback — if a component uses the hook without a provider, return defaults
    // rather than throwing. Keeps pages functional during SSR and progressive enhancement.
    return {
      prefs: DEFAULT_PREFERENCES,
      loading: false,
      error: null,
      refresh: async () => {},
      update: async () => {},
    }
  }
  return ctx
}

// Convenience: format currency with current prefs, without extracting from hook.
// Useful in tight loops where a component already has prefs in scope.
export function makeCurrencyFormatter(prefs: UserPreferences, opts: CurrencyFormatOptions = {}) {
  return (amountExGst: number | null | undefined) => formatCurrency(amountExGst, prefs, opts)
}

// ── API response post-processing ────────────────────────────────────────
// Apply the user's gst_display preference to an API response by walking the
// object tree. Works with:
//   - CData-style wrapped results: { results: [{ schema: [{columnName}], rows: [[...]] }] }
//   - Flat objects with TotalAmountExGst / BalanceDueExGst / totalAmountExGst fields
//
// When pref is 'inc', multiplies the ex-GST fields by 1.1. When 'ex', leaves as-is.
// This is the cleanest way to make pages GST-aware without touching every $
// display call site: the hook post-processes the response before the UI reads it.

const EX_GST_FIELDS = new Set([
  'TotalAmountExGst', 'BalanceDueExGst', 'SubtotalExGst',
  'TotalExGst', 'UnitPriceExGst',
  'totalAmountExGst', 'balanceDueExGst', 'subtotalExGst',
  'amountExGst', 'totalRevenueExGst', 'TotalRevenue',
])

// When pref is 'inc' we also multiply the raw inc-GST mirror fields BACK so
// they end up showing correctly — but because those are already inc-GST,
// leave them as-is. The safest approach: replace the display field entirely.

export function applyGstPreferenceToRows(
  rows: any[],
  pref: GstDisplay,
): any[] {
  if (!rows || rows.length === 0) return rows
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row
    const copy: any = { ...row }
    // If row has ex-GST fields, overlay onto the display-canonical fields.
    // After this, TotalAmount will always hold the user's preferred view.
    if ('TotalAmountExGst' in copy) {
      copy.TotalAmount = applyGstDisplay(Number(copy.TotalAmountExGst) || 0, pref)
    }
    if ('BalanceDueExGst' in copy && copy.BalanceDueExGst != null) {
      copy.BalanceDueAmount = applyGstDisplay(Number(copy.BalanceDueExGst) || 0, pref)
    }
    if ('SubtotalExGst' in copy) {
      copy.Subtotal = applyGstDisplay(Number(copy.SubtotalExGst) || 0, pref)
    }
    if ('TotalExGst' in copy) {
      copy.Total = applyGstDisplay(Number(copy.TotalExGst) || 0, pref)
    }
    if ('UnitPriceExGst' in copy) {
      copy.UnitPrice = applyGstDisplay(Number(copy.UnitPriceExGst) || 0, pref)
    }
    // Camel-case variants (quotes-orders.ts)
    if ('totalAmountExGst' in copy) {
      copy.totalAmount = applyGstDisplay(Number(copy.totalAmountExGst) || 0, pref)
    }
    if ('balanceDueExGst' in copy && copy.balanceDueExGst != null) {
      copy.balanceDueAmount = applyGstDisplay(Number(copy.balanceDueExGst) || 0, pref)
    }
    return copy
  })
}

// Process a CData-wrapped { results: [{ schema, rows }] } object.
// Returns a NEW object with rows converted to objects-with-GST-applied,
// and schema rebuilt to include the canonical display fields.
export function applyGstPreferenceToCDataWrap(wrap: any, pref: GstDisplay): any {
  if (!wrap?.results?.[0]) return wrap
  const result = wrap.results[0]
  const cols: string[] = (result.schema || []).map((c: any) => c.columnName)
  const rawRows: any[][] = result.rows || []

  // Convert to objects
  const objectRows = rawRows.map(r => {
    const o: any = {}
    cols.forEach((c, i) => { o[c] = r[i] })
    return o
  })

  // Apply GST preference
  const gstRows = applyGstPreferenceToRows(objectRows, pref)

  // Also normalise TotalRevenue (top-customer rows come pre-computed ex-GST
  // from the backend — multiply by 1.1 for inc view).
  const finalRows = gstRows.map(o => {
    const copy = { ...o }
    if ('TotalRevenue' in copy) {
      copy.TotalRevenue = applyGstDisplay(Number(copy.TotalRevenue) || 0, pref)
    }
    return copy
  })

  // Re-wrap back into CData shape so downstream code is unchanged
  return {
    results: [{
      schema: result.schema,
      rows: finalRows.map(o => cols.map(c => o[c])),
    }],
  }
}

// Walk an entire dashboard response and apply the user's GST pref everywhere.
// This is the single call a page makes after fetching /api/dashboard.
export function applyGstPreferenceToDashboard(data: any, pref: GstDisplay): any {
  if (!data) return data
  if (data.amountsAreExGst !== true) return data  // old-format response — don't touch

  const processed = { ...data }
  for (const company of ['jaws', 'vps']) {
    if (!processed[company]) continue
    processed[company] = { ...processed[company] }
    for (const key of ['recentInvoices', 'openInvoices', 'topCustomers', 'openBills']) {
      if (processed[company][key]) {
        processed[company][key] = applyGstPreferenceToCDataWrap(processed[company][key], pref)
      }
    }
  }
  return processed
}

// Apply GST pref to a quotes-orders response (camelCase style)
export function applyGstPreferenceToQuotesOrders(data: any, pref: GstDisplay): any {
  if (!data || data.amountsAreExGst !== true) return data
  const processed = { ...data }
  if (Array.isArray(processed.openOrders)) processed.openOrders = applyGstPreferenceToRows(processed.openOrders, pref)
  if (Array.isArray(processed.convertedOrders)) processed.convertedOrders = applyGstPreferenceToRows(processed.convertedOrders, pref)
  if (Array.isArray(processed.quotes)) processed.quotes = applyGstPreferenceToRows(processed.quotes, pref)
  if (processed.totals && typeof processed.totals === 'object') {
    processed.totals = {
      ...processed.totals,
      openOrdersTotal: applyGstDisplay(Number(processed.totals.openOrdersTotal) || 0, pref),
      openOrdersOwing: applyGstDisplay(Number(processed.totals.openOrdersOwing) || 0, pref),
      convertedTotal30d: applyGstDisplay(Number(processed.totals.convertedTotal30d) || 0, pref),
      quotesTotal: applyGstDisplay(Number(processed.totals.quotesTotal) || 0, pref),
    }
  }
  return processed
}

// Apply GST pref to an invoice-detail response
export function applyGstPreferenceToInvoiceDetail(data: any, pref: GstDisplay): any {
  if (!data || data.amountsAreExGst !== true) return data
  const processed = { ...data }
  if (processed.invoice) {
    processed.invoice = applyGstPreferenceToRows([processed.invoice], pref)[0]
  }
  if (Array.isArray(processed.lineItems)) {
    processed.lineItems = applyGstPreferenceToRows(processed.lineItems, pref)
  }
  return processed
}

