// lib/md-importers/job-types.ts
//
// Job-types importer. Only handles the "Job Type Summaries" sheet — the
// linked Invoice Items + Checklists are separate sheets and are imported
// separately (Phase 2). This shipped earlier as scripts/import-md-job-types.ts;
// this is the same logic exposed through the in-portal importer UI.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow, MultiRoleRows } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const num = (v: any) => { const n = Number(v); return isFinite(n) ? n : null }

const FIELDS: ImportField[] = [
  { id: 'name',                 label: 'Name',                aliases: ['Job Type', 'Name', 'Service'], required: true },
  { id: 'description',          label: 'Description',         aliases: ['Description', 'Work Done', 'Notes'] },
  { id: 'estimated_hour',       label: 'Estimated hours',     aliases: ['Estimated hour', 'Estimated Hours', 'Est Hours', 'Est Hour', 'Duration (hours)'], hint: 'Converted to minutes' },
  { id: 'category',             label: 'Category',            aliases: ['Category'] },
  { id: 'tags',                 label: 'Tags',                aliases: ['Tags'] },
]

function normalizeMain(rows: MappedRow[]) {
  let skippedNoName = 0
  const seen = new Set<string>()
  const out: MappedRow[] = []
  rows.forEach((r, i) => {
    const name = str(r.name)
    if (!name) { skippedNoName++; return }
    const key = name.toUpperCase()
    if (seen.has(key)) { skippedNoName++; return }
    seen.add(key)
    const estHr = num(r.estimated_hour)
    out.push({
      name,
      code: name,
      md_id: name,
      description: str(r.description) || null,
      default_duration_min: estHr && estHr > 0 ? Math.round(estHr * 60) : null,
      active: true,
      sort_order: i * 10,
    })
  })
  return {
    rows: out,
    summary: {
      total_in_file: rows.length,
      skipped_no_name_or_dup: skippedNoName,
      total_to_import: out.length,
    },
  }
}

async function runMain(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
  const summary = { upserted: 0, errors: 0 }
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200)
    const { error } = await db.from('workshop_job_types').upsert(batch, { onConflict: 'code' })
    if (error) { summary.errors += batch.length; continue }
    summary.upserted += batch.length
  }
  return summary
}

export const JOB_TYPES_CONFIG: ImportTypeConfig = {
  id: 'job_types',
  label: 'Job types',
  roles: [{ id: 'main', label: 'Job type summaries', sheets: ['Job Type Summaries', 'Job Types', 'Job Type'], fields: FIELDS, required: true }],
  normalize: (data: MultiRoleRows) => { const r = normalizeMain(data.main || []); return { rows: { main: r.rows }, summary: r.summary } },
  run: async (db: SupabaseClient, data: MultiRoleRows) => runMain(db, data.main || []),
  blurb: 'Upserts job types on name. Estimated hours convert to minutes (used as default booking duration). Re-running updates existing rows.',
}
