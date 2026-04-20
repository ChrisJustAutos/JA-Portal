// lib/dashboard/dates.ts
// Resolve a DateRangeKey (e.g. 'today', 'this_month') into concrete from/to
// dates in Brisbane time (UTC+10, no DST). All portal financial reporting
// uses AU FY July-June.

import { DateRangeKey } from './catalog'

// All returned dates are ISO YYYY-MM-DD (date only, no time component).
export interface DateRange {
  from: string
  to: string
}

// Brisbane is UTC+10 fixed. Get "today" in Brisbane as YYYY-MM-DD.
function brisbaneNow(): Date {
  const nowMs = Date.now()
  return new Date(nowMs + 10 * 60 * 60 * 1000)
}

function isoDate(d: Date): string {
  return d.toISOString().substring(0, 10)
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setUTCDate(r.getUTCDate() + days)
  return r
}

function startOfWeekMonday(d: Date): Date {
  // JS: Sunday=0, Monday=1. Shift so Monday=0.
  const r = new Date(d)
  const dow = r.getUTCDay()
  const shift = (dow + 6) % 7
  r.setUTCDate(r.getUTCDate() - shift)
  return r
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

function startOfFY(d: Date): Date {
  // AU FY runs July 1 → June 30. If month < 7, FY started prev calendar year.
  const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1
  return new Date(Date.UTC(y, 6, 1))
}

export function resolveDateRange(
  key: DateRangeKey,
  customFrom?: string,
  customTo?: string,
): DateRange {
  const now = brisbaneNow()
  const today = isoDate(now)

  switch (key) {
    case 'today':      return { from: today, to: today }
    case 'yesterday': {
      const y = isoDate(addDays(now, -1))
      return { from: y, to: y }
    }
    case 'this_week':  return { from: isoDate(startOfWeekMonday(now)), to: today }
    case 'this_month': return { from: isoDate(startOfMonth(now)), to: today }
    case 'this_fy':    return { from: isoDate(startOfFY(now)), to: today }
    case 'last_7':     return { from: isoDate(addDays(now, -6)), to: today }
    case 'last_30':    return { from: isoDate(addDays(now, -29)), to: today }
    case 'last_90':    return { from: isoDate(addDays(now, -89)), to: today }
    case 'all':        return { from: '2000-01-01', to: today }
    case 'custom':
      return {
        from: customFrom || today,
        to:   customTo   || today,
      }
  }
}

// Given a period, return the "previous" period of the same length for
// comparison widgets (yesterday, last_week, last_month, last_period).
export function resolveCompareRange(
  period: DateRange,
  compare: 'none'|'yesterday'|'last_week'|'last_month'|'last_period',
): DateRange | null {
  if (compare === 'none') return null
  const from = new Date(period.from + 'T00:00:00Z')
  const to   = new Date(period.to   + 'T00:00:00Z')
  const days = Math.round((to.getTime() - from.getTime()) / 86400000) + 1

  if (compare === 'yesterday') {
    // Shift one day back
    return { from: isoDate(addDays(from, -1)), to: isoDate(addDays(to, -1)) }
  }
  if (compare === 'last_week') {
    return { from: isoDate(addDays(from, -7)), to: isoDate(addDays(to, -7)) }
  }
  if (compare === 'last_month') {
    // Same day-range shifted by 30 days (rough but fine for trend)
    return { from: isoDate(addDays(from, -30)), to: isoDate(addDays(to, -30)) }
  }
  // last_period — shift back by the length of the current period
  return { from: isoDate(addDays(from, -days)), to: isoDate(addDays(to, -days)) }
}
