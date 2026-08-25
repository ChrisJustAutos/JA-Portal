// components/b2b/ui.tsx
//
// The "Alloy" kit — shared look for the DISTRIBUTOR portal (design refresh,
// Chris 2026-08-12). Staff pages keep components/ui; this kit is B2B-only.
//
// Rules the kit encodes (see the design artifact for the full pitch):
//   - one accent (JA blue) + semantic good/warn/bad for status only
//   - nothing under 12px; size/weight replace uppercase micro-labels
//   - radii 10 / 16 / pill; soft shadows over extra borders
//   - every tappable control ≥44px tall; primary actions are pills
//
// Surfaces/text still come from the theme CSS vars (T) so light/dark keeps
// working unchanged. Hover/press/focus states need real CSS, so pages render
// inside <B2BLayout> which mounts <AlloyStyles/> once.

import React, { useState } from 'react'
import { T, alpha } from '../../lib/ui/theme'

// Accent roles. Teal/purple are deliberately absent — retired from this portal.
export const A = {
  accent: '#4f8ef7',
  good:   '#34c77b',
  warn:   '#f5a623',
  bad:    '#f04e4e',
} as const

export const RADIUS = { sm: 10, md: 16, pill: 999 } as const
export const SHADOW = { sm: 'var(--a-shadow-sm)', md: 'var(--a-shadow-md)' } as const

// ── Global interaction styles (mounted once by B2BLayout) ───────────────
export function AlloyStyles() {
  return (
    <style>{`
      :root {
        --a-shadow-sm: 0 1px 2px rgba(0,0,0,0.30), 0 6px 20px rgba(0,0,0,0.20);
        --a-shadow-md: 0 2px 8px rgba(0,0,0,0.36), 0 14px 34px rgba(0,0,0,0.36);
      }
      html[data-theme="light"] {
        --a-shadow-sm: 0 1px 2px rgba(18,22,30,0.05), 0 4px 14px rgba(18,22,30,0.06);
        --a-shadow-md: 0 2px 6px rgba(18,22,30,0.08), 0 12px 30px rgba(18,22,30,0.11);
      }
      .al-press { transition: transform .15s ease, filter .15s ease, background .15s ease, border-color .15s ease, color .15s ease; }
      .al-press:active:not(:disabled) { transform: scale(.98); }
      .al-primary:hover:not(:disabled) { filter: brightness(1.07); }
      .al-ghost:hover:not(:disabled) { background: ${T.bg3}; }
      .al-raise { transition: box-shadow .18s ease, transform .18s ease, border-color .18s ease, background .18s ease; }
      .al-raise:hover { box-shadow: var(--a-shadow-md); transform: translateY(-1px); }
      .al-focus:focus-visible { outline: 2px solid ${A.accent}; outline-offset: 2px; }
      input.al-nospin::-webkit-outer-spin-button, input.al-nospin::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      @media (prefers-reduced-motion: reduce) {
        .al-press, .al-raise { transition: none; }
        .al-press:active:not(:disabled) { transform: none; }
        .al-raise:hover { transform: none; }
      }
    `}</style>
  )
}

// ── Buttons ──────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type BtnSize = 'sm' | 'md' | 'lg'

export function btnStyle(variant: BtnVariant = 'primary', size: BtnSize = 'md', disabled = false): React.CSSProperties {
  const pad = size === 'lg' ? '13px 22px' : size === 'md' ? '10px 18px' : '7px 14px'
  const fs  = size === 'lg' ? 15 : size === 'md' ? 14 : 13
  const base: React.CSSProperties = {
    padding: pad, borderRadius: RADIUS.pill, fontSize: fs, fontWeight: 600,
    fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
    minHeight: size === 'sm' ? 36 : 44,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    border: '1px solid transparent', opacity: disabled ? 0.55 : 1,
    whiteSpace: 'nowrap',
  }
  if (variant === 'primary')   return { ...base, background: disabled ? T.bg3 : A.accent, color: disabled ? T.text3 : '#fff' }
  if (variant === 'danger')    return { ...base, background: disabled ? T.bg3 : A.bad,    color: disabled ? T.text3 : '#fff' }
  if (variant === 'secondary') return { ...base, background: T.bg3, color: T.text }
  return { ...base, background: 'transparent', color: T.text2 }
}

