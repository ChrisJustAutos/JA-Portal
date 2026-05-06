// pages/admin/b2b.tsx
// B2B Portal admin landing page.
//
// Today: catalogue sync button + status count tiles + result display.
// Will grow into the full staff admin surface (distributors, catalogue grid
// with image upload, orders list, settings) over Phase 2.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import type { UserRole } from '../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
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

interface CatalogueStats {
  total: number
  visible: number
  priced: number
  lastSyncAt: string | null
  lastSyncAdded: number | null
  lastSyncUpdated: number | null
  lastSyncError: string | null
}

interface SyncResult {
  totalScanned: number
  added: number
  updated: number
  unchanged: number
  skipped: number
  errors: Array<{ uid: string; sku: string; error: string }>
  durationMs: number
  startedAt: string
  finishedAt: string
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0)         return 'in the future'
  if (ms < 60_000)    return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export default function B2BAdminPage({ user }: Props) {
  const [stats, setStats] = useState<CatalogueStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)

  async function loadStats() {
    setStatsLoading(true)
    try {
      const r = await fetch('/api/b2b/admin/catalogue/stats', { credentials: 'same-origin' })
      if (!r.ok) {
        const txt = await r.text()
        throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`)
      }
      const j = await r.json()
      setStats(j)
      setStatsError(null)
    } catch (e: any) {
      setStatsError(e?.message || String(e))
    } finally {
      setStatsLoading(false)
    }
  }

  useEffect(() => { loadStats() }, [])

  async function runSync() {
    if (syncing) return
    setSyncing(true)
    setSyncResult(null)
    setSyncError(null)
    try {
      const r = await fetch('/api/b2b/admin/catalogue/sync', {
        method: 'POST',
        credentials: 'same-origin',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setSyncResult(j)
      loadStats()
    } catch (e: any) {
      setSyncError(e?.message || String(e))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <Head><title>B2B Portal — Admin · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'32px 36px',maxWidth:1100}}>

          {/* Header */}
          <header style={{marginBottom:24}}>
            <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
              JAWS Distribution
            </div>
            <h1 style={{fontSize:24,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>
              B2B Portal — Admin
            </h1>
            <p style={{margin:'6px 0 0',color:T.text2,fontSize:13}}>
              Manage the JAWS distributor portal: catalogue sync, distributor accounts, orders.
              Distributor-facing pages will live at <code style={{color:T.teal,fontSize:12}}>/b2b/*</code>.
            </p>
          </header>

          {/* Catalogue stats grid */}
          <section style={{marginBottom:24}}>
            <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10}}>
              Catalogue
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}>
              <StatTile label="Total items"            value={stats?.total ?? null}   loading={statsLoading} color={T.blue}/>
              <StatTile label="Visible to distributors" value={stats?.visible ?? null} loading={statsLoading} color={T.green}/>
              <StatTile label="With trade price"       value={stats?.priced ?? null}  loading={statsLoading} color={T.teal}/>
              <StatTile label="Last sync"              display={relativeTime(stats?.lastSyncAt ?? null)} loading={statsLoading} color={T.text2}/>
            </div>
            {statsError && (
              <div style={{marginTop:10,padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:6,color:T.red,fontSize:12}}>
                Couldn't load stats: {statsError}
              </div>
            )}
          </section>

          {/* Sync card */}
          <section style={{
            background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
            padding:'18px 20px',marginBottom:14,
          }}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
              <div style={{flex:1,minWidth:240}}>
                <div style={{fontSize:14,fontWeight:600,marginBottom:3}}>Sync catalogue from MYOB</div>
                <div style={{fontSize:12,color:T.text2}}>
                  Pulls all active selling items from MYOB JAWS and upserts into the B2B catalogue.
                  Preserves visibility, trade prices, descriptions, and images on existing rows.
                </div>
                {stats?.lastSyncAdded != null && (
                  <div style={{fontSize:11,color:T.text3,marginTop:6,fontFamily:'monospace'}}>
                    Last run: +{stats.lastSyncAdded} added · ~{stats.lastSyncUpdated ?? 0} updated
                    {stats?.lastSyncError && <span style={{color:T.red}}> · {stats.lastSyncError}</span>}
                  </div>
                )}
              </div>
              <button
                onClick={runSync}
                disabled={syncing}
                style={{
                  padding:'9px 18px',borderRadius:6,
                  border:`1px solid ${syncing ? T.border2 : T.blue}`,
                  background: syncing ? T.bg3 : T.blue,
                  color: syncing ? T.text3 : '#fff',
                  fontSize:13,fontWeight:500,
                  cursor: syncing ? 'wait' : 'pointer',
                  transition:'all 120ms ease',
                  fontFamily:'inherit',
                  whiteSpace:'nowrap',
                }}>
                {syncing ? 'Syncing…' : 'Run sync'}
              </button>
            </div>

            {syncing && (
              <div style={{marginTop:14,fontSize:12,color:T.text3,fontStyle:'italic'}}>
                Pulling JAWS Inventory items… can take 30-90s for the full catalogue.
              </div>
            )}

            {syncError && (
              <div style={{marginTop:14,padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:6,color:T.red,fontSize:12}}>
                <strong>Sync failed:</strong> {syncError}
              </div>
            )}

            {syncResult && (
              <div style={{marginTop:14,padding:12,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:6,fontSize:12}}>
                <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(110px,1fr))',gap:10}}>
                  <ResultStat label="Scanned"   value={syncResult.totalScanned}                                    color={T.text}/>
                  <ResultStat label="Added"     value={syncResult.added}                                            color={T.green}/>
                  <ResultStat label="Updated"   value={syncResult.updated}                                          color={T.blue}/>
                  <ResultStat label="Unchanged" value={syncResult.unchanged}                                        color={T.text3}/>
                  <ResultStat label="Skipped"   value={syncResult.skipped ?? 0}                                     color={T.text3}/>
                  <ResultStat label="Errors"    value={syncResult.errors.length}                                    color={syncResult.errors.length ? T.red : T.text3}/>
                  <ResultStat label="Duration"  value={`${(syncResult.durationMs/1000).toFixed(1)}s`}              color={T.text2}/>
                </div>
                {syncResult.errors.length > 0 && (
                  <details style={{marginTop:12}}>
                    <summary style={{cursor:'pointer',color:T.amber,fontSize:12}}>
                      {syncResult.errors.length} error{syncResult.errors.length === 1 ? '' : 's'} — click to expand
                    </summary>
                    <div style={{marginTop:8,maxHeight:200,overflowY:'auto'}}>
                      {syncResult.errors.map((err, i) => (
                        <div key={i} style={{
                          padding:'6px 8px',marginBottom:4,
                          background:T.bg2,border:`1px solid ${T.border}`,borderRadius:4,
                          fontFamily:'monospace',fontSize:11,
                        }}>
                          <span style={{color:T.text3}}>{err.sku}</span>
                          {' — '}
                          <span style={{color:T.red}}>{err.error}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
          </section>

          {/* Quick links */}
          <section style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:10,marginBottom:24}}>
            <QuickLinkCard
              href="/admin/b2b/catalogue"
              title="Manage catalogue"
              subtitle="Toggle visibility · edit trade prices · upload images"
              ready
            />
            <QuickLinkCard
              href="#"
              title="Distributors"
              subtitle="Coming next — accounts and magic-link invites"
            />
            <QuickLinkCard
              href="#"
              title="Orders"
              subtitle="Coming after distributor surface goes live"
            />
          </section>

          {/* Coming next */}
          <section style={{padding:'14px 18px',background:T.bg2,border:`1px dashed ${T.border2}`,borderRadius:10,fontSize:12,color:T.text2}}>
            <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:6}}>
              Phase 2 — coming next
            </div>
            Catalogue management grid (visibility, trade prices, image upload),
            distributor accounts &amp; user invitations,
            orders list with status + MYOB writeback,
            and the distributor-facing surface at <code style={{color:T.teal}}>/b2b/login</code>.
          </section>

        </main>
      </div>
    </>
  )
}

// ─── Tile components ───────────────────────────────────────────────────

function StatTile({
  label, value, display, loading, color,
}: {
  label: string
  value?: number | null
  display?: string
  loading: boolean
  color: string
}) {
  const shown = loading ? '—' : (display ?? value ?? 0)
  return (
    <div style={{
      background:T.bg2,border:`1px solid ${T.border}`,borderRadius:8,
      padding:'14px 16px',
    }}>
      <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:4}}>
        {label}
      </div>
      <div style={{fontSize:22,fontWeight:600,color,fontVariantNumeric:'tabular-nums',lineHeight:1.1}}>
        {shown}
      </div>
    </div>
  )
}

function ResultStat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div>
      <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:2}}>
        {label}
      </div>
      <div style={{fontSize:16,fontWeight:600,color,fontVariantNumeric:'tabular-nums'}}>
        {value}
      </div>
    </div>
  )
}

function QuickLinkCard({
  href, title, subtitle, ready,
}: {
  href: string
  title: string
  subtitle: string
  ready?: boolean
}) {
  const disabled = href === '#'
  const Wrapper: any = disabled ? 'div' : 'a'
  return (
    <Wrapper
      {...(disabled ? {} : { href })}
      style={{
        display:'block',
        background: T.bg2,
        border: `1px solid ${ready ? T.blue : T.border}`,
        borderRadius:8,padding:'14px 16px',
        textDecoration:'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition:'transform 120ms ease, border-color 120ms ease',
      }}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6,marginBottom:4}}>
        <div style={{fontSize:13,fontWeight:600,color: ready ? T.blue : T.text}}>{title}</div>
        {!disabled && <span style={{color: ready ? T.blue : T.text3,fontSize:14}}>→</span>}
      </div>
      <div style={{fontSize:11,color:T.text3,lineHeight:1.4}}>{subtitle}</div>
    </Wrapper>
  )
}

// ─── Auth gate ─────────────────────────────────────────────────────────

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_catalogue')
}
