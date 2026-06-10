// lib/ui/theme.ts
// THE portal palette — single source of truth for the `T` colour tokens that
// were previously copy-pasted into ~63 pages (all identical, audited 2026-06-10).
// Import this instead of declaring a local `const T = {…}`:
//
//   import { T } from '../lib/ui/theme'
//
// The values intentionally match the historical inline palettes exactly, so
// converting a page is a pure refactor with zero visual change.

export const T = {
  // Surfaces (darkest → lightest)
  bg:  '#0d0f12',
  bg2: '#131519',
  bg3: '#1a1d23',
  bg4: '#21252d',
  // Hairlines
  border:  'rgba(255,255,255,0.07)',
  border2: 'rgba(255,255,255,0.12)',
  // Text (primary → faint)
  text:  '#e8eaf0',
  text2: '#8b90a0',
  text3: '#545968',
  // Accents
  blue:   '#4f8ef7',
  teal:   '#2dd4bf',
  green:  '#34c77b',
  amber:  '#f5a623',
  red:    '#f04e4e',
  purple: '#a78bfa',
  accent: '#4f8ef7',
} as const

export type ThemeTokens = typeof T

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
