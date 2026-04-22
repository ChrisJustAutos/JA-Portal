// pages/api/calls/stats.ts
// Dashboard statistics: today's totals, per-agent breakdown, 7-day rollups.
// Accepts optional ?startDate=&endDate= to scope "today" stats to a date range.

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
  week_talk_seconds: number
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

      // Parse optional date range for the "today" bucket — when provided,
      // the first stats card set reflects the selected range. Week stats
      // are always a rolling 7-day window (used for per-agent activity
      // bars that shouldn't whipsaw as the user changes the main range).
      const q = req.query
      const startDateParam = q.startDate ? String(q.startDate) : null
      const endDateParam = q.endDate ? String(q.endDate) : null

      const now = new Date()
      let periodFromIso: string
      let periodToIso: string | null = null
      let periodLabel: string

      if (startDateParam || endDateParam) {
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

      const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0)

      // Build the "period" query — with or without upper bound
      let periodQuery = sb.from('calls')
        .select('direction, disposition, billsec_seconds, agent_ext')
        .gte('call_date', periodFromIso)
      if (periodToIso) periodQuery = periodQuery.lte('call_date', periodToIso)

      const [
        periodRes,
        weekRes,
        extensionsRes,
        syncRes,
      ] = await Promise.all([
        periodQuery,
        sb.from('calls')
          .select('direction, disposition, billsec_seconds, agent_ext, call_date')
          .gte('call_date', weekStart.toISOString()),
        sb.from('extensions')
          .select('extension, display_name, role')
          .eq('active', true),
        sb.from('sync_state')
          .select('last_synced_at, last_error, records_synced_total')
          .eq('id', 'freepbx_cdr')
          .maybeSingle(),
      ])

      if (periodRes.error) throw periodRes.error
      if (weekRes.error) throw weekRes.error
      if (extensionsRes.error) throw extensionsRes.error

      const periodCalls = periodRes.data || []
      const weekCalls = weekRes.data || []
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

      // Per-agent stats — period totals + rolling week talk time
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
      }
      for (const c of weekCalls) {
        if (!c.agent_ext) continue
        const a = agentMap.get(c.agent_ext)
        if (!a) continue
        a.week_talk_seconds += (c.billsec_seconds || 0)
      }

      const agents = Array.from(agentMap.values())
        .filter(a => a.week_talk_seconds > 0 || a.today_total > 0)
        .sort((a, b) => b.week_talk_seconds - a.week_talk_seconds)

      const weekTalk = weekCalls.reduce((s, c) => s + (c.billsec_seconds || 0), 0)

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
        week: {
          total: weekCalls.length,
          talk_seconds: weekTalk,
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
