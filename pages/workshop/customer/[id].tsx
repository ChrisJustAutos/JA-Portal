// pages/workshop/customer/[id].tsx
// Customer detail — contact info + their vehicles, bookings, invoices.
// The "previous history" view the customer-lookup tab links into.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { BOOKING_STATUS_META, BookingStatus, vehicleLabel } from '../../../lib/workshop'
import { T, Section, Table, Row, Empty, StatusPill } from '../../../components/ui'
import { money2 as money, fmtDate } from '../../../lib/ui/format'

export default function CustomerDetailPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = String(router.query.id || '')
  const [data, setData] = useState<any | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!id) return
    fetch(`/api/workshop/customers/${id}`).then(r => r.json()).then(d => {
      if (d.error) setErr(d.error); else setData(d)
    }).catch(e => setErr(e?.message || 'Load failed'))
  }, [id])

  return (
    <>
      <Head><title>{data?.customer?.name || 'Customer'} · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="customers" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ margin:'0 auto', padding:'24px 28px' }}>
            <Link href="/workshop/customers" style={{ fontSize:11, color:T.text3, textDecoration:'none', fontFamily:'monospace' }}>← Customers</Link>
            {err && <div style={{ marginTop:14, padding:12, background:'#3a1d1d', border:`1px solid ${T.red}`, borderRadius:6, color:T.red, fontSize:13 }}>{err}</div>}
            {!data && !err && <div style={{ marginTop:14, fontSize:13, color:T.text3 }}>Loading…</div>}

            {data && (
              <>
                {/* Header */}
                <div style={{ marginTop:10, marginBottom:22 }}>
                  <h1 style={{ fontSize:24, fontWeight:600, margin:'4px 0' }}>{data.customer.name}</h1>
                  <div style={{ fontSize:12, color:T.text3 }}>
                    {[data.customer.mobile, data.customer.phone, data.customer.email].filter(Boolean).join(' · ') || 'No contact details'}
                  </div>
                  {data.customer.address && <div style={{ fontSize:12, color:T.text3, marginTop:4 }}>{data.customer.address}</div>}
                  <div style={{ fontSize:10, color:T.text3, marginTop:8, fontFamily:'monospace' }}>
                    {data.customer.customer_number && <span>#{data.customer.customer_number} · </span>}
                    {data.customer.customer_type === 'company' ? 'Company' : 'Individual'}
                    {data.customer.myob_uid && <span> · MYOB linked</span>}
                    {data.customer.md_id && <span> · External ID: {data.customer.md_id}</span>}
                  </div>
                </div>

                {/* Vehicles */}
                <Section title="Vehicles" count={data.vehicles.length}>
                  {data.vehicles.length === 0 ? <Empty>No vehicles on file</Empty> : (() => {
                    const cols = '120px 1fr 70px 90px 110px 70px'
                    return (
                      <Table cols={cols} header={<><div>Rego</div><div>Make / Model</div><div style={{ textAlign:'right' }}>Year</div><div style={{ textAlign:'right' }}>KMs</div><div style={{ textAlign:'right' }}>Service due</div><div /></>}>
                        {data.vehicles.map((v: any) => (
                          <Row key={v.id} cols={cols}>
                            <div style={{ fontFamily:'monospace', fontWeight:600 }}>{v.rego || '—'}</div>
                            <div>{[v.make, v.model].filter(Boolean).join(' ') || '—'}</div>
                            <div style={{ textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{v.year || '—'}</div>
                            <div style={{ textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{v.odometer ? v.odometer.toLocaleString() : '—'}</div>
                            <div style={{ textAlign:'right', fontFamily:'monospace', fontSize:11, color: v.next_service_due_date ? T.amber : T.text3 }}>{v.next_service_due_date ? fmtDate(`${v.next_service_due_date}T00:00:00+10:00`) : '—'}</div>
                            <div style={{ textAlign:'right' }}><Link href={`/workshop/vehicle/${v.id}`} style={{ color:T.blue, fontSize:11, textDecoration:'none' }}>Open →</Link></div>
                          </Row>
                        ))}
                      </Table>
                    )
                  })()}
                </Section>

                {/* Bookings */}
                <Section title="Bookings" count={data.bookings.length}>
                  {data.bookings.length === 0 ? <Empty>No bookings yet</Empty> : (() => {
                    const cols = '110px 80px 1fr 80px 100px'
                    return (
                      <Table cols={cols} header={<><div>Date</div><div>Status</div><div>Description</div><div style={{ textAlign:'right' }}>Est. value</div><div style={{ textAlign:'right' }}></div></>}>
                        {data.bookings.map((b: any) => {
                          const meta = (BOOKING_STATUS_META as any)[b.status as BookingStatus] || { label: b.status, color: T.text3 }
                          return (
                            <Row key={b.id} cols={cols}>
                              <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11 }}>{fmtDate(b.starts_at)}</div>
                              <div><StatusPill label={meta.label} color={meta.color} uppercase={false} /></div>
                              <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(b.description || '').split('\n')[0] || '—'}</div>
                              <div style={{ textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums' }}>{b.estimated_value ? money(b.estimated_value) : '—'}</div>
                              <div style={{ textAlign:'right' }}><Link href={`/workshop/job/${b.id}`} style={{ color:T.blue, fontSize:11, textDecoration:'none' }}>Open →</Link></div>
                            </Row>
                          )
                        })}
                      </Table>
                    )
                  })()}
                </Section>

                {/* Invoices */}
                <Section title="Invoices" count={data.invoices.length}>
                  {data.invoices.length === 0 ? <Empty>No invoices yet</Empty> : (() => {
                    const cols = '110px 80px 1fr 100px 100px 100px'
                    return (
                      <Table cols={cols} header={<><div>Date</div><div>Status</div><div></div><div style={{ textAlign:'right' }}>Subtotal</div><div style={{ textAlign:'right' }}>GST</div><div style={{ textAlign:'right' }}>Total</div></>}>
                        {data.invoices.map((inv: any) => (
                          <Row key={inv.id} cols={cols}>
                            <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11 }}>{fmtDate(inv.created_at)}</div>
                            <div><span style={{ color:T.text3, fontSize:10, textTransform:'uppercase' }}>{inv.status}</span></div>
                            <div style={{ color:T.text3, fontSize:10, fontFamily:'monospace' }}>{inv.md_id ? `Ext: ${inv.md_id}` : inv.myob_invoice_uid ? 'MYOB linked' : ''}</div>
                            <div style={{ textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{money(inv.subtotal)}</div>
                            <div style={{ textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{money(inv.gst)}</div>
                            <div style={{ textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:600 }}>{money(inv.total)}</div>
                          </Row>
                        ))}
                      </Table>
                    )
                  })()}
                </Section>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
