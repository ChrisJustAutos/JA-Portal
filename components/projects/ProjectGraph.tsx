// components/projects/ProjectGraph.tsx
// Self-contained SVG force-directed graph (Obsidian-style) for the /projects
// module. No external dependency — a small Verlet-ish spring simulation runs in
// a requestAnimationFrame loop with alpha cooling so it settles and stops.
//
// Node types: 'person' (hub) → 'project' (orbits person) → 'comment' (branches
// off a project). Links are drawn as gently bowed quadratic curves for the web
// feel. Selecting a node dims everything outside its immediate neighbourhood.
//
// Loaded via next/dynamic({ ssr:false }) from pages/projects.tsx — it touches
// window/RAF and must only run client-side.

import { useRef, useEffect, useReducer, useCallback, useState } from 'react'

export type NodeType = 'person' | 'project' | 'comment'

export interface GraphNode {
  id: string
  type: NodeType
  label: string
  color: string
  status?: string
  critical?: boolean
  hasUpdates?: boolean
  parentId?: string   // used to spawn new nodes near their parent
}
export interface GraphLink {
  source: string
  target: string
  kind: 'owns' | 'comment'
}

interface P { x: number; y: number; vx: number; vy: number; fixed?: boolean }

// ── Force / layout constants ───────────────────────────────────────────
const REPULSION = 2600
const MIN_DIST = 14
const SPRING_K = 0.045
const REST_OWNS = 150
const REST_COMMENT = 60
const CENTER_K = 0.012
const DAMPING = 0.86
const ALPHA_DECAY = 0.985
const ALPHA_MIN = 0.004

const RADIUS: Record<NodeType, number> = { person: 24, project: 12, comment: 5 }

