// pages/admin/b2b/index.tsx
//
// B2B admin hub. The sidebar's "B2B Portal" link points here, and from
// here staff can navigate to Catalogue / Distributors / Settings.
//
// Top-of-page also shows live numbers (catalogue count, distributors,
// recent paid orders) so it doubles as a quick health check.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { AppIcon } from '../../../lib/AppIcons'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { SkeletonRows } from '../../../components/ui'
import { T, alpha } from '../../../lib/ui/theme'
import { useIsMobile } from '../../../lib/useIsMobile'
import { A, RADIUS, cardStyle, Banner, PageTitle, SectionLabel, StatusPill, orderStatusColor, orderStatusLabel } from '../../../components/b2b/ui'

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

interface SettingsSummary {
  next_invoice_number_preview: string | null
  stripe_env: {
    secret_key_set: boolean
    webhook_secret_set: boolean
  }
  settings: {
    myob_card_fee_account_code: string | null
    last_catalogue_sync_at: string | null
    last_catalogue_sync_added: number | null
  }
}

interface SyncResult {
  totalScanned: number
  added: number
  updated: number
  unchanged: number
  skipped: number
  errors: Array<{ uid: string; sku: string; error: string }>
  durationMs: number
}

interface OrdersSummary {
  total_count: number
  totals: { total_inc_sum: number; paid_sum: number }
  status_counts: Record<string, number>
  orders: Array<{
    id: string
    order_number: string
    status: string
    total_inc: number
    created_at: string
    distributor: { display_name: string } | null
    myob_invoice_number: string | null
    myob_write_error: string | null
  }>
}

