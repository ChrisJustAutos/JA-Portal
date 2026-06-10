// pages/workshop/quotes.tsx
// Quotes board — list workshop quotes, create a new one (→ quote builder).
// Reads/writes via /api/workshop/quotes (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { QUOTE_STATUS_META, QUOTE_STATUSES, QuoteStatus, vehicleLabel, customerLabel } from '../../lib/workshop'
import { T, Chip, SkeletonRows } from '../../components/ui'
import { money2 as money, fmtDate } from '../../lib/ui/format'

function QuoteChip({ status }: { status: QuoteStatus }) {
  const m = QUOTE_STATUS_META[status] || { label: status, color: T.text3 }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 3, background: `${m.color}1e`, border: `1px solid ${m.color}55`, color: m.color, fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: m.color }} />{m.label}
    </span>
  )
}

export default function QuotesPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [quotes, setQuotes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<string>('')
  const [view, setView] = useState<'active'|'trash'>('active')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filter) params.set('status', filter)
      params.set('view', view)
      const r = await fetch(`/api/workshop/quotes?${params}`)
      const d = await r.json()
      if (r.ok) setQuotes(Array.isArray(d.quotes) ? d.quotes : [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [filter, view])

  async function restoreQuote(id: string, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    const r = await fetch(`/api/workshop/quotes/${id}/restore`, { method: 'POST' })
    if (r.ok) load()
  }

  useEffect(() => { load() }, [load])

  async function newQuote() {
    setCreating(true)
    try {
      const r = await fetch('/api/workshop/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const d = await r.json()
      if (r.ok && d.id) router.push(`/workshop/quote/${d.id}`)
      else setCreating(false)
    } catch { setCreating(false) }
  }

  return (
    <>
      <Head><title>Quotes — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="quotes" role={user.role} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Quotes</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <Chip label="Active" active={view === 'active'} onClick={() => setView('active')} />
              <Chip label="Trash" active={view === 'trash'} onClick={() => setView('trash')} c={T.red} />
            </div>
            <select value={filter} onChange={e => setFilter(e.target.value)} disabled={view === 'trash'} style={{ padding: '4px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text2, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', opacity: view === 'trash' ? 0.5 : 1 }}>
              <option value="">All statuses</option>
              {QUOTE_STATUSES.map(s => <option key={s} value={s}>{QUOTE_STATUS_META[s].label}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            {canEdit && view === 'active' && (
              <button onClick={newQuote} disabled={creating} style={{ padding: '5px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, background: T.accent, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {creating ? 'Creating…' : '+ New quote'}
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            <div style={{ maxWidth: 1400, margin: '0 auto', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: view === 'trash' ? '90px 1fr 1fr 110px 90px 90px' : '90px 1fr 1fr 110px 90px', gap: 8, padding: '9px 16px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <div>Status</div><div>Customer</div><div>Vehicle</div><div style={{ textAlign: 'right' }}>Total</div><div style={{ textAlign: 'right' }}>Created</div>{view === 'trash' && <div style={{ textAlign: 'right' }}></div>}
              </div>
              {loading && quotes.length === 0 ? (
                <SkeletonRows rows={8} />
              ) : quotes.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>
                  {view === 'trash' ? 'Trash is empty.' : `No quotes${filter ? ' with that status' : ''}.${canEdit ? ' Create one with “+ New quote”.' : ''}`}
                </div>
              ) : quotes.map(q => (
                <Link key={q.id} href={`/workshop/quote/${q.id}`} style={{ display: 'grid', gridTemplateColumns: view === 'trash' ? '90px 1fr 1fr 110px 90px 90px' : '90px 1fr 1fr 110px 90px', gap: 8, padding: '11px 16px', borderTop: `1px solid ${T.border}`, alignItems: 'center', textDecoration: 'none', color: 'inherit', opacity: view === 'trash' ? 0.7 : 1 }}>
                  <div><QuoteChip status={q.status} /></div>
                  <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.customer ? customerLabel(q.customer) : '—'}</div>
                  <div style={{ fontSize: 12, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.vehicle ? vehicleLabel(q.vehicle) : '—'}</div>
                  <div style={{ fontSize: 12, fontFamily: 'monospace', color: T.text, textAlign: 'right' }}>{money(q.total)}</div>
                  <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace', textAlign: 'right' }}>{fmtDate(q.created_at)}</div>
                  {view === 'trash' && canEdit && (
                    <div style={{ textAlign: 'right' }}>
                      <button onClick={e => restoreQuote(q.id, e)} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit', fontWeight: 600, background: 'transparent', color: T.green, border: `1px solid ${T.green}55`, cursor: 'pointer' }}>Restore</button>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