function radiusFor(n: GraphNode): number {
  return RADIUS[n.type]
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
  const [size, setSize] = useState({ w: 800, h: 600 })

  // Live refs so the rAF loop always sees the latest props without re-binding.
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const linksRef = useRef(links); linksRef.current = links

  const posRef = useRef<Map<string, P>>(new Map())
  const alphaRef = useRef(1)
  const rafRef = useRef<number | null>(null)
  const draggingRef = useRef<{ id: string; moved: boolean } | null>(null)
  const panningRef = useRef<{ x: number; y: number } | null>(null)
  const viewRef = useRef({ panX: 0, panY: 0, zoom: 1 })
  const [, rerender] = useReducer((x: number) => x + 1, 0)

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

  const ensureLoop = useCallback(() => {
    if (rafRef.current != null) return
    const step = () => {
      const ns = nodesRef.current
      const ls = linksRef.current
      const pos = posRef.current
      const cx = size.w / 2, cy = size.h / 2
      const alpha = alphaRef.current

      // Repulsion (O(n^2) — fine for a few hundred nodes).
      for (let i = 0; i < ns.length; i++) {
        const a = pos.get(ns[i].id); if (!a) continue
        for (let j = i + 1; j < ns.length; j++) {
          const b = pos.get(ns[j].id); if (!b) continue
          let dx = a.x - b.x, dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < MIN_DIST * MIN_DIST) d2 = MIN_DIST * MIN_DIST
          const d = Math.sqrt(d2)
          const f = (REPULSION / d2) * alpha
          const fx = (dx / d) * f, fy = (dy / d) * f
          if (!a.fixed) { a.vx += fx; a.vy += fy }
          if (!b.fixed) { b.vx -= fx; b.vy -= fy }
        }
      }

      // Springs along links.
      for (const l of ls) {
        const a = pos.get(l.source), b = pos.get(l.target)
        if (!a || !b) continue
        const rest = l.kind === 'owns' ? REST_OWNS : REST_COMMENT
        let dx = b.x - a.x, dy = b.y - a.y
        let d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const f = (d - rest) * SPRING_K * alpha
        const fx = (dx / d) * f, fy = (dy / d) * f
        if (!a.fixed) { a.vx += fx; a.vy += fy }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy }
      }

      // Weak centering + integrate.
      for (const n of ns) {
        const p = pos.get(n.id); if (!p || p.fixed) continue
        // Comments cling to their parent more than to the canvas centre.
        const ck = n.type === 'comment' ? CENTER_K * 0.3 : CENTER_K
        p.vx += (cx - p.x) * ck * alpha
        p.vy += (cy - p.y) * ck * alpha
        p.vx *= DAMPING; p.vy *= DAMPING
        p.x += p.vx; p.y += p.vy
      }

      alphaRef.current = alpha * ALPHA_DECAY
      rerender()

      if (alphaRef.current > ALPHA_MIN || draggingRef.current) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [size.w, size.h])

  const reheat = useCallback((a = 1) => {
    alphaRef.current = Math.max(alphaRef.current, a)
    ensureLoop()
  }, [ensureLoop])

  // ── Reconcile positions when the node set changes ───────────────────
  useEffect(() => {
    const pos = posRef.current
    const cx = size.w / 2, cy = size.h / 2
    const present = new Set(nodes.map(n => n.id))
    // Drop gone nodes.
    Array.from(pos.keys()).forEach(id => { if (!present.has(id)) pos.delete(id) })
    // Seed new ones.
    const people = nodes.filter(n => n.type === 'person')
    nodes.forEach((n, i) => {
      if (pos.has(n.id)) return
      if (n.type === 'person') {
        const idx = people.findIndex(p => p.id === n.id)
        const ang = (idx / Math.max(1, people.length)) * Math.PI * 2
        const r = Math.min(size.w, size.h) * 0.28
        pos.set(n.id, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r, vx: 0, vy: 0 })
      } else if (n.parentId && pos.has(n.parentId)) {
        const pp = pos.get(n.parentId)!
        const jitter = () => (Math.sin((i + 1) * 12.9898) * 43758.5453 % 1) * 60 - 30
        pos.set(n.id, { x: pp.x + jitter(), y: pp.y + jitter() + 18, vx: 0, vy: 0 })
      } else {
        pos.set(n.id, { x: cx + (i % 7) * 12 - 36, y: cy + (i % 5) * 12 - 24, vx: 0, vy: 0 })
      }
    })
    reheat(0.9)
  }, [nodes, size.w, size.h, reheat])

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }, [])

  // ── Focus: recentre the view on a node (chip click / selection) ─────
  useEffect(() => {
    if (!focusId) return
    const p = posRef.current.get(focusId)
    if (!p) return
    const v = viewRef.current
    v.panX = size.w / 2 - p.x * v.zoom
    v.panY = size.h / 2 - p.y * v.zoom
    rerender()
  }, [focusId, size.w, size.h])

  // ── Coordinate helpers ──────────────────────────────────────────────
  const toWorld = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.panX) / v.zoom,
      y: (clientY - rect.top - v.panY) / v.zoom,
    }
  }

  // ── Pointer interaction ─────────────────────────────────────────────
  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const p = posRef.current.get(id); if (!p) return
    p.fixed = true
    draggingRef.current = { id, moved: false }
    reheat(0.6)
  }
  const onBackgroundDown = (e: React.MouseEvent) => {
    panningRef.current = { x: e.clientX, y: e.clientY }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) {
        const { id } = draggingRef.current
        const p = posRef.current.get(id); if (!p) return
        const w = toWorld(e.clientX, e.clientY)
        p.x = w.x; p.y = w.y; p.vx = 0; p.vy = 0
        draggingRef.current.moved = true
        reheat(0.5)
      } else if (panningRef.current) {
        const v = viewRef.current
        v.panX += e.clientX - panningRef.current.x
        v.panY += e.clientY - panningRef.current.y
        panningRef.current = { x: e.clientX, y: e.clientY }
        rerender()
      }
    }
    const onUp = () => {
      if (draggingRef.current) {
        const { id, moved } = draggingRef.current
        const p = posRef.current.get(id)
        if (p) p.fixed = false
        if (!moved) onSelect(id === selectedId ? null : id)
        draggingRef.current = null
      }
      panningRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, reheat, onSelect])

  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current
    const rect = wrapRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const newZoom = Math.min(3, Math.max(0.25, v.zoom * factor))
    // Zoom toward the cursor.
    v.panX = mx - ((mx - v.panX) * newZoom) / v.zoom
    v.panY = my - ((my - v.panY) * newZoom) / v.zoom
    v.zoom = newZoom
    rerender()
  }

  const zoomBy = (factor: number) => {
    const v = viewRef.current
    const mx = size.w / 2, my = size.h / 2
    const newZoom = Math.min(3, Math.max(0.25, v.zoom * factor))
    v.panX = mx - ((mx - v.panX) * newZoom) / v.zoom
    v.panY = my - ((my - v.panY) * newZoom) / v.zoom
    v.zoom = newZoom
    rerender()
  }

  // ── Derived highlight neighbourhood ─────────────────────────────────
  const neighbours = (() => {
    if (!selectedId) return null
    const set = new Set<string>([selectedId])
    for (const l of links) {
      if (l.source === selectedId) set.add(l.target)
      if (l.target === selectedId) set.add(l.source)
    }
    return set
  })()
  const isLit = (id: string) => !neighbours || neighbours.has(id)

  const pos = posRef.current
  const v = viewRef.current

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor: panningRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <svg
        width={size.w} height={size.h}
        onMouseDown={onBackgroundDown}
        onWheel={onWheel}
        style={{ display: 'block', userSelect: 'none' }}
      >
        <g transform={`translate(${v.panX},${v.panY}) scale(${v.zoom})`}>
          {/* Links */}
          {links.map((l, i) => {
            const a = pos.get(l.source), b = pos.get(l.target)
            if (!a || !b) return null
            const lit = isLit(l.source) && isLit(l.target)
            const touchesSel = selectedId && (l.source === selectedId || l.target === selectedId)
            // Bowed control point for the web feel.
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
            const ox = -(b.y - a.y) * 0.12, oy = (b.x - a.x) * 0.12
            const owns = l.kind === 'owns'
            return (
              <path
                key={`l${i}`}
                d={`M${a.x},${a.y} Q${mx + ox},${my + oy} ${b.x},${b.y}`}
                fill="none"
                stroke={touchesSel ? '#8b90a0' : owns ? 'rgba(139,144,160,0.5)' : 'rgba(139,144,160,0.28)'}
                strokeWidth={(owns ? 1.4 : 0.9) / v.zoom + (touchesSel ? 0.6 : 0)}
                style={{ opacity: lit ? 1 : 0.08, transition: 'opacity 0.15s' }}
              />
            )
          })}

          {/* Nodes */}
          {nodes.map(n => {
            const p = pos.get(n.id); if (!p) return null
            const r = radiusFor(n)
            const lit = isLit(n.id)
            const sel = n.id === selectedId
            const stroke = sel ? '#e8eaf0' : `${n.color}`
            return (
              <g
                key={n.id}
                transform={`translate(${p.x},${p.y})`}
                onMouseDown={e => onNodeDown(e, n.id)}
                style={{ cursor: 'pointer', opacity: lit ? 1 : 0.18, transition: 'opacity 0.15s' }}
              >
                {/* Critical ring on a project */}
                {n.type === 'project' && n.critical && (
                  <circle r={r + 3.5} fill="none" stroke="#f04e4e" strokeWidth={2} />
                )}
                <circle
                  r={r}
                  fill={n.type === 'comment' ? n.color : `${n.color}${n.type === 'person' ? 'ee' : 'cc'}`}
                  stroke={stroke}
                  strokeWidth={sel ? 2.5 : n.type === 'person' ? 2 : 1.4}
                />
                {/* Comment indicator dot on projects that have updates */}
                {n.type === 'project' && n.hasUpdates && (
                  <circle cx={r * 0.72} cy={-r * 0.72} r={3.2} fill="#e8eaf0" stroke={n.color} strokeWidth={1} />
                )}
                {/* Labels: people always; projects when zoomed in or in focus */}
                {n.type === 'person' && (
                  <text y={r + 14} textAnchor="middle" fontSize={13} fontWeight={600} fill="#e8eaf0" style={{ pointerEvents: 'none' }}>{n.label}</text>
                )}
                {n.type === 'project' && (v.zoom > 0.75 || sel || (neighbours && neighbours.has(n.id))) && (
                  <text y={r + 12} textAnchor="middle" fontSize={10.5} fill="#b9bdc9" style={{ pointerEvents: 'none' }}>
                    {n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label}
                  </text>
                )}
                <title>{n.label}{n.status ? ` — ${n.status}` : ''}</title>
              </g>
            )
          })}
        </g>
      </svg>

      {/* Zoom controls */}
      <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[['+', 1.2], ['−', 1 / 1.2]].map(([lbl, f]) => (
          <button
            key={lbl as string}
            onClick={() => zoomBy(f as number)}
            style={{ width: 30, height: 30, borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: '#131519', color: '#e8eaf0', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1 }}
          >{lbl}</button>
        ))}
      </div>
    </div>
  )
}
