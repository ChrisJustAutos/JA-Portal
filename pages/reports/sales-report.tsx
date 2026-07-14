// pages/reports/sales-report.tsx
// Reports → Sales Report — a LIVE Weekly Sales Recap. Order/booking figures
// (sections 1-3 + flags) are pulled fresh from Monday on every load via
// /api/reports/sales-recap/live; the workshop forecast + diary come from the
// last scrape and show an "as of" time. Toggle This week / Last week, refresh
// on demand, kick off a workshop-data refresh, or email the team now.
// The same report auto-emails Ryan/Matt/Chris every Monday 7am.

import Head from 'next/head'
import { useEffect, useState, useCallback } from 'react'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

type WeekMode = 'previous' | 'current'

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default function SalesReportPage({ user }: { user: PortalUserSSR }) {
  const [weekMode, setWeekMode] = useState<WeekMode>('previous')
  const [html, setHtml] = useState<string | null>(null)
  const [ordersAsOf, setOrdersAsOf] = useState<string | null>(null)
  const [workshopAsOf, setWorkshopAsOf] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'refresh' | 'send' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async (mode: WeekMode) => {
    setLoading(true); setErr(null)
    try {
      const r = await fetch(`/api/reports/sales-recap/live?week=${mode}`)
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setHtml(d.html)
      setOrdersAsOf(d.ordersAsOf || null)
      setWorkshopAsOf(d.workshopAsOf || null)
    } catch (e: any) {
      setErr(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(weekMode) }, [weekMode, load])

  async function runWorkshop(action: 'refresh' | 'send') {
    setBusy(action); setNote(null)
    try {
      const r = await fetch('/api/reports/sales-recap/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.detail || d.error || `HTTP ${r.status}`)
      setNote(action === 'send'
        ? 'Report is generating and will email Ryan, Matt & Chris in ~4 min. Refresh the order data below anytime.'
        : 'Workshop data refresh started (~4 min). Hit Refresh below once it finishes to pull the new forecast & diary.')
    } catch (e: any) {
      setNote(`Couldn’t start: ${String(e.message || e)}`)
    } finally {
      setBusy(null)
    }
  }

  const btn = (active: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? T.blue : T.border}`, background: active ? 'rgba(79,142,247,0.15)' : T.bg3,
    color: active ? T.blue : T.text2, whiteSpace: 'nowrap',
  })
  const actionBtn = (disabled: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
    border: `1px solid ${T.border}`, background: T.bg3, color: disabled ? T.text3 : T.text2, whiteSpace: 'nowrap', opacity: disabled ? 0.7 : 1,
  })

  return (
    <>
      <Head><title>Sales Report — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <ReportsTabs active="sales-report" role={user.role} />

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: T.text3, marginRight: 2 }}>Week</span>
          <button style={btn(weekMode === 'previous')} onClick={() => setWeekMode('previous')}>Last week</button>
          <button style={btn(weekMode === 'current')} onClick={() => setWeekMode('current')}>This week (to date)</button>

          <div style={{ width: 1, height: 20, background: T.border, margin: '0 4px' }} />

          <button style={actionBtn(loading)} disabled={loading} onClick={() => load(weekMode)}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          <button style={actionBtn(!!busy)} disabled={!!busy} onClick={() => runWorkshop('refresh')}>
            {busy === 'refresh' ? 'Starting…' : 'Update workshop data'}
          </button>
          <button style={actionBtn(!!busy)} disabled={!!busy} onClick={() => runWorkshop('send')}>
            {busy === 'send' ? 'Starting…' : 'Run & email team now'}
          </button>

          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: T.text3, textAlign: 'right' }}>
            Order data: {loading ? '…' : relTime(ordersAsOf)}<br />
            Workshop data: {workshopAsOf ? relTime(workshopAsOf) : 'not scraped yet'}
          </div>
        </div>

        {note && (
          <div style={{ padding: '8px 16px', background: 'rgba(79,142,247,0.1)', borderBottom: `1px solid ${T.border}`, color: T.text2, fontSize: 12, flexShrink: 0 }}>
            {note}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px' }}>
          {loading && !html && <div style={{ color: T.text3 }}>Loading live sales recap…</div>}
          {err && (
            <div style={{ maxWidth: 640, background: 'rgba(240,78,78,0.1)', border: '1px solid rgba(240,78,78,0.2)', borderRadius: 10, padding: 16, color: T.red }}>
              <div style={{ marginBottom: 10 }}>Couldn’t load report: {err}</div>
              <button onClick={() => load(weekMode)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
            </div>
          )}
          {html && (
            <div style={{ maxWidth: 860, margin: '0 auto', opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
              <div style={{ background: '#fff', borderRadius: 8, padding: 20 }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}