export function Btn({ variant = 'primary', size = 'md', full, disabled, onClick, type, title, children }: {
  variant?: BtnVariant; size?: BtnSize; full?: boolean; disabled?: boolean
  onClick?: () => void; type?: 'button' | 'submit'; title?: string; children: React.ReactNode
}) {
  return (
    <button
      type={type || 'button'} onClick={onClick} disabled={disabled} title={title}
      className={`al-press al-focus${variant === 'primary' || variant === 'danger' ? ' al-primary' : variant === 'ghost' ? ' al-ghost' : ''}`}
      style={{ ...btnStyle(variant, size, disabled), width: full ? '100%' : undefined }}>
      {children}
    </button>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────
export function cardStyle(pad: boolean | number | string = true): React.CSSProperties {
  return {
    background: T.bg2, border: `1px solid ${T.border}`, borderRadius: RADIUS.md,
    boxShadow: SHADOW.sm,
    padding: pad === true ? '18px 20px' : pad === false ? 0 : pad,
    overflow: pad === false ? 'hidden' : undefined,
  }
}

export function Card({ pad = true, style, children }: { pad?: boolean | number | string; style?: React.CSSProperties; children: React.ReactNode }) {
  return <div style={{ ...cardStyle(pad), ...style }}>{children}</div>
}

// ── Status pill (dot + readable label) ──────────────────────────────────
export function StatusPill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 12, fontWeight: 600, padding: '4px 11px', borderRadius: RADIUS.pill,
      background: alpha(color, '1f'), color, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: RADIUS.pill, background: 'currentColor', flexShrink: 0 }}/>
      {children}
    </span>
  )
}

// Small status dot + sentence — for stock lines etc. (quieter than a pill)
export function DotLine({ color, halo = true, children }: { color: string; halo?: boolean; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: T.text2 }}>
      <span style={{
        width: 7, height: 7, borderRadius: RADIUS.pill, background: color, flexShrink: 0,
        boxShadow: halo ? `0 0 0 3px ${alpha(color, '26')}` : undefined,
      }}/>
      {children}
    </span>
  )
}

