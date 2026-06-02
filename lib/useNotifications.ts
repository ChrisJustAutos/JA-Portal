// lib/useNotifications.ts
// Client hook polling /api/notifications/summary every 30s. Used by
// PortalTopBar, PortalSidebar and the home launcher so per-module unread
// badges (and the bell total) stay current on every page. refresh() lets
// the bell dropdown update counts immediately after marking read.

import { useCallback, useEffect, useState } from 'react'

export interface NotificationSummary {
  total: number                       // unread notifications (bell badge)
  byModule: Record<string, number>    // unread per module id (tile badges)
  messages: number                    // unread chat messages (Messages tile)
}

export interface NotificationRow {
  id: string
  module: string
  title: string
  body: string | null
  href: string | null
  created_at: string
  read_at: string | null
}

export function useNotificationSummary(enabled = true): {
  summary: NotificationSummary | null
  refresh: () => void
} {
  const [summary, setSummary] = useState<NotificationSummary | null>(null)

  const refresh = useCallback(() => {
    fetch('/api/notifications/summary')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setSummary(d) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!enabled) return
    refresh()
    const i = setInterval(refresh, 30000)
    return () => clearInterval(i)
  }, [enabled, refresh])

  return { summary, refresh }
}

// Relative timestamp for the bell dropdown ("2m", "3h", "4d").
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
