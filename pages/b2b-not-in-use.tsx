// pages/b2b-not-in-use.tsx
// Shown in place of the retired B2B sections (Stock Wall, Suppliers).
//
// Reached by rewrite from next.config.js, so the browser URL stays on the page
// the person actually asked for — an old /admin/b2b/suppliers bookmark still
// reads that way and explains itself, rather than silently bouncing somewhere
// else. See lib/b2b-sections.js.
//
// Deliberately NOT under /admin, so the one notice can also cover the
// supplier-facing /b2b/supplier route without pulling staff auth into it.

import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import { requirePageAuth } from '../lib/authServer'
import type { PortalUserSSR } from '../lib/authServer'
import { T, alpha } from '../lib/ui/theme'
import { A, RADIUS, Btn, cardStyle } from '../components/b2b/ui'

const { B2B_SECTIONS } = require('../lib/b2b-sections')

export default function B2BNotInUse({ user, label, why }: { user: PortalUserSSR; label: string; why: string }) {
  const router = useRouter()
  return (
    <>
      <Head><title>{label} — not in use</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName} currentUserEmail={user.email}/>
        <main style={{ padding: '40px 20px', maxWidth: 620, margin: '0 auto' }}>
          <section style={{ ...cardStyle(true), display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{
              alignSelf: 'flex-start', fontSize: 12, fontWeight: 600, padding: '4px 11px',
              borderRadius: RADIUS.pill, background: alpha(A.warn, '1f'), color: A.warn,
            }}>
              Switched off
            </span>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.02em' }}>
              {label} is no longer in use
            </h1>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: T.text2 }}>{why}</p>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: T.text3 }}>
              Nothing has been deleted — the screen and its data are still here, just off the menu.
              If you need it back, ask Chris.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <Btn size="sm" onClick={() => router.push('/admin/b2b')}>Back to B2B</Btn>
              <Btn variant="ghost" size="sm" onClick={() => router.push('/home')}>Home</Btn>
            </div>
          </section>
        </main>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const gate = await requirePageAuth(context, 'view:b2b')
  if (!('props' in gate)) return gate
  const id = String(context.query?.section || '')
  const section = B2B_SECTIONS.find((s: any) => s.id === id)
  return {
    props: {
      ...(gate as any).props,
      label: section?.label || 'This section',
      why: section?.why || 'It has been switched off because it is no longer needed.',
    },
  }
}
