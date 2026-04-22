// pages/api/calls/stats.ts
// Dashboard statistics: today's totals, per-agent breakdown, 7-day rollups.
// Computed server-side so the page renders fast and reps can't see raw SQL.

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

      const now = new Date()
      const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0)
      const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7); weekStart.setHours(0, 0, 0, 0)

      // Fetch all necessary data in parallel
      const [
        todayRes,
        weekRes,
        extensionsRes,
        syncRes,
      ] = await Promise.all([
        sb.from('calls')
          .select('direction, disposition, billsec_seconds, agent_ext')
          .gte('call_date', todayStart.toISOString()),
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

      if (todayRes.error) throw todayRes.error
      if (weekRes.error) throw weekRes.error
      if (extensionsRes.error) throw extensionsRes.error

      const todayCalls = todayRes.data || []
      const weekCalls = weekRes.data || []
      const extensions = extensionsRes.data || []
      const sync = syncRes.data || { last_synced_at: null, last_error: null, records_synced_total: 0 }

      // Today aggregate
      const inbound = todayCalls.filter(c => c.direction === 'inbound')
      const outbound = todayCalls.filter(c => c.direction === 'outbound')
      const answered = todayCalls.filter(c => c.disposition === 'ANSWERED')
      const missedInbound = inbound.filter(c => c.disposition !== 'ANSWERED')
      const totalTalk = todayCalls.reduce((s, c) => s + (c.billsec_seconds || 0), 0)
      const avgCall = answered.length > 0 ? Math.round(totalTalk / answered.length) : 0
      const answerRate = inbound.length > 0
        ? Math.round((inbound.filter(c => c.disposition === 'ANSWERED').length / inbound.length) * 100)
        : 0

      // Per-agent: today stats + week stats
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
      for (const c of todayCalls) {
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

      // Filter to agents with activity in the last week, sort by week talk time desc
      const agents = Array.from(agentMap.values())
        .filter(a => a.week_talk_seconds > 0 || a.today_total > 0)
        .sort((a, b) => b.week_talk_seconds - a.week_talk_seconds)

      const weekTalk = weekCalls.reduce((s, c) => s + (c.billsec_seconds || 0), 0)

      const response: StatsResponse = {
        today: {
          total: todayCalls.length,
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