// ── Quantity stepper (44px pill) ─────────────────────────────────────────
// Quantity stepper.
//
// The box is a real typed input: type 24, press Enter or click away, done —
// you don't have to press + twenty-four times. That means it must NOT commit
// on every keystroke, which is why there's a draft:
//   · while focused, the field holds whatever you've typed (including empty,
//     mid-edit) and nothing is sent
//   · Enter / blur commits the clamped value; Escape or an empty field reverts
//   · + and − commit straight away, since there's nothing ambiguous about them
// Committing per keystroke is what made typing "10" briefly set qty 1 — and,
// worse, clearing the field to retype parsed as 0 and removed the line.
//
// Callers should debounce the network write, not this component: + must feel
// instant, so onChange fires immediately and the page decides when to POST.
export function Stepper({ qty, onChange, max, min = 0, compact, pending }: {
  qty: number; onChange: (q: number) => void
  max?: number | null; min?: number; compact?: boolean
  /** true while the page has an unsaved change in flight — shown as a soft
   *  pulse, never by disabling: a disabled stepper is what "lag" feels like. */
  pending?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const clamp = (v: number) => Math.max(min, max != null ? Math.min(v, max) : v)

  const commitDraft = () => {
    if (draft == null) return
    const v = parseInt(draft, 10)
    setDraft(null)
    if (!isFinite(v)) return                 // empty or junk → keep what we had
    if (clamp(v) !== qty) onChange(clamp(v))
  }
  const step = (delta: number) => { setDraft(null); onChange(clamp(qty + delta)) }

  const atMax = max != null && qty >= max
  const atMin = qty <= min
  const h = compact ? 38 : 44
  const btn = (disabled: boolean): React.CSSProperties => ({
    width: h, height: h, border: 'none', background: 'transparent',
    color: disabled ? T.text3 : T.text, fontSize: 17, fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: RADIUS.pill,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  })
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', background: T.bg3, borderRadius: RADIUS.pill,
      transition: 'opacity 140ms ease', opacity: pending ? 0.72 : 1,
    }}>
      <button className="al-press al-focus" onClick={() => step(-1)} disabled={atMin} aria-label="Decrease quantity" style={btn(atMin)}>−</button>
      <input
        type="number" inputMode="numeric" className="al-nospin al-focus"
        value={draft ?? String(qty)} min={min} max={max ?? undefined}
        aria-label="Quantity"
        onFocus={e => { setDraft(String(qty)); e.currentTarget.select() }}
        onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={commitDraft}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commitDraft(); e.currentTarget.blur() }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(null); e.currentTarget.blur() }
          // Let the arrow keys step by one without going through the browser's
          // own number spinner, so they clamp the same way the buttons do.
          else if (e.key === 'ArrowUp') { e.preventDefault(); setDraft(null); onChange(clamp(qty + 1)) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setDraft(null); onChange(clamp(qty - 1)) }
        }}
        style={{
          // Wide enough for three digits — a 40px box made a typed quantity
          // look like it wasn't meant to be typed in.
          width: 54, textAlign: 'center', background: 'transparent', border: 'none',
          color: T.text, fontSize: 15, fontWeight: 600, outline: 'none', fontFamily: 'inherit',
          fontVariantNumeric: 'tabular-nums', MozAppearance: 'textfield' as any, padding: 0,
        }}/>
      <button className="al-press al-focus" onClick={() => step(1)} disabled={atMax} aria-label="Increase quantity" style={btn(atMax)}>+</button>
    </div>
  )
}

