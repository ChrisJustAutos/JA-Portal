// pages/api/calls/stats.ts
// Dashboard statistics: totals for the selected period, per-agent breakdown.
// Accepts optional ?startDate=&endDate= — when provided, BOTH the top-line
// totals and the per-agent breakdown scope to that range. This means the
// activity bar next to each agent respects the date filter instead of being
// locked to a rolling 7-day window.
//
// The `week` block + `agents[].week_talk_seconds` field are preserved in
// the response shape for frontend compatibility, but both are now sourced
// from the same period query rather than a separate 7-day rollup.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

export const config = { maxDuration: 30 }

interface AgentStats {
  extension: string
  display_name: string
  role: string | null
  today_total: number
  today_answered_inbound: number
  today_outbound: number
  today_talk_seconds: number
  week_talk_seconds: number   // now = period talk seconds (kept for compat)
}

interface StatsResponse {
  periodLabel: string
  today: {
    total: number
    inbound: number
    outbound: number
    answered: number
    missed_inbound: number
    talk_seconds: number
    avg_call_seconds: number
    answer_rate: number
  }
  week: {
    total: number
    talk_seconds: number
  }
  agents: AgentStats[]
  sync: {
    last_synced_at: string | null
    last_error: string | null
    records_synced_total: number
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })

      const sb = createClient(url, key, { auth: { persistSession: false } })

      // Parse the optional date range. When provided, every aggregate in this
      // response reflects that range (including the per-agent bar). Defaults
      // to "today from midnight Brisbane".
      const q = req.query
      const startDateParam = q.startDate ? String(q.startDate) : null
      const endDateParam = q.endDate ? String(q.endDate) : null

      const now = new Date()
      let periodFromIso: string
      let periodToIso: string | null = null
      let periodLabel: string

      if (startDateParam || endDateParam) {
        // Brisbane is UTC+10 with no DST. Convert local date boundaries
        // to UTC so our call_date range filter lines up with calls stored
        // in UTC.
        const tzOffsetMs = 10 * 3600 * 1000
        if (startDateParam) {
          const d = new Date(startDateParam + 'T00:00:00Z')
          periodFromIso = new Date(d.getTime() - tzOffsetMs).toISOString()
        } else {
          const d = new Date(now); d.setHours(0, 0, 0, 0)
          periodFromIso = d.toISOString()
        }
        if (endDateParam) {
          const d = new Date(endDateParam + 'T23:59:59.999Z')
          periodToIso = new Date(d.getTime() - tzOffsetMs).toISOString()
        }
        periodLabel = startDateParam && endDateParam && startDateParam === endDateParam
          ? startDateParam
          : `${startDateParam || 'start'} → ${endDateParam || 'now'}`
      } else {
        const d = new Date(now); d.setHours(0, 0, 0, 0)
        periodFromIso = d.toISOString()
        periodLabel = 'Today'
      }

      // Build the period query — single source of truth for all aggregates.
      let periodQuery = sb.from('calls')
        .select('direction, disposition, billsec_seconds, agent_ext, call_date')
        .gte('call_date', periodFromIso)
      if (periodToIso) periodQuery = periodQuery.lte('call_date', periodToIso)

      const [
        periodRes,
        extensionsRes,
        syncRes,
      ] = await Promise.all([
        periodQuery,
        sb.from('extensions')
          .select('extension, display_name, role')
          .eq('active', true),
        sb.from('sync_state')
          .select('last_synced_at, last_error, records_synced_total')
          .eq('id', 'freepbx_cdr')
          .maybeSingle(),
      ])

      if (periodRes.error) throw periodRes.error
      if (extensionsRes.error) throw extensionsRes.error

      const periodCalls = periodRes.data || []
      const extensions = extensionsRes.data || []
      const sync = syncRes.data || { last_synced_at: null, last_error: null, records_synced_total: 0 }

      // Period aggregates
      const inbound = periodCalls.filter(c => c.direction === 'inbound')
      const outbound = periodCalls.filter(c => c.direction === 'outbound')
      const answered = periodCalls.filter(c => c.disposition === 'ANSWERED')
      const missedInbound = inbound.filter(c => c.disposition !== 'ANSWERED')
      const totalTalk = periodCalls.reduce((s, c) => s + (c.billsec_seconds || 0), 0)
      const avgCall = answered.length > 0 ? Math.round(totalTalk / answered.length) : 0
      const answerRate = inbound.length > 0
        ? Math.round((inbound.filter(c => c.disposition === 'ANSWERED').length / inbound.length) * 100)
        : 0

      // Per-agent aggregates — scoped to the same period as everything else.
      const agentMap = new Map<string, AgentStats>()
      for (const ext of extensions) {
        agentMap.set(ext.extension, {
          extension: ext.extension,
          display_name: ext.display_name,
          role: ext.role,
          today_total: 0,
          today_answered_inbound: 0,
          today_outbound: 0,
          today_talk_seconds: 0,
          week_talk_seconds: 0,
        })
      }
      for (const c of periodCalls) {
        if (!c.agent_ext) continue
        const a = agentMap.get(c.agent_ext)
        if (!a) continue
        a.today_total += 1
        if (c.direction === 'inbound' && c.disposition === 'ANSWERED') a.today_answered_inbound += 1
        if (c.direction === 'outbound') a.today_outbound += 1
        a.today_talk_seconds += (c.billsec_seconds || 0)
        // `week_talk_seconds` is kept for frontend compat. Now = period.
        a.week_talk_seconds += (c.billsec_seconds || 0)
      }

      const agents = Array.from(agentMap.values())
        .filter(a => a.today_total > 0)
        .sort((a, b) => b.week_talk_seconds - a.week_talk_seconds)

      const response: StatsResponse = {
        periodLabel,
        today: {
          total: periodCalls.length,
          inbound: inbound.length,
          outbound: outbound.length,
          answered: answered.length,
          missed_inbound: missedInbound.length,
          talk_seconds: totalTalk,
          avg_call_seconds: avgCall,
          answer_rate: answerRate,
        },
        // `week` block reflects the same period as `today` — kept for compat.
        week: {
          total: periodCalls.length,
          talk_seconds: totalTalk,
        },
        agents,
        sync: {
          last_synced_at: sync.last_synced_at,
          last_error: sync.last_error,
          records_synced_total: sync.records_synced_total || 0,
        },
      }

      return res.status(200).json(response)
    } catch (e: any) {
      console.error('calls/stats error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}
