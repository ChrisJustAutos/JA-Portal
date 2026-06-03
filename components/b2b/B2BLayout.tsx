// components/b2b/B2BLayout.tsx
//
// Shared layout for the distributor (B2B) portal. Native-app feel on
// mobile: condensed top bar (brand + sign-out icon) with a fixed bottom
// nav bar; desktop keeps the wider top nav.
//
// Distributor pages call this as a wrapper:
//
//   <B2BLayout user={b2bUser} active="catalogue">
//     ...page content...
//   </B2BLayout>

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'
import { useIsMobile } from '../../lib/useIsMobile'
import { AppIcon } from '../../lib/AppIcons'
import { enableNotifications, ensurePushSubscription } from '../../lib/pushClient'

const B2B_SUBSCRIBE_URL = '/api/b2b/notifications/push-subscribe'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e',
}

type ActiveNav = 'catalogue' | 'cart' | 'orders' | 'team' | 'account' | null

interface Props {
  user: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: {
      id: string
      displayName: string
    }
  }
  active?: ActiveNav
  children: React.ReactNode
  /** Optional small badge next to "Cart" link (e.g. line count) */
  cartCount?: number
}

// `icon` is an AppIcons name (lucide-style SVG) so the distributor
// portal matches the staff launcher's look.
const NAV_ITEMS: Array<{ id: ActiveNav; label: string; href: string; icon: string }> = [
  { id: 'catalogue', label: 'Shop',   href: '/b2b/catalogue', icon: 'catalogue' },
  { id: 'cart',      label: 'Cart',   href: '/b2b/cart',      icon: 'cart' },
  { id: 'orders',    label: 'Orders', href: '/b2b/orders',    icon: 'orders' },
  { id: 'team',      label: 'Team',   href: '/b2b/team',      icon: 'team' },
  { id: 'account',   label: 'Settings', href: '/b2b/settings', icon: 'workshop-settings' },
]

