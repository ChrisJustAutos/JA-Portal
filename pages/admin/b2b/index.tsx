// pages/admin/b2b/index.tsx
//
// B2B admin hub. The sidebar's "B2B Portal" link points here, and from
// here staff can navigate to Catalogue / Distributors / Settings.
//
// Top-of-page also shows live numbers (catalogue count, distributors,
// recent paid orders) so it doubles as a quick health check.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import PortalSidebar from '../../../lib/PortalSidebar'
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

export default function B2BHubPage({ user }: Props) {
  const [settings, setSettings] = useState<SettingsSummary | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  function loadSettings() {
    fetch('/api/b2b/admin/settings', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setSettings(j) })
      .catch(() => { /* ignore */ })
  }

  useEffect(() => { loadSettings() }, [])

  async function runSync() {
    if (syncing) return
    setSyncing(true); setSyncResult(null); setSyncError(null)
    try {
      const r = await fetch('/api/b2b/admin/catalogue/sync', {
        method: 'POST',
        credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setSyncResult(j)
      loadSettings()
    } catch (e: any) {
      setSyncError(e?.message || String(e))
    } finally {
      setSyncing(false)
    }
  }

  const cfgComplete =
    !!settings?.stripe_env.secret_key_set &&
    !!settings?.stripe_env.webhook_secret_set &&
    !!settings?.settings.myob_card_fee_account_code

  return (
    <>
      <Head><title>B2B Portal · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1200}}>

          <header style={{marginBottom:24,display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16}}>
            <div>
              <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <span style={{color:T.text2}}>B2B Portal</span>
              </div>
              <h1 style={{fontSize:24,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>B2B distributor portal</h1>
              <div style={{fontSize:13,color:T.text3,marginTop:6}}>
                JAWS-side wholesale ordering. Distributors sign in at <a href="/b2b/login" style={{color:T.blue,textDecoration:'none'}}>/b2b/login</a> with magic links.
              </div>
            </div>
            <button
              onClick={runSync}
              disabled={syncing}
              style={{
                padding:'8px 14px',borderRadius:6,
                background: syncing ? T.bg3 : T.blue,
                border:`1px solid ${syncing ? T.border2 : T.blue}`,
                color: syncing ? T.text3 : '#fff',
                fontSize:13,fontWeight:500,fontFamily:'inherit',
                cursor: syncing ? 'wait' : 'pointer',whiteSpace:'nowrap',
              }}
            >
              {syncing ? 'Syncing…' : 'Sync from MYOB'}
            </button>
          </header>

          {/* Sync result / error */}
          {syncResult && (
            <div style={{
              padding:'10px 14px',marginBottom:14,borderRadius:6,fontSize:12,
              background:`${T.green}12`,border:`1px solid ${T.green}38`,color:T.text2,
              fontFamily:'monospace',
            }}>
              ✓ Sync complete · scanned {syncResult.totalScanned} · added {syncResult.added} · updated {syncResult.updated} · unchanged {syncResult.unchanged}
              {syncResult.skipped > 0 && ` · skipped ${syncResult.skipped}`}
              {syncResult.errors.length > 0 && ` · ${syncResult.errors.length} error${syncResult.errors.length === 1 ? '' : 's'}`}
              {' · '}
              {(syncResult.durationMs / 1000).toFixed(1)}s
            </div>
          )}
          {syncError && (
            <div style={{
              padding:'10px 14px',marginBottom:14,borderRadius:6,fontSize:12,
              background:`${T.red}12`,border:`1px solid ${T.red}38`,color:T.text2,
            }}>
              ✗ Sync failed: {syncError}
            </div>
          )}

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

          {/* Card grid */}
          <div style={{
            display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))',gap:18,
          }}>
            <Card
              href="/admin/b2b/catalogue"
              dot={T.teal}
              title="Catalogue"
              description="Set trade prices, upload images, control which items are visible to distributors."
              meta={settings?.settings.last_catalogue_sync_at
                ? `Last synced ${formatRel(settings.settings.last_catalogue_sync_at)}`
                : 'Not yet synced from MYOB'}
            />
            <Card
              href="/admin/b2b/distributors"
              dot={T.blue}
              title="Distributors"
              description="Add distributor accounts, link them to MYOB customers, manage their portal users."
            />
            <Card
              href="/admin/b2b/settings"
              dot={T.purple}
              title="Settings"
              description="Invoice numbering, card surcharge rates, Stripe + MYOB configuration, Slack notifications."
              meta={settings?.next_invoice_number_preview
                ? `Next invoice: ${settings.next_invoice_number_preview}`
                : undefined}
              warning={!cfgComplete}
            />
            <Card
              href="/admin/b2b/orders"
              dot={T.amber}
              title="Orders"
              description="Live orders dashboard with status transitions, refunds and shipping tracking."
            />
          </div>

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

function Card({
  href, dot, title, description, meta, warning, disabled,
}: {
  href: string | null
  dot: string
  title: string
  description: string
  meta?: string
  warning?: boolean
  disabled?: boolean
}) {
  const content = (
    <div style={{
      display:'flex',flexDirection:'column',gap:8,height:'100%',
      padding:'18px 20px',
      background:T.bg2,border:`1px solid ${warning ? T.amber + '60' : T.border}`,
      borderRadius:10,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1,
      transition:'border-color 0.15s, transform 0.1s',
    }}>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <div style={{width:10,height:10,borderRadius:'50%',background:dot,flexShrink:0}}/>
        <div style={{fontSize:14,fontWeight:600,color:T.text}}>{title}</div>
        {warning && <span style={{fontSize:14,color:T.amber}}>⚠</span>}
        {!disabled && <span style={{marginLeft:'auto',color:T.text3,fontSize:14}}>→</span>}
      </div>
      <div style={{fontSize:13,color:T.text2,lineHeight:1.5}}>{description}</div>
      {meta && (
        <div style={{fontSize:12,color:T.text3,marginTop:'auto',paddingTop:8,fontFamily:'monospace'}}>
          {meta}
        </div>
      )}
    </div>
  )

  if (disabled || !href) return <div>{content}</div>
  return <a href={href} style={{textDecoration:'none'}}>{content}</a>
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
