// pages/workshop/activity.tsx — workshop activity log (audit feed).
import { useState, useEffect, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'|'workshop'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const ACTION_COLOR: Record<string, string> = { created: T.green, updated: T.blue, deleted: T.red, split: T.purple, converted: T.teal, payment: T.amber, status: T.amber }
const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' }, { id: 'booking', label: 'Bookings' }, { id: 'quote', label: 'Quotes' },
  { id: 'customer', label: 'Customers' }, { id: 'invoice', label: 'Invoices' }, { id: 'inventory', label: 'Inventory' },
]

export default function WorkshopActivityPage({ user }: { user: PortalUserSSR }) {
  const [rows, setRows] = useState<any[]>([])
  const [entity, setEntity] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/workshop/activity?entity=${entity}`)
      const d = await r.json()
      if (r.ok) setRows(d.activity || [])
    } catch { /* keep */ } finally { setLoading(false) }
  }, [entity])
  useEffect(() => { load() }, [load])

  // Group by day.
  const groups: { day: string; items: any[] }[] = []
  for (const a of rows) {
    const day = new Date(a.created_at).toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short' })
    const g = groups.find(x => x.day === day) || (groups.push({ day, items: [] }), groups[groups.length - 1])
    g.items.push(a)
  }
  const time = (s: string) => new Date(s).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })

  return (
    <>
      <Head><title>Activity — Workshop · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.text, fontFamily: '"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Workshop activity</h1>
              <span style={{ flex: 1 }} />
              {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
              {FILTERS.map(f => (
                <button key={f.id} onClick={() => setEntity(f.id)} style={{
                  background: entity === f.id ? T.bg4 : 'transparent', border: `1px solid ${entity === f.id ? T.border2 : T.border}`,
                  color: entity === f.id ? T.text : T.text2, fontSize: 12, fontFamily: 'inherit', padding: '5px 12px', borderRadius: 7, cursor: 'pointer',
                }}>{f.label}</button>
              ))}
            </div>

            {!loading && rows.length === 0 && <div style={{ padding: 30, textAlign: 'center', color: T.text3, fontSize: 13 }}>No activity recorded yet.</div>}

            {groups.map(g => (
              <div key={g.day} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>{g.day}</div>
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
                  {g.items.map((a, i) => (
                    <div key={a.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderTop: i ? `1px solid ${T.border}` : 'none', alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace', width: 48, flexShrink: 0 }}>{time(a.created_at)}</span>
                      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: ACTION_COLOR[a.action] || T.text2, background: `${ACTION_COLOR[a.action] || T.text2}1f`, padding: '2px 7px', borderRadius: 4, flexShrink: 0 }}>{a.action}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13 }}>{a.detail || `${a.entity} ${a.entity_label || ''}`}</span>
                        {a.entity_label && a.detail && <span style={{ fontSize: 12, color: T.text2 }}> · {a.entity_label}</span>}
                      </div>
                      {a.actor_name && <span style={{ fontSize: 11, color: T.text3, flexShrink: 0 }}>{a.actor_name}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
