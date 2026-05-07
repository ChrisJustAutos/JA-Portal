// components/b2b/B2BLayout.tsx
//
// Shared layout for the distributor (B2B) portal. Sticky top nav with
// brand, primary nav links, distributor name, and sign-out.
//
// Distributor pages call this as a wrapper:
//
//   <B2BLayout user={b2bUser} active="catalogue">
//     ...page content...
//   </B2BLayout>

import React from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'

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

export default function B2BLayout({ user, active = null, children, cartCount }: Props) {
  const router = useRouter()

  async function signOut() {
    try { await getSupabase().auth.signOut() } catch {}
    try {
      await fetch('/api/b2b/auth/session', { method: 'DELETE', credentials: 'same-origin' })
    } catch {}
    router.replace('/b2b/login')
  }

  return (
    <div style={{minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>

      {/* Sticky top nav */}
      <header style={{
        position:'sticky',top:0,zIndex:40,
        background:T.bg2,borderBottom:`1px solid ${T.border}`,
        padding:'10px 24px',
        display:'flex',alignItems:'center',gap:24,
      }}>
        <a href="/b2b/catalogue" style={{textDecoration:'none',display:'flex',alignItems:'baseline',gap:10}}>
          <span style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.12em',fontWeight:600}}>
            Just Autos
          </span>
          <span style={{fontSize:13,color:T.text,fontWeight:500}}>Distributor Portal</span>
        </a>

        <nav style={{display:'flex',gap:4,marginLeft:16}}>
          <NavLink href="/b2b/catalogue" active={active === 'catalogue'}>Catalogue</NavLink>
          <NavLink href="/b2b/cart"      active={active === 'cart'} badge={cartCount}>Cart</NavLink>
          <NavLink href="/b2b/orders"    active={active === 'orders'}>Orders</NavLink>
          <NavLink href="/b2b/team"      active={active === 'team'}>Team</NavLink>
        </nav>

        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:14}}>
          <div style={{textAlign:'right'}}>
            <div style={{fontSize:13,color:T.text,fontWeight:500}}>{user.distributor.displayName}</div>
            <div style={{fontSize:10,color:T.text3,marginTop:1}}>
              {user.fullName || user.email}
              {user.role === 'owner' && <span style={{marginLeft:6,color:T.blue}}>· owner</span>}
            </div>
          </div>
          <button onClick={signOut}
            style={{
              padding:'6px 12px',borderRadius:5,
              border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,
              fontSize:12,cursor:'pointer',fontFamily:'inherit',
            }}>
            Sign out
          </button>
        </div>
      </header>

      <main style={{maxWidth:1280,margin:'0 auto',padding:'24px 24px 60px'}}>
        {children}
      </main>
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
    fontSize:13,fontWeight:500,
    color: disabled ? T.text3 : (active ? T.text : T.text2),
    background: active ? T.bg3 : 'transparent',
    border: `1px solid ${active ? T.border2 : 'transparent'}`,
    textDecoration:'none',
    display:'inline-flex',alignItems:'center',gap:6,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
  const label = (
    <>
      {children}
      {badge != null && badge > 0 && (
        <span style={{
          fontSize:10,fontWeight:600,
          background: active ? T.blue : T.bg4,
          color: active ? '#fff' : T.text2,
          borderRadius:8,padding:'1px 6px',minWidth:14,textAlign:'center',
        }}>
          {badge}
        </span>
      )}
    </>
  )
  if (disabled) return <span style={style}>{label}</span>
  return <a href={href} style={style}>{label}</a>
}
