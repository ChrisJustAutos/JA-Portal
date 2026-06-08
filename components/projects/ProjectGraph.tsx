// components/projects/ProjectGraph.tsx
// Project tracking graph for the /projects module. A tidy deterministic
// layout: each person is a hub, their projects stack in a column below the
// name, and subitems indent directly beneath their project — wherever that
// project has been moved to. Cross-column curves connect a project to any
// OTHER person tagged on it.
//
// Any node can be dragged and STAYS where you drop it (pinned, persisted to
// localStorage). A pinned project/subitem leaves the auto column flow so it
// never leaves a gap or overlaps; its subitems follow it. Dragging a person
// moves its whole (un-pinned) column. Pan = drag background; a click on empty
// space clears the selection; zoom = wheel / buttons; Auto-organise (driven by
// reorganiseSignal) clears all pins and refits.
//
// Loaded via next/dynamic({ ssr:false }) from pages/projects.tsx.

import { useRef, useEffect, useReducer, useState, useCallback, useMemo } from 'react'

export type NodeType = 'person' | 'project' | 'subitem'

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  color: string
  status?: string
  critical?: boolean
  hasUpdates?: boolean
  parentId?: string        // project → person, subitem → project
  taggedColors?: string[]  // colours of other people tagged (project nodes)
  childCount?: number      // # subitems (project nodes) — drives the caret
  expanded?: boolean       // whether subitems are shown
  progress?: number        // person nodes: % of projects done (0–100)
}
export interface GraphLink {
  source: string
  target: string
  kind: 'owns' | 'sub' | 'tag'
  color?: string           // tag links carry the tagged person's colour
}

interface XY { x: number; y: number }

// ── Layout constants ────────────────────────────────────────────────────
const MARGIN_X = 130
const TOP_Y = 64
const COL_W = 310
const PERSON_R = 22
const PROJECT_R = 8
const SUB_R = 4.5
const HEADER_GAP = 66        // first project below the person name
const PROJ_ROW = 30
const SUB_ROW = 24
const SUB_GAP = 10
const SUB_INDENT = 26

const PIN_KEY = 'ja-projects-pins-v1'

function loadPins(): Record<string, XY> {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '{}') } catch { return {} }
}

