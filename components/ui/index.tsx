// components/ui/index.tsx
// The shared UI kit — canonical versions of the small presentational pieces
// that were re-implemented per page (Chip ×4, Card ×8, KPI ×5, StatusPill,
// Section/Table/Row/Hdr/Empty, button + input style factories, Skeleton).
// All match the historical inline implementations visually, so adopting them
// is a pure refactor. Pages import what they need:
//
//   import { Chip, Card, KPI, StatusPill, Section, Table, Row, Empty,
//            Skeleton, qbtn, miniBtn, pagerBtn, pbtn, inp } from '../components/ui'

import React from 'react'
import { T, ACCENTS } from '../../lib/ui/theme'

// ── Filter chip (pill button with active state) ─────────────────────────
export function Chip({ label, active, onClick, c, size = 'sm' }: {
  label: string; active: boolean; onClick: () => void; c?: string; size?: 'sm' | 'md'
}) {
  const accent = c || T.blue
  const pad = size === 'md' ? '8px 14px' : '4px 10px'
  const fs = size === 'md' ? 12 : 11
  return (
    <button onClick={onClick} style={{
      padding: pad, borderRadius: size === 'md' ? 6 : 4, fontSize: fs, fontFamily: 'inherit', fontWeight: 600, whiteSpace: 'nowrap',
      background: active ? `${accent}1f` : 'transparent', color: active ? accent : T.text2,
      border: `1px solid ${active ? accent + '55' : T.border}`, cursor: 'pointer',
    }}>{label}</button>
  )
}

// ── Status pill (coloured badge) ────────────────────────────────────────
export function StatusPill({ label, color, uppercase = true }: { label: string; color: string; uppercase?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', padding: '2px 8px', borderRadius: 3, background: `${color}1e`, color,
      fontSize: 10, fontWeight: 600, textTransform: uppercase ? 'uppercase' : undefined, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

// ── KPI tile (label + big value) ────────────────────────────────────────
export function KPI({ label, value, accent, sub }: { label: string; value: React.ReactNode; accent?: string; sub?: string }) {
  const color = accent ? (ACCENTS[accent] || accent) : T.text
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

// ── Card (background + border wrapper, optional title above) ───────────
// pad=true gives an inner-padded panel; pad=false is flush (for tables).
export function Card({ title, hint, count, children, pad = false }: {
  title?: string; hint?: string; count?: number; children: React.ReactNode; pad?: boolean
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      {(title || count !== undefined) && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
          {count !== undefined && <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{count}</div>}
        </div>
      )}
      {hint && <div style={{ fontSize: 11, color: T.text3, marginBottom: 8, lineHeight: 1.5 }}>{hint}</div>}
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', padding: pad ? '14px 16px' : undefined }}>
        {children}
      </div>
    </div>
  )
}

// ── Section header + grid table primitives ─────────────────────────────
export function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{title}</h2>
        {count !== undefined && <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{count}</div>}
      </div>
      {children}
    </div>
  )
}

export function Table({ cols, header, children }: { cols: string; header: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '9px 14px', fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${T.border}`, background: T.bg3 }}>
        {header}
      </div>
      {children}
    </div>
  )
}

export function Row({ cols, children, onClick }: { cols: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{ display: 'grid', gridTemplateColumns: cols, gap: 12, padding: '9px 14px', borderTop: `1px solid ${T.border}`, alignItems: 'center', fontSize: 12, cursor: onClick ? 'pointer' : undefined }}>
      {children}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8 }}>{children}</div>
}

// ── Loading skeleton ────────────────────────────────────────────────────
// Pulsing placeholder. Use <Skeleton/> for a bar, <SkeletonRows/> for a list.
export function Skeleton({ width = '100%', height = 14, radius = 4, style }: {
  width?: number | string; height?: number; radius?: number; style?: React.CSSProperties
}) {
  return (
    <>
      <span style={{ display: 'inline-block', width, height, borderRadius: radius, background: 'rgba(255,255,255,0.06)', animation: 'ja-skeleton 1.4s ease-in-out infinite', ...style }} />
      <style>{`@keyframes ja-skeleton { 0%,100% { opacity: 0.5 } 50% { opacity: 1 } }`}</style>
    </>
  )
}

export function SkeletonRows({ rows = 6, height = 38 }: { rows?: number; height?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ padding: '0 14px', borderTop: i ? `1px solid ${T.border}` : 'none', display: 'flex', alignItems: 'center', height }}>
          <Skeleton width={`${55 + ((i * 17) % 35)}%`} height={11} />
        </div>
      ))}
    </div>
  )
}

// ── Style factories (shared button / input looks) ──────────────────────
/** Quick-action button: outlined, coloured text. */
export const qbtn = (c: string): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 5, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
  background: 'transparent', color: c, border: `1px solid ${c}55`, cursor: 'pointer',
})

/** Primary button: tinted background. */
export const pbtn = (c: string): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600,
  background: `${c}1e`, color: c, border: `1px solid ${c}55`, cursor: 'pointer',
})

/** Tiny inline row-action button. */
export const miniBtn = (c: string): React.CSSProperties => ({
  padding: '3px 8px', borderRadius: 4, fontSize: 10, fontFamily: 'inherit', fontWeight: 600,
  background: 'transparent', color: c, border: `1px solid ${c}55`, cursor: 'pointer',
})

/** Pager (prev/next) button. */
export const pagerBtn = (disabled: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600,
  background: disabled ? 'transparent' : T.bg3, color: disabled ? T.text3 : T.text2,
  border: `1px solid ${T.border2}`, cursor: disabled ? 'default' : 'pointer',
})

/** Standard text input / select style. */
export const inp: React.CSSProperties = {
  padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 5,
  color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
}

export { T }
