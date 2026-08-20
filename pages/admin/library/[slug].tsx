// pages/admin/library/[slug].tsx
// Library reader — renders a document's markdown on screen with a sticky
// contents rail, and offers the PDF for download.
//
// Markdown is converted server-side (marked) in getServerSideProps, so the
// browser gets finished HTML. The source is our own repo markdown, not user
// input, which is why injecting it is safe here — do not repoint this at
// anything a user can write.

import Head from 'next/head'
import Link from 'next/link'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { findDoc, readMarkdown, docStats } from '../../../lib/library-docs'
import { T, alpha } from '../../../lib/ui/theme'

interface TocItem { id: string; text: string; level: number }

const DOC_CSS = `
.doc-body { color: var(--t-text); font-size: 15px; line-height: 1.72; }
.doc-body h1, .doc-body h2, .doc-body h3, .doc-body h4 { line-height: 1.3; font-weight: 700; scroll-margin-top: 76px; }
.doc-body h1 { font-size: 25px; margin: 0 0 14px; padding-bottom: 9px; border-bottom: 2px solid #4f8ef7; }
.doc-body h2 { font-size: 20px; margin: 34px 0 12px; padding-bottom: 7px; border-bottom: 1px solid var(--t-border); }
.doc-body h3 { font-size: 16.5px; margin: 24px 0 8px; }
.doc-body h4 { font-size: 15px; margin: 18px 0 6px; color: var(--t-text2); }
.doc-body p { margin: 0 0 13px; }
.doc-body ul, .doc-body ol { margin: 0 0 14px; padding-left: 22px; }
.doc-body li { margin-bottom: 6px; }
.doc-body li > ul, .doc-body li > ol { margin-top: 6px; }
.doc-body strong { color: var(--t-text); font-weight: 700; }
.doc-body a { color: #4f8ef7; text-decoration: none; }
.doc-body a:hover { text-decoration: underline; }
.doc-body code { font-family: ui-monospace, Consolas, monospace; font-size: 13px;
  background: var(--t-bg3); border: 1px solid var(--t-border); border-radius: 4px;
  padding: 1px 5px; word-break: break-word; }
.doc-body pre { background: var(--t-bg2); border: 1px solid var(--t-border);
  border-left: 3px solid #4f8ef7; border-radius: 8px; padding: 13px 15px;
  overflow-x: auto; margin: 0 0 15px; }
.doc-body pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.55; }
.doc-body blockquote { margin: 0 0 14px; padding: 9px 15px; border-left: 3px solid #f5a623;
  background: var(--t-bg2); border-radius: 0 8px 8px 0; color: var(--t-text2); }
.doc-body hr { border: none; border-top: 1px solid var(--t-border); margin: 30px 0; }
.doc-table-wrap { overflow-x: auto; margin: 0 0 16px; }
.doc-body table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
.doc-body th { background: var(--t-bg3); text-align: left; font-weight: 700; }
.doc-body th, .doc-body td { border: 1px solid var(--t-border); padding: 8px 11px; vertical-align: top; }
.doc-body tbody tr:nth-child(even) { background: var(--t-bg2); }
@media (max-width: 900px) { .doc-toc { display: none; } }
`

export default function LibraryDoc({
  user, title, audience, confidential, html, toc, slug, updatedAt,
}: {
  user: PortalUserSSR
  title: string
  audience: string
  confidential: boolean
  html: string
  toc: TocItem[]
  slug: string
  updatedAt: string | null
}) {
  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', minHeight: 40, padding: '0 15px',
    borderRadius: 8, fontSize: 14, fontWeight: 600, textDecoration: 'none',
    border: `1px solid ${T.border}`, background: T.bg3, color: T.text,
  }

  return (
    <>
      <Head><title>{title} — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <style dangerouslySetInnerHTML={{ __html: DOC_CSS }} />
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <PortalTopBar
          activeId="settings"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '20px 20px 70px', display: 'flex', gap: 30 }}>
          {/* Contents rail */}
          <aside className="doc-toc" style={{ width: 240, flex: '0 0 240px' }}>
            <div style={{ position: 'sticky', top: 20, maxHeight: 'calc(100vh - 46px)', overflowY: 'auto' }}>
              <Link href="/admin/library" style={{ fontSize: 13, color: T.text3, textDecoration: 'none' }}>← Library</Link>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: T.text3, margin: '18px 0 9px' }}>
                Contents
              </div>
              <nav style={{ display: 'grid', gap: 2 }}>
                {toc.map(t => (
                  <a
                    key={t.id}
                    href={`#${t.id}`}
                    style={{
                      fontSize: t.level === 2 ? 13.5 : 12.5,
                      color: t.level === 2 ? T.text2 : T.text3,
                      fontWeight: t.level === 2 ? 600 : 400,
                      textDecoration: 'none',
                      padding: '3px 0 3px ' + (t.level === 2 ? '0px' : '12px'),
                      lineHeight: 1.4,
                    }}
                  >{t.text}</a>
                ))}
              </nav>
            </div>
          </aside>

          {/* Document */}
          <main style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              paddingBottom: 16, marginBottom: 22, borderBottom: `1px solid ${T.border}`,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, color: T.text3 }}>{audience}</span>
                  {confidential && (
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: '#d97706',
                      background: alpha('#d97706', '1f'), border: `1px solid ${alpha('#d97706', '59')}`,
                      borderRadius: 999, padding: '2px 9px',
                    }}>Confidential — do not forward outside Just Autos</span>
                  )}
                </div>
                {updatedAt && (
                  <div style={{ fontSize: 12.5, color: T.text3, marginTop: 4 }}>
                    Updated {new Date(updatedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                <a href={`/api/admin/library/${slug}`} target="_blank" rel="noreferrer" style={btn}>Open PDF</a>
                <a href={`/api/admin/library/${slug}?download=1`} style={{ ...btn, background: T.accent, color: '#fff', borderColor: T.accent }}>
                  Download PDF
                </a>
              </div>
            </div>

            <article className="doc-body" dangerouslySetInnerHTML={{ __html: html }} />
          </main>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const gate = await requirePageAuth(context, 'admin:settings')
  if ('redirect' in gate) return gate

  const doc = findDoc(context.params?.slug)
  if (!doc) return { notFound: true }

  const { marked } = await import('marked')
  let md: string
  try {
    md = readMarkdown(doc)
  } catch {
    return { notFound: true }
  }

  // Slug the headings ourselves so the contents rail and the anchors agree.
  const toc: TocItem[] = []
  const used = new Set<string>()
  const renderer = new marked.Renderer()
  renderer.heading = (text: string, level: number) => {
    const plain = text.replace(/<[^>]+>/g, '')
    let id = plain.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || `s${toc.length}`
    while (used.has(id)) id += '-x'
    used.add(id)
    if (level === 2 || level === 3) toc.push({ id, text: plain, level })
    return `<h${level} id="${id}">${text}</h${level}>`
  }
  // Tables need their own scroll container or a wide one pushes the page sideways.
  renderer.table = (header: string, body: string) =>
    `<div class="doc-table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`

  const html = marked.parse(md, { renderer, gfm: true, breaks: false }) as string
  const { updatedAt } = docStats(doc)

  return {
    props: {
      ...(gate as any).props,
      title: doc.title,
      audience: doc.audience,
      confidential: !!doc.confidential,
      html,
      toc,
      slug: doc.slug,
      updatedAt,
    },
  }
}
