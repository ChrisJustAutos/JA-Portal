// lib/md-importers/vehicles.ts
//
// Match strategy:
//   1. md_vehicle_id — exact (idempotent on re-run)
//   2. rego          — case-insensitive, whitespace-stripped
// Customer link: by the customer's md_id (which we imported earlier) — vehicle
// rows referring to an unknown MD customer go in with customer_id = null and
// are reported in the summary so you can review.

import { SupabaseClient } from '@supabase/supabase-js'
import { ImportField, ImportTypeConfig, MappedRow } from './types'

const str = (v: any) => (v == null ? '' : String(v).trim())
const intOr = (v: any) => { const n = parseInt(String(v ?? ''), 10); return isFinite(n) ? n : null }
const normRego = (v: any) => String(v || '').replace(/\s+/g, '').toUpperCase()

const FIELDS: ImportField[] = [
  { id: 'md_id',           label: 'External Vehicle ID',  aliases: ['Vehicle ID', 'VehicleID', 'External ID', 'Source ID'], required: true, hint: 'Unique row ID from your source system' },
  { id: 'rego',            label: 'Rego',           aliases: ['Rego', 'Registration', 'Plate', 'Number Plate'] },
  { id: 'make',            label: 'Make',           aliases: ['Make', 'Manufacturer'] },
  { id: 'model',           label: 'Model',          aliases: ['Model'] },
  { id: 'year',            label: 'Year',           aliases: ['Year', 'Year Of Manufacture', 'Built'] },
  { id: 'vin',             label: 'VIN',            aliases: ['VIN', 'Chassis', 'Chassis Number'] },
  { id: 'colour',          label: 'Colour',         aliases: ['Colour', 'Color'] },
  { id: 'engine',          label: 'Engine',         aliases: ['Engine', 'Engine Number'] },
  { id: 'transmission',    label: 'Transmission',   aliases: ['Transmission', 'Gearbox'] },
  { id: 'odometer',        label: 'Odometer',       aliases: ['Odometer', 'Kms', 'Mileage'] },
  { id: 'notes',           label: 'Notes',          aliases: ['Notes', 'Note', 'Description'] },
  { id: 'customer_md_id',  label: 'Customer (external ID)', aliases: ['Customer ID', 'Owner ID', 'CustomerID'], hint: 'Matches a customer imported earlier so the vehicle gets attached to the right card' },
]

function normalize(rows: MappedRow[]) {
  let skipped = 0
  const out: MappedRow[] = []
  for (const r of rows) {
    const mdId = str(r.md_id)
    if (!mdId) { skipped++; continue }
    out.push({
      md_id: mdId,
      rego: str(r.rego) || null,
      make: str(r.make) || null,
      model: str(r.model) || null,
      year: intOr(r.year),
      vin: str(r.vin) || null,
      colour: str(r.colour) || null,
      engine: str(r.engine) || null,
      transmission: str(r.transmission) || null,
      odometer: intOr(r.odometer),
      notes: str(r.notes) || null,
      customer_md_id: str(r.customer_md_id) || null,
    })
  }
  return {
    rows: out,
    summary: { total_in_file: rows.length, skipped_no_md_id: skipped, total_to_import: out.length },
  }
}

async function run(db: SupabaseClient, rows: MappedRow[]): Promise<any> {
  // 1. Build customer md_id → id map so we can attach vehicles.
  const custMdToId = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_customers').select('id, md_id').not('md_id', 'is', null).range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) custMdToId.set((r as any).md_id, (r as any).id)
    if (data.length < 1000) break
  }

  // 2. Pull existing vehicles for matching by rego.
  const existing: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('workshop_vehicles').select('id, rego, md_vehicle_id').range(from, from + 999)
    if (!data || data.length === 0) break
    for (const r of data) existing.push(r)
    if (data.length < 1000) break
  }
  const byMdId = new Map<string, string>()
  const byRego = new Map<string, string>()
  for (const v of existing) {
    if (v.md_vehicle_id) byMdId.set(v.md_vehicle_id, v.id)
    const nr = normRego(v.rego)
    if (nr && !byRego.has(nr)) byRego.set(nr, v.id)
  }

  const updates: any[] = []
  const inserts: any[] = []
  const summary = { matched_md_id: 0, matched_rego: 0, inserted: 0, updated: 0, no_customer: 0, errors: 0 }

  for (const r of rows) {
    const customerId = r.customer_md_id ? custMdToId.get(r.customer_md_id) : null
    if (r.customer_md_id && !customerId) summary.no_customer++

    const matchId = byMdId.get(r.md_id) || (normRego(r.rego) && byRego.get(normRego(r.rego))) || null
    const row = {
      rego: r.rego, make: r.make, model: r.model, year: r.year, vin: r.vin,
      colour: r.colour, engine: r.engine, transmission: r.transmission, odometer: r.odometer, notes: r.notes,
      md_vehicle_id: r.md_id, customer_id: customerId || null,
    }
    if (matchId) {
      if (byMdId.get(r.md_id)) summary.matched_md_id++; else summary.matched_rego++
      updates.push({ id: matchId, ...row })
    } else {
      inserts.push(row)
    }
  }

  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500)
    const { error } = await db.from('workshop_vehicles').upsert(batch, { onConflict: 'id' })
    if (error) { summary.errors += batch.length; continue }
    summary.updated += batch.length
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error } = await db.from('workshop_vehicles').insert(batch)
    if (error) { summary.errors += batch.length; continue }
    summary.inserted += batch.length
  }
  return summary
}

export const VEHICLES_CONFIG: ImportTypeConfig = {
  id: 'vehicles',
  label: 'Vehicles',
  sheets: ['Vehicles', 'Vehicle'],
  fields: FIELDS,
  normalize,
  run,
  blurb: 'Vehicles match existing rows by External Vehicle ID, then by rego. Linked to customers via their external customer ID — import customers first so the link finds a match.',
}
