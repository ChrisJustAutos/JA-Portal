// pages/overview.tsx
// Custom dashboard with named layouts. 12-col grid, drag/resize in edit mode,
// per-user persistence, multiple saved layouts with one marked active.

import { useState, useEffect, useCallback, useRef } from 'react'
import Head from 'next/head'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import { UserRole } from '../lib/permissions'
import { getWidgetDef, defaultConfigFor, DateRangeKey, DATE_RANGE_OPTIONS } from '../lib/dashboard/catalog'
import { RENDERERS } from '../components/dashboard/WidgetRenderers'
import WidgetConfigPanel from '../components/dashboard/WidgetConfigPanel'
import WidgetCatalogPicker from '../components/dashboard/WidgetCatalogPicker'
import { useChatContext } from '../components/GlobalChatbot'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

const GRID_COLS = 12
const ROW_HEIGHT = 80
const GAP = 12

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:overview')
}

interface WidgetInstance {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  config: Record<string, any>
  dateOverride?: { range: DateRangeKey, from?: string, to?: string }
}

interface SavedLayoutMeta {
  id: string
  name: string
  is_active: boolean
  updated_at: string
}

function newId(): string { return 'w_' + Math.random().toString(36).substring(2, 10) }

function findSpot(widgets: WidgetInstance[], w: number, h: number): { x: number, y: number } {
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const overlaps = widgets.some(wi =>
        !(x + w <= wi.x || x >= wi.x + wi.w || y + h <= wi.y || y >= wi.y + wi.h)
      )
      if (!overlaps) return { x, y }
    }
  }
  return { x: 0, y: 0 }
}

