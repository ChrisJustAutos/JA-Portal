// lib/ui/theme.ts
// THE portal palette — single source of truth for the `T` colour tokens that
// were previously copy-pasted into ~63 pages (all identical, audited 2026-06-10).
// Import this instead of declaring a local `const T = {…}`:
//
//   import { T } from '../lib/ui/theme'
//
// Light/dark mode (2026-06-11): surface, text and border tokens are now CSS
// variables. The actual colour values live in styles/globals.css — dark on
// :root (default) and light under html[data-theme="light"] — so every page
// that uses `T` switches theme automatically with zero code changes.
//
// Accent tokens stay literal hex on purpose: dozens of call sites build
// translucent tints by appending a 2-digit alpha suffix (`${T.blue}55`),
// which only works on hex literals. The accents read fine on both themes.
// If you need a tint of a THEME token (a var()), use alpha() below.

export const T = {
  // Surfaces (page → raised panel)
  bg:  'var(--t-bg)',
  bg2: 'var(--t-bg2)',
  bg3: 'var(--t-bg3)',
  bg4: 'var(--t-bg4)',
  // Hairlines
  border:  'var(--t-border)',
  border2: 'var(--t-border2)',
  // Text (primary → faint)
  text:  'var(--t-text)',
  text2: 'var(--t-text2)',
  text3: 'var(--t-text3)',
  // Accents — literal hex, identical in both themes (see note above)
  blue:   '#4f8ef7',
  teal:   '#2dd4bf',
  green:  '#34c77b',
  amber:  '#f5a623',
  red:    '#f04e4e',
  purple: '#a78bfa',
  accent: '#4f8ef7',
} as const

export type ThemeTokens = typeof T

// The raw palette values, keyed by theme. globals.css is the runtime source
// of truth — these exist for places that need a literal colour (PDF/print
// generation, canvas, emails, theme-color meta) and for the settings preview.
export const DARK_PALETTE = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
} as const

export const LIGHT_PALETTE = {
  bg: '#f3f4f6', bg2: '#ffffff', bg3: '#eceef2', bg4: '#e2e5ea',
  border: 'rgba(16,24,40,0.10)', border2: 'rgba(16,24,40,0.18)',
  text: '#171a21', text2: '#5b6271', text3: '#9097a6',
} as const

// Translucent tint of any colour token — works on hex literals AND on the
// var()-based theme tokens. `alphaHex` is the historical 2-digit hex suffix
// (e.g. '40' ≈ 25%), kept so converting `${T.text3}40` is a drop-in change:
//   border: `1px solid ${alpha(T.text3, '40')}`
export function alpha(color: string, alphaHex: string): string {
  if (color.startsWith('#') && color.length === 7) return color + alphaHex
  const pct = Math.round((parseInt(alphaHex, 16) / 255) * 100)
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

// Named accent lookup for KPI/value colouring by semantic name
// (e.g. reports API returns accent: 'green').
export const ACCENTS: Record<string, string> = {
  blue: T.blue, teal: T.teal, green: T.green, amber: T.amber, red: T.red, purple: T.purple,
}

// Standard content width for full-page containers. Historical pages ranged
// 1000–1600px; 1400 is the standard for new/converted pages unless a dense
// table genuinely needs 1600.
export const PAGE_MAX_WIDTH = 1400
export const PAGE_MAX_WIDTH_WIDE = 1600
