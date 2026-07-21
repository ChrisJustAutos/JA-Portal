// pages/b2b/assets.tsx — distributor resource library ("Assets").
// Sectioned documents (Quote Page / Package Information / Technical / …)
// uploaded by Just Autos admins; downloads via short-lived signed URLs.
// "New"/"Updated" chips mark documents touched in the last 14 days.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { fmtBytes } from '../../lib/b2b-assets'

const T = {
  bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)', border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)', blue: '#4f8ef7', green: '#34c77b', amber: '#e9932b',
}

interface Asset { id: string; title: string; description: string | null; file_name: string; mime: string | null; size_bytes: number | null; updated_at: string; created_at: string }
interface Section { name: string; assets: Asset[] }

const FRESH_MS = 14 * 86400_000

export default function B2BAssetsPage({ user }: { user: any }) {
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
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Resources</h1>
          <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>Quotes, technical documents, bulletins, training and media from Just Autos.</div>
        </div>
        {error && <div style={{ background: 'rgba(240,78,78,0.1)', border: '1px solid rgba(240,78,78,0.3)', borderRadius: 8, padding: 12, fontSize: 13, color: '#f04e4e' }}>{error}</div>}
        {sections === null && !error && <div style={{ color: T.text3, padding: 30, textAlign: 'center' }}>Loading…</div>}
        {sections !== null && sections.length === 0 && <div style={{ color: T.text3, padding: 30, textAlign: 'center', fontStyle: 'italic' }}>Nothing here yet — documents will appear as Just Autos publishes them.</div>}
        {(sections || []).map(sec => (
          <div key={sec.name} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text2 }}>
              {sec.name}
            </div>
            {sec.assets.map((a, i) => {
              const chip = freshness(a)
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${T.border}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                      {a.title}
                      {chip && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 8, background: chip === 'New' ? 'rgba(52,199,123,0.15)' : 'rgba(233,147,43,0.15)', color: chip === 'New' ? T.green : T.amber }}>{chip}</span>}
                    </div>
                    {a.description && <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>{a.description}</div>}
                    <div style={{ fontSize: 11, color: T.text3, marginTop: 3 }}>
                      {a.file_name}{a.size_bytes ? ` · ${fmtBytes(a.size_bytes)}` : ''} · updated {new Date(a.updated_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </div>
                  </div>
                  <button onClick={() => download(a)} disabled={busyId === a.id}
                    style={{ fontSize: 12, fontWeight: 700, padding: '8px 16px', borderRadius: 8, border: `1px solid ${T.blue}`, background: 'transparent', color: T.blue, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                    {busyId === a.id ? '…' : '⬇ Download'}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </B2BLayout>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}
