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
      const range = String(q.range || 'today')           // 'today' | 'week' | 'all'
      const extension = q.extension ? String(q.extension) : null
      const direction = q.direction ? String(q.direction) : null  // 'inbound' | 'outbound'
      const disposition = q.disposition ? String(q.disposition) : null // 'answered' | 'missed'
      const search = q.search ? String(q.search).trim() : null
      const limit = Math.min(parseInt(String(q.limit || '200'), 10) || 200, 500)

      // Determine date cutoff
      const now = new Date()
      let fromDate: string | null = null
      if (range === 'today') {
        const d = new Date(now); d.setHours(0, 0, 0, 0)
        fromDate = d.toISOString()
      } else if (range === 'week') {
        const d = new Date(now); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0)
        fromDate = d.toISOString()
      } else if (range === 'month') {
        const d = new Date(now); d.setDate(d.getDate() - 30)
        fromDate = d.toISOString()
      }
      // 'all' → no date filter

      // ── Build query ────────────────────────────────────────────────
      let query = sb.from('calls')
        .select('id, linkedid, call_date, direction, external_number, caller_name, agent_ext, agent_name, duration_seconds, billsec_seconds, disposition, call_type, has_recording, transcript_status, sales_score')
        .order('call_date', { ascending: false })
        .limit(limit)

      if (fromDate) query = query.gte('call_date', fromDate)
      if (extension) query = query.eq('agent_ext', extension)
      if (direction === 'inbound' || direction === 'outbound') query = query.eq('direction', direction)
      if (disposition === 'answered') query = query.eq('disposition', 'ANSWERED')
      else if (disposition === 'missed') query = query.neq('disposition', 'ANSWERED')

      if (search) {
        // Search across number, caller name, agent name
        // Postgres ilike via or() filter
        const s = search.replace(/[%_]/g, '\\$&')  // escape wildcards
        query = query.or(
          `external_number.ilike.%${s}%,caller_name.ilike.%${s}%,agent_name.ilike.%${s}%,agent_ext.eq.${s}`
        )
      }

      const { data, error } = await query
      if (error) throw error

      const calls: CallRow[] = (data || []) as CallRow[]

      return res.status(200).json({
        range,
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
