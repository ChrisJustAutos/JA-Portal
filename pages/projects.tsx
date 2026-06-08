// pages/projects.tsx — Project Tracking Board
// An Obsidian-style force-directed web of the six Monday "Hidden To Do" boards.
// Person hubs → their "Projects"-group items → each project's comment thread.
// Clicking expands inline on the canvas; the selected node opens a docked
// inspector (NOT a modal) where you can read and post comments back to Monday.

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import Head from 'next/head'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import PortalTopBar from '../lib/PortalTopBar'
import { UserRole, roleHasPermission } from '../lib/permissions'
import { requirePageAuth } from '../lib/authServer'
import { useChatContext } from '../components/GlobalChatbot'
import type { GraphNode, GraphLink } from '../components/projects/ProjectGraph'

const ProjectGraph = dynamic(() => import('../components/projects/ProjectGraph'), { ssr: false })

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', pink:'#ff5ac4',
  accent:'#4f8ef7',
}

const STATUS_COLOURS: Record<string, string> = {
  'Working on it': T.amber,
  'Done':          T.green,
  'Stuck':         T.red,
  'On Hold':       T.pink,
  'Testing Phase': T.purple,
}
const NEUTRAL = '#6b7280'
// Canonical status labels (shared across the boards + subitem boards).
const STATUS_OPTIONS = ['Working on it', 'Stuck', 'On Hold', 'Testing Phase', 'Done']

interface SubItem {
  id: string; name: string; status: string; owner: string; url: string; boardId: number; hasUpdates: boolean
}
interface ProjectItem {
  id: string; name: string; status: string; priority: string | null
  url: string; createdAt: string; updatedAt: string; hasUpdates: boolean
  subitems: SubItem[]; tagged: string[]
}
interface PersonProjects {
  key: string; name: string; color: string; boardId: number; projects: ProjectItem[]
}
interface ProjectComment { id: string; body: string; author: string; createdAt: string }

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs?: string[] | null }

function fmtDateTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function ProjectsBoard({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const canEdit = roleHasPermission(user.role, 'edit:projects')

  const [people, setPeople] = useState<PersonProjects[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const [expandedPeople, setExpandedPeople] = useState<Set<string>>(new Set())
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [commentsByItem, setCommentsByItem] = useState<Record<string, ProjectComment[]>>({})
  const [loadingComments, setLoadingComments] = useState<Set<string>>(new Set())

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)

  const [composer, setComposer] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState('')

  const didInitExpand = useRef(false)

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const r = await fetch(`/api/projects${isRefresh ? '?refresh=true' : ''}`)
      if (r.status === 401) { router.push('/login'); return }
      if (!r.ok) throw new Error('Failed to load projects')
      const d = await r.json()
      setPeople(d.people || [])
      setError('')
      // On first load, open every person so the full web shows; comments stay lazy.
      if (!didInitExpand.current) {
        setExpandedPeople(new Set((d.people || []).map((p: PersonProjects) => p.key)))
        didInitExpand.current = true
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [router])
  useEffect(() => { load() }, [load])

  // Lazy-load a project's comment thread (used on expand + inspector open).
  const loadComments = useCallback(async (itemId: string, forceReload = false) => {
    if (!forceReload && commentsByItem[itemId]) return
    setLoadingComments(prev => { const n = new Set(prev); n.add(itemId); return n })
    try {
      const r = await fetch(`/api/projects/${itemId}/updates`)
      if (r.ok) {
        const d = await r.json()
        setCommentsByItem(prev => ({ ...prev, [itemId]: d.updates || [] }))
      }
    } catch { /* keep */ } finally {
      setLoadingComments(prev => { const n = new Set(prev); n.delete(itemId); return n })
    }
  }, [commentsByItem])

  const colorByKey = useMemo(() => {
    const m: Record<string, string> = {}
    for (const p of people) m[p.key] = p.color
    return m
  }, [people])
  const peopleByKey = useMemo(() => {
    const m: Record<string, { name: string; color: string }> = {}
    for (const p of people) m[p.key] = { name: p.name, color: p.color }
    return m
  }, [people])

  // ── Build the graph from data + expansion state ─────────────────────
  const { nodes, links } = useMemo(() => {
    const nodes: GraphNode[] = []
    const links: GraphLink[] = []
    for (const person of people) {
      const pid = `person:${person.key}`
      nodes.push({ id: pid, type: 'person', label: person.name, color: person.color })
      if (!expandedPeople.has(person.key)) continue
      for (const proj of person.projects) {
        const projId = `project:${proj.id}`
        const cached = commentsByItem[proj.id]
        nodes.push({
          id: projId, type: 'project', label: proj.name,
          color: STATUS_COLOURS[proj.status] || NEUTRAL,
          status: proj.status,
          critical: !!proj.priority && proj.priority.toLowerCase().startsWith('critical'),
          hasUpdates: proj.hasUpdates || (cached ? cached.length > 0 : false),
          parentId: pid,
          taggedColors: (proj.tagged || []).map(k => colorByKey[k]).filter(Boolean),
          childCount: (proj.subitems || []).length,
          expanded: expandedProjects.has(proj.id),
        })
        links.push({ source: pid, target: projId, kind: 'owns' })
        // Cross-column links to other people tagged on this project.
        for (const k of (proj.tagged || [])) {
          if (colorByKey[k]) links.push({ source: `person:${k}`, target: projId, kind: 'tag', color: colorByKey[k] })
        }
        // Subitems branch beneath the project when expanded.
        if (expandedProjects.has(proj.id)) {
          for (const s of (proj.subitems || [])) {
            const sid = `subitem:${s.id}`
            nodes.push({
              id: sid, type: 'subitem', label: s.name,
              color: STATUS_COLOURS[s.status] || NEUTRAL,
              status: s.status, hasUpdates: s.hasUpdates, parentId: projId,
            })
            links.push({ source: projId, target: sid, kind: 'sub' })
          }
        }
      }
    }
    return { nodes, links }
  }, [people, expandedPeople, expandedProjects, commentsByItem, colorByKey])

  // Ref so selection logic can resolve a comment → its project without staleness.
  const linksRef = useRef(links); linksRef.current = links

  // ── Selection / expansion handlers ──────────────────────────────────
  const togglePerson = useCallback((key: string) => {
    setExpandedPeople(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])

  const handleSelect = useCallback((id: string | null) => {
    if (!id) { setSelectedId(null); return }
    if (id.startsWith('person:')) {
      togglePerson(id.slice('person:'.length))
      setSelectedId(id); setFocusId(id)
    } else if (id.startsWith('project:')) {
      const itemId = id.slice('project:'.length)
      // Selecting a project reveals its subitems and loads its comment thread.
      setExpandedProjects(prev => { const n = new Set(prev); n.add(itemId); return n })
      loadComments(itemId)
      setSelectedId(id); setFocusId(id)
    } else if (id.startsWith('subitem:')) {
      // Subitems are first-class: select the subitem itself + load its thread.
      const subId = id.slice('subitem:'.length)
      loadComments(subId)
      setSelectedId(id); setFocusId(id)
    }
  }, [togglePerson, loadComments])

  // Caret on a project node: expand/collapse its subitems, without selecting.
  const toggleProjectExpand = useCallback((projNodeId: string) => {
    const itemId = projNodeId.slice('project:'.length)
    setExpandedProjects(prev => { const n = new Set(prev); n.has(itemId) ? n.delete(itemId) : n.add(itemId); return n })
  }, [])

  // ── Write helpers (optimistic local update) ─────────────────────────
  const patchProject = useCallback((itemId: string, patch: Partial<ProjectItem>) => {
    setPeople(prev => prev.map(p => ({ ...p, projects: p.projects.map(x => x.id === itemId ? { ...x, ...patch } : x) })))
  }, [])
  const patchSubitem = useCallback((subId: string, patch: Partial<SubItem>) => {
    setPeople(prev => prev.map(p => ({ ...p, projects: p.projects.map(x => ({ ...x, subitems: x.subitems.map(s => s.id === subId ? { ...s, ...patch } : s) })) })))
  }, [])

  const setStatus = useCallback(async (itemId: string, boardId: number, label: string, target: 'project' | 'subitem') => {
    const prevLabel = (() => {
      for (const p of people) {
        if (target === 'project') { const x = p.projects.find(x => x.id === itemId); if (x) return x.status }
        else { for (const x of p.projects) { const s = x.subitems.find(s => s.id === itemId); if (s) return s.status } }
      }
      return ''
    })()
    if (target === 'project') patchProject(itemId, { status: label }); else patchSubitem(itemId, { status: label })
    try {
      const r = await fetch(`/api/projects/${itemId}/column`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId, columnId: 'status', label }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Failed')
    } catch (e: any) {
      // revert
      if (target === 'project') patchProject(itemId, { status: prevLabel }); else patchSubitem(itemId, { status: prevLabel })
      alert(`Couldn't update status: ${e.message || e}`)
    }
  }, [people, patchProject, patchSubitem])

  const addSubitem = useCallback(async (projectId: string, name: string) => {
    const r = await fetch(`/api/projects/${projectId}/subitems`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Failed to add subitem')
    setPeople(prev => prev.map(p => ({ ...p, projects: p.projects.map(x => x.id === projectId ? { ...x, subitems: [...x.subitems, d.subitem] } : x) })))
    setExpandedProjects(prev => { const n = new Set(prev); n.add(projectId); return n })
  }, [])

  // Chip click: focus + expand that person.
  const onChip = useCallback((key: string) => {
    setExpandedPeople(prev => { const n = new Set(prev); n.add(key); return n })
    const pid = `person:${key}`
    setSelectedId(pid); setFocusId(pid)
  }, [])

  // ── Resolve the selected entity for the inspector ───────────────────
  const selectedProject = useMemo(() => {
    if (!selectedId?.startsWith('project:')) return null
    const itemId = selectedId.slice('project:'.length)
    for (const p of people) {
      const proj = p.projects.find(x => x.id === itemId)
      if (proj) return { person: p, proj }
    }
    return null
  }, [selectedId, people])

  const selectedPerson = useMemo(() => {
    if (!selectedId?.startsWith('person:')) return null
    const key = selectedId.slice('person:'.length)
    return people.find(p => p.key === key) || null
  }, [selectedId, people])

  const selectedSubitem = useMemo(() => {
    if (!selectedId?.startsWith('subitem:')) return null
    const subId = selectedId.slice('subitem:'.length)
    for (const p of people) for (const proj of p.projects) {
      const s = proj.subitems.find(s => s.id === subId)
      if (s) return { person: p, proj, sub: s }
    }
    return null
  }, [selectedId, people])

  // Reset the composer when switching what's selected.
  useEffect(() => { setComposer(''); setPostError('') }, [selectedId])

  // ── Post a comment ──────────────────────────────────────────────────
  const postComment = useCallback(async (itemId: string) => {
    const body = composer.trim()
    if (!body) return
    setPosting(true); setPostError('')
    try {
      const r = await fetch(`/api/projects/${itemId}/updates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Failed to post')
      setCommentsByItem(prev => ({ ...prev, [itemId]: d.updates || [] }))
      setExpandedProjects(prev => { const n = new Set(prev); n.add(itemId); return n })
      // Reflect hasUpdates locally so the node indicator lights up (project or subitem).
      setPeople(prev => prev.map(p => ({ ...p, projects: p.projects.map(x => ({
        ...x,
        hasUpdates: x.id === itemId ? true : x.hasUpdates,
        subitems: x.subitems.map(s => s.id === itemId ? { ...s, hasUpdates: true } : s),
      })) })))
      setComposer('')
    } catch (e: any) {
      setPostError(e.message || 'Failed to post comment')
    } finally {
      setPosting(false)
    }
  }, [composer])

  // ── Feed a compact summary to the global assistant ──────────────────
  const { setPageContext: setChatContext } = useChatContext()
  useEffect(() => {
    if (loading) { setChatContext(null); return }
    setChatContext({
      module: 'projects',
      people: people.map(p => ({
        name: p.name,
        projectCount: p.projects.length,
        projects: p.projects.slice(0, 40).map(x => ({ name: x.name, status: x.status, priority: x.priority, hasComments: x.hasUpdates })),
      })),
    })
    return () => setChatContext(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, people])

  const totalProjects = people.reduce((s, p) => s + p.projects.length, 0)

  return (
    <>
      <Head><title>Projects — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <PortalTopBar activeId="projects" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          {/* Header */}
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12, flexShrink: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Projects</div>
            <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4, background: 'rgba(245,166,35,0.12)', color: T.amber, border: `1px solid ${T.amber}40` }}>Monday</span>
            {!loading && <span style={{ fontSize: 11, color: T.text3 }}>{totalProjects} projects · {people.length} channels</span>}
            <div style={{ flex: 1 }}/>
            <button onClick={() => load(true)} disabled={refreshing}
              style={{ padding: '5px 12px', borderRadius: 5, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, fontSize: 11, cursor: refreshing ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
              {refreshing ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </div>

          {/* Person chips */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap', flexShrink: 0 }}>
            {people.map(p => {
              const on = expandedPeople.has(p.key)
              return (
                <button key={p.key} onClick={() => onChip(p.key)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 16, border: `1px solid ${on ? p.color : T.border2}`, fontSize: 12, background: on ? `${p.color}22` : 'transparent', color: on ? T.text : T.text2, cursor: 'pointer', fontFamily: 'inherit' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }}/>
                  {p.name}
                  <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{p.projects.length}</span>
                </button>
              )
            })}
            {people.length > 0 && (
              <button onClick={() => setExpandedPeople(new Set())}
                style={{ padding: '5px 12px', borderRadius: 16, border: `1px solid ${T.border}`, fontSize: 11, background: 'transparent', color: T.text3, cursor: 'pointer', fontFamily: 'inherit', marginLeft: 4 }}>
                Collapse all
              </button>
            )}
          </div>

          {/* Body: graph canvas + inspector */}
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
            <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
              {error && <div style={{ position: 'absolute', top: 16, left: 16, right: 16, zIndex: 5, background: 'rgba(240,78,78,0.1)', border: `1px solid ${T.red}40`, borderRadius: 8, padding: 12, color: T.red, fontSize: 12 }}>{error}</div>}
              {loading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
                  <div style={{ fontSize: 28, animation: 'spin 1s linear infinite', color: T.text3 }}>⟳</div>
                  <div style={{ color: T.text3 }}>Loading projects from Monday…</div>
                  <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                </div>
              ) : (
                <ProjectGraph nodes={nodes} links={links} selectedId={selectedId} onSelect={handleSelect} focusId={focusId} onToggleExpand={toggleProjectExpand}/>
              )}

              {/* Legend */}
              {!loading && (
                <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 12, fontSize: 10, color: T.text3, background: 'rgba(19,21,25,0.8)', border: `1px solid ${T.border}`, borderRadius: 8, padding: '6px 10px', flexWrap: 'wrap', maxWidth: 'calc(100% - 24px)' }}>
                  {[['Working on it', T.amber], ['Stuck', T.red], ['On Hold', T.pink], ['Testing', T.purple], ['Done', T.green]].map(([l, c]) => (
                    <span key={l as string} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: c as string, display: 'inline-block' }}/>{l}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Inspector (docked, in-page — not a modal) */}
            <div style={{ width: 360, flexShrink: 0, borderLeft: `1px solid ${T.border}`, background: T.bg2, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {selectedSubitem ? (
                <SubitemInspector
                  person={selectedSubitem.person}
                  proj={selectedSubitem.proj}
                  sub={selectedSubitem.sub}
                  comments={commentsByItem[selectedSubitem.sub.id]}
                  loadingComments={loadingComments.has(selectedSubitem.sub.id)}
                  canEdit={canEdit}
                  onStatus={(label) => setStatus(selectedSubitem!.sub.id, selectedSubitem!.sub.boardId, label, 'subitem')}
                  composer={composer} setComposer={setComposer}
                  posting={posting} postError={postError}
                  onPost={() => postComment(selectedSubitem!.sub.id)}
                  onBack={() => handleSelect(`project:${selectedSubitem!.proj.id}`)}
                  onClose={() => setSelectedId(null)}
                />
              ) : selectedProject ? (
                <ProjectInspector
                  person={selectedProject.person}
                  proj={selectedProject.proj}
                  tagged={(selectedProject.proj.tagged || []).map(k => peopleByKey[k]).filter(Boolean)}
                  comments={commentsByItem[selectedProject.proj.id]}
                  loadingComments={loadingComments.has(selectedProject.proj.id)}
                  canEdit={canEdit}
                  onStatus={(label) => setStatus(selectedProject!.proj.id, selectedProject!.person.boardId, label, 'project')}
                  onSelectSubitem={(subId) => handleSelect(`subitem:${subId}`)}
                  onAddSubitem={(name) => addSubitem(selectedProject!.proj.id, name)}
                  composer={composer} setComposer={setComposer}
                  posting={posting} postError={postError}
                  onPost={() => postComment(selectedProject!.proj.id)}
                  onClose={() => setSelectedId(null)}
                />
              ) : selectedPerson ? (
                <PersonInspector person={selectedPerson} onClose={() => setSelectedId(null)}/>
              ) : (
                <div style={{ padding: 24, color: T.text3, fontSize: 13, lineHeight: 1.6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.text2, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Project web</div>
                  Each <strong style={{ color: T.text }}>person</strong> column lists their projects below their name. Click a <strong style={{ color: T.text }}>project</strong> to branch out its subitems and read/post comments here. Dashed lines connect a project to anyone else tagged on it. Drag any node and it stays where you drop it; scroll to zoom, drag the background to pan.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Inspector: a selected project + its comment thread + composer ───────
function ProjectInspector({
  person, proj, tagged, comments, loadingComments, canEdit, onStatus, onSelectSubitem, onAddSubitem, composer, setComposer, posting, postError, onPost, onClose,
}: {
  person: PersonProjects
  proj: ProjectItem
  tagged: { name: string; color: string }[]
  comments: ProjectComment[] | undefined
  loadingComments: boolean
  canEdit: boolean
  onStatus: (label: string) => void
  onSelectSubitem: (subId: string) => void
  onAddSubitem: (name: string) => Promise<void>
  composer: string
  setComposer: (s: string) => void
  posting: boolean
  postError: string
  onPost: () => void
  onClose: () => void
}) {
  const [newSub, setNewSub] = useState('')
  const [addingSub, setAddingSub] = useState(false)
  const submitSub = async () => {
    const name = newSub.trim(); if (!name) return
    setAddingSub(true)
    try { await onAddSubitem(name); setNewSub('') } catch (e: any) { alert(e.message || 'Failed to add subitem') } finally { setAddingSub(false) }
  }
  return (
    <>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: person.color, fontWeight: 600 }}>{person.name}</span>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text, lineHeight: 1.3 }}>{proj.name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <StatusSelect value={proj.status} canEdit={canEdit} onChange={onStatus} />
          {proj.priority && proj.priority.toLowerCase().startsWith('critical') && (
            <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, background: `${T.red}20`, color: T.red, border: `1px solid ${T.red}40` }}>⚠ Critical</span>
          )}
          <a href={proj.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: T.blue, textDecoration: 'none' }}>Open in Monday ↗</a>
        </div>
        {tagged.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: T.text3 }}>Tagged:</span>
            {tagged.map(t => (
              <span key={t.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 12, background: `${t.color}22`, border: `1px solid ${t.color}55`, fontSize: 10.5, color: T.text }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.color }}/>{t.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Scrollable body: subitems + comment thread */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ marginBottom: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Subitems ({proj.subitems.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {proj.subitems.map(s => {
              const sc = STATUS_COLOURS[s.status] || NEUTRAL
              return (
                <div key={s.id} onClick={() => onSelectSubitem(s.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, cursor: 'pointer' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, flexShrink: 0 }}/>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                  {s.hasUpdates && <span title="Has comments" style={{ fontSize: 10, color: T.text3 }}>💬</span>}
                  {s.status && <span style={{ fontSize: 9.5, color: sc, whiteSpace: 'nowrap' }}>{s.status}</span>}
                </div>
              )
            })}
            {proj.subitems.length === 0 && <div style={{ fontSize: 12, color: T.text3 }}>No subitems.</div>}
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input value={newSub} onChange={e => setNewSub(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitSub() }}
                placeholder="Add a subitem…"
                style={{ flex: 1, background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
              <button onClick={submitSub} disabled={addingSub || !newSub.trim()}
                style={{ padding: '6px 10px', borderRadius: 6, fontSize: 12, background: newSub.trim() && !addingSub ? T.bg4 : T.bg3, color: newSub.trim() ? T.text : T.text3, border: `1px solid ${T.border2}`, cursor: newSub.trim() && !addingSub ? 'pointer' : 'default', fontFamily: 'inherit' }}>
                {addingSub ? '…' : '+'}
              </button>
            </div>
          )}
        </div>
        <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Comments</div>
        {loadingComments && !comments && <div style={{ color: T.text3, fontSize: 12 }}>Loading comments…</div>}
        {comments && comments.length === 0 && <div style={{ color: T.text3, fontSize: 12 }}>No comments yet.</div>}
        {(comments || []).map(c => (
          <div key={c.id} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: person.color, fontWeight: 600 }}>{c.author}</span>
              <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtDateTime(c.createdAt)}</span>
            </div>
            <div style={{ fontSize: 12.5, color: T.text, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{c.body || <span style={{ color: T.text3 }}>(no text)</span>}</div>
          </div>
        ))}
      </div>

      {/* Composer */}
      {canEdit ? (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 12, flexShrink: 0 }}>
          {postError && <div style={{ color: T.red, fontSize: 11, marginBottom: 6 }}>{postError}</div>}
          <textarea
            value={composer}
            onChange={e => setComposer(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onPost() }}
            placeholder="Add a comment… (⌘/Ctrl+Enter)"
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={onPost} disabled={posting || !composer.trim()}
              style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: composer.trim() && !posting ? T.blue : T.bg4, color: composer.trim() && !posting ? '#fff' : T.text3, border: 'none', cursor: composer.trim() && !posting ? 'pointer' : 'default', fontFamily: 'inherit' }}>
              {posting ? 'Posting…' : 'Post to Monday'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 12, fontSize: 11, color: T.text3, flexShrink: 0 }}>Read-only — you don’t have permission to post comments.</div>
      )}
    </>
  )
}

// ── Inspector: a selected person hub ────────────────────────────────────
function PersonInspector({ person, onClose }: { person: PersonProjects; onClose: () => void }) {
  const byStatus: Record<string, number> = {}
  for (const p of person.projects) byStatus[p.status || '—'] = (byStatus[p.status || '—'] || 0) + 1
  return (
    <>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: person.color, display: 'inline-block' }}/>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{person.name}</div>
        <div style={{ flex: 1 }}/>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit', lineHeight: 1 }}>×</button>
      </div>
      <div style={{ padding: '14px 16px', overflowY: 'auto' }}>
        <div style={{ fontSize: 26, fontWeight: 600, fontFamily: 'monospace', color: T.text }}>{person.projects.length}</div>
        <div style={{ fontSize: 11, color: T.text3, marginBottom: 16 }}>projects in this channel</div>
        <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>By status</div>
        {Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: STATUS_COLOURS[s] || NEUTRAL, display: 'inline-block' }}/>
            <span style={{ fontSize: 12.5, color: T.text2, flex: 1 }}>{s}</span>
            <span style={{ fontSize: 12.5, fontFamily: 'monospace', color: T.text }}>{n}</span>
          </div>
        ))}
        <div style={{ marginTop: 16, fontSize: 11, color: T.text3 }}>Click a project node to read and add comments.</div>
      </div>
    </>
  )
}

// ── Editable status pill (native select styled as a chip) ───────────────
function StatusSelect({ value, canEdit, onChange }: { value: string; canEdit: boolean; onChange: (label: string) => void }) {
  const color = STATUS_COLOURS[value] || NEUTRAL
  if (!canEdit) {
    return <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 500, background: `${color}20`, color, border: `1px solid ${color}40` }}>{value || '—'}</span>
  }
  const opts = (value && !STATUS_OPTIONS.includes(value)) ? [value, ...STATUS_OPTIONS] : STATUS_OPTIONS
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ padding: '3px 6px', borderRadius: 4, fontSize: 11, fontWeight: 500, background: `${color}20`, color, border: `1px solid ${color}55`, fontFamily: 'inherit', cursor: 'pointer', outline: 'none' }}>
      {!value && <option value="" style={{ background: T.bg2, color: T.text }}>— set status —</option>}
      {opts.map(o => <option key={o} value={o} style={{ background: T.bg2, color: T.text }}>{o}</option>)}
    </select>
  )
}

// ── Inspector: a selected subitem (own status + comment thread) ─────────
function SubitemInspector({
  person, proj, sub, comments, loadingComments, canEdit, onStatus, composer, setComposer, posting, postError, onPost, onBack, onClose,
}: {
  person: PersonProjects
  proj: ProjectItem
  sub: SubItem
  comments: ProjectComment[] | undefined
  loadingComments: boolean
  canEdit: boolean
  onStatus: (label: string) => void
  composer: string
  setComposer: (s: string) => void
  posting: boolean
  postError: string
  onPost: () => void
  onBack: () => void
  onClose: () => void
}) {
  return (
    <>
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button onClick={onBack} style={{ background: 'none', border: 'none', color: T.text2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', padding: 0 }} title="Back to project">‹ {proj.name.length > 26 ? proj.name.slice(0, 25) + '…' : proj.name}</button>
          <div style={{ flex: 1 }}/>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 10, color: person.color, fontWeight: 600, marginBottom: 4 }}>Subitem</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text, lineHeight: 1.3 }}>{sub.name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <StatusSelect value={sub.status} canEdit={canEdit} onChange={onStatus} />
          {sub.owner && <span style={{ fontSize: 11, color: T.text2 }}>{sub.owner}</span>}
          {sub.url && <a href={sub.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: T.blue, textDecoration: 'none' }}>Open in Monday ↗</a>}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Comments</div>
        {loadingComments && !comments && <div style={{ color: T.text3, fontSize: 12 }}>Loading comments…</div>}
        {comments && comments.length === 0 && <div style={{ color: T.text3, fontSize: 12 }}>No comments yet.</div>}
        {(comments || []).map(c => (
          <div key={c.id} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: person.color, fontWeight: 600 }}>{c.author}</span>
              <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{fmtDateTime(c.createdAt)}</span>
            </div>
            <div style={{ fontSize: 12.5, color: T.text, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{c.body || <span style={{ color: T.text3 }}>(no text)</span>}</div>
          </div>
        ))}
      </div>

      {canEdit ? (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 12, flexShrink: 0 }}>
          {postError && <div style={{ color: T.red, fontSize: 11, marginBottom: 6 }}>{postError}</div>}
          <textarea value={composer} onChange={e => setComposer(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onPost() }}
            placeholder="Add a comment… (⌘/Ctrl+Enter)" rows={3}
            style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '8px 10px', fontSize: 12.5, fontFamily: 'inherit', outline: 'none', resize: 'vertical' }} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button onClick={onPost} disabled={posting || !composer.trim()}
              style={{ padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: composer.trim() && !posting ? T.blue : T.bg4, color: composer.trim() && !posting ? '#fff' : T.text3, border: 'none', cursor: composer.trim() && !posting ? 'pointer' : 'default', fontFamily: 'inherit' }}>
              {posting ? 'Posting…' : 'Post to Monday'}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: 12, fontSize: 11, color: T.text3, flexShrink: 0 }}>Read-only — you don’t have permission to post comments.</div>
      )}
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:projects')
}