export default function B2BLayout({ user, active = null, children, cartCount }: Props) {
  const router = useRouter()
  const isMobile = useIsMobile()

  async function signOut() {
    try { await getSupabase().auth.signOut() } catch {}
    try {
      await fetch('/api/b2b/auth/session', { method: 'DELETE', credentials: 'same-origin' })
    } catch {}
    router.replace('/b2b/login')
  }

  return (
    <div style={{
      minHeight:'100vh',
      background:T.bg,color:T.text,
      // Reserve space at the bottom for the mobile nav bar so content
      // doesn't sit underneath it. 64px bar + safe-area inset.
      paddingBottom: isMobile ? `calc(64px + env(safe-area-inset-bottom))` : 0,
    }}>

      {/* ── Top header ─────────────────────────────────────────── */}
      <header style={{
        position:'sticky', top:0, zIndex:40,
        background:T.bg2, borderBottom:`1px solid ${T.border}`,
        padding: isMobile
          ? `calc(env(safe-area-inset-top) + 10px) 16px 10px`
          : '10px 24px',
        display:'flex', alignItems:'center', gap: isMobile ? 12 : 24,
      }}>
        <a href="/b2b/catalogue" style={{textDecoration:'none', display:'flex', alignItems:'baseline', gap: isMobile ? 6 : 10, minWidth:0}}>
          <span style={{
            fontSize: isMobile ? 11 : 12, color:T.text3,
            textTransform:'uppercase', letterSpacing:'0.12em', fontWeight:600,
          }}>
            Just Autos
          </span>
          {!isMobile && (
            <span style={{fontSize:13, color:T.text, fontWeight:500}}>Distributor Portal</span>
          )}
        </a>

        {/* Desktop nav inline with header */}
        {!isMobile && (
          <nav style={{display:'flex', gap:4, marginLeft:16}}>
            {NAV_ITEMS.map(item => (
              <NavLink
                key={item.id}
                href={item.href}
                active={active === item.id}
                iconName={item.icon}
                badge={item.id === 'cart' ? cartCount : undefined}>
                {item.label === 'Shop' ? 'Catalogue' : item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div style={{
          marginLeft:'auto',
          display:'flex', alignItems:'center', gap: isMobile ? 8 : 14,
          minWidth:0,
        }}>
          {!isMobile && (
            <div style={{textAlign:'right', minWidth:0}}>
              <div style={{fontSize:13, color:T.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {user.distributor.displayName}
              </div>
              <div style={{fontSize:10, color:T.text3, marginTop:1}}>
                {user.fullName || user.email}
                {user.role === 'owner' && <span style={{marginLeft:6, color:T.blue}}>· owner</span>}
              </div>
            </div>
          )}
          {isMobile && (
            // Mobile: just show distributor name (compact). No personal email
            // — keeps the bar uncluttered. Sign-out is still one tap away.
            <div style={{
              fontSize:12, color:T.text2, fontWeight:500,
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
              maxWidth:180,
            }}>
              {user.distributor.displayName}
            </div>
          )}
          <button onClick={signOut} title="Sign out"
            style={{
              padding: isMobile ? '8px 10px' : '6px 12px',
              borderRadius:5,
              border:`1px solid ${T.border2}`, background:'transparent', color:T.text2,
              fontSize:12, cursor:'pointer', fontFamily:'inherit',
              minHeight: 36,
            }}>
            {isMobile ? '↪' : 'Sign out'}
          </button>
        </div>
      </header>

      {/* ── Notifications opt-in banner ───────────────────────── */}
      <B2BNotifyBanner isMobile={isMobile} />

      {/* ── Main content ──────────────────────────────────────── */}
      <main style={{
        maxWidth:1280, margin:'0 auto',
        padding: isMobile ? '14px 14px 24px' : '24px 24px 60px',
      }}>
        {children}
      </main>

      {/* ── Mobile bottom nav ─────────────────────────────────── */}
      {isMobile && (
        <nav style={{
          position:'fixed', left:0, right:0, bottom:0, zIndex:50,
          background: T.bg2,
          borderTop: `1px solid ${T.border2}`,
          paddingBottom: 'env(safe-area-inset-bottom)',
          boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
        }}>
          <div style={{
            display:'grid', gridTemplateColumns: `repeat(${NAV_ITEMS.length}, 1fr)`,
            height: 64,
          }}>
            {NAV_ITEMS.map(item => {
              const on = active === item.id
              const showBadge = item.id === 'cart' && cartCount != null && cartCount > 0
              return (
                <a key={item.id} href={item.href}
                  style={{
                    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                    gap:2, textDecoration:'none',
                    color: on ? T.blue : T.text3,
                    position:'relative',
                  }}>
                  <span style={{lineHeight:1, opacity: on ? 1 : 0.85, display:'flex'}}><AppIcon name={item.icon} size={21}/></span>
                  <span style={{
                    fontSize:10, fontWeight: on ? 600 : 500,
                    letterSpacing:'0.02em',
                  }}>
                    {item.label}
                  </span>
                  {showBadge && (
                    <span style={{
                      position:'absolute', top:6, right:'25%',
                      minWidth:18, height:18, padding:'0 5px',
                      background: T.blue, color:'#fff',
                      fontSize:10, fontWeight:600,
                      borderRadius:9,
                      display:'flex', alignItems:'center', justifyContent:'center',
                      boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
                    }}>
                      {cartCount! > 99 ? '99+' : cartCount}
                    </span>
                  )}
                  {on && (
                    <span style={{
                      position:'absolute', top:0, left:'25%', right:'25%',
                      height:2, background: T.blue, borderRadius:'0 0 2px 2px',
                    }}/>
                  )}
                </a>
              )
            })}
          </div>
        </nav>
      )}
    </div>
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
    if (Notification.permission === 'granted') ensurePushSubscription(B2B_SUBSCRIBE_URL)
  }, [])

  if (perm !== 'default' || dismissed) return null
  return (
    <div style={{
      maxWidth: 1280, margin: '0 auto',
      padding: isMobile ? '10px 14px 0' : '14px 24px 0',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'rgba(79,142,247,0.12)', border: `1px solid ${T.blue}55`,
        borderRadius: 10, padding: '10px 12px', fontSize: 13, color: T.text,
      }}>
        <span style={{ fontSize: 16 }}>🔔</span>
        <span style={{ flex: 1 }}>Turn on notifications for order confirmations & shipping updates.</span>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { const p = await enableNotifications(B2B_SUBSCRIBE_URL); setPerm(p) } finally { setBusy(false) } }}
          style={{ background: T.blue, border: 'none', color: '#fff', borderRadius: 7, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
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

function NavLink({
  href, active, disabled, badge, iconName, children,
}: {
  href: string
  active?: boolean
  disabled?: boolean
  badge?: number
  iconName?: string
  children: React.ReactNode
}) {
  const style: React.CSSProperties = {
    padding:'7px 13px',
    borderRadius:6,
    fontSize:13, fontWeight:500,
    color: disabled ? T.text3 : (active ? T.text : T.text2),
    background: active ? T.bg3 : 'transparent',
    border: `1px solid ${active ? T.border2 : 'transparent'}`,
    textDecoration:'none',
    display:'inline-flex', alignItems:'center', gap:7,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
  const label = (
    <>
      {iconName && <span style={{display:'flex', color: active ? T.blue : T.text3}}><AppIcon name={iconName} size={16}/></span>}
      {children}
      {badge != null && badge > 0 && (
        <span style={{
          fontSize:10, fontWeight:600,
          background: active ? T.blue : T.bg4,
          color: active ? '#fff' : T.text2,
          borderRadius:8, padding:'1px 6px', minWidth:14, textAlign:'center',
        }}>
          {badge}
        </span>
      )}
    </>
  )
  if (disabled) return <span style={style}>{label}</span>
  return <a href={href} style={style}>{label}</a>
}
