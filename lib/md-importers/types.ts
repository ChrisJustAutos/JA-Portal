// lib/md-importers/types.ts
//
// Shared interfaces for the MD importer framework.
//
// An import type has one or more ROLES — each role is one sheet's worth of
// rows. Most types have one role (id: 'main'), but composite types like
// invoices have several (header / items / payments) that all get uploaded
// together and stitched server-side during run.
//
// Single-role types: client picks the file → picks one sheet → maps columns.
// Multi-role types : client picks the file → for each role, picks a sheet +
//                    maps columns. Optional roles can be skipped.

import { SupabaseClient } from '@supabase/supabase-js'

export type ImportType = 'customers' | 'job_types' | 'vehicles' | 'inventory' | 'quotes' | 'invoices'

export interface ImportField {
  id: string
  label: string
  aliases: string[]
  required?: boolean
  hint?: string
}

/** A single source row already keyed by portal field id (post column-mapping). */
export type MappedRow = Record<string, any>
/** Per-role bundle of rows after column mapping. */
export type MultiRoleRows = Record<string, MappedRow[]>

export interface ImportRole {
  /** Stable id used in the URL / db (e.g. 'main', 'header', 'items', 'payments'). */
  id: string
  label: string
  /** Candidate sheet names. */
  sheets: string[]
  fields: ImportField[]
  /** When false, the user can skip mapping/uploading this role. Defaults to true. */
  required?: boolean
  /** Short blurb on the role card (e.g. "One row per invoice"). */
  blurb?: string
}

export interface ImportTypeConfig {
  id: ImportType
  label: string
  roles: ImportRole[]
  /** Validates + cleans per-role rows. Returns per-role normalised rows + an
   *  overall summary shown on the preview screen. */
  normalize: (data: MultiRoleRows) => { rows: MultiRoleRows; summary: any }
  /** Writes the normalised per-role rows to the DB. */
  run: (db: SupabaseClient, data: MultiRoleRows) => Promise<any>
  blurb: string
}
