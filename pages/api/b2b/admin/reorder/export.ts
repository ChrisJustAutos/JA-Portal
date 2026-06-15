// pages/api/b2b/admin/reorder/export.ts
// GET — download the reorder sheet as .xlsx (computed columns included).
// Permission: edit:b2b_catalogue.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { withAuth } from '../../../../../lib/authServer'
import { computeReorder, monthsInRange, ReorderSettings } from '../../../../../lib/b2b-reorder'

export const config = { maxDuration: 20 }

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_catalogue', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()
  const [{ data: s }, { data: items }] = await Promise.all([
    db.from('b2b_reorder_settings').select('*').eq('id', 'singleton').maybeSingle(),
    db.from('b2b_reorder_items').select('*').order('sort_order', { ascending: true }).order('sku', { ascending: true }),
  ])
  const settings: ReorderSettings = { from_date: s?.from_date || null, to_date: s?.to_date || null, growth_pct: Number(s?.growth_pct) || 0, forecast_months: Number(s?.forecast_months) || 0 }
  const months = monthsInRange(settings.from_date, settings.to_date)

  const rows = (items || []).map((it: any) => {
    const c = computeReorder(it, settings, months)
    return {
      'Stock No.': it.sku,
      'Name': it.name || '',
      'On Hand': Number(it.on_hand) || 0,
      'Committed': Number(it.committed) || 0,
      'Available': c.available,
      'On Order': Number(it.on_order) || 0,
      [`Total Sales (${months} mo)`]: Number(it.sales_qty) || 0,
      'Monthly Avg': Math.round(c.monthlyAvg * 100) / 100,
      'Monthly Round Up': c.monthlyRound,
      [`+Growth ${Math.round(settings.growth_pct * 100)}%`]: c.withGrowth,
      [`Projected ${settings.forecast_months} mo`]: c.projected,
      'Shortfall': c.shortfall,
      'Suggested Order': c.suggested,
      'MOQ': it.moq ?? '',
      "Morgan's Judgment": it.morgans_judgment ?? '',
      'Final Order': c.finalOrder,
      'Notes': it.notes || '',
    }
  })

  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Order')
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="JAWS-stock-order-${new Date().toISOString().slice(0, 10)}.xlsx"`)
  return res.status(200).send(buf)
})