export default function OverviewPage({ user }: { user: { id: string, email: string, role: UserRole, name: string } }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [widgets, setWidgets] = useState<WidgetInstance[]>([])
  const [globalDate, setGlobalDate] = useState<DateRangeKey>('today')
  const [widgetData, setWidgetData] = useState<Record<string, any>>({})
  const [dataLoading, setDataLoading] = useState(false)
  const [isDefault, setIsDefault] = useState(false)

  // Named layout state
  const [currentLayoutId, setCurrentLayoutId] = useState<string | null>(null)
  const [currentLayoutName, setCurrentLayoutName] = useState<string>('Default')
  const [savedLayouts, setSavedLayouts] = useState<SavedLayoutMeta[]>([])
  const [layoutsMenuOpen, setLayoutsMenuOpen] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [renameForId, setRenameForId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const [editMode, setEditMode] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)

  const [dragging, setDragging] = useState<{ id: string, mode: 'move'|'resize', startX: number, startY: number, origW: WidgetInstance } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const loadDataAbort = useRef<AbortController | null>(null)

  const loadLayout = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [activeRes, listRes] = await Promise.all([
        fetch('/api/dashboard/layout?key=overview'),
        fetch('/api/dashboard/layout?key=overview&list=1'),
      ])
      const active = await activeRes.json()
      const list = await listRes.json()
      if (!activeRes.ok) throw new Error(active.error || 'Load failed')
      if (!listRes.ok)   throw new Error(list.error   || 'List failed')

      setWidgets((active.widgets || []).map((w: any) => ({ ...w, config: w.config || {} })))
      setGlobalDate((active.global_date_range || 'today') as DateRangeKey)
      setIsDefault(!!active.is_default)
      setCurrentLayoutId(active.id || null)
      setCurrentLayoutName(active.name || 'Default')
      setSavedLayouts(list.layouts || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  const loadData = useCallback(async (ws: WidgetInstance[], gd: DateRangeKey) => {
    if (ws.length === 0) { setWidgetData({}); return }
    loadDataAbort.current?.abort()
    const ctrl = new AbortController()
    loadDataAbort.current = ctrl
    setDataLoading(true)
    try {
      const r = await fetch('/api/dashboard/data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widgets: ws.map(w => ({ id: w.id, type: w.type, config: w.config, dateOverride: w.dateOverride })),
          globalDateRange: { key: gd },
        }),
        signal: ctrl.signal,
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Data load failed')
      setWidgetData(d.results || {})
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError('Data: ' + (e?.message || e))
    }
    finally { setDataLoading(false) }
  }, [])

  useEffect(() => { loadLayout() }, [loadLayout])

  const dataCacheKey = JSON.stringify({
    gd: globalDate,
    ws: widgets.map(w => ({ id: w.id, type: w.type, config: w.config, dateOverride: w.dateOverride })),
  })
  useEffect(() => {
    if (loading) return
    if (dragging) return
    loadData(widgets, globalDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataCacheKey, loading])

  async function saveCurrent() {
    setError(''); setInfo('')
    if (!currentLayoutId) {
      // Viewing default — prompt for name via Save As flow
      setSaveAsName(currentLayoutName === 'Default' ? 'My dashboard' : currentLayoutName)
      setSaveAsOpen(true)
      return
    }
    try {
      const r = await fetch('/api/dashboard/layout?key=overview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: currentLayoutId,
          widgets,
          global_date_range: globalDate,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      setInfo(`Saved "${currentLayoutName}"`)
      setDirty(false)
      await loadLayout()
      setTimeout(() => setInfo(''), 2500)
    } catch (e: any) { setError(e.message) }
  }

  async function saveAs(name: string) {
    setError(''); setInfo('')
    const clean = name.trim()
    if (!clean) { setError('Name required'); return }
    try {
      const r = await fetch('/api/dashboard/layout?key=overview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: clean, widgets,
          global_date_range: globalDate,
          activate: true,
        }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Save failed')
      setInfo(`Saved as "${clean}"`)
      setSaveAsOpen(false)
      setSaveAsName('')
      setDirty(false)
      setIsDefault(false)
      await loadLayout()
      setTimeout(() => setInfo(''), 2500)
    } catch (e: any) { setError(e.message) }
  }

  async function switchLayout(id: string) {
    if (dirty && !confirm('Discard unsaved changes and switch layout?')) return
    setLayoutsMenuOpen(false)
    setError(''); setInfo('')
    try {
      const r = await fetch('/api/dashboard/layout?key=overview&action=activate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Switch failed')
      setDirty(false)
      await loadLayout()
    } catch (e: any) { setError(e.message) }
  }

  async function renameLayout(id: string, name: string) {
    const clean = name.trim()
    if (!clean) return
    try {
      const r = await fetch('/api/dashboard/layout?key=overview&action=rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: clean }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Rename failed')
      setRenameForId(null)
      setRenameValue('')
      await loadLayout()
    } catch (e: any) { setError(e.message) }
  }

  async function deleteLayout(id: string, name: string) {
    if (!confirm(`Delete layout "${name}"? This cannot be undone.`)) return
    try {
      const r = await fetch(`/api/dashboard/layout?key=overview&id=${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed')
      setLayoutsMenuOpen(false)
      setInfo(`Deleted "${name}"`)
      await loadLayout()
      setTimeout(() => setInfo(''), 2500)
    } catch (e: any) { setError(e.message) }
  }

  async function resetToDefault() {
    if (!confirm('Delete ALL your saved layouts and revert to the shared default? This cannot be undone.')) return
    try {
      const r = await fetch('/api/dashboard/layout?key=overview', { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Reset failed')
      setLayoutsMenuOpen(false)
      setInfo('Reset to default')
      setDirty(false)
      await loadLayout()
      setTimeout(() => setInfo(''), 2500)
    } catch (e: any) { setError(e.message) }
  }

  function addWidget(type: string) {
    const def = getWidgetDef(type)
    if (!def) return
    const size = def.defaultSize
    const { x, y } = findSpot(widgets, size.w, size.h)
    const w: WidgetInstance = { id: newId(), type, x, y, w: size.w, h: size.h, config: defaultConfigFor(type) }
    setWidgets(ws => [...ws, w])
    setDirty(true)
    setCatalogOpen(false)
    setConfigFor(w.id)
  }

  function updateConfig(id: string, config: Record<string, any>) {
    setWidgets(ws => ws.map(w => w.id === id ? { ...w, config } : w))
    setConfigFor(null)
    setDirty(true)
  }

  function removeWidget(id: string) {
    setWidgets(ws => ws.filter(w => w.id !== id))
    setConfigFor(null)
    setDirty(true)
  }

  function onMouseDown(e: React.MouseEvent, id: string, mode: 'move'|'resize') {
    if (!editMode) return
    e.preventDefault(); e.stopPropagation()
    const w = widgets.find(x => x.id === id)
    if (!w) return
    setDragging({ id, mode, startX: e.clientX, startY: e.clientY, origW: { ...w } })
  }

  useEffect(() => {
    if (!dragging) return
    function onMove(e: MouseEvent) {
      if (!dragging || !gridRef.current) return
      const rect = gridRef.current.getBoundingClientRect()
      const colW = (rect.width - GAP * (GRID_COLS - 1)) / GRID_COLS
      const dx = e.clientX - dragging.startX
      const dy = e.clientY - dragging.startY
      const dCol = Math.round(dx / (colW + GAP))
      const dRow = Math.round(dy / (ROW_HEIGHT + GAP))
      setWidgets(ws => ws.map(w => {
        if (w.id !== dragging.id) return w
        if (dragging.mode === 'move') {
          const newX = Math.max(0, Math.min(GRID_COLS - w.w, dragging.origW.x + dCol))
          const newY = Math.max(0, dragging.origW.y + dRow)
          return { ...w, x: newX, y: newY }
        } else {
          const newW = Math.max(2, Math.min(GRID_COLS - w.x, dragging.origW.w + dCol))
          const newH = Math.max(2, dragging.origW.h + dRow)
          return { ...w, w: newW, h: newH }
        }
      }))
      setDirty(true)
    }
    function onUp() { setDragging(null) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-layouts-menu]')) setLayoutsMenuOpen(false)
    }
    if (layoutsMenuOpen) document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [layoutsMenuOpen])

  const maxRow = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 6)
  const gridHeight = maxRow * ROW_HEIGHT + (maxRow - 1) * GAP + 40

  const configWidget = configFor ? widgets.find(w => w.id === configFor) : null
  const configDef = configWidget ? getWidgetDef(configWidget.type) : null

  // ─── Feed dashboard layout + widget data to the global AI chatbot ──────
  // Overview is fully customisable, so we tell the assistant which layout
  // is active, what widgets are on it, and the current data each widget
  // is rendering. That way it can answer "what's on my dashboard" or
  // "what does the X widget show me right now" without any back-end fetch.
  const { setPageContext: setChatContext } = useChatContext()
  useEffect(() => {
    if (loading) { setChatContext(null); return }
    setChatContext({
      layoutName: currentLayoutName,
      layoutId: currentLayoutId,
      isDefault,
      editMode,
      globalDateRange: globalDate,
      savedLayouts: savedLayouts.map(l => ({
        name: l.name,
        isActive: l.is_active,
      })),
      widgetCount: widgets.length,
      // For each widget on the current layout: what type, what config,
      // and the data it is currently rendering (capped to keep payload small).
      widgets: widgets.map(w => {
        const def = getWidgetDef(w.type)
        const data = widgetData[w.id]
        // Cap each widget's data to avoid blowing the system prompt budget.
        // The widget renderer holds the full data; the assistant only needs
        // a representative slice to answer questions.
        let dataPreview: any = data
        if (data && typeof data === 'object') {
          const json = JSON.stringify(data)
          if (json.length > 1500) {
            // Truncate large payloads — keep top-level keys + a short tail
            if (Array.isArray(data)) {
              dataPreview = { _truncated: true, count: data.length, sample: data.slice(0, 5) }
            } else {
              const keys = Object.keys(data)
              dataPreview = { _truncated: true, keys, sample: Object.fromEntries(keys.slice(0, 8).map(k => [k, data[k]])) }
            }
          }
        }
        return {
          id: w.id,
          type: w.type,
          title: def?.label || w.type,
          size: { w: w.w, h: w.h },
          position: { x: w.x, y: w.y },
          config: w.config,
          dateRange: w.dateOverride?.range || globalDate,
          data: dataPreview,
        }
      }),
    })
    return () => { setChatContext(null) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, widgets, widgetData, currentLayoutName, currentLayoutId, isDefault, editMode, globalDate, savedLayouts])

  return (
    <>
      <Head><title>Overview — Just Autos</title></Head>
      <div style={{display:'flex', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalSidebar activeId="overview" currentUserRole={user.role} currentUserVisibleTabs={(user as any).visibleTabs}/>
        <main style={{flex:1, padding:'20px 32px 40px', overflow:'auto'}}>

          <div style={{display:'flex', alignItems:'center', gap:12, marginBottom:6, flexWrap:'wrap'}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Overview</h1>

            {/* Layouts dropdown */}
            <div data-layouts-menu style={{position:'relative'}}>
              <button onClick={() => setLayoutsMenuOpen(o => !o)}
                style={{display:'inline-flex', alignItems:'center', gap:6, padding:'6px 12px', borderRadius:6, border:`1px solid ${T.border2}`, background:T.bg3, color:T.text, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
                <span style={{color:T.text3, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>Layout:</span>
                <span style={{fontWeight:500}}>{currentLayoutName}</span>
                {dirty && <span style={{color:T.amber, fontSize:14, marginLeft:2}}>•</span>}
                <span style={{color:T.text3, fontSize:10}}>▾</span>
              </button>
              {layoutsMenuOpen && (
                <div style={{position:'absolute', top:'100%', left:0, marginTop:4, background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.4)', minWidth:280, zIndex:50, padding:4}}>
                  {savedLayouts.length === 0 ? (
                    <div style={{padding:'10px 14px', fontSize:11, color:T.text3}}>No saved layouts yet. Make changes, then Save to create one.</div>
                  ) : savedLayouts.map(l => {
                    const isEditing = renameForId === l.id
                    return (
                      <div key={l.id} style={{display:'flex', alignItems:'center', gap:4, padding:'4px 6px', borderRadius:6, background: l.is_active ? T.bg3 : 'transparent'}}>
                        {isEditing ? (
                          <>
                            <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') renameLayout(l.id, renameValue); if (e.key === 'Escape') setRenameForId(null) }}
                              style={{flex:1, padding:'6px 8px', background:T.bg3, border:`1px solid ${T.blue}`, color:T.text, borderRadius:4, fontSize:12, fontFamily:'inherit', outline:'none', minWidth:0}}/>
                            <button onClick={() => renameLayout(l.id, renameValue)} style={{padding:'4px 8px', border:'none', background:T.blue, color:'#fff', borderRadius:4, fontSize:10, cursor:'pointer', fontFamily:'inherit'}}>✓</button>
                            <button onClick={() => setRenameForId(null)} style={{padding:'4px 8px', border:`1px solid ${T.border2}`, background:'transparent', color:T.text3, borderRadius:4, fontSize:10, cursor:'pointer', fontFamily:'inherit'}}>✕</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => switchLayout(l.id)}
                              style={{flex:1, textAlign:'left', padding:'6px 8px', background:'transparent', border:'none', color:T.text, fontSize:12, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', gap:6}}>
                              <span style={{width:12, color: l.is_active ? T.green : 'transparent', fontSize:10}}>{l.is_active ? '●' : ''}</span>
                              <span>{l.name}</span>
                            </button>
                            <button onClick={() => { setRenameForId(l.id); setRenameValue(l.name) }} title="Rename"
                              style={{padding:'4px 6px', border:'none', background:'transparent', color:T.text3, borderRadius:4, fontSize:11, cursor:'pointer'}}>✎</button>
                            <button onClick={() => deleteLayout(l.id, l.name)} title="Delete"
                              style={{padding:'4px 6px', border:'none', background:'transparent', color:T.text3, borderRadius:4, fontSize:11, cursor:'pointer'}}>🗑</button>
                          </>
                        )}
                      </div>
                    )
                  })}
                  <div style={{height:1, background:T.border, margin:'4px 0'}}/>
                  <button onClick={() => { setSaveAsName(''); setSaveAsOpen(true); setLayoutsMenuOpen(false) }}
                    style={{display:'block', width:'100%', textAlign:'left', padding:'8px 14px', background:'transparent', border:'none', color:T.blue, fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>
                    + Save current as new layout…
                  </button>
                  <button onClick={resetToDefault}
                    style={{display:'block', width:'100%', textAlign:'left', padding:'8px 14px', background:'transparent', border:'none', color:T.red, fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>
                    Reset all layouts to default
                  </button>
                </div>
              )}
            </div>

            {isDefault && <span style={{fontSize:10, padding:'3px 8px', borderRadius:10, background:`${T.amber}22`, color:T.amber, border:`1px solid ${T.amber}55`, fontWeight:600, textTransform:'uppercase'}}>Default</span>}

            <div style={{flex:1}}/>

            <select value={globalDate} onChange={e => { setGlobalDate(e.target.value as DateRangeKey); setDirty(true) }}
              style={{padding:'7px 12px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:12, fontFamily:'inherit', outline:'none'}}>
              {DATE_RANGE_OPTIONS.filter(o => o.value !== 'custom').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            {!editMode ? (
              <button onClick={() => setEditMode(true)}
                style={{padding:'7px 14px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
                ✎ Edit dashboard
              </button>
            ) : (
              <>
                <button onClick={() => setCatalogOpen(true)}
                  style={{padding:'7px 14px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:12, fontWeight:600, fontFamily:'inherit', cursor:'pointer'}}>
                  + Add widget
                </button>
                <button onClick={saveCurrent} disabled={!dirty}
                  style={{padding:'7px 14px', borderRadius:6, border:'none', background: dirty ? T.green : T.bg4, color: dirty ? '#fff' : T.text3, fontSize:12, fontWeight:600, fontFamily:'inherit', cursor: dirty ? 'pointer' : 'not-allowed'}}>
                  {dirty ? 'Save' : 'Saved'}
                </button>
                <button onClick={() => { setSaveAsName(''); setSaveAsOpen(true) }}
                  style={{padding:'7px 12px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
                  Save as…
                </button>
                <button onClick={() => { if (dirty && !confirm('Discard unsaved changes?')) return; setEditMode(false); loadLayout() }}
                  style={{padding:'7px 12px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>
                  Done
                </button>
              </>
            )}
          </div>

          {dataLoading && <div style={{fontSize:11, color:T.text3, marginBottom:10}}>Refreshing widget data…</div>}
          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}
          {info  && <div style={{background:'rgba(52,199,123,0.1)', border:`1px solid ${T.green}40`, borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13, marginBottom:12}}>{info}</div>}

          {loading ? (
            <div style={{padding:40, textAlign:'center', color:T.text3}}>Loading…</div>
          ) : widgets.length === 0 ? (
            <div style={{background:T.bg2, border:`1px dashed ${T.border2}`, borderRadius:12, padding:60, textAlign:'center'}}>
              <div style={{fontSize:16, fontWeight:600, marginBottom:8}}>Your dashboard is empty</div>
              <div style={{fontSize:13, color:T.text3, marginBottom:20}}>Add widgets to customise your Overview page.</div>
              <button onClick={() => { setEditMode(true); setCatalogOpen(true) }}
                style={{padding:'10px 20px', borderRadius:6, border:'none', background:T.accent, color:'#fff', fontSize:13, fontWeight:600, fontFamily:'inherit', cursor:'pointer'}}>
                + Add your first widget
              </button>
            </div>
          ) : (
            <div ref={gridRef} style={{
              position:'relative', width:'100%', minHeight: gridHeight,
              background: editMode ? `repeating-linear-gradient(0deg, transparent, transparent ${ROW_HEIGHT + GAP - 1}px, ${T.border} ${ROW_HEIGHT + GAP - 1}px, ${T.border} ${ROW_HEIGHT + GAP}px)` : 'transparent',
            }}>
              {widgets.map(w => {
                const r = widgetData[w.id]
                const def = getWidgetDef(w.type)
                const Renderer = RENDERERS[w.type]
                const x = `calc((100% - ${GAP * (GRID_COLS - 1)}px) / ${GRID_COLS} * ${w.x} + ${GAP * w.x}px)`
                const wid = `calc((100% - ${GAP * (GRID_COLS - 1)}px) / ${GRID_COLS} * ${w.w} + ${GAP * (w.w - 1)}px)`
                const y = w.y * (ROW_HEIGHT + GAP)
                const h = w.h * ROW_HEIGHT + (w.h - 1) * GAP
                return (
                  <div key={w.id} style={{
                    position:'absolute', left: x, top: y, width: wid, height: h,
                    background:T.bg2, border:`1px solid ${editMode ? T.border2 : T.border}`, borderRadius:10,
                    padding:14, boxSizing:'border-box',
                    transition: dragging?.id === w.id ? 'none' : 'left 0.15s, top 0.15s, width 0.15s, height 0.15s',
                    userSelect: editMode ? 'none' : 'auto',
                  }}>
                    {editMode && (
                      <div style={{position:'absolute', top:4, right:4, display:'flex', gap:4, zIndex:2}}>
                        <button onMouseDown={e => onMouseDown(e, w.id, 'move')} title="Drag to move"
                          style={{width:24, height:24, borderRadius:4, border:`1px solid ${T.border2}`, background:T.bg3, color:T.text2, fontSize:12, cursor:'move', padding:0, lineHeight:'22px'}}>⤧</button>
                        <button onClick={() => setConfigFor(w.id)} title="Edit config"
                          style={{width:24, height:24, borderRadius:4, border:`1px solid ${T.border2}`, background:T.bg3, color:T.text2, fontSize:10, cursor:'pointer', padding:0}}>⚙</button>
                      </div>
                    )}
                    {editMode && (
                      <div onMouseDown={e => onMouseDown(e, w.id, 'resize')} title="Drag to resize"
                        style={{position:'absolute', bottom:0, right:0, width:16, height:16, cursor:'nwse-resize', background:`linear-gradient(135deg, transparent 50%, ${T.text3} 50%)`, opacity:0.6, zIndex:2}}/>
                    )}
                    {!Renderer ? (
                      <div style={{color:T.red, fontSize:11}}>Unknown widget type: {w.type}</div>
                    ) : !r ? (
                      <div style={{color:T.text3, fontSize:11}}>Loading…</div>
                    ) : !r.ok ? (
                      <div style={{color:T.red, fontSize:11}}>
                        <div style={{fontWeight:600, marginBottom:4}}>{def?.label || w.type} — error</div>
                        <div style={{fontFamily:'monospace', fontSize:10}}>{r.error}</div>
                      </div>
                    ) : (
                      <Renderer config={w.config} data={r.data}/>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>

      {catalogOpen && <WidgetCatalogPicker onPick={addWidget} onClose={() => setCatalogOpen(false)}/>}
      {configWidget && configDef && (
        <WidgetConfigPanel
          widgetDef={configDef}
          initialConfig={configWidget.config}
          onSave={(cfg) => updateConfig(configWidget.id, cfg)}
          onCancel={() => setConfigFor(null)}
          onDelete={() => removeWidget(configWidget.id)}
        />
      )}

      {saveAsOpen && (
        <div style={{position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:20}}
             onClick={() => setSaveAsOpen(false)}>
          <div onClick={e => e.stopPropagation()}
               style={{background:T.bg2, border:`1px solid ${T.border2}`, borderRadius:12, width:'100%', maxWidth:420, padding:20}}>
            <div style={{fontSize:16, fontWeight:600, marginBottom:6}}>Save layout as…</div>
            <div style={{fontSize:12, color:T.text3, marginBottom:14}}>Give this layout a name. It will be saved and set as active.</div>
            <input autoFocus value={saveAsName} onChange={e => setSaveAsName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveAs(saveAsName) }}
              placeholder="e.g. Sales view, Ops view"
              style={{width:'100%', padding:'8px 10px', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box', marginBottom:14}}/>
            <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
              <button onClick={() => setSaveAsOpen(false)}
                style={{padding:'8px 14px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:'pointer'}}>Cancel</button>
              <button onClick={() => saveAs(saveAsName)} disabled={!saveAsName.trim()}
                style={{padding:'8px 18px', borderRadius:6, border:'none', background: saveAsName.trim() ? T.accent : T.bg4, color: saveAsName.trim() ? '#fff' : T.text3, fontSize:12, fontWeight:600, fontFamily:'inherit', cursor: saveAsName.trim() ? 'pointer' : 'not-allowed'}}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
