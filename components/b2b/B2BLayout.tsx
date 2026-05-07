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

import React from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'
import { useIsMobile } from '../../lib/useIsMobile'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e',
}

type ActiveNav = 'catalogue' | 'cart' | 'orders' | 'team' | null

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

const NAV_ITEMS: Array<{ id: ActiveNav; label: string; href: string; icon: string }> = [
  { id: 'catalogue', label: 'Shop',   href: '/b2b/catalogue', icon: '🛍️' },
  { id: 'cart',      label: 'Cart',   href: '/b2b/cart',      icon: '🛒' },
  { id: 'orders',    label: 'Orders', href: '/b2b/orders',    icon: '📦' },
  { id: 'team',      label: 'Team',   href: '/b2b/team',      icon: '👥' },
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
                  <span style={{fontSize:20, lineHeight:1, opacity: on ? 1 : 0.85}}>{item.icon}</span>
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

function NavLink({
  href, active, disabled, badge, children,
}: {
  href: string
  active?: boolean
  disabled?: boolean
  badge?: number
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
    display:'inline-flex', alignItems:'center', gap:6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
  const label = (
    <>
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
