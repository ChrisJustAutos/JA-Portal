// pages/workshop/vehicle/[id].tsx
// Vehicle detail — owner, editable details (PATCH-on-blur), service/rego due
// quick-set, full service history (bookings + invoices), photos & documents.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import WorkshopTabs from '../../../components/WorkshopTabs'
import FilesPanel from '../../../components/workshop/FilesPanel'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { BOOKING_STATUS_META, BookingStatus, jobTypeLabel, vehicleLabel, ymdBrisbane } from '../../../lib/workshop'
import { T, Section, Table, Row, Empty, StatusPill, inp } from '../../../components/ui'
import { money2 as money, fmtDate } from '../../../lib/ui/format'

function addMonthsYmd(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00+10:00`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return ymdBrisbane(d)
}

export default function VehicleDetailPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = String(router.query.id || '')
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  const [data, setData] = useState<any | null>(null)
  const [err, setErr] = useState('')
  const [saveMsg, setSaveMsg] = useState('')

  const load = useCallback(() => {
    if (!id) return
    fetch(`/api/workshop/vehicles/${id}`).then(r => r.json()).then(d => {
      if (d.error) setErr(d.error); else { setData(d); setErr('') }
    }).catch(e => setErr(e?.message || 'Load failed'))
  }, [id])

  useEffect(() => { load() }, [load])

  async function patchVehicle(patch: any) {
    setSaveMsg('')
    const r = await fetch(`/api/workshop/vehicles?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!r.ok) setSaveMsg((await r.json()).error || 'Save failed')
    else setSaveMsg('Saved ✓')
    load()
  }

  const v = data?.vehicle
  const today = ymdBrisbane(new Date())

  return (
    <>
      <Head><title>{v ? vehicleLabel(v) : 'Vehicle'} · JA Portal</title></Head>
      <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:T.bg, color:T.text, fontFamily:'"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="diary" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="vehicles" role={user.role} />
        <div style={{ flex:1, overflowY:'auto' }}>
          <div style={{ maxWidth:1600, margin:'0 auto', padding:'24px 28px' }}>
            <Link href="/workshop/vehicles" style={{ fontSize:11, color:T.text3, textDecoration:'none', fontFamily:'monospace' }}>← Vehicles</Link>
            {err && <div style={{ marginTop:14, padding:12, background:'#3a1d1d', border:`1px solid ${T.red}`, borderRadius:6, color:T.red, fontSize:13 }}>{err}</div>}
            {!data && !err && <div style={{ marginTop:14, fontSize:13, color:T.text3 }}>Loading…</div>}

            {v && (
              <>
                {/* Header */}
                <div style={{ marginTop:10, marginBottom:22 }}>
                  <h1 style={{ fontSize:24, fontWeight:600, margin:'4px 0' }}>{vehicleLabel(v)}</h1>
                  <div style={{ fontSize:12, color:T.text3 }}>
                    Owner: {v.customer
                      ? <Link href={`/workshop/customer/${v.customer.id}`} style={{ color:T.blue, textDecoration:'none' }}>{v.customer.name}</Link>
                      : 'no owner on file'}
                    {v.customer?.mobile && <span> · {v.customer.mobile}</span>}
                  </div>
                  {saveMsg && <div style={{ fontSize:11, color: saveMsg.includes('✓') ? T.green : T.red, marginTop:6 }}>{saveMsg}</div>}
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'380px 1fr', gap:18, alignItems:'start' }}>
                  {/* LEFT — details + due dates */}
                  <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                    <Card title="Details">
                      <EditRow label="Rego" value={v.rego || ''} mono canEdit={canEdit} onSave={val => patchVehicle({ rego: val })} />
                      <EditRow label="Make" value={v.make || ''} canEdit={canEdit} onSave={val => patchVehicle({ make: val })} />
                      <EditRow label="Model" value={v.model || ''} canEdit={canEdit} onSave={val => patchVehicle({ model: val })} />
                      <EditRow label="Year" value={v.year ? String(v.year) : ''} mono canEdit={canEdit} onSave={val => patchVehicle({ year: val })} />
                      <EditRow label="VIN" value={v.vin || ''} mono canEdit={canEdit} onSave={val => patchVehicle({ vin: val })} />
                      <EditRow label="Colour" value={v.colour || ''} canEdit={canEdit} onSave={val => patchVehicle({ colour: val })} />
                      <EditRow label="Odometer (km)" value={v.odometer ? String(v.odometer) : ''} mono canEdit={canEdit} onSave={val => patchVehicle({ odometer: val })} />
                      <EditRow label="Notes" value={v.notes || ''} canEdit={canEdit} onSave={val => patchVehicle({ notes: val })} />
                      {canEdit && (
                        <div style={{ paddingTop:8, marginTop:4, borderTop:`1px solid ${T.border}` }}>
                          <button disabled title="External rego/VIN lookup not connected yet" style={{
                            padding:'5px 10px', borderRadius:5, fontSize:11, fontFamily:'inherit',
                            background:'transparent', color:T.text3, border:`1px solid ${T.border2}`, cursor:'not-allowed',
                          }}>🔍 Lookup rego (not connected)</button>
                        </div>
                      )}
                    </Card>

                    <Card title="Service & rego due">
                      <DueRow label="Next service" ymd={v.next_service_due_date} today={today}
                        extra={v.next_service_due_km ? `${Number(v.next_service_due_km).toLocaleString()} km` : null} />
                      <DueRow label="Rego renewal" ymd={v.rego_due_date} today={today} />
                      {canEdit && (
                        <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:10, paddingTop:10, borderTop:`1px solid ${T.border}` }}>
                          <div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' }}>
                            <input type="date" defaultValue={v.next_service_due_date || ''} key={`s-${v.next_service_due_date}`}
                              onBlur={e => { if (e.target.value !== (v.next_service_due_date || '')) patchVehicle({ next_service_due_date: e.target.value || null }) }}
                              style={{ ...inp, colorScheme:'dark' }} title="Next service due date" />
                            <button onClick={() => patchVehicle({ next_service_due_date: addMonthsYmd(today, 6) })} style={miniBtn}>+6 mo</button>
                            <button onClick={() => patchVehicle({ next_service_due_date: addMonthsYmd(today, 12) })} style={miniBtn}>+12 mo</button>
                            <input defaultValue={v.next_service_due_km || ''} key={`k-${v.next_service_due_km}`} inputMode="numeric" placeholder="due km"
                              onBlur={e => { if (e.target.value !== String(v.next_service_due_km || '')) patchVehicle({ next_service_due_km: e.target.value || null }) }}
                              style={{ ...inp, width:90 }} title="Or due by odometer (km)" />
                          </div>
                          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                            <input type="date" defaultValue={v.rego_due_date || ''} key={`r-${v.rego_due_date}`}
                              onBlur={e => { if (e.target.value !== (v.rego_due_date || '')) patchVehicle({ rego_due_date: e.target.value || null }) }}
                              style={{ ...inp, colorScheme:'dark' }} title="Rego due date" />
                            <span style={{ fontSize:10, color:T.text3 }}>rego due — SMS reminder goes out automatically</span>
                          </div>
                        </div>
                      )}
                    </Card>
                  </div>

                  {/* RIGHT — history, invoices, files */}
                  <div>
                    <Section title="Service history" count={(data.bookings || []).length}>
                      {(data.bookings || []).length === 0 ? <Empty>No jobs on this vehicle yet</Empty> : (() => {
                        const cols = '100px 90px 1fr 90px 90px 70px'
                        return (
                          <Table cols={cols} header={<><div>Date</div><div>Status</div><div>Job</div><div style={{ textAlign:'right' }}>KMs</div><div style={{ textAlign:'right' }}>Total</div><div /></>}>
                            {data.bookings.map((b: any) => {
                              const meta = (BOOKING_STATUS_META as any)[b.status as BookingStatus] || { label: b.status, color: T.text3 }
                              return (
                                <Row key={b.id} cols={cols}>
                                  <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11 }}>{fmtDate(b.completed_at || b.starts_at)}</div>
                                  <div><StatusPill label={meta.label} color={meta.color} uppercase={false} /></div>
                                  <div style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(b.description || '').split('\n')[0] || jobTypeLabel(b.job_type) || '—'}</div>
                                  <div style={{ textAlign:'right', color:T.text3, fontVariantNumeric:'tabular-nums' }}>{b.odometer ? b.odometer.toLocaleString() : '—'}</div>
                                  <div style={{ textAlign:'right', color:T.text2, fontVariantNumeric:'tabular-nums' }}>{b.total_inc_gst ? money(b.total_inc_gst) : '—'}</div>
                                  <div style={{ textAlign:'right' }}><Link href={`/workshop/job/${b.id}`} style={{ color:T.blue, fontSize:11, textDecoration:'none' }}>Open →</Link></div>
                                </Row>
                              )
                            })}
                          </Table>
                        )
                      })()}
                    </Section>

                    <Section title="Invoices" count={(data.invoices || []).length}>
                      {(data.invoices || []).length === 0 ? <Empty>No invoices for this vehicle</Empty> : (() => {
                        const cols = '110px 90px 1fr 110px'
                        return (
                          <Table cols={cols} header={<><div>Date</div><div>Status</div><div></div><div style={{ textAlign:'right' }}>Total</div></>}>
                            {data.invoices.map((inv: any) => (
                              <Row key={inv.id} cols={cols}>
                                <div style={{ color:T.text2, fontFamily:'monospace', fontSize:11 }}>{fmtDate(inv.created_at)}</div>
                                <div><span style={{ color:T.text3, fontSize:10, textTransform:'uppercase' }}>{inv.status}</span></div>
                                <div style={{ color:T.text3, fontSize:10, fontFamily:'monospace' }}>{inv.md_id ? `Ext: ${inv.md_id}` : ''}</div>
                                <div style={{ textAlign:'right', color:T.text, fontVariantNumeric:'tabular-nums', fontWeight:600 }}>{money(inv.total)}</div>
                              </Row>
                            ))}
                          </Table>
                        )
                      })()}
                    </Section>

                    <Section title="Photos & documents" count={(data.files || []).length}>
                      <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8 }}>
                        <FilesPanel vehicleId={id} customerId={v.customer_id} canEdit={canEdit} />
                      </div>
                    </Section>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Card({ title, children }: { title: string; children: any }) {
  return (
    <div style={{ background:T.bg2, border:`1px solid ${T.border}`, borderRadius:8, padding:'14px 16px' }}>
      <div style={{ fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:10 }}>{title}</div>
      {children}
    </div>
  )
}

