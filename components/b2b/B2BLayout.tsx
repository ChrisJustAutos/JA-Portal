// components/b2b/B2BLayout.tsx
//
// Shared layout for the distributor (B2B) portal — "Alloy" design refresh
// (Chris 2026-08-12). Native-app feel on mobile: compact header + fixed
// 5-tab bottom nav (Shop / Cart / Orders / Jobs / More — the long tail lives
// in a More sheet). Desktop keeps pill nav inline with the header, and the
// rare actions (refresh, sign out, account switch) fold into an avatar menu.
//
// Distributor pages call this as a wrapper:
//
//   <B2BLayout user={b2bUser} active="catalogue">
//     ...page content...
//   </B2BLayout>

import React, { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'
import { useIsMobile } from '../../lib/useIsMobile'
import { AppIcon } from '../../lib/AppIcons'
import { T, alpha } from '../../lib/ui/theme'
import { enableNotifications, keepPushFresh, installPushAutoHeal } from '../../lib/pushClient'
import B2BNotificationBell from './B2BNotificationBell'
import { A, RADIUS, SHADOW, AlloyStyles, Btn } from './ui'

const B2B_SUBSCRIBE_URL = '/api/b2b/notifications/push-subscribe'

type ActiveNav = 'catalogue' | 'cart' | 'orders' | 'jobs' | 'assets' | 'training' | 'team' | 'account' | null

interface Props {
  user: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    preview?: boolean
    distributor: {
      id: string
      displayName: string
    }
    memberships?: { distributorId: string; displayName: string; role: string }[] | null
  }
  active?: ActiveNav
  children: React.ReactNode
  /** Optional small badge next to "Cart" link (e.g. line count) */
  cartCount?: number
}

// `icon` is an AppIcons name (lucide-style SVG) so the distributor
// portal matches the staff launcher's look.
const NAV_ITEMS: Array<{ id: ActiveNav; label: string; href: string; icon: string }> = [
  { id: 'catalogue', label: 'Shop',      href: '/b2b/catalogue', icon: 'catalogue' },
  { id: 'cart',      label: 'Cart',      href: '/b2b/cart',      icon: 'cart' },
  { id: 'orders',    label: 'Orders',    href: '/b2b/orders',    icon: 'orders' },
  { id: 'jobs',      label: 'Jobs',      href: '/b2b/jobs',      icon: 'jobs' },
  { id: 'assets',    label: 'Resources', href: '/b2b/assets',    icon: 'reports' },
  { id: 'team',      label: 'Team',      href: '/b2b/team',      icon: 'team' },
  { id: 'account',   label: 'Settings',  href: '/b2b/settings',  icon: 'workshop-settings' },
]

// Training is ASSIGNED coursework (migration 192) — the tab only renders when
// the signed-in membership has ≥1 visible module (see nav-count fetch below).
// It slots in between Resources and Team.
const TRAINING_ITEM: { id: ActiveNav; label: string; href: string; icon: string } =
  { id: 'training', label: 'Training', href: '/b2b/training', icon: 'call-coaching' }
const TRAINING_NAV_POS = 5   // after Resources

// Mobile bottom nav shows the 4 everyday tabs; everything else lives in More.
const MOBILE_TAB_IDS: ActiveNav[] = ['catalogue', 'cart', 'orders', 'jobs']

