// pages/admin/b2b/training.tsx — assign training coursework to distributors.
// Training is ASSIGNED, not global (migration 192): a module is only visible
// in a distributor's portal when it's ticked here — either the whole
// distributor (every current + future team member) or individual users.
// Each assigned person shows their best-attempt status inline
// (Passed / Attempted / Not started) from b2b_training_attempts.

import { useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import { T, alpha } from '../../../lib/ui/theme'
import { useToast } from '../../../components/ui/Feedback'

interface AdminModule {
  id: string
  slug: string
  title: string
  description: string | null
  pass_pct: number
  enabled: boolean
  sections_count: number
  slides_count: number
  questions_count: number
}
interface DistRow { id: string; display_name: string; is_active: boolean }
interface UserRow { id: string; distributor_id: string; email: string; full_name: string | null; is_active: boolean }
interface AssignmentRow { id: string; module_id: string; distributor_id: string; distributor_user_id: string | null }
interface ResultRow {
  module_slug: string
  user_id: string
  attempts: number
  passed: boolean
  best_score_pct: number | null
  passed_at: string | null
  last_attempt_at: string | null
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : ''

export default function B2BTrainingAdmin({ user }: { user: any }) {
  const toast = useToast()
  const [modules, setModules] = useState<AdminModule[]>([])
  const [distributors, setDistributors] = useState<DistRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [results, setResults] = useState<ResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // `${moduleId}:${distId}` keys of expanded user lists
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showUpload, setShowUpload] = useState(false)

  useEffect(() => {
    fetch('/api/b2b/admin/training', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setModules(d.modules || []); setDistributors(d.distributors || [])
        setUsers(d.users || []); setAssignments(d.assignments || []); setResults(d.results || [])
        setError('')
      })
      .catch(e => setError(e.message || 'Load failed'))
      .finally(() => setLoading(false))
  }, [])

  const usersByDist = useMemo(() => {
    const m = new Map<string, UserRow[]>()
    for (const u of users) {
      const arr = m.get(u.distributor_id) || []
      arr.push(u); m.set(u.distributor_id, arr)
    }
    return m
  }, [users])

  const resultBy = useMemo(() => {
    const m = new Map<string, ResultRow>()
    for (const r of results) m.set(`${r.user_id}:${r.module_slug}`, r)
    return m
  }, [results])

  const hasWhole = (moduleId: string, distId: string) =>
    assignments.some(a => a.module_id === moduleId && a.distributor_id === distId && a.distributor_user_id === null)
  const hasUser = (moduleId: string, userId: string) =>
    assignments.some(a => a.module_id === moduleId && a.distributor_user_id === userId)

  // Memberships a module reaches: whole-distributor rows cover every active
  // user of that distributor; per-user rows count regardless of active flag.
  function coveredUserIds(moduleId: string): Set<string> {
    const covered = new Set<string>()
    for (const a of assignments) {
      if (a.module_id !== moduleId) continue
      if (a.distributor_user_id) covered.add(a.distributor_user_id)
      else for (const u of usersByDist.get(a.distributor_id) || []) { if (u.is_active !== false) covered.add(u.id) }
    }
    return covered
  }

  async function toggleWhole(m: AdminModule, d: DistRow, next: boolean) {
    const prev = assignments
    setAssignments(next
      ? [...prev, { id: `tmp-${m.id}-${d.id}`, module_id: m.id, distributor_id: d.id, distributor_user_id: null }]
      : prev.filter(a => !(a.module_id === m.id && a.distributor_id === d.id && a.distributor_user_id === null)))
    try {
      const r = await fetch('/api/b2b/admin/training/assignments', {
        method: next ? 'POST' : 'DELETE', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_id: m.id, distributor_id: d.id }),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      toast(next ? `${m.slug.toUpperCase()} assigned to all of ${d.display_name}` : `${m.slug.toUpperCase()} unassigned from ${d.display_name}`, 'success')
    } catch (e: any) {
      setAssignments(prev)
      toast(e.message || 'Save failed', 'error')
    }
  }

  async function toggleUser(m: AdminModule, d: DistRow, u: UserRow, next: boolean) {
    const prev = assignments
    setAssignments(next
      ? [...prev, { id: `tmp-${m.id}-${u.id}`, module_id: m.id, distributor_id: d.id, distributor_user_id: u.id }]
      : prev.filter(a => !(a.module_id === m.id && a.distributor_user_id === u.id)))
    try {
      const r = await fetch('/api/b2b/admin/training/assignments', {
        method: next ? 'POST' : 'DELETE', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_id: m.id, distributor_id: d.id, distributor_user_id: u.id }),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      toast(next ? `${m.slug.toUpperCase()} assigned to ${u.full_name || u.email}` : `${m.slug.toUpperCase()} unassigned from ${u.full_name || u.email}`, 'success')
    } catch (e: any) {
      setAssignments(prev)
      toast(e.message || 'Save failed', 'error')
    }
  }

  async function toggleEnabled(m: AdminModule, next: boolean) {
    const prev = modules
    setModules(ms => ms.map(x => x.id === m.id ? { ...x, enabled: next } : x))
    try {
      const r = await fetch('/api/b2b/admin/training', {
        method: 'PATCH', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module_id: m.id, enabled: next }),
      }).then(x => x.json())
      if (r.error) throw new Error(r.error)
      toast(`${m.slug.toUpperCase()} ${next ? 'enabled' : 'disabled'}`, 'success')
    } catch (e: any) {
      setModules(prev)
      toast(e.message || 'Save failed', 'error')
    }
  }

  function statusPill(u: UserRow, m: AdminModule) {
    const r = resultBy.get(`${u.id}:${m.slug}`)
    if (r?.passed) {
      return <Pill color={T.green} label={`Passed ${r.best_score_pct != null ? `${Math.round(r.best_score_pct)}%` : ''}${r.passed_at ? ` · ${fmtDate(r.passed_at)}` : ''}`} />
    }
    if (r && r.attempts > 0) {
      return <Pill color={T.amber} label={`Attempted · best ${r.best_score_pct != null ? `${Math.round(r.best_score_pct)}%` : '—'}`} />
    }
    return <Pill color={T.text3} label="Not started" />
  }

  return (
    <>
      <Head><title>B2B Training — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      {/* Normal page scroll (minHeight, NOT height+overflow:hidden) — the flex
          min-height:auto trap silently killed scrolling on the first version. */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: "'DM Sans',system-ui,sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <main className="b2b-admin-main" style={{ flex: 1, padding: '28px 32px', width: '100%', boxSizing: 'border-box' }}>
        <B2BAdminTabs active="training" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100 }}>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Training assignments</h1>
              <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>
                Courses only appear in a distributor's portal when assigned here — tick a whole distributor (covers every current and future team member) or individual people.
              </div>
            </div>
            <button onClick={() => setShowUpload(s => !s)}
              style={{
                fontSize: 12.5, fontWeight: 700, padding: '9px 16px', borderRadius: 8, whiteSpace: 'nowrap',
                border: `1px solid ${T.blue}`, background: showUpload ? 'transparent' : T.blue,
                color: showUpload ? T.blue : '#fff', cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {showUpload ? 'Close' : '＋ Upload document → course'}
            </button>
          </div>

          {showUpload && <UploadCoursePanel onClose={() => setShowUpload(false)} />}

          {error && <div style={{ background: alpha(T.red, '1a'), border: `1px solid ${alpha(T.red, '40')}`, borderRadius: 8, padding: 12, color: T.red, fontSize: 13 }}>{error}</div>}
          {loading && <div style={{ color: T.text3, textAlign: 'center', padding: 30 }}>Loading…</div>}

          {/* Compact overview: per module, assigned / passed counts */}
          {!loading && !error && modules.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {modules.map(m => {
                const covered = coveredUserIds(m.id)
                const passed = Array.from(covered).filter(uid => resultBy.get(`${uid}:${m.slug}`)?.passed).length
                return (
                  <div key={m.id} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '12px 14px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{m.slug}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                      {covered.size} assigned <span style={{ color: T.text3, fontWeight: 500 }}>·</span> <span style={{ color: passed > 0 ? T.green : T.text3 }}>{passed} passed</span>
                    </div>
                    {!m.enabled && <div style={{ fontSize: 11, color: T.amber, marginTop: 3 }}>module disabled — hidden even if assigned</div>}
                  </div>
                )
              })}
            </div>
          )}

          {!loading && !error && modules.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, color: T.text3, fontStyle: 'italic' }}>
              No training modules in b2b_training_modules yet.
            </div>
          )}

          {/* Per-module assignment panels */}
          {!loading && !error && modules.map(m => (
            <section key={m.id} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{m.title}</div>
                  <div style={{ fontSize: 12, color: T.text3, marginTop: 3 }}>
                    <span style={{ fontFamily: 'monospace' }}>{m.slug}</span>
                    {' · '}{m.sections_count} sections · {m.slides_count} slides · {m.questions_count} questions · pass mark {m.pass_pct}%
                  </div>
                </div>
                <a href={`/admin/b2b/training/${encodeURIComponent(m.slug)}`}
                  style={{
                    fontSize: 12, fontWeight: 600, color: T.blue, textDecoration: 'none', whiteSpace: 'nowrap',
                    border: `1px solid ${alpha(T.blue, '55')}`, borderRadius: 7, padding: '5px 12px',
                  }}>
                  ▶ Preview as distributor
                </a>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: m.enabled ? T.text2 : T.amber, cursor: 'pointer' }}>
                  <input type="checkbox" checked={m.enabled} onChange={e => toggleEnabled(m, e.target.checked)} />
                  {m.enabled ? 'Enabled' : 'Disabled (hidden for everyone)'}
                </label>
              </div>

              <div style={{ padding: '8px 12px 12px' }}>
                {distributors.map(d => {
                  const dUsers = usersByDist.get(d.id) || []
                  const whole = hasWhole(m.id, d.id)
                  const explicit = dUsers.filter(u => hasUser(m.id, u.id))
                  const isOpen = expanded.has(`${m.id}:${d.id}`) || whole
                  const coveredCount = whole ? dUsers.filter(u => u.is_active !== false).length : explicit.length
                  const passedCount = (whole ? dUsers.filter(u => u.is_active !== false) : explicit)
                    .filter(u => resultBy.get(`${u.id}:${m.slug}`)?.passed).length
                  return (
                    <div key={d.id} style={{ borderTop: `1px solid ${T.border}`, opacity: d.is_active === false ? 0.55 : 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 6px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => setExpanded(s => {
                            const n = new Set(s); const k = `${m.id}:${d.id}`
                            if (n.has(k)) n.delete(k); else n.add(k)
                            return n
                          })}
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                          style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 11, width: 22, padding: 0, fontFamily: 'inherit' }}>
                          {isOpen ? '▾' : '▸'}
                        </button>
                        <div style={{ flex: 1, minWidth: 160, fontSize: 13, fontWeight: 600 }}>
                          {d.display_name}
                          {d.is_active === false && <span style={{ fontSize: 10, color: T.text3, fontWeight: 500 }}> · inactive</span>}
                        </div>
                        {coveredCount > 0 && (
                          <span style={{ fontSize: 11, color: passedCount === coveredCount ? T.green : T.text3, whiteSpace: 'nowrap' }}>
                            {passedCount}/{coveredCount} passed
                          </span>
                        )}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: T.text2, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={whole} onChange={e => toggleWhole(m, d, e.target.checked)} />
                          Whole distributor
                        </label>
                      </div>
                      {isOpen && (
                        <div style={{ padding: '0 6px 10px 28px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {dUsers.length === 0 && <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>No portal users.</div>}
                          {dUsers.map(u => {
                            const ticked = hasUser(m.id, u.id)
                            return (
                              <div key={u.id} style={{
                                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                                background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 7, padding: '7px 10px',
                                opacity: u.is_active === false ? 0.55 : 1,
                              }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 180, cursor: whole ? 'default' : 'pointer' }}
                                  title={whole && !ticked ? 'Covered by the whole-distributor assignment' : undefined}>
                                  <input type="checkbox"
                                    checked={ticked || whole}
                                    disabled={whole && !ticked}
                                    onChange={e => toggleUser(m, d, u, e.target.checked)} />
                                  <span style={{ fontSize: 12.5, color: T.text }}>
                                    {u.full_name || u.email}
                                    {u.full_name && <span style={{ color: T.text3 }}> · {u.email}</span>}
                                    {u.is_active === false && <span style={{ fontSize: 10, color: T.text3 }}> · inactive</span>}
                                  </span>
                                </label>
                                {(ticked || whole) && statusPill(u, m)}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
                {distributors.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '10px 6px' }}>No distributors yet.</div>}
              </div>
            </section>
          ))}

        </div>
        </main>
      </div>
    </>
  )
}

// ─── Upload document → course ─────────────────────────────────────────────
// PDF → signed direct upload to b2b-training-uploads → /generate renders
// every page to slides + drafts a quiz → redirect to the answer sheet in
// review mode. The course lands DISABLED; enabling/assigning happens here
// afterwards.

const suggestSlug = (t: string) =>
  t.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

function putWithProgress(url: string, file: File, onPct: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/pdf')
    xhr.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed: storage HTTP ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Upload failed — network error'))
    xhr.send(file)
  })
}

function UploadCoursePanel({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [fileName, setFileName] = useState('')
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [passPct, setPassPct] = useState(90)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'generating'>('idle')
  const [uploadPct, setUploadPct] = useState(0)
  const [err, setErr] = useState('')

  const busy = phase !== 'idle'

  function onTitle(v: string) {
    setTitle(v)
    if (!slugTouched) setSlug(suggestSlug(v))
  }

  async function start() {
    const file = fileRef.current?.files?.[0]
    if (!file) { setErr('Choose a PDF first.'); return }
    if (!/\.pdf$/i.test(file.name)) { setErr('Only PDFs are supported — export Word/PowerPoint documents as PDF first.'); return }
    if (!title.trim()) { setErr('Give the course a title.'); return }
    if (!slug.trim()) { setErr('Give the course a slug.'); return }
    setErr('')
    try {
      setPhase('uploading')
      setUploadPct(0)
      const sign = await fetch('/api/b2b/admin/training/upload-url', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name }),
      }).then(r => r.json())
      if (sign.error || !sign.signedUrl) throw new Error(sign.error || 'Could not get an upload URL')
      await putWithProgress(sign.signedUrl, file, setUploadPct)

      setPhase('generating')
      const gen = await fetch('/api/b2b/admin/training/generate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadPath: sign.path, title: title.trim(), slug: slug.trim(), passPct }),
      }).then(r => r.json())
      if (gen.error) throw new Error(gen.error)
      toast(`Draft course created — ${gen.pageCount} slides, ${gen.questionCount} suggested questions`, 'success')
      router.push(`/admin/b2b/training/${encodeURIComponent(gen.slug)}/answers?review=1`)
    } catch (e: any) {
      setErr(e.message || 'Something went wrong')
      setPhase('idle')
    }
  }

  const inputStyle: React.CSSProperties = {
    background: T.bg3, color: T.text, border: `1px solid ${T.border2}`, borderRadius: 8,
    padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: T.text2, marginBottom: 5, display: 'block' }

  return (
    <section style={{ background: T.bg2, border: `1px solid ${alpha(T.blue, '45')}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Upload a document → training course</div>
        <div style={{ fontSize: 12, color: T.text3, marginTop: 3 }}>
          Every page of the PDF becomes a slide, and a quiz is drafted automatically. The course is saved as a <b>draft</b> — you review and edit the questions before enabling and assigning it.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div>
          <label style={labelStyle}>Document (PDF)</label>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" disabled={busy}
            onChange={e => setFileName(e.target.files?.[0]?.name || '')}
            style={{ ...inputStyle, padding: '7px 9px' }} />
          <div style={{ fontSize: 11, color: T.text3, marginTop: 4 }}>Export Word/PowerPoint documents as PDF first.</div>
        </div>
        <div>
          <label style={labelStyle}>Course title</label>
          <input value={title} disabled={busy} onChange={e => onTitle(e.target.value)}
            placeholder="e.g. JA103 — EasyLock Fitting Guide" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>Slug</label>
          <input value={slug} disabled={busy}
            onChange={e => { setSlugTouched(true); setSlug(suggestSlug(e.target.value) || e.target.value.toLowerCase()) }}
            placeholder="ja103-easylock-fitting" style={{ ...inputStyle, fontFamily: 'monospace' }} />
          <div style={{ fontSize: 11, color: T.text3, marginTop: 4 }}>Lowercase letters, numbers and hyphens — becomes the course URL.</div>
        </div>
        <div>
          <label style={labelStyle}>Pass mark %</label>
          <input type="number" min={1} max={100} value={passPct} disabled={busy}
            onChange={e => setPassPct(Math.max(1, Math.min(100, Number(e.target.value) || 0)))} style={inputStyle} />
        </div>
      </div>

      {err && (
        <div style={{ background: alpha(T.red, '18'), border: `1px solid ${alpha(T.red, '40')}`, borderRadius: 8, padding: 10, fontSize: 12.5, color: T.red }}>
          {err}
        </div>
      )}

      {phase === 'uploading' && (
        <div>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 5 }}>Uploading {fileName || 'document'}… {uploadPct}%</div>
          <div style={{ height: 5, background: T.bg3, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${uploadPct}%`, background: T.blue, borderRadius: 3, transition: 'width 0.15s ease' }} />
          </div>
        </div>
      )}
      {phase === 'generating' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: T.text2 }}>
          <span style={{
            width: 15, height: 15, border: `2px solid ${alpha(T.blue, '40')}`, borderTopColor: T.blue,
            borderRadius: '50%', display: 'inline-block', animation: 'ja-train-spin 0.8s linear infinite', flexShrink: 0,
          }} />
          Reading document and drafting the quiz — this can take a couple of minutes…
          <style jsx>{`@keyframes ja-train-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={start} disabled={busy}
          style={{
            fontSize: 13, fontWeight: 700, padding: '10px 20px', borderRadius: 8,
            border: `1px solid ${T.blue}`, background: T.blue, color: '#fff',
            cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
          }}>
          {phase === 'uploading' ? 'Uploading…' : phase === 'generating' ? 'Generating…' : 'Generate course'}
        </button>
        <button onClick={onClose} disabled={busy}
          style={{
            fontSize: 13, fontWeight: 600, padding: '10px 16px', borderRadius: 8,
            border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2,
            cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1,
          }}>
          Cancel
        </button>
      </div>
    </section>
  )
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 9, background: alpha(color, '18'), color, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}
