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

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

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

const STATUS_COLOR: Record<string, string> = {
  pending_payment: T.text3, paid: T.blue, picking: T.amber, packed: T.amber,
  shipped: T.teal, delivered: T.green, cancelled: T.red, refunded: T.purple,
}
const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Pending', paid: 'Paid', picking: 'Picking', packed: 'Packed',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
}

export default function B2BHubPage({ user }: Props) {
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
        <main className="b2b-admin-main" style={{flex:1,padding:'28px 32px',maxWidth:1200,width:'100%',boxSizing:'border-box'}}>
          <B2BAdminTabs active="dashboard"/>

          <header style={{marginBottom:24,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <span style={{color:T.text2}}>B2B Portal</span>
              </div>
              <h1 style={{fontSize:24,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>B2B distributor portal</h1>
              <div style={{fontSize:13,color:T.text3,marginTop:6}}>
                JAWS-side wholesale ordering. Distributors sign in at <a href="/b2b/login" style={{color:T.blue,textDecoration:'none'}}>/b2b/login</a> with magic links.
              </div>
            </div>
            <a href="/admin/b2b/catalogue" style={{fontSize:12,color:T.text3,textDecoration:'none',whiteSpace:'nowrap'}}>
              Catalogue sync moved to the Catalogue page →
            </a>
          </header>

          {/* Configuration health banner */}
          {settings && !cfgComplete && (
            <div style={{
              padding:'12px 16px',background:`${T.amber}15`,border:`1px solid ${T.amber}40`,
              borderRadius:8,marginBottom:18,fontSize:13,color:T.text2,
            }}>
              ⚠ Checkout is currently disabled — some configuration is missing.{' '}
              <a href="/admin/b2b/settings" style={{color:T.amber,fontWeight:500,textDecoration:'none'}}>Open Settings →</a>
            </div>
          )}

          {/* At-a-glance stats — each links to the orders list pre-filtered */}
          {(() => {
            const sc = orders?.status_counts || {}
            const pending   = sc.pending_payment || 0
            const awaiting  = (sc.paid || 0) + (sc.picking || 0) + (sc.packed || 0)
            const inTransit = sc.shipped || 0
            const delivered = sc.delivered || 0
            return (
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(168px, 1fr))',gap:14,marginBottom:18}}>
                <StatTile icon="pending"      color={T.amber} label="Pending payment"     value={pending}   href="/admin/b2b/orders?status=pending_payment"/>
                <StatTile icon="orders"       color={T.blue}  label="Awaiting fulfilment" value={awaiting}  href="/admin/b2b/orders?status=paid,picking,packed"/>
                <StatTile icon="truck"        color={T.teal}  label="In transit"          value={inTransit} href="/admin/b2b/orders?status=shipped"/>
                <StatTile icon="check-circle" color={T.green} label="Delivered"           value={delivered} href="/admin/b2b/orders?status=delivered"/>
                <StatTile icon="payables"     color={T.green} label="Paid revenue"        value={orders ? `$${money(orders.totals.paid_sum)}` : '—'} href="/admin/b2b/orders"/>
              </div>
            )
          })()}

          {/* Recent orders */}
          <section style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,overflow:'hidden',marginBottom:18}}>
            <div style={{display:'flex',alignItems:'center',padding:'14px 18px',borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:13,fontWeight:600}}>Recent orders</div>
              {orders && <span style={{fontSize:12,color:T.text3,marginLeft:10}}>{orders.total_count} total</span>}
              <span style={{flex:1}}/>
              <a href="/admin/b2b/orders" style={{fontSize:12,color:T.blue,textDecoration:'none'}}>View all →</a>
            </div>
            {!orders ? (
              <div style={{padding:20,color:T.text3,fontSize:13}}>Loading…</div>
            ) : orders.orders.length === 0 ? (
              <div style={{padding:20,color:T.text3,fontSize:13}}>No orders yet.</div>
            ) : (
              orders.orders.map((o, i) => (
                <a key={o.id} href={`/admin/b2b/orders/${o.id}`}
                  style={{display:'flex',alignItems:'center',gap:10,padding:'12px 16px',borderTop:i>0?`1px solid ${T.border}`:'none',textDecoration:'none',color:T.text}}>
                  <span style={{fontFamily:'monospace',fontSize:12.5,minWidth:0,flexShrink:0}}>{o.order_number}</span>
                  <span style={{flex:1,minWidth:40,fontSize:13,color:T.text2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{o.distributor?.display_name || '—'}</span>
                  {o.myob_write_error && <span title={o.myob_write_error} style={{fontSize:11,color:T.red,flexShrink:0}}>⚠</span>}
                  <StatusChip status={o.status}/>
                  <span style={{fontFamily:'monospace',fontSize:12.5,textAlign:'right',flexShrink:0}}>${money(Number(o.total_inc))}</span>
                  <span style={{fontSize:11,color:T.text3,textAlign:'right',flexShrink:0,whiteSpace:'nowrap'}}>{formatRel(o.created_at)}</span>
                </a>
              ))
            )}
          </section>

          {/* Quick links */}
          <section style={{
            marginTop:48,padding:'22px 26px',
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
          }}>
            <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10,fontWeight:500}}>
              Distributor portal links
            </div>
            <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
              <ExternalLink href="/b2b/login"     label="Sign-in page"/>
              <ExternalLink href="/b2b/catalogue" label="Catalogue (as a distributor)"/>
              <ExternalLink href="/b2b/orders"    label="Orders (as a distributor)"/>
            </div>
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
    <a href={href} style={{display:'flex',alignItems:'center',gap:12,padding:'16px 16px',background:T.bg2,border:`1px solid ${T.border}`,borderRadius:12,textDecoration:'none',color:T.text}}>
      <span style={{width:42,height:42,borderRadius:11,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',background:`${color}1f`,color,border:`1px solid ${color}33`}}>
        <AppIcon name={icon} size={22}/>
      </span>
      <div style={{minWidth:0}}>
        <div style={{fontSize:20,fontWeight:600,lineHeight:1.1,fontVariantNumeric:'tabular-nums'}}>{value}</div>
        <div style={{fontSize:11,color:T.text3,marginTop:2}}>{label}</div>
      </div>
    </a>
  )
}

function StatusChip({ status }: { status: string }) {
  const color = STATUS_COLOR[status] || T.text3
  return (
    <span style={{fontSize:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em',color,background:`${color}15`,border:`1px solid ${color}40`,padding:'2px 8px',borderRadius:4,whiteSpace:'nowrap'}}>
      {STATUS_LABEL[status] || status}
    </span>
  )
}

function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{
        fontSize:13,color:T.text2,textDecoration:'none',
        padding:'6px 10px',borderRadius:5,border:`1px solid ${T.border2}`,
      }}>
      {label} ↗
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