export default function B2BLayout({ user, active = null, children, cartCount }: Props) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [menuOpen, setMenuOpen] = useState(false)       // avatar menu
  const [moreOpen, setMoreOpen] = useState(false)       // mobile More sheet
  const [refreshing, setRefreshing] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Assigned-training gate: one cheap fetch per mount; the Training tab only
  // appears for memberships with ≥1 visible module.
  const [trainingCount, setTrainingCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch('/api/b2b/training/nav-count', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setTrainingCount(Number(d.count) || 0) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const navItems = trainingCount > 0
    ? [...NAV_ITEMS.slice(0, TRAINING_NAV_POS), TRAINING_ITEM, ...NAV_ITEMS.slice(TRAINING_NAV_POS)]
    : NAV_ITEMS

  const mobileTabs = navItems.filter(i => MOBILE_TAB_IDS.includes(i.id))
  const moreItems  = navItems.filter(i => !MOBILE_TAB_IDS.includes(i.id))
  const moreActive = moreItems.some(i => i.id === active)

  // Close the avatar menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  async function signOut() {
    try { await getSupabase().auth.signOut() } catch {}
    try {
      await fetch('/api/b2b/auth/session', { method: 'DELETE', credentials: 'same-origin' })
    } catch {}
    router.replace('/b2b/login')
  }

  // Multi-site people (one login, several distributor accounts) switch from
  // inside the avatar menu.
  const memberships = user.memberships || []
  const multiAccount = memberships.length > 1
  async function switchAccount(distributorId: string) {
    if (distributorId === user.distributor.id) { setMenuOpen(false); return }
    try {
      const r = await fetch('/api/b2b/session/switch', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distributor_id: distributorId }),
      })
      if (r.ok) window.location.href = '/b2b/catalogue'
    } catch {}
  }

  const initials = (user.fullName || user.email || '?')
    .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('') || '?'

  return (
    <div style={{
      minHeight:'100vh',
      background:T.bg, color:T.text,
      // Reserve space at the bottom for the mobile nav bar so content
      // doesn't sit underneath it. 64px bar + safe-area inset.
      paddingBottom: isMobile ? `calc(64px + env(safe-area-inset-bottom))` : 0,
    }}>
      <AlloyStyles/>

      {user.preview && (
        <div style={{
          position:'sticky', top:0, zIndex:50, background:A.warn, color:'#1a1205',
          fontSize:12, fontWeight:700, textAlign:'center', padding:'6px 12px',
          letterSpacing:0.3,
        }}>
          READ-ONLY PREVIEW · viewing {user.distributor.displayName}'s portal · actions are disabled
        </div>
      )}

      {/* ── Top header ─────────────────────────────────────────── */}
      <header style={{
        position:'sticky', top:0, zIndex:40,
        background:T.bg2, borderBottom:`1px solid ${T.border}`,
        padding: isMobile
          ? `calc(env(safe-area-inset-top) + 10px) 16px 10px`
          : '10px 24px',
        display:'flex', alignItems:'center', gap: isMobile ? 10 : 20,
      }}>
        <a href="/b2b/catalogue" style={{textDecoration:'none', color:T.text, display:'flex', alignItems:'baseline', gap:8, minWidth:0, flexShrink:0}}>
          <span style={{fontSize:15, fontWeight:700, letterSpacing:'-0.02em', whiteSpace:'nowrap'}}>Just Autos</span>
          {!isMobile && <span style={{fontSize:12.5, color:T.text3, fontWeight:500}}>Distributors</span>}
        </a>

        {/* Desktop nav — pills */}
        {!isMobile && (
          <nav style={{display:'flex', gap:2, marginLeft:8, flexWrap:'wrap'}}>
            {navItems.map(item => (
              <NavPill key={item.id} href={item.href} active={active === item.id}
                badge={item.id === 'cart' ? cartCount : undefined}>
                {item.label}
              </NavPill>
            ))}
          </nav>
        )}

        <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap: isMobile ? 6 : 10, minWidth:0}}>
          {isMobile && (
            <div style={{fontSize:12.5, color:T.text2, fontWeight:550, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:150}}>
              {user.distributor.displayName}
            </div>
          )}
          <B2BNotificationBell isMobile={isMobile}/>

          {/* Avatar → account menu (identity, switcher, refresh, sign out) */}
          <div ref={menuRef} style={{position:'relative'}}>
            <button onClick={() => setMenuOpen(o => !o)} className="al-press al-focus"
              aria-label="Account menu" aria-expanded={menuOpen}
              style={{
                width:38, height:38, borderRadius:RADIUS.pill, border:'none', cursor:'pointer',
                background: alpha(A.accent, '2b'), color:A.accent,
                fontSize:13, fontWeight:700, fontFamily:'inherit',
                display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0,
              }}>
              {initials}
            </button>
            {menuOpen && (
              <div style={{
                position:'absolute', right:0, top:46, width:260, zIndex:60,
                background:T.bg2, border:`1px solid ${T.border}`, borderRadius:RADIUS.md,
                boxShadow:SHADOW.md, overflow:'hidden',
              }}>
                <div style={{padding:'14px 16px 12px', borderBottom:`1px solid ${T.border}`}}>
                  <div style={{fontSize:14, fontWeight:650, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {user.distributor.displayName}
                  </div>
                  <div style={{fontSize:12, color:T.text3, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                    {user.fullName || user.email}{user.role === 'owner' ? ' · owner' : ''}
                  </div>
                </div>
                {multiAccount && (
                  <div style={{padding:'10px 16px', borderBottom:`1px solid ${T.border}`}}>
                    <div style={{fontSize:12, color:T.text3, fontWeight:600, marginBottom:6}}>Switch account</div>
                    <div style={{display:'flex', flexDirection:'column', gap:2}}>
                      {memberships.map(m => {
                        const on = m.distributorId === user.distributor.id
                        return (
                          <button key={m.distributorId} onClick={() => switchAccount(m.distributorId)} className="al-press al-ghost"
                            style={{
                              textAlign:'left', padding:'8px 10px', borderRadius:RADIUS.sm, border:'none',
                              background: on ? T.bg3 : 'transparent', color: on ? T.text : T.text2,
                              fontSize:13, fontWeight: on ? 600 : 450, fontFamily:'inherit', cursor:'pointer',
                              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                            }}>
                            {m.displayName}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                <div style={{padding:8, display:'flex', flexDirection:'column', gap:2}}>
                  <MenuItem
                    label={refreshing ? 'Refreshing…' : 'Refresh the portal'}
                    hint="Clears stale data, loads the latest version"
                    disabled={refreshing}
                    onClick={() => { setRefreshing(true); window.location.reload() }}/>
                  <MenuItem label="Sign out" onClick={signOut}/>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Notifications opt-in banner ───────────────────────── */}
      <B2BNotifyBanner isMobile={isMobile} />

      {/* ── Main content ──────────────────────────────────────── */}
      <main style={{
        maxWidth:1280, margin:'0 auto',
        padding: isMobile ? '16px 14px 28px' : '26px 24px 60px',
      }}>
        {children}
      </main>

      {/* ── Mobile bottom nav (4 everyday tabs + More) ────────── */}
      {isMobile && (
        <>
          <nav style={{
            position:'fixed', left:0, right:0, bottom:0, zIndex:50,
            background: T.bg2,
            borderTop: `1px solid ${T.border}`,
            paddingBottom: 'env(safe-area-inset-bottom)',
            boxShadow: '0 -4px 16px rgba(0,0,0,0.25)',
          }}>
            <div style={{display:'grid', gridTemplateColumns:'repeat(5, 1fr)', height:64}}>
              {mobileTabs.map(item => (
                <MobileTab key={item.id} href={item.href} icon={item.icon} label={item.label}
                  active={active === item.id}
                  badge={item.id === 'cart' ? cartCount : undefined}/>
              ))}
              <MobileTab icon="" label="More" active={moreActive} onClick={() => setMoreOpen(true)}
                customIcon={<MoreDots active={moreActive}/>}/>
            </div>
          </nav>

          {/* More sheet */}
          {moreOpen && (
            <div onClick={() => setMoreOpen(false)} style={{
              position:'fixed', inset:0, zIndex:70, background:'rgba(0,0,0,0.45)',
              display:'flex', alignItems:'flex-end',
            }}>
              <div onClick={e => e.stopPropagation()} style={{
                width:'100%', background:T.bg2,
                borderRadius:'20px 20px 0 0', boxShadow:SHADOW.md,
                padding:`10px 14px calc(16px + env(safe-area-inset-bottom))`,
              }}>
                <div style={{width:38, height:5, borderRadius:RADIUS.pill, background:T.bg4, margin:'2px auto 12px'}}/>
                {moreItems.map(item => {
                  const on = active === item.id
                  return (
                    <a key={item.id} href={item.href} style={{
                      display:'flex', alignItems:'center', gap:14,
                      padding:'13px 12px', borderRadius:RADIUS.sm + 2,
                      textDecoration:'none', minHeight:48, boxSizing:'border-box',
                      color: on ? T.text : T.text2,
                      background: on ? T.bg3 : 'transparent',
                    }}>
                      <span style={{display:'flex', color: on ? A.accent : T.text3}}><AppIcon name={item.icon} size={20}/></span>
                      <span style={{fontSize:15, fontWeight: on ? 600 : 500}}>{item.label}</span>
                    </a>
                  )
                })}
                <div style={{marginTop:10}}>
                  <Btn variant="secondary" full onClick={() => setMoreOpen(false)}>Close</Btn>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function MenuItem({ label, hint, disabled, onClick }: { label: string; hint?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled} className="al-press al-ghost"
      style={{
        textAlign:'left', padding:'10px 10px', borderRadius:RADIUS.sm, border:'none',
        background:'transparent', color:T.text, fontSize:13.5, fontWeight:550,
        fontFamily:'inherit', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
        minHeight:44, width:'100%',
        display:'flex', flexDirection:'column', justifyContent:'center', gap:2,
      }}>
      {label}
      {hint && <span style={{fontSize:11.5, color:T.text3, fontWeight:400}}>{hint}</span>}
    </button>
  )
}

function NavPill({ href, active, badge, children }: {
  href: string; active?: boolean; badge?: number; children: React.ReactNode
}) {
  return (
    <a href={href} className="al-press"
      style={{
        padding:'8px 15px', borderRadius:RADIUS.pill,
        fontSize:13.5, fontWeight:550, minHeight:38, boxSizing:'border-box',
        color: active ? T.text : T.text2,
        background: active ? T.bg3 : 'transparent',
        textDecoration:'none',
        display:'inline-flex', alignItems:'center', gap:7,
      }}>
      {children}
      {badge != null && badge > 0 && (
        <span style={{
          fontSize:11, fontWeight:700, lineHeight:1,
          background: A.accent, color:'#fff',
          borderRadius:RADIUS.pill, padding:'3px 7px', minWidth:12, textAlign:'center',
        }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </a>
  )
}

function MobileTab({ href, icon, customIcon, label, active, badge, onClick }: {
  href?: string; icon: string; customIcon?: React.ReactNode; label: string
  active?: boolean; badge?: number; onClick?: () => void
}) {
  const inner = (
    <>
      <span style={{lineHeight:1, display:'flex'}}>
        {customIcon || <AppIcon name={icon} size={21}/>}
      </span>
      <span style={{fontSize:10.5, fontWeight: active ? 650 : 500, letterSpacing:'0.02em'}}>{label}</span>
      {badge != null && badge > 0 && (
        <span style={{
          position:'absolute', top:7, right:'24%',
          minWidth:17, height:17, padding:'0 5px', boxSizing:'border-box',
          background: A.accent, color:'#fff',
          fontSize:10, fontWeight:700,
          borderRadius:RADIUS.pill,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </>
  )
  const style: React.CSSProperties = {
    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
    gap:3, textDecoration:'none', position:'relative',
    color: active ? A.accent : T.text3,
    background:'none', border:'none', fontFamily:'inherit', cursor:'pointer', padding:0,
  }
  if (onClick) return <button onClick={onClick} className="al-press" style={style}>{inner}</button>
  return <a href={href} style={style}>{inner}</a>
}

// Three-dot glyph for the More tab (AppIcons has no ellipsis icon).
function MoreDots({ active }: { active?: boolean }) {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.9"/>
      <circle cx="12" cy="12" r="1.9"/>
      <circle cx="19" cy="12" r="1.9"/>
    </svg>
  )
}

// Slim opt-in banner for order/shipping push notifications. Auto-subscribes
// if permission is already granted; prompts (on click — required by browsers)
// when undecided; dismissible so it doesn't nag.
function B2BNotifyBanner({ isMobile }: { isMobile: boolean }) {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported' | 'loading'>('loading')
  const [dismissed, setDismissed] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (typeof Notification === 'undefined') { setPerm('unsupported'); return }
    setPerm(Notification.permission)
    setDismissed(localStorage.getItem('ja-b2b-notif-dismissed') === '1')
    if (Notification.permission === 'granted') keepPushFresh(B2B_SUBSCRIBE_URL)  // self-heal stale iOS subs
    installPushAutoHeal(B2B_SUBSCRIBE_URL)                                        // re-arm on app update
  }, [])

  if (perm !== 'default' || dismissed) return null
  return (
    <div style={{
      maxWidth: 1280, margin: '0 auto',
      padding: isMobile ? '10px 14px 0' : '14px 24px 0',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: alpha(A.accent, '14'), border: `1px solid ${alpha(A.accent, '38')}`,
        borderRadius: RADIUS.sm + 2, padding: '10px 14px', fontSize: 13.5, color: T.text,
      }}>
        <span style={{ display:'flex', color: A.accent }}><AppIcon name="messages" size={18}/></span>
        <span style={{ flex: 1, lineHeight: 1.45 }}>Turn on notifications for order confirmations &amp; shipping updates.</span>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { const p = await enableNotifications(B2B_SUBSCRIBE_URL); setPerm(p) } finally { setBusy(false) } }}
          className="al-press al-primary al-focus"
          style={{ background: A.accent, border: 'none', color: '#fff', borderRadius: RADIUS.pill, padding: '9px 18px', minHeight: 38, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          {busy ? '…' : 'Enable'}
        </button>
        <button
          onClick={() => { setDismissed(true); try { localStorage.setItem('ja-b2b-notif-dismissed', '1') } catch {} }}
          aria-label="Dismiss"
          style={{ background: 'none', border: 'none', color: T.text3, fontSize: 17, lineHeight: 1, cursor: 'pointer', padding: '0 2px' }}>×</button>
      </div>
    </div>
  )
}