// Inline-editable field row — saves on blur when changed.
function EditRow({ label, value, onSave, canEdit, mono }: { label: string; value: string; onSave: (v: string) => void; canEdit: boolean; mono?: boolean }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 0' }}>
      <div style={{ width:110, fontSize:11, color:T.text3, flexShrink:0 }}>{label}</div>
      {canEdit ? (
        <input defaultValue={value} key={value}
          onBlur={e => { if (e.target.value !== value) onSave(e.target.value) }}
          style={{ ...inp, flex:1, fontFamily: mono ? 'monospace' : 'inherit' }} />
      ) : (
        <div style={{ fontSize:12, color:T.text, fontFamily: mono ? 'monospace' : 'inherit' }}>{value || '—'}</div>
      )}
    </div>
  )
}

function DueRow({ label, ymd, today, extra }: { label: string; ymd: string | null; today: string; extra?: string | null }) {
  const overdue = !!ymd && ymd < today
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 0' }}>
      <div style={{ width:110, fontSize:11, color:T.text3, flexShrink:0 }}>{label}</div>
      <div style={{ fontSize:12, fontFamily:'monospace', color: !ymd ? T.text3 : overdue ? T.red : T.text }}>
        {ymd ? new Date(`${ymd}T00:00:00+10:00`).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' }) : 'not set'}
        {extra ? ` / ${extra}` : ''}{overdue ? ' · OVERDUE' : ''}
      </div>
    </div>
  )
}

const miniBtn: React.CSSProperties = {
  padding:'5px 9px', borderRadius:5, fontSize:11, fontFamily:'inherit', fontWeight:600,
  background:'transparent', color:T.text2, border:`1px solid ${T.border2}`, cursor:'pointer',
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}
