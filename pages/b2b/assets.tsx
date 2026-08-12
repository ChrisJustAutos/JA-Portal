// pages/b2b/assets.tsx — distributor resource library ("Assets").
// Sectioned documents (Quote Page / Package Information / Technical / …)
// uploaded by Just Autos admins; downloads via short-lived signed URLs.
// "New"/"Updated" pills mark documents touched in the last 14 days.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { fmtBytes } from '../../lib/b2b-assets'
import { T } from '../../lib/ui/theme'
import { A, Banner, Btn, Card, EmptyState, PageTitle, StatusPill } from '../../components/b2b/ui'

interface Asset { id: string; title: string; description: string | null; file_name: string; mime: string | null; size_bytes: number | null; updated_at: string; created_at: string }
interface Section { name: string; assets: Asset[] }

const FRESH_MS = 14 * 86400_000

export default function B2BAssetsPage({ b2bUser: user }: { b2bUser: any }) {
  const [sections, setSections] = useState<Section[] | null>(null)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    fetch('/api/b2b/assets', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setSections(d.sections || []) })
      .catch(e => setError(e.message || 'Failed to load'))
  }, [])

  async function download(a: Asset) {
    setBusyId(a.id)
    try {
      const r = await fetch(`/api/b2b/assets?download=${a.id}`, { credentials: 'same-origin' })
      const d = await r.json()
      if (!r.ok || d.error || !d.url) throw new Error(d.error || 'Download failed')
      window.location.href = d.url
    } catch (e: any) { setError(e.message || 'Download failed') }
    setBusyId('')
  }

  const freshness = (a: Asset): 'New' | 'Updated' | null => {
    const now = Date.now()
    if (now - Date.parse(a.created_at) < FRESH_MS) return 'New'
    if (now - Date.parse(a.updated_at) < FRESH_MS) return 'Updated'
    return null
  }

  return (
    <B2BLayout user={user} active={'assets' as any}>
      <Head><title>Resources — Just Autos Wholesale</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <PageTitle sub="Quotes, technical documents, bulletins, training and media from Just Autos.">
          Resources
        </PageTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && <Banner tone="error">{error}</Banner>}
          {sections === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontSize: 13 }}>Loading…</div>}
          {sections !== null && sections.length === 0 && (
            <EmptyState title="Nothing here yet" sub="Documents will appear as Just Autos publishes them." />
          )}
          {(sections || []).map(sec => (
            <Card key={sec.name} pad={false}>
              <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, fontSize: 13.5, fontWeight: 650, color: T.text2 }}>
                {sec.name}
              </div>
              {sec.assets.map((a, i) => {
                const chip = freshness(a)
                return (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderTop: i === 0 ? 'none' : `1px solid ${T.border}` }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {a.title}
                        {chip && <StatusPill color={chip === 'New' ? A.good : A.warn}>{chip}</StatusPill>}
                      </div>
                      {a.description && <div style={{ fontSize: 12.5, color: T.text2, marginTop: 2 }}>{a.description}</div>}
                      <div style={{ fontSize: 12, color: T.text3, marginTop: 3 }}>
                        {a.file_name}{a.size_bytes ? ` · ${fmtBytes(a.size_bytes)}` : ''} · updated {new Date(a.updated_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </div>
                    </div>
                    <Btn variant="secondary" onClick={() => download(a)} disabled={busyId === a.id}>
                      {busyId === a.id ? 'Preparing…' : 'Download'}
                    </Btn>
                  </div>
                )
              })}
            </Card>
          ))}
        </div>
      </div>
    </B2BLayout>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
