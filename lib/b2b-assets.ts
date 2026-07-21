// lib/b2b-assets.ts
// Shared bits for the B2B distributor resource library ("Assets" — sectioned
// documents distributors can browse/download, managed on the admin side).
// Sections mirror the menu Chris supplied (2026-07-22); add here to extend —
// both the admin editor and the distributor page render from this list.

export const B2B_ASSET_SECTIONS = [
  'Quote Page',
  'Package Information',
  'Technical',
  'Operation Instructions',
  'Bulletins',
  'Training Document',
  'Media Assets',
] as const

export const B2B_ASSETS_BUCKET = 'b2b-assets'

export interface B2BAssetRow {
  id: string
  section: string
  title: string
  description: string | null
  storage_path: string
  file_name: string
  mime: string | null
  size_bytes: number | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
  updated_by: string | null
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
