// pages/api/calls/index.ts
// Lists calls from Supabase with filtering (date range, extension, direction, disposition, search).
// Follows existing JA Portal auth + Supabase patterns (see pages/api/distributors.ts).
// Source of truth: ja-cdr-sync agent on FreePBX pushes CDR rows every 5 min.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'
import { parseAgentKey } from '../../../lib/calls-advisor'

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
  effective_advisor_name: string | null
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
      // ?agent= is the advisor-aware filter ("slack:<id>" or "ext:<n>");
      // ?extension= is kept for back-compat (treated as a bare extension).
      const agentKey = parseAgentKey(q.agent ? String(q.agent) : (q.extension ? String(q.extension) : null))
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
        .select('id, linkedid, call_date, direction, external_number, caller_name, agent_ext, agent_name, effective_advisor_name, duration_seconds, billsec_seconds, disposition, call_type, has_recording, transcript_status, sales_score')
        .order('call_date', { ascending: false })
        .limit(limit)

      if (fromIso) query = query.gte('call_date', fromIso)
      if (toIso) query = query.lte('call_date', toIso)
      // Advisor-aware agent filter. A slack-keyed agent matches every call
      // that person handled (regardless of which handset rang); an ext-keyed
      // agent matches calls on that extension that were NOT attributed to an
      // identified advisor (so hot-desk calls don't double-count).
      if (agentKey?.kind === 'slack') query = query.eq('effective_advisor_slack_user_id', agentKey.id)
      else if (agentKey?.kind === 'ext') query = query.eq('agent_ext', agentKey.ext).is('effective_advisor_slack_user_id', null)
      if (direction === 'inbound' || direction === 'outbound') query = query.eq('direction', direction)
      if (disposition === 'answered') query = query.eq('disposition', 'ANSWERED')
      else if (disposition === 'missed') query = query.neq('disposition', 'ANSWERED')

      if (search) {
        const s = search.replace(/[%_]/g, '\\$&')
        query = query.or(
          `external_number.ilike.%${s}%,caller_name.ilike.%${s}%,agent_name.ilike.%${s}%,effective_advisor_name.ilike.%${s}%,agent_ext.eq.${s}`
        )
      }

      const { data, error } = await query
      if (error) throw error

      const calls: CallRow[] = (data || []) as CallRow[]

      // Mark "rescued" rings: an un-answered inbound row whose caller WAS
      // answered within ±120s (ext A rang, ext B picked up — FreePBX logs
      // A's leg as its own missed call). One extra query scoped to just the
      // page's missed callers; the UI shows these as picked-up-elsewhere
      // rather than missed.
      const missedRows = calls.filter(c => c.direction === 'inbound' && c.disposition !== 'ANSWERED' && c.external_number)
      if (missedRows.length > 0) {
        const numbers = Array.from(new Set(missedRows.map(c => c.external_number as string))).slice(0, 100)
        const times = missedRows.map(c => new Date(c.call_date).getTime())
        const windowFrom = new Date(Math.min(...times) - 120_000).toISOString()
        const windowTo = new Date(Math.max(...times) + 120_000).toISOString()
        const { data: siblings } = await sb.from('calls')
          .select('external_number, call_date')
          .eq('direction', 'inbound').eq('disposition', 'ANSWERED')
          .in('external_number', numbers)
          .gte('call_date', windowFrom).lte('call_date', windowTo)
        const answeredEpochs = new Map<string, number[]>()
        for (const s of siblings || []) {
          const arr = answeredEpochs.get(s.external_number) || []
          arr.push(new Date(s.call_date).getTime())
          answeredEpochs.set(s.external_number, arr)
        }
        for (const c of missedRows) {
          const t = new Date(c.call_date).getTime()
          if ((answeredEpochs.get(c.external_number as string) || []).some(e => Math.abs(e - t) < 120_000)) {
            (c as any).rescued = true
          }
        }
      }

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