export default function B2BHubPage({ user }: Props) {
  const isMobile = useIsMobile()
  const [settings, setSettings] = useState<SettingsSummary | null>(null)
  const [orders, setOrders] = useState<OrdersSummary | null>(null)

  function loadSettings() {
    fetch('/api/b2b/admin/settings', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setSettings(j) })
      .catch(() => { /* ignore */ })
  }
  function loadOrders() {
    fetch('/api/b2b/admin/orders?limit=6', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setOrders(j) })
      .catch(() => { /* ignore */ })
  }

  useEffect(() => { loadSettings(); loadOrders() }, [])

  const cfgComplete =
    !!settings?.stripe_env.secret_key_set &&
    !!settings?.stripe_env.webhook_secret_set &&
    !!settings?.settings.myob_card_fee_account_code

  return (
    <>
      <Head><title>B2B Portal · JA Portal</title></Head>
      <div style={{display:'flex',flexDirection:'column',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalTopBar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main className="b2b-admin-main" style={{flex:1,padding:'28px 32px',width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="dashboard"/>

          <PageTitle
            sub={<>JAWS-side wholesale ordering. Distributors sign in at <a href="/b2b/login" style={{color:A.accent,textDecoration:'none'}}>/b2b/login</a> with magic links.</>}
            action={
              <a href="/admin/b2b/catalogue" style={{fontSize:12.5,color:T.text3,textDecoration:'none',whiteSpace:'nowrap'}}>
                Catalogue sync moved to the Catalogue page →
              </a>
            }>
            B2B distributor portal
          </PageTitle>

          {/* Configuration health banner */}
          {settings && !cfgComplete && (
            <div style={{marginBottom:18}}>
              <Banner tone="warn">
                Checkout is currently disabled — some configuration is missing.{' '}
                <a href="/admin/b2b/settings" style={{color:A.warn,fontWeight:600,textDecoration:'none'}}>Open Settings →</a>
              </Banner>
            </div>
          )}

          {/* At-a-glance stats — each links to the orders list pre-filtered */}
          {(() => {
            const sc = orders?.status_counts || {}
            const pending   = sc.pending_payment || 0
            const awaiting  = (sc.paid || 0) + (sc.picking || 0) + (sc.packed || 0)
            const inTransit = sc.shipped || 0
            const delivered = sc.delivered || 0
            // Phone: the same swipe rail as the orders filters. Five 168px
            // tiles stacked into five rows and pushed the recent orders off
            // the screen entirely.
            return (
              <div className={isMobile ? 'b2b-swipe' : undefined}
                style={isMobile ? {marginBottom:18} : {display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(168px, 1fr))',gap:14,marginBottom:18}}>
                <StatTile icon="pending"      color={A.warn}   label="Pending payment"     value={pending}   href="/admin/b2b/orders?status=pending_payment"/>
                <StatTile icon="orders"       color={A.accent} label="Awaiting fulfilment" value={awaiting}  href="/admin/b2b/orders?status=paid,picking,packed"/>
                <StatTile icon="truck"        color={A.accent} label="In transit"          value={inTransit} href="/admin/b2b/orders?status=shipped"/>
                <StatTile icon="check-circle" color={A.good}   label="Delivered"           value={delivered} href="/admin/b2b/orders?status=delivered"/>
                <StatTile icon="payables"     color={A.good}   label="Paid revenue"        value={orders ? `$${money(orders.totals.paid_sum)}` : '—'} href="/admin/b2b/orders"/>
              </div>
            )
          })()}

          {/* Recent orders */}
          <section style={{...cardStyle(false),marginBottom:18}}>
            <div style={{display:'flex',alignItems:'center',padding:'14px 18px',borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:13,fontWeight:650,color:T.text2}}>Recent orders</div>
              {orders && <span style={{fontSize:12,color:T.text3,marginLeft:10}}>{orders.total_count} total</span>}
              <span style={{flex:1}}/>
              <a href="/admin/b2b/orders" style={{fontSize:12.5,color:A.accent,textDecoration:'none'}}>View all →</a>
            </div>
            {!orders ? (
              <SkeletonRows rows={8}/>
            ) : orders.orders.length === 0 ? (
              <div style={{padding:20,color:T.text3,fontSize:13}}>No orders yet.</div>
            ) : (
              orders.orders.map((o, i) => (
                <a key={o.id} href={`/admin/b2b/orders/${o.id}`}
                  style={{display:'block',padding: isMobile ? '11px 14px' : '12px 16px',borderTop:i>0?`1px solid ${T.border}`:'none',textDecoration:'none',color:T.text}}>
                  {/* Two lines on a phone. Six items competing on one line meant
                      the distributor was permanently truncated and the money was
                      squeezed against the date (Chris 2026-09-02). Money and
                      status lead; who and when sit underneath. */}
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <span style={{fontFamily:'monospace',fontSize:12.5,flexShrink:0}}>{o.order_number}</span>
                    <StatusPill color={orderStatusColor(o.status)}>{orderStatusLabel(o.status)}</StatusPill>
                    <span style={{flex:1}}/>
                    <span style={{fontFamily:'monospace',fontSize:13.5,fontWeight:650,fontVariantNumeric:'tabular-nums',flexShrink:0}}>${money(Number(o.total_inc))}</span>
                  </div>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginTop:3}}>
                    <span style={{flex:1,minWidth:0,fontSize:12.5,color:T.text2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                      {o.distributor?.display_name || '—'}
                    </span>
                    {o.myob_write_error && <span title={o.myob_write_error} style={{fontSize:12,color:A.bad,flexShrink:0}}>MYOB failed</span>}
                    <span style={{fontSize:12,color:T.text3,flexShrink:0,whiteSpace:'nowrap'}}>{formatRel(o.created_at)}</span>
                  </div>
                </a>
              ))
            )}
          </section>


        </main>
      </div>
    </>
  )
}

function StatTile({ icon, color, label, value, href }: {
  icon: string; color: string; label: string; value: number | string; href: string
}) {
  return (
    <a href={href} className="al-raise" style={{...cardStyle(false),display:'flex',alignItems:'center',gap:12,padding:'16px 16px',textDecoration:'none',color:T.text}}>
      <span style={{width:42,height:42,borderRadius:11,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:alpha(color,'1f'),color}}>
        <AppIcon name={icon} size={22}/>
      </span>
      <div style={{minWidth:0}}>
        <div style={{fontSize:20,fontWeight:650,lineHeight:1.1,fontVariantNumeric:'tabular-nums'}}>{value}</div>
        <div style={{fontSize:12,color:T.text3,marginTop:2}}>{label}</div>
      </div>
    </a>
  )
}


function money(n: number): string {
  return n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatRel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'in the future'
  if (ms < 60_000)    return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}