export default function ProjectGraph({
  nodes, links, selectedId, onSelect, focusId, onToggleExpand, reorganiseSignal,
}: {
  nodes: GraphNode[]
  links: GraphLink[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  focusId?: string | null
  onToggleExpand?: (id: string) => void
  reorganiseSignal?: number
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 900, h: 640 })
  const [pins, setPins] = useState<Record<string, XY>>({})
  const pinsRef = useRef(pins); pinsRef.current = pins
  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 })
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const didFit = useRef(false)
  const pendingFit = useRef(false)
  const reorgInit = useRef(true)

  const dragRef = useRef<{ id: string; offX: number; offY: number; sx: number; sy: number; moved: boolean } | null>(null)
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)

  useEffect(() => { setPins(loadPins()) }, [])

  // ── Container sizing ────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(320, r.width), h: Math.max(320, r.height) })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: Math.max(320, r.width), h: Math.max(320, r.height) })
    return () => ro.disconnect()
  }, [])

  const persons = useMemo(() => nodes.filter(n => n.type === 'person'), [nodes])

  // ── Deterministic, pin-aware layout ─────────────────────────────────
  const pos = useMemo(() => {
    const projectsByPerson: Record<string, GraphNode[]> = {}
    const subsByProject: Record<string, GraphNode[]> = {}
    for (const n of nodes) {
      if (n.type === 'project' && n.parentId) (projectsByPerson[n.parentId] ||= []).push(n)
      if (n.type === 'subitem' && n.parentId) (subsByProject[n.parentId] ||= []).push(n)
    }
    const m = new Map<string, XY>()
    persons.forEach((person, idx) => {
      const base = pins[person.id] || { x: MARGIN_X + idx * COL_W, y: TOP_Y }
      m.set(person.id, base)
      let y = base.y + HEADER_GAP
      for (const proj of (projectsByPerson[person.id] || [])) {
        const projPin = pins[proj.id]
        const pp = projPin || { x: base.x, y }
        m.set(proj.id, pp)
        if (!projPin) y += PROJ_ROW
        const subs = subsByProject[proj.id] || []
        if (subs.length) {
          // Subitems ALWAYS stack directly below their project's effective
          // position (they aren't individually pinnable) — so they follow a
          // project wherever it's dragged and the connector always lands.
          let sy = projPin ? pp.y + SUB_ROW : y
          for (const s of subs) {
            m.set(s.id, { x: pp.x + SUB_INDENT, y: sy })
            sy += SUB_ROW
          }
          if (!projPin) y = sy + SUB_GAP   // in-flow projects reserve subitem space
        }
      }
    })
    return m
  }, [nodes, persons, pins])

  // ── Fit everything into view ────────────────────────────────────────
  const fit = useCallback(() => {
    if (pos.size === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    pos.forEach(p => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + 200); maxY = Math.max(maxY, p.y)
    })
    minX -= 60; minY -= 60; maxY += 40
    const w = maxX - minX, h = maxY - minY
    const zoom = Math.min(1, Math.max(0.3, Math.min(size.w / w, size.h / h)))
    const v = viewRef.current
    v.zoom = zoom
    v.panX = (size.w - w * zoom) / 2 - minX * zoom
    v.panY = Math.max(16, (size.h - h * zoom) / 2 - minY * zoom)
    rerender()
  }, [pos, size.w, size.h])

  // Fit once when the first data arrives.
  useEffect(() => {
    if (!didFit.current && persons.length > 0 && size.w > 0) { fit(); didFit.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons.length, size.w, fit])

  // ── Auto-organise: clear pins + refit when the signal changes ───────
  useEffect(() => {
    if (reorgInit.current) { reorgInit.current = false; return }
    pendingFit.current = true
    setPins({})
    try { localStorage.removeItem(PIN_KEY) } catch { /* ignore */ }
  }, [reorganiseSignal])
  useEffect(() => {
    if (pendingFit.current) { pendingFit.current = false; fit() }
  }, [pos, fit])

  // ── Focus a node (chip click) ───────────────────────────────────────
  useEffect(() => {
    if (!focusId) return
    const p = pos.get(focusId)
    if (!p) return
    const v = viewRef.current
    v.panX = size.w / 2 - p.x * v.zoom
    v.panY = size.h / 3 - p.y * v.zoom
    rerender()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  // ── Coordinate helpers ──────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number): XY => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return { x: (clientX - rect.left - v.panX) / v.zoom, y: (clientY - rect.top - v.panY) / v.zoom }
  }

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const p = pos.get(id); if (!p) return
    const w = toWorld(e.clientX, e.clientY)
    dragRef.current = { id, offX: p.x - w.x, offY: p.y - w.y, sx: e.clientX, sy: e.clientY, moved: false }
  }
  const onBackgroundDown = (e: React.MouseEvent) => { panRef.current = { x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, moved: false } }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const d = dragRef.current
        // Subitems auto-arrange under their project — not individually movable.
        if (d.id.startsWith('subitem:')) return
        // Only start moving once past a small threshold, so a click with a
        // tiny wobble still opens the item instead of pinning it.
        if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) <= 4) return
        d.moved = true
        const w = toWorld(e.clientX, e.clientY)
        setPins(prev => ({ ...prev, [d.id]: { x: w.x + d.offX, y: w.y + d.offY } }))
      } else if (panRef.current) {
        const v = viewRef.current
        v.panX += e.clientX - panRef.current.x
        v.panY += e.clientY - panRef.current.y
        panRef.current.x = e.clientX; panRef.current.y = e.clientY
        if (Math.abs(e.clientX - panRef.current.ox) + Math.abs(e.clientY - panRef.current.oy) > 4) panRef.current.moved = true
        rerender()
      }
    }
    const onUp = () => {
      if (dragRef.current) {
        const { id, moved } = dragRef.current
        if (moved) { try { localStorage.setItem(PIN_KEY, JSON.stringify(pinsRef.current)) } catch { /* quota */ } }
        else onSelect(id)
        dragRef.current = null
      } else if (panRef.current && !panRef.current.moved) {
        onSelect(null)   // click on empty space clears selection
      }
      panRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, onSelect])

  const zoomToward = (mx: number, my: number, factor: number) => {
    const v = viewRef.current
    const nz = Math.min(3, Math.max(0.25, v.zoom * factor))
    v.panX = mx - ((mx - v.panX) * nz) / v.zoom
    v.panY = my - ((my - v.panY) * nz) / v.zoom
    v.zoom = nz
    rerender()
  }
  const onWheel = (e: React.WheelEvent) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    zoomToward(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  }

  // ── Selection neighbourhood ─────────────────────────────────────────
  const neighbours = (() => {
    if (!selectedId) return null
    const set = new Set<string>([selectedId])
    for (const l of links) {
      if (l.source === selectedId) set.add(l.target)
      if (l.target === selectedId) set.add(l.source)
    }
    return set
  })()
  const lit = (id: string) => !neighbours || neighbours.has(id)

  const v = viewRef.current

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor: panRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}>
      <svg width={size.w} height={size.h} onMouseDown={onBackgroundDown} onWheel={onWheel} style={{ display: 'block', userSelect: 'none' }}>
        <g transform={`translate(${v.panX},${v.panY}) scale(${v.zoom})`}>
          {/* Links */}
          {links.map((l, i) => {
            const a = pos.get(l.source), b = pos.get(l.target)
            if (!a || !b) return null
            const on = lit(l.source) && lit(l.target)
            if (l.kind === 'tag') {
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
              const ox = -(b.y - a.y) * 0.18, oy = (b.x - a.x) * 0.18
              return (
                <path key={`l${i}`} d={`M${a.x},${a.y} Q${mx + ox},${my + oy} ${b.x},${b.y}`} fill="none"
                  stroke={l.color || '#8b90a0'} strokeWidth={1.4 / v.zoom} strokeDasharray="5 4"
                  style={{ opacity: on ? 0.7 : 0.06, transition: 'opacity 0.15s' }} />
              )
            }
            // Tree elbow: drop from the parent, then branch across to the
            // child — so the connector clearly lands on each subitem (and keeps
            // connecting wherever a node has been dragged).
            return (
              <path key={`l${i}`} d={`M${a.x},${a.y} L${a.x},${b.y} L${b.x},${b.y}`} fill="none"
                stroke="rgba(139,144,160,0.65)" strokeWidth={(l.kind === 'owns' ? 1.5 : 1.4) / v.zoom}
                style={{ opacity: on ? 1 : 0.1, transition: 'opacity 0.15s' }} />
            )
          })}

          {/* Nodes */}
          {nodes.map(n => {
            const p = pos.get(n.id); if (!p) return null
            const isLit = lit(n.id)
            const sel = n.id === selectedId
            if (n.type === 'person') {
              const R = PERSON_R + 4
              const C = 2 * Math.PI * R
              const prog = typeof n.progress === 'number' ? Math.max(0, Math.min(100, n.progress)) : null
              const pHitW = Math.max(2 * (PERSON_R + 10), n.label.length * 9 + 24)
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} onMouseDown={e => onNodeDown(e, n.id)} style={{ cursor: 'grab', opacity: isLit ? 1 : 0.2, transition: 'opacity 0.15s' }}>
                  <rect x={-pHitW / 2} y={-(PERSON_R + 24)} width={pHitW} height={2 * PERSON_R + 52} fill="transparent" />
                  <circle r={PERSON_R} fill={`${n.color}ee`} stroke={sel ? '#e8eaf0' : n.color} strokeWidth={sel ? 2.5 : 2} />
                  {prog !== null && (
                    <>
                      <circle r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={3} />
                      <circle r={R} fill="none" stroke="#34c77b" strokeWidth={3} strokeLinecap="round"
                        strokeDasharray={`${(C * prog) / 100} ${C}`} transform="rotate(-90)" />
                      <text y={-(PERSON_R + 13)} textAnchor="middle" fontSize={11} fontWeight={700} fill="#34c77b" style={{ pointerEvents: 'none' }}>{prog}% done</text>
                    </>
                  )}
                  <text y={PERSON_R + 17} textAnchor="middle" fontSize={14} fontWeight={700} fill="#e8eaf0" style={{ pointerEvents: 'none' }}>{n.label}</text>
                  <title>{n.label}</title>
                </g>
              )
            }
            const r = n.type === 'project' ? PROJECT_R : SUB_R
            const showLabel = n.type === 'project' || v.zoom > 0.55 || sel || (neighbours && neighbours.has(n.id))
            const label = n.label.length > 32 ? n.label.slice(0, 31) + '…' : n.label
            const fontPx = n.type === 'project' ? 12 : 10.5
            const hitLeft = -(r + (n.type === 'project' && (n.childCount || 0) > 0 ? 22 : 8))
            const hitRight = r + 10 + label.length * fontPx * 0.6
            const hitH = n.type === 'project' ? 26 : 22
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} onMouseDown={e => onNodeDown(e, n.id)} style={{ cursor: n.type === 'subitem' ? 'pointer' : 'grab', opacity: isLit ? 1 : 0.18, transition: 'opacity 0.15s' }}>
                <rect x={hitLeft} y={-hitH / 2} width={hitRight - hitLeft} height={hitH} fill="transparent" />
                {n.type === 'project' && n.critical && <circle r={r + 6} fill="none" stroke="#f04e4e" strokeWidth={2} />}
                <circle r={r} fill={n.color} stroke={sel ? '#e8eaf0' : `${n.color}`} strokeWidth={sel ? 2.5 : 1.4} />
                {/* per-project completion ring (subitem-based) */}
                {n.type === 'project' && typeof n.progress === 'number' && (
                  <>
                    <circle r={r + 3} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={2.5} />
                    <circle r={r + 3} fill="none" stroke="#34c77b" strokeWidth={2.5} strokeLinecap="round"
                      strokeDasharray={`${2 * Math.PI * (r + 3) * Math.max(0, Math.min(100, n.progress)) / 100} ${2 * Math.PI * (r + 3)}`} transform="rotate(-90)" />
                  </>
                )}
                {n.hasUpdates && <circle cx={r * 0.85} cy={r * 0.85} r={3} fill="#e8eaf0" stroke={n.color} strokeWidth={1} />}
                {n.type === 'project' && (n.taggedColors || []).map((c, k, arr) => (
                  <circle key={k} cx={(k - (arr.length - 1) / 2) * 7} cy={-(r + 7)} r={3} fill={c} />
                ))}
                {n.type === 'project' && (n.childCount || 0) > 0 && (
                  <g onMouseDown={e => { e.stopPropagation(); onToggleExpand?.(n.id) }} style={{ cursor: 'pointer' }}>
                    <circle cx={-(r + 12)} cy={0} r={8} fill="#1a1d23" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                    <text x={-(r + 12)} y={3.5} textAnchor="middle" fontSize={10} fill="#b9bdc9" style={{ pointerEvents: 'none' }}>{n.expanded ? '−' : '+'}</text>
                  </g>
                )}
                {showLabel && (
                  <text x={r + 8} y={n.type === 'project' ? 4 : 3.5} fontSize={n.type === 'project' ? 12 : 10.5}
                    fontWeight={n.type === 'project' ? 500 : 400} fill={n.type === 'project' ? '#e8eaf0' : '#b9bdc9'} style={{ pointerEvents: 'none' }}>
                    {label}
                  </text>
                )}
                <title>{n.label}{n.status ? ` — ${n.status}` : ''}</title>
              </g>
            )
          })}
        </g>
      </svg>

      {/* Controls */}
      <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={fit} title="Fit to view" style={ctrlBtn}>⤢</button>
        <button onClick={() => zoomToward(size.w / 2, size.h / 2, 1.2)} style={ctrlBtn}>+</button>
        <button onClick={() => zoomToward(size.w / 2, size.h / 2, 1 / 1.2)} style={ctrlBtn}>−</button>
      </div>
    </div>
  )
}

const ctrlBtn: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
  background: '#131519', color: '#e8eaf0', fontSize: 15, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1,
}
