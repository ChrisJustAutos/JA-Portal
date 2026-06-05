// pages/workshop/customers.tsx
// Customer lookup — search by name / mobile / phone / email, paginated list,
// click a row to open the detail page with their full history.

import { useEffect, useState, useCallback, useRef } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer'|'workshop'; visibleTabs?: string[] | null }

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', purple: '#a78bfa',
}

interface Customer {
  id: string; name: string; first_name: string | null; last_name: string | null
  phone: string | null; mobile: string | null; email: string | null
  company: string | null; customer_number: string | null
}

const PAGE = 50

export default function CustomersPage({ user }: { user: PortalUserSSR }) {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const timer = useRef<any>(null)

  // Debounce the search so typing doesn't fire a query per keystroke.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setDebouncedQ(q); setOffset(0) }, 200)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (debouncedQ) params.set('q', debouncedQ)
      params.set('limit', String(PAGE))
      params.set('offset', String(offset))
      const r = await fetch(`/api/workshop/customers?${params}`)
      const d = await r.json()
      if (r.ok) { setCustomers(d.customers || []); setTotal(d.total || 0) }
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [debouncedQ, offset])

  useEffect(() => { load() }, [load])

  const pageStart = offset + 1
  const pageEnd = Math.min(offset + PAGE, total)

  return (
    <>
      <Head><title>Customers · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="customers" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ maxWidth:1600, margin:'0 auto', padding:'24px 28px' }}>
            <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:18, gap:16, flexWrap:'wrap' }}>
              <h1 style={{ fontSize:22, fontWeight:600, margin:0 }}>Customers</h1>
              <div style={{ fontSize:11, color:T.text3 }}>{total.toLocaleString()} total{debouncedQ ? ` matching "${debouncedQ}"` : ''}</div>
            </div>

            <div style={{ marginBottom:14, position:'relative' }}>
              <input
                autoFocus value={q} onChange={e => setQ(e.target.value)}
                placeholder="Search name, mobile, phone, or email…"
                style={{
                  width:'100%', padding:'10px 14px', background:T.bg2, border:`1px solid ${T.border2}`,
                  borderRadius:8, color:T.text, fontSize:14, fontFamily:'inherit', outline:'none',
                }}
              />
              {loading && <span style={{ position:'absolute', right:14, top:'50%', transform:'translateY(-50%)', fontSize:11, color:T.text3 }}>Loading…</span>}
            </div>

            <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden' }}>
              <div style={{ display:'grid', gridTemplateColumns:'1.4fr 110px 130px 1.6fr 90px', gap:12, padding:'10px 14px', fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${T.border}`, background:T.bg3 }}>
                <div>Name</div><div>Mobile</div><div>Phone</div><div>Email</div><div style={{ textAlign:'right' }}>Customer #</div>
              </div>
              {customers.length === 0 ? (
                <div style={{ padding:30, textAlign:'center', fontSize:13, color:T.text3 }}>{loading ? 'Loading…' : debouncedQ ? `No customers match "${debouncedQ}"` : 'No customers'}</div>
              ) : customers.map(c => (
                <Link key={c.id} href={`/workshop/customer/${c.id}`} style={{ display:'grid', gridTemplateColumns:'1.4fr 110px 130px 1.6fr 90px', gap:12, padding:'10px 14px', borderTop:`1px solid ${T.border}`, alignItems:'center', fontSize:12, color:T.text, textDecoration:'none' }}>
                  <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {c.name}
                    {c.company && c.company !== c.name && <span style={{ color:T.text3, marginLeft:6 }}>· {c.company}</span>}
                  </div>
                  <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11 }}>{c.mobile || '—'}</div>
                  <div style={{ color:T.text3, fontFamily:'monospace', fontSize:11 }}>{c.phone || '—'}</div>
                  <div style={{ color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize:11 }}>{c.email || '—'}</div>
                  <div style={{ color:T.text3, fontFamily:'monospace', fontSize:11, textAlign:'right' }}>{c.customer_number || ''}</div>
                </Link>
              ))}
            </div>

            {total > PAGE && (
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:14, fontSize:12, color:T.text3 }}>
                <div>Showing {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of {total.toLocaleString()}</div>
                <div style={{ display:'flex', gap:6 }}>
                  <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))} style={pagerBtn(offset === 0)}>← Prev</button>
                  <button disabled={offset + PAGE >= total || loading} onClick={() => setOffset(offset + PAGE)} style={pagerBtn(offset + PAGE >= total)}>Next →</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

const pagerBtn = (disabled: boolean): React.CSSProperties => ({
  padding:'6px 12px', borderRadius:5, fontSize:11, fontFamily:'inherit', fontWeight:600,
  background:disabled ? 'transparent' : T.bg3, color:disabled ? T.text3 : T.text2,
  border:`1px solid ${T.border2}`, cursor:disabled ? 'default' : 'pointer',
})

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
