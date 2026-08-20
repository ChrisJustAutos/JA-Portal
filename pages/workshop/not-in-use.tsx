// pages/workshop/not-in-use.tsx
// Shown in place of the parked Workshop screens (diary, jobs, customers,
// vehicles, quotes, invoices, comms, workshop reports).
//
// Reached by rewrite from next.config.js, so the browser URL stays on the page
// the person actually asked for — an old /diary bookmark still reads /diary and
// explains itself, rather than silently bouncing somewhere else.
//
// The point is to stop someone entering real work into a system nobody reads:
// MechanicDesk is the workshop system of record. See lib/workshop-sections.js.

import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T, alpha } from '../../lib/ui/theme'
import { WORKSHOP_SECTIONS, WORKSHOP_LANDING } from '../../lib/workshop-sections'

export default function WorkshopNotInUse({ user, sectionLabel }: { user: PortalUserSSR; sectionLabel: string }) {
  const router = useRouter()

  return (
    <>
      <Head><title>{sectionLabel} — not in use</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <PortalTopBar
          activeId="diary"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <WorkshopTabs active={'inventory' as any} role={user.role} />

        <div style={{ maxWidth: 620, margin: '0 auto', padding: '64px 20px' }}>
          <div style={{
            background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14,
            padding: '28px 30px',
          }}>
            <div style={{
              display: 'inline-block', fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
              textTransform: 'uppercase', color: '#d97706', background: alpha('#d97706', '1f'),
              border: `1px solid ${alpha('#d97706', '59')}`, borderRadius: 999, padding: '3px 10px',
            }}>Not in use</div>

            <h1 style={{ fontSize: 21, fontWeight: 700, margin: '14px 0 10px' }}>
              {sectionLabel} isn&apos;t used in the portal
            </h1>

            <p style={{ color: T.text2, fontSize: 15, lineHeight: 1.68, margin: '0 0 12px' }}>
              The workshop runs on <strong>Mechanics Desk</strong> — bookings, job cards, customers,
              vehicles, quotes and invoicing all happen there. This screen was built for a changeover
              that is on hold, so anything entered here would reach nobody.
            </p>

            <p style={{ color: T.text2, fontSize: 15, lineHeight: 1.68, margin: '0 0 20px' }}>
              What the portal does handle around it — letters, the parts worklist, purchase orders,
              Pre&nbsp;Pick and stock counting — is still here and still live.
            </p>

            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              <button
                onClick={() => router.push(WORKSHOP_LANDING)}
                style={{
                  minHeight: 42, padding: '0 17px', borderRadius: 8, border: 'none',
                  background: T.accent, color: '#fff', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >Go to Inventory</button>
              <button
                onClick={() => router.push('/workshop/letters')}
                style={{
                  minHeight: 42, padding: '0 17px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${T.border}`, background: T.bg3, color: T.text,
                  fontSize: 14, fontWeight: 600, fontFamily: 'inherit',
                }}
              >Letters</button>
            </div>

            <p style={{ color: T.text3, fontSize: 12.5, lineHeight: 1.65, margin: '20px 0 0' }}>
              Think this should be switched back on? It is one flag in{' '}
              <code style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4 }}>lib/workshop-sections.js</code> —
              talk to Chris.
            </p>
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const gate = await requirePageAuth(context, 'view:diary')
  if ('redirect' in gate) return gate

  const id = typeof context.query?.section === 'string' ? context.query.section : ''
  const section = WORKSHOP_SECTIONS.find((s: any) => s.id === id)

  return {
    props: {
      ...(gate as any).props,
      sectionLabel: section ? section.label : 'This section',
    },
  }
}
