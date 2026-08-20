// pages/admin/library/index.tsx
// Admin → Library. The portal's own documentation, readable on screen and
// downloadable as PDF, so nobody has to go digging through the repo.
//
// The documents are the markdown in docs/ (source of truth) plus a rendered
// PDF; the registry is lib/library-docs.ts. Admin-gated — the handover names
// where every credential lives.

import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { LIBRARY_DOCS, docStats } from '../../../lib/library-docs'
import { T, alpha } from '../../../lib/ui/theme'

interface Card {
  slug: string
  title: string
  description: string
  audience: string
  confidential: boolean
  updatedAt: string | null
  pdfKb: number | null
}

export default function LibraryIndex({ user, docs }: { user: PortalUserSSR; docs: Card[] }) {
  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'

  return (
    <>
      <Head><title>Library — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <PortalTopBar
          activeId="settings"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        <main style={{ maxWidth: 880, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px' }}>Library</h1>
          <p style={{ color: T.text3, fontSize: 14, margin: '0 0 26px', maxWidth: 620 }}>
            How the portal works and how to use it. Read here, or download the PDF to keep a copy.
          </p>

          <div style={{ display: 'grid', gap: 14 }}>
            {docs.map(d => (
              <div
                key={d.slug}
                style={{
                  background: T.bg2,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  padding: '18px 20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{d.title}</h2>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: T.text3, background: T.bg3,
                    border: `1px solid ${T.border}`, borderRadius: 999, padding: '2px 9px',
                  }}>{d.audience}</span>
                  {d.confidential && (
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: '#d97706',
                      background: alpha('#d97706', '1f'), border: `1px solid ${alpha('#d97706', '59')}`,
                      borderRadius: 999, padding: '2px 9px',
                    }}>Confidential</span>
                  )}
                </div>

                <p style={{ color: T.text2, fontSize: 14, lineHeight: 1.6, margin: '9px 0 14px' }}>{d.description}</p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <Link
                    href={`/admin/library/${d.slug}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: '0 16px',
                      borderRadius: 8, background: T.accent, color: '#fff', fontSize: 14, fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >Read</Link>

                  {d.pdfKb != null ? (
                    <a
                      href={`/api/admin/library/${d.slug}?download=1`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: '0 16px',
                        borderRadius: 8, background: T.bg3, color: T.text, fontSize: 14, fontWeight: 600,
                        textDecoration: 'none', border: `1px solid ${T.border}`,
                      }}
                    >Download PDF</a>
                  ) : (
                    <span style={{ fontSize: 13, color: T.text3 }}>PDF not built</span>
                  )}

                  <span style={{ fontSize: 12.5, color: T.text3, marginLeft: 'auto' }}>
                    Updated {fmtDate(d.updatedAt)}{d.pdfKb != null ? ` · ${d.pdfKb} KB` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <p style={{ color: T.text3, fontSize: 12.5, lineHeight: 1.7, marginTop: 24 }}>
            These are generated from <code style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4 }}>docs/*.md</code> in
            the repo. To change one, edit the markdown and re-run{' '}
            <code style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4 }}>scripts/render-doc-pdf.js</code> — editing
            the PDF directly will be overwritten on the next render.
          </p>
        </main>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const gate = await requirePageAuth(context, 'admin:settings')
  if ('redirect' in gate) return gate

  const docs: Card[] = LIBRARY_DOCS.map(d => {
    const { updatedAt, pdfKb } = docStats(d)
    return {
      slug: d.slug,
      title: d.title,
      description: d.description,
      audience: d.audience,
      confidential: !!d.confidential,
      updatedAt,
      pdfKb,
    }
  })

  return { props: { ...(gate as any).props, docs } }
}
