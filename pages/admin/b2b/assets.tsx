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
import { T } from '../../../lib/ui/theme'
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

  const input: React.CSSProperties = { fontSize: 12, padding: '6px 10px', borderRadius: 6, border: `1px solid ${T.border}`, background: T.bg3, color: T.text, fontFamily: 'inherit' }

  return (
    <>
      <Head><title>B2B Resources — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <B2BAdminTabs active="assets" />
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1000 }}>

          {/* Publish / replace panel */}
          <div style={{ background: T.bg2, border: `1px solid ${replaceTarget ? T.amber : T.border}`, borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {replaceTarget ? <>Replace file on “{replaceTarget.title}” <button onClick={() => setReplaceTarget(null)} style={{ ...input, cursor: 'pointer', marginLeft: 8, padding: '2px 8px' }}>cancel</button></> : 'Publish a document'}
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
              <label style={{ fontSize: 12, color: T.text2, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={upNotify} onChange={e => setUpNotify(e.target.checked)} /> notify distributors
              </label>
              <button disabled={uploading} onClick={submitUpload}
                style={{ fontSize: 12, fontWeight: 700, padding: '8px 18px', borderRadius: 8, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                {uploading ? 'Uploading…' : replaceTarget ? 'Upload replacement' : '⬆ Publish'}
              </button>
            </div>
            {note && <div style={{ fontSize: 12, color: /fail/i.test(note) ? T.red : T.green }}>{note}</div>}
          </div>

          {error && <div style={{ background: 'rgba(240,78,78,0.1)', border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, color: T.red, fontSize: 13 }}>{error}</div>}
          {loading && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}

          {/* Sections */}
          {!loading && B2B_ASSET_SECTIONS.map(sec => {
            const rows = assets.filter(a => a.section === sec)
            return (
              <div key={sec} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text2 }}>
                  {sec} <span style={{ color: T.text3, fontWeight: 400 }}>({rows.length})</span>
                </div>
                {rows.length === 0 && <div style={{ padding: '10px 14px', fontSize: 12, color: T.text3, fontStyle: 'italic' }}>Empty</div>}
                {rows.map((a, i) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderTop: i === 0 ? 'none' : `1px solid ${T.border}`, opacity: a.is_active ? 1 : 0.5 }}>
                    <input defaultValue={a.title} onBlur={e => { if (e.target.value.trim() && e.target.value !== a.title) patch(a.id, { title: e.target.value }) }}
                      style={{ ...input, minWidth: 220, fontWeight: 600 }} />
                    <select value={a.section} onChange={e => patch(a.id, { section: e.target.value })} style={input}>
                      {B2B_ASSET_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span style={{ fontSize: 11, color: T.text3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.file_name}{a.size_bytes ? ` · ${fmtBytes(a.size_bytes)}` : ''} · {new Date(a.updated_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}
                    </span>
                    <button onClick={() => { setReplaceTarget(a); setNote('') }} style={{ ...input, cursor: 'pointer' }}>Replace file</button>
                    <button onClick={() => patch(a.id, { is_active: !a.is_active })} title={a.is_active ? 'Hide from distributors' : 'Show to distributors'} style={{ ...input, cursor: 'pointer' }}>
                      {a.is_active ? 'Hide' : 'Unhide'}
                    </button>
                    <button onClick={() => removeAsset(a)} style={{ ...input, cursor: 'pointer', color: T.red, borderColor: `${T.red}60` }}>✕</button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
