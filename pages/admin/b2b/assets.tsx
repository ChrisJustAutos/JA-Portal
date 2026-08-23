// pages/admin/b2b/assets.tsx — manage the distributor resource library.
// Upload documents into the fixed sections (Quote Page / Package Information /
// Technical / Operation Instructions / Bulletins / Training Document / Media
// Assets), edit/replace/retire them, and optionally bell-notify every active
// distributor user on publish or update. Files upload DIRECT to Supabase
// Storage via signed URLs (no function body limits — media can be large).

import { useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { T, alpha } from '../../../lib/ui/theme'
import { A, Btn, btnStyle, Banner, cardStyle, inputStyle, PageTitle } from '../../../components/b2b/ui'
import { useConfirm } from '../../../components/ui/Feedback'
import { B2B_ASSET_SECTIONS, fmtBytes, type B2BAssetRow } from '../../../lib/b2b-assets'

export default function B2BAssetsAdmin({ user }: { user: any }) {
  const confirmDialog = useConfirm()
  const [assets, setAssets] = useState<B2BAssetRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  // Upload form
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [upSection, setUpSection] = useState<string>(B2B_ASSET_SECTIONS[0])
  const [upTitle, setUpTitle] = useState('')
  const [upDesc, setUpDesc] = useState('')
  const [upNotify, setUpNotify] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [replaceTarget, setReplaceTarget] = useState<B2BAssetRow | null>(null)

  const load = () => {
    fetch('/api/b2b/admin/assets').then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setAssets(d.assets || []); setError('') })
      .catch(e => setError(e.message || 'Load failed'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  async function pushFile(file: File): Promise<{ path: string } | null> {
    const sign = await fetch('/api/b2b/admin/assets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sign-upload', fileName: file.name, mime: file.type }),
    }).then(r => r.json())
    if (sign.error || !sign.signedUrl) { setNote(`Upload failed: ${sign.error || 'no signed URL'}`); return null }
    const put = await fetch(sign.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
    if (!put.ok) { setNote(`Upload failed: storage HTTP ${put.status}`); return null }
    return { path: sign.path }
  }

  async function submitUpload() {
    const file = fileRef.current?.files?.[0]
    if (!file) { setNote('Choose a file first.'); return }
    if (!upTitle.trim()) { setNote('Give the document a title.'); return }
    setUploading(true); setNote('')
    try {
      const up = await pushFile(file)
      if (!up) return
      const body = replaceTarget
        ? { action: 'replace', id: replaceTarget.id, path: up.path, fileName: file.name, mime: file.type, sizeBytes: file.size, notify: upNotify }
        : { action: 'create', section: upSection, title: upTitle.trim(), description: upDesc.trim() || null, path: up.path, fileName: file.name, mime: file.type, sizeBytes: file.size, notify: upNotify }
      const r = await fetch('/api/b2b/admin/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      setNote(`${replaceTarget ? 'Replaced' : 'Published'}${upNotify ? ` — ${r.notified} distributor user${r.notified === 1 ? '' : 's'} notified` : ''}.`)
      setUpTitle(''); setUpDesc(''); setReplaceTarget(null)
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch (e: any) { setNote(`Failed: ${e.message || e}`) }
    setUploading(false)
  }

  async function patch(id: string, body: any) {
    const r = await fetch('/api/b2b/admin/assets', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...body }) }).then(x => x.json())
    if (r.error) setNote(`Save failed: ${r.error}`); else load()
  }
  async function removeAsset(a: B2BAssetRow) {
    if (!(await confirmDialog({ title: `Delete "${a.title}"?`, message: 'Removes the document and its file for all distributors.', danger: true }))) return
    const r = await fetch(`/api/b2b/admin/assets?id=${a.id}`, { method: 'DELETE' }).then(x => x.json())
    if (r.error) setNote(`Delete failed: ${r.error}`); else load()
  }

  // Kit input look at staff-tool density
  const input: React.CSSProperties = { ...inputStyle(), width: 'auto', fontSize: 13, padding: '8px 11px', minHeight: 36 }

  return (
    <>
      <Head><title>B2B Resources — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      {/* Normal page scroll (minHeight, NOT height + overflow:hidden) — the
          flex min-height:auto trap leaves the bottom of the list unreachable.
          See the Handover's design conventions. */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '20px 20px 40px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="assets" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>

          <PageTitle sub="Documents distributors see under Resources — publish, replace or retire files by section.">Resource library</PageTitle>

          {/* Publish / replace panel */}
          <div style={{ ...cardStyle(16), border: `1px solid ${replaceTarget ? alpha(A.warn, '66') : T.border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13.5, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 10 }}>
              {replaceTarget ? <>Replace file on “{replaceTarget.title}” <Btn variant="ghost" size="sm" onClick={() => setReplaceTarget(null)}>Cancel</Btn></> : 'Publish a document'}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {!replaceTarget && <>
                <select value={upSection} onChange={e => setUpSection(e.target.value)} style={input}>
                  {B2B_ASSET_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <input value={upTitle} onChange={e => setUpTitle(e.target.value)} placeholder="Title distributors will see" style={{ ...input, minWidth: 240 }} />
                <input value={upDesc} onChange={e => setUpDesc(e.target.value)} placeholder="Description (optional)" style={{ ...input, minWidth: 260, flex: 1 }} />
              </>}
              <input ref={fileRef} type="file" style={{ ...input, padding: 5 }} onChange={e => { if (replaceTarget && !upTitle) setUpTitle(replaceTarget.title) }} />
              <label style={{ fontSize: 12.5, color: T.text2, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={upNotify} onChange={e => setUpNotify(e.target.checked)} /> notify distributors
              </label>
              <Btn size="sm" disabled={uploading} onClick={submitUpload}>
                {uploading ? 'Uploading…' : replaceTarget ? 'Upload replacement' : 'Publish'}
              </Btn>
            </div>
            {note && <div style={{ fontSize: 12.5, color: /fail/i.test(note) ? A.bad : A.good }}>{note}</div>}
          </div>

          {error && <Banner tone="error">{error}</Banner>}
          {loading && <div style={{ color: T.text3, textAlign: 'center', padding: 30, fontSize: 13 }}>Loading…</div>}

          {/* Sections */}
          {!loading && B2B_ASSET_SECTIONS.map(sec => {
            const rows = assets.filter(a => a.section === sec)
            return (
              <div key={sec} style={cardStyle(false)}>
                <div style={{ padding: '11px 16px', borderBottom: `1px solid ${T.border}`, fontSize: 13, fontWeight: 650, color: T.text2 }}>
                  {sec} <span style={{ color: T.text3, fontWeight: 400, fontSize: 12.5 }}>({rows.length})</span>
                </div>
                {rows.length === 0 && <div style={{ padding: '11px 16px', fontSize: 12.5, color: T.text3, fontStyle: 'italic' }}>Empty</div>}
                {rows.map((a, i) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderTop: i === 0 ? 'none' : `1px solid ${T.border}`, opacity: a.is_active ? 1 : 0.5 }}>
                    <input defaultValue={a.title} onBlur={e => { if (e.target.value.trim() && e.target.value !== a.title) patch(a.id, { title: e.target.value }) }}
                      style={{ ...input, minWidth: 220, fontWeight: 600 }} />
                    <select value={a.section} onChange={e => patch(a.id, { section: e.target.value })} style={input}>
                      {B2B_ASSET_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span style={{ fontSize: 12, color: T.text3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.file_name}{a.size_bytes ? ` · ${fmtBytes(a.size_bytes)}` : ''} · {new Date(a.updated_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}
                    </span>
                    <Btn variant="ghost" size="sm" onClick={() => { setReplaceTarget(a); setNote('') }}>Replace file</Btn>
                    <Btn variant="ghost" size="sm" title={a.is_active ? 'Hide from distributors' : 'Show to distributors'} onClick={() => patch(a.id, { is_active: !a.is_active })}>
                      {a.is_active ? 'Hide' : 'Unhide'}
                    </Btn>
                    <button className="al-press al-focus al-ghost" onClick={() => removeAsset(a)} style={{ ...btnStyle('ghost', 'sm'), color: A.bad }}>Delete</button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        </main>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
