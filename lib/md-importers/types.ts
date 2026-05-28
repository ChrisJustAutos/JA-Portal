// lib/md-importers/types.ts
//
// Shared interfaces for the MD importer framework. One config per importable
// type — fields + aliases + a runner. The client uses fields to drive the
// "map your columns" UI; the server uses the runner to actually insert/merge.

import { SupabaseClient } from '@supabase/supabase-js'

export type ImportType = 'customers' | 'job_types' | 'vehicles' | 'inventory' | 'quotes' | 'invoices'

export interface ImportField {
  /** Portal-side field name (used as the key in mapped rows). */
  id: string
  label: string
  /** Source-column header strings we'll try to auto-match against. */
  aliases: string[]
  required?: boolean
  hint?: string
}

/** A single source row already keyed by portal field id (post column-mapping). */
export type MappedRow = Record<string, any>

export interface ImportTypeConfig {
  id: ImportType
  label: string
  /** Candidate sheet names within the workbook (resolved case-insensitively). */
  sheets: string[]
  /** What the user maps their columns to. */
  fields: ImportField[]
  /** Server-side: validates + cleans the mapped rows. Returns rows to persist + a preview. */
  normalize: (rows: MappedRow[]) => { rows: MappedRow[]; summary: any }
  /** Server-side: writes them to the DB. */
  run: (db: SupabaseClient, rows: MappedRow[]) => Promise<any>
  /** A short blurb shown on the upload card explaining what this importer does. */
  blurb: string
}
