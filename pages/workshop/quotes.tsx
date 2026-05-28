// pages/workshop/quotes.tsx
// Quotes board — list workshop quotes, create a new one (→ quote builder).
// Reads/writes via /api/workshop/quotes (service-role, gated view:diary/edit:bookings).

import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import { QUOTE_STATUS_META, QUOTE_STATUSES, QuoteStatus, vehicleLabel, customerLabel } from '../../lib/workshop'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' })
}

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
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/workshop/quotes${filter ? `?status=${filter}` : ''}`)
      const d = await r.json()
      if (r.ok) setQuotes(Array.isArray(d.quotes) ? d.quotes : [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [filter])

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
        <PortalTopBar activeId="workshop-quotes" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Quotes</span>
            <select value={filter} onChange={e => setFilter(e.target.value)} style={{ padding: '4px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text2, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' }}>
              <option value="">All statuses</option>
              {QUOTE_STATUSES.map(s => <option key={s} value={s}>{QUOTE_STATUS_META[s].label}</option>)}
            </select>
            <div style={{ flex: 1 }} />
            {canEdit && (
              <button onClick={newQuote} disabled={creating} style={{ padding: '5px 14px', borderRadius: 5, fontSize: 12, fontWeight: 600, background: T.accent, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {creating ? 'Creating…' : '+ New quote'}
              </button>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            <div style={{ maxWidth: 1400, margin: '0 auto', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 110px 90px', gap: 8, padding: '9px 16px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <div>Status</div><div>Customer</div><div>Vehicle</div><div style={{ textAlign: 'right' }}>Total</div><div style={{ textAlign: 'right' }}>Created</div>
              </div>
              {loading && quotes.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>Loading…</div>
              ) : quotes.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 12 }}>No quotes{filter ? ' with that status' : ''}.{canEdit ? ' Create one with “+ New quote”.' : ''}</div>
              ) : quotes.map(q => (
                <Link key={q.id} href={`/workshop/quote/${q.id}`} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 110px 90px', gap: 8, padding: '11px 16px', borderTop: `1px solid ${T.border}`, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
                  <div><QuoteChip status={q.status} /></div>
                  <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.customer ? customerLabel(q.customer) : '—'}</div>
                  <div style={{ fontSize: 12, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.vehicle ? vehicleLabel(q.vehicle) : '—'}</div>
                  <div style={{ fontSize: 12, fontFamily: 'monospace', color: T.text, textAlign: 'right' }}>{money(q.total)}</div>
                  <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace', textAlign: 'right' }}>{fmtDate(q.created_at)}</div>
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
