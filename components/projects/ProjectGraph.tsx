// components/projects/ProjectGraph.tsx
// Project tracking graph for the /projects module. NOT a physics web — a tidy
// deterministic layout: each person is a hub, their projects stack in a column
// directly below the name, and subitems indent beneath their project. Cross-
// column curves connect a project to any OTHER person tagged on it.
//
// Any node can be dragged and STAYS where you drop it (pinned, persisted to
// localStorage). Dragging a person moves its whole column (un-pinned projects
// follow). Pan = drag the background; zoom = wheel or the +/− buttons; Fit
// recentres everything.
//
// Loaded via next/dynamic({ ssr:false }) from pages/projects.tsx.

import { useRef, useEffect, useReducer, useState, useCallback } from 'react'

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
const TOP_Y = 60
const COL_W = 300
const PERSON_R = 22
const PROJECT_R = 8
const SUB_R = 4.5
const HEADER_GAP = 64       // first project below the person name
const PROJ_ROW = 30
const SUB_ROW = 24
const SUB_GAP = 8
const SUB_INDENT = 24

const PIN_KEY = 'ja-projects-pins-v1'

function loadPins(): Record<string, XY> {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '{}') } catch { return {} }
}

export default function ProjectGraph({
  nodes, links, selectedId, onSelect, focusId,
}: {
  nodes: GraphNode[]
  links: GraphLink[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  focusId?: string | null
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 900, h: 640 })
  const [pins, setPins] = useState<Record<string, XY>>({})
  const pinsRef = useRef(pins); pinsRef.current = pins
  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 })
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  const didFit = useRef(false)

  const dragRef = useRef<{ id: string; offX: number; offY: number; moved: boolean } | null>(null)
  const panRef = useRef<{ x: number; y: number } | null>(null)

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

  // ── Deterministic layout ────────────────────────────────────────────
  const persons = nodes.filter(n => n.type === 'person')
  const projectsByPerson: Record<string, GraphNode[]> = {}
  const subsByProject: Record<string, GraphNode[]> = {}
  for (const n of nodes) {
    if (n.type === 'project' && n.parentId) (projectsByPerson[n.parentId] ||= []).push(n)
    if (n.type === 'subitem' && n.parentId) (subsByProject[n.parentId] ||= []).push(n)
  }

  const pos = new Map<string, XY>()
  persons.forEach((person, idx) => {
    const base = pins[person.id] || { x: MARGIN_X + idx * COL_W, y: TOP_Y }
    pos.set(person.id, base)
    let y = base.y + HEADER_GAP
    for (const proj of (projectsByPerson[person.id] || [])) {
      pos.set(proj.id, pins[proj.id] || { x: base.x, y })
      y += PROJ_ROW
      const subs = subsByProject[proj.id] || []
      for (const s of subs) { pos.set(s.id, pins[s.id] || { x: base.x + SUB_INDENT, y }); y += SUB_ROW }
      if (subs.length) y += SUB_GAP
    }
  })

  // ── Fit everything into view ────────────────────────────────────────
  const fit = useCallback(() => {
    if (pos.size === 0) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    pos.forEach(p => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + 200); maxY = Math.max(maxY, p.y) // +label width estimate
    })
    minX -= 60; minY -= 60; maxY += 40
    const w = maxX - minX, h = maxY - minY
    const zoom = Math.min(1, Math.max(0.3, Math.min(size.w / w, size.h / h)))
    const v = viewRef.current
    v.zoom = zoom
    v.panX = (size.w - w * zoom) / 2 - minX * zoom
    v.panY = Math.max(16, (size.h - h * zoom) / 2 - minY * zoom)
    rerender()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h])

  // Fit once when the first data arrives.
  useEffect(() => {
    if (!didFit.current && persons.length > 0 && size.w > 0) { fit(); didFit.current = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persons.length, size.w, fit])

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
    dragRef.current = { id, offX: p.x - w.x, offY: p.y - w.y, moved: false }
  }
  const onBackgroundDown = (e: React.MouseEvent) => { panRef.current = { x: e.clientX, y: e.clientY } }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { id, offX, offY } = dragRef.current
        const w = toWorld(e.clientX, e.clientY)
        dragRef.current.moved = true
        setPins(prev => ({ ...prev, [id]: { x: w.x + offX, y: w.y + offY } }))
      } else if (panRef.current) {
        const v = viewRef.current
        v.panX += e.clientX - panRef.current.x
        v.panY += e.clientY - panRef.current.y
        panRef.current = { x: e.clientX, y: e.clientY }
        rerender()
      }
    }
    const onUp = () => {
      if (dragRef.current) {
        const { id, moved } = dragRef.current
        if (moved) { try { localStorage.setItem(PIN_KEY, JSON.stringify(pinsRef.current)) } catch { /* quota */ } }
        else onSelect(id)
        dragRef.current = null
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
            // owns / sub — clean near-vertical connectors
            return (
              <line key={`l${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="rgba(139,144,160,0.45)" strokeWidth={(l.kind === 'owns' ? 1.4 : 1) / v.zoom}
                style={{ opacity: on ? 1 : 0.1, transition: 'opacity 0.15s' }} />
            )
          })}

          {/* Nodes */}
          {nodes.map(n => {
            const p = pos.get(n.id); if (!p) return null
            const isLit = lit(n.id)
            const sel = n.id === selectedId
            if (n.type === 'person') {
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} onMouseDown={e => onNodeDown(e, n.id)} style={{ cursor: 'grab', opacity: isLit ? 1 : 0.2, transition: 'opacity 0.15s' }}>
                  <circle r={PERSON_R} fill={`${n.color}ee`} stroke={sel ? '#e8eaf0' : n.color} strokeWidth={sel ? 2.5 : 2} />
                  <text y={PERSON_R + 16} textAnchor="middle" fontSize={14} fontWeight={700} fill="#e8eaf0" style={{ pointerEvents: 'none' }}>{n.label}</text>
                  <title>{n.label}</title>
                </g>
              )
            }
            const r = n.type === 'project' ? PROJECT_R : SUB_R
            const showLabel = n.type === 'project' || v.zoom > 0.55 || sel || (neighbours && neighbours.has(n.id))
            const label = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} onMouseDown={e => onNodeDown(e, n.id)} style={{ cursor: 'grab', opacity: isLit ? 1 : 0.18, transition: 'opacity 0.15s' }}>
                {n.type === 'project' && n.critical && <circle r={r + 3.5} fill="none" stroke="#f04e4e" strokeWidth={2} />}
                <circle r={r} fill={n.color} stroke={sel ? '#e8eaf0' : `${n.color}`} strokeWidth={sel ? 2.5 : 1.4} />
                {n.type === 'project' && n.hasUpdates && <circle cx={r * 0.8} cy={-r * 0.8} r={3} fill="#e8eaf0" stroke={n.color} strokeWidth={1} />}
                {/* tagged-people mini dots, stacked to the left of the node */}
                {n.type === 'project' && (n.taggedColors || []).map((c, k) => (
                  <circle key={k} cx={-(r + 6 + k * 7)} cy={0} r={3} fill={c} />
                ))}
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