// ── Segmented control ────────────────────────────────────────────────────
export function Seg<Id extends string>({ options, value, onChange }: {
  options: ReadonlyArray<{ id: Id; label: string }>; value: Id; onChange: (id: Id) => void
}) {
  return (
    <div style={{ display: 'flex', background: T.bg3, borderRadius: RADIUS.pill, padding: 3 }}>
      {options.map(o => {
        const on = value === o.id
        return (
          <button key={o.id} type="button" onClick={() => onChange(o.id)}
            className="al-press al-focus"
            style={{
              flex: 1, textAlign: 'center', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              padding: '9px 6px', minHeight: 38, borderRadius: RADIUS.pill, border: 'none', cursor: 'pointer',
              background: on ? T.bg4 : 'transparent', color: on ? T.text : T.text2,
              boxShadow: on ? SHADOW.sm : 'none',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Form bits ────────────────────────────────────────────────────────────
// fontSize 16 is deliberate: anything smaller makes iOS Safari zoom the page
// on focus, which wrecks the mobile checkout flow.
export function inputStyle(invalid = false): React.CSSProperties {
  return {
    width: '100%', boxSizing: 'border-box',
    background: T.bg3, border: `1px solid ${invalid ? A.bad : 'transparent'}`,
    color: T.text, borderRadius: RADIUS.sm, padding: '11px 13px', fontSize: 16,
    outline: 'none', fontFamily: 'inherit', minHeight: 44,
  }
}

export function Field({ label, required, hint, hintColor, children }: {
  label: string; required?: boolean; hint?: string; hintColor?: string; children: React.ReactNode
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: T.text2, fontWeight: 650 }}>
        {label}{required && <span style={{ color: A.bad, marginLeft: 4 }}>required</span>}
      </span>
      {children}
      {hint && <span style={{ fontSize: 12, color: hintColor || T.text3, lineHeight: 1.45 }}>{hint}</span>}
    </label>
  )
}

// ── Banner (error / warn / success / info) ───────────────────────────────
export function Banner({ tone, onDismiss, children }: {
  tone: 'error' | 'warn' | 'success' | 'info'; onDismiss?: () => void; children: React.ReactNode
}) {
  const c = tone === 'error' ? A.bad : tone === 'warn' ? A.warn : tone === 'success' ? A.good : A.accent
  return (
    <div style={{
      padding: '12px 16px', background: alpha(c, '14'), border: `1px solid ${alpha(c, '38')}`,
      borderRadius: RADIUS.sm + 2, fontSize: 13.5, color: T.text, lineHeight: 1.5,
      display: 'flex', alignItems: 'flex-start', gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" className="al-press"
          style={{ background: 'none', border: 'none', color: T.text3, fontSize: 17, lineHeight: 1, cursor: 'pointer', padding: '0 2px', fontFamily: 'inherit' }}>
          ×
        </button>
      )}
    </div>
  )
}

// ── Page + section headings ──────────────────────────────────────────────
export function PageTitle({ sub, action, children }: { sub?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <header style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.15 }}>{children}</h1>
        {sub && <div style={{ fontSize: 13.5, color: T.text3, marginTop: 5 }}>{sub}</div>}
      </div>
      {action}
    </header>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 650, color: T.text2, marginBottom: 10 }}>{children}</div>
}

// ── Totals row ───────────────────────────────────────────────────────────
export function Row({ label, value, muted, large, color }: {
  label: React.ReactNode; value: React.ReactNode; muted?: boolean; large?: boolean; color?: string
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '4px 0',
      fontSize: large ? 17 : 13, color: muted ? T.text3 : T.text2, fontWeight: large ? 700 : 400,
    }}>
      <span>{label}</span>
      <span style={{ color: color || (large ? T.text : 'inherit'), fontVariantNumeric: 'tabular-nums', letterSpacing: large ? '-0.01em' : undefined }}>{value}</span>
    </div>
  )
}

// ── Disclosure ("How does this work?") ──────────────────────────────────
export function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(o => !o)} className="al-press al-focus"
        style={{
          background: 'none', border: 'none', color: A.accent, fontSize: 12.5, fontWeight: 550,
          cursor: 'pointer', fontFamily: 'inherit', padding: '4px 0', display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
        {summary}
        <span aria-hidden style={{ fontSize: 10, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease', display: 'inline-block' }}>▾</span>
      </button>
      {open && (
        <div style={{ fontSize: 12.5, color: T.text2, background: T.bg3, borderRadius: RADIUS.sm, padding: '10px 12px', lineHeight: 1.55, marginTop: 6 }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Order status vocabulary ──────────────────────────────────────────────
// One colour family per meaning: green = money/goods good, blue = in motion,
// amber = waiting, red = problem, grey = closed. Shared by the orders list
// and order detail so the language never drifts between pages.
export function orderStatusColor(status: string): string {
  switch (status) {
    case 'pending_payment': return A.warn
    case 'paid':            return A.good
    case 'picking':
    case 'packed':          return A.accent
    case 'shipped':         return A.accent
    case 'delivered':
    case 'completed':       return A.good
    case 'cancelled':       return T.text3
    case 'refunded':        return A.bad
    default:                return T.text2
  }
}

export function orderStatusLabel(status: string): string {
  if (status === 'pending_payment') return 'Checkout not finished'
  if (status === 'picking' || status === 'packed') return 'Being prepared'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

// ── Empty state ──────────────────────────────────────────────────────────
export function EmptyState({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div style={{ ...cardStyle(true), padding: '44px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: sub ? 6 : 0 }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5, color: T.text3, marginBottom: 16 }}>{sub}</div>}
      {action && <div style={{ display: 'flex', justifyContent: 'center', marginTop: sub ? 0 : 16 }}>{action}</div>}
    </div>
  )
}
