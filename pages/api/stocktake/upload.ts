// pages/api/stocktake/upload.ts
//
// Accept an XLSX upload (base64), parse it, store the rows in a new
// stocktake_uploads row, return the upload id + parse preview.
//
// Auth: admin/manager only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { withAuth } from '../../../lib/authServer'
import { parseStocktakeRows } from '../../../lib/stocktake-parser'

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
}

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface UploadBody {
  filename?: string
  file_base64?: string
  notes?: string
}

export default withAuth('edit:stocktakes', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const body = (req.body || {}) as UploadBody
  const { filename, file_base64, notes } = body
  if (!filename || !file_base64) {
    return res.status(400).json({ error: 'Missing filename or file_base64' })
  }
  if (!/\.xlsx?$/i.test(filename)) {
    return res.status(400).json({ error: 'File must be an .xlsx or .xls' })
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(file_base64, 'base64')
  } catch (e: any) {
    return res.status(400).json({ error: 'Invalid base64 file content' })
  }
  if (buffer.length < 100) {
    return res.status(400).json({ error: 'File too small — likely empty or corrupted' })
  }
  if (buffer.length > 10_000_000) {
    return res.status(400).json({ error: 'File too large (>10MB)' })
  }

  let rawRows: any[][]
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    if (!wb.SheetNames.length) throw new Error('No sheets in workbook')
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][]
  } catch (e: any) {
    return res.status(400).json({ error: `Could not parse spreadsheet: ${e?.message || e}` })
  }

  const parsed = parseStocktakeRows(rawRows)

  if (parsed.rows.length === 0) {
    return res.status(400).json({
      error: 'No usable rows found in spreadsheet',
      warnings: parsed.warnings,
      detected_columns: parsed.detected_columns,
    })
  }

  const { data, error } = await sb()
    .from('stocktake_uploads')
    .insert({
      uploaded_by: user.id,
      filename,
      status: 'parsed',
      total_rows: parsed.rows.length,
      parsed_rows: parsed.rows,
      parse_warnings: parsed.warnings,
      notes: notes || null,
    })
    .select('id')
    .single()

  if (error || !data) {
    return res.status(500).json({ error: `Failed to store upload: ${error?.message || 'unknown'}` })
  }

  return res.status(200).json({
    ok: true,
    upload_id: data.id,
    parsed: {
      total_rows: parsed.rows.length,
      skipped_blank: parsed.skipped_blank,
      skipped_invalid: parsed.skipped_invalid,
      duplicate_skus: parsed.duplicate_skus,
      detected_columns: parsed.detected_columns,
      warnings: parsed.warnings,
      preview: parsed.rows.slice(0, 5),
    },
  })
})
