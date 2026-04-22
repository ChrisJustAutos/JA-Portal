// pages/api/calls/index.ts
// Lists calls from Supabase with filtering (date range, extension, direction, disposition, search).
// Follows existing JA Portal auth + Supabase patterns (see pages/api/distributors.ts).
// Source of truth: ja-cdr-sync agent on FreePBX pushes CDR rows every 5 min.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

export const config = { maxDuration: 30 }

interface CallRow {
  id: string
  linkedid: string
  call_date: string
  direction: 'inbound' | 'outbound'
  external_number: string | null
  caller_name: string | null
  agent_ext: string | null
  agent_name: string | null
  duration_seconds: number
  billsec_seconds: number
  disposition: string
  call_type: string | null
  has_recording: boolean
  transcript_status: string | null
  sales_score: number | null
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) {
        return res.status(500).json({ error: 'Supabase not configured' })
      }

      const sb = createClient(url, key, { auth: { persistSession: false } })

      // ── Parse query params ─────────────────────────────────────────
      const q = req.query
      const extension = q.extension ? String(q.extension) : null
      const direction = q.direction ? String(q.direction) : null
      const disposition = q.disposition ? String(q.disposition) : null
      const search = q.search ? String(q.search).trim() : null
      const limit = Math.min(parseInt(String(q.limit || '500'), 10) || 500, 2000)

      // Date range — two ways to specify, in priority order:
      //   1. Explicit ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (inclusive, Brisbane time)
      //   2. Preset ?range=today|week|month|all (backwards compatible)
      const startDateParam = q.startDate ? String(q.startDate) : null
      const endDateParam = q.endDate ? String(q.endDate) : null
      const rangePreset = String(q.range || (startDateParam || endDateParam ? 'custom' : 'today'))

      let fromIso: string | null = null
      let toIso: string | null = null
      let effectiveRange = rangePreset

      if (startDateParam || endDateParam) {
        // Brisbane is UTC+10 (no DST). Convert Brisbane-local date bounds to UTC.
        const tzOffsetMs = 10 * 3600 * 1000
        if (startDateParam) {
          const d = new Date(startDateParam + 'T00:00:00Z')
          fromIso = new Date(d.getTime() - tzOffsetMs).toISOString()
        }
        if (endDateParam) {
          const d = new Date(endDateParam + 'T23:59:59.999Z')
          toIso = new Date(d.getTime() - tzOffsetMs).toISOString()
        }
        effectiveRange = 'custom'
      } else {
        const now = new Date()
        if (rangePreset === 'today') {
          const d = new Date(now); d.setHours(0, 0, 0, 0)
          fromIso = d.toISOString()
        } else if (rangePreset === 'week') {
          const d = new Date(now); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0)
          fromIso = d.toISOString()
        } else if (rangePreset === 'month') {
          const d = new Date(now); d.setDate(d.getDate() - 30)
          fromIso = d.toISOString()
        }
        // 'all' → no date filter
      }

      // ── Build query ────────────────────────────────────────────────
      let query = sb.from('calls')
        .select('id, linkedid, call_date, direction, external_number, caller_name, agent_ext, agent_name, duration_seconds, billsec_seconds, disposition, call_type, has_recording, transcript_status, sales_score')
        .order('call_date', { ascending: false })
        .limit(limit)

      if (fromIso) query = query.gte('call_date', fromIso)
      if (toIso) query = query.lte('call_date', toIso)
      if (extension) query = query.eq('agent_ext', extension)
      if (direction === 'inbound' || direction === 'outbound') query = query.eq('direction', direction)
      if (disposition === 'answered') query = query.eq('disposition', 'ANSWERED')
      else if (disposition === 'missed') query = query.neq('disposition', 'ANSWERED')

      if (search) {
        const s = search.replace(/[%_]/g, '\\$&')
        query = query.or(
          `external_number.ilike.%${s}%,caller_name.ilike.%${s}%,agent_name.ilike.%${s}%,agent_ext.eq.${s}`
        )
      }

      const { data, error } = await query
      if (error) throw error

      const calls: CallRow[] = (data || []) as CallRow[]

      return res.status(200).json({
        range: effectiveRange,
        startDate: startDateParam,
        endDate: endDateParam,
        count: calls.length,
        truncated: calls.length === limit,
        calls,
      })
    } catch (e: any) {
      console.error('calls error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}
