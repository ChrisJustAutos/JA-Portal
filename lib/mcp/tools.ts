// lib/mcp/tools.ts
// Read-only tools exposed by the JA Portal MCP connector. Every tool is gated by
// the same portal permission as its corresponding screen (so roles are mirrored),
// and runs with the service-role DB client only AFTER that check passes.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { roleHasPermission, Permission } from '../permissions'
import { fetchSalesSummary } from '../../pages/api/sales'
import type { McpUser } from './auth'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const clampLimit = (n: any, def = 25, max = 100) => Math.min(max, Math.max(1, Math.round(Number(n) || def)))
const dayEnd = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59+10:00` : d

export interface ToolDef {
  name: string
  description: string
  permission: Permission
  inputSchema: Record<string, any>
  run: (args: any, user: McpUser) => Promise<any>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_call_coaching',
    description: "Recent phone calls with their AI coaching summary, sales score and outcome. Filter by advisor name, date range, or outcome. Use this for coaching notes and call performance questions.",
    permission: 'view:calls',
    inputSchema: {
      type: 'object',
      properties: {
        advisor_name: { type: 'string', description: 'Filter to one advisor (partial name match, e.g. "Kaleb").' },
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
        outcome: { type: 'string', description: 'Filter by outcome_classification (partial match).' },
        min_sales_score: { type: 'number', description: 'Only calls with sales_score >= this.' },
        limit: { type: 'number', description: 'Max rows (default 25, max 100).' },
      },
    },
    run: async (args) => {
      const db = sb()
      let q = db.from('calls')
        .select('call_date, direction, effective_advisor_name, agent_name, caller_name, external_number, duration_seconds, outcome_classification, sales_score, objections_raised, coaching_summary')
        .not('coaching_summary', 'is', null)
        .order('call_date', { ascending: false })
        .limit(clampLimit(args.limit))
      if (args.advisor_name) q = q.ilike('effective_advisor_name', `%${String(args.advisor_name).replace(/[%]/g, '')}%`)
      if (args.from) q = q.gte('call_date', args.from)
      if (args.to) q = q.lte('call_date', dayEnd(String(args.to)))
      if (args.outcome) q = q.ilike('outcome_classification', `%${String(args.outcome).replace(/[%]/g, '')}%`)
      if (args.min_sales_score != null) q = q.gte('sales_score', Number(args.min_sales_score))
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return { count: data?.length || 0, calls: data || [] }
    },
  },
  {
    name: 'search_customers',
    description: 'Look up workshop customers by name, phone, mobile or email, with their vehicles. Use for "what do we know about <customer>" / vehicle history questions.',
    permission: 'view:diary',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name / phone / mobile / email to search.' },
        limit: { type: 'number', description: 'Max customers (default 10, max 50).' },
      },
      required: ['query'],
    },
    run: async (args) => {
      const db = sb()
      const term = String(args.query || '').replace(/[%,()*]/g, ' ').trim()
      if (!term) throw new Error('query is required')
      const { data: customers, error } = await db.from('workshop_customers')
        .select('id, name, customer_type, company, phone, mobile, email, address, address_suburb, address_state, address_postcode, source_of_business')
        .or(`name.ilike.%${term}%,phone.ilike.%${term}%,mobile.ilike.%${term}%,email.ilike.%${term}%`)
        .limit(clampLimit(args.limit, 10, 50))
      if (error) throw new Error(error.message)
      const ids = (customers || []).map((c: any) => c.id)
      let vehiclesByCustomer: Record<string, any[]> = {}
      if (ids.length) {
        const { data: vehicles } = await db.from('workshop_vehicles')
          .select('id, customer_id, rego, rego_state, make, series, model, year, model_code, vin, colour, odometer').in('customer_id', ids)
        for (const v of vehicles || []) (vehiclesByCustomer[v.customer_id] ||= []).push(v)
      }
      return { count: customers?.length || 0, customers: (customers || []).map((c: any) => ({ ...c, vehicles: vehiclesByCustomer[c.id] || [] })) }
    },
  },
  {
    name: 'get_quotes',
    description: 'Workshop quotes with customer, vehicle and totals. Filter by status or search text. Use for quote status / value questions.',
    permission: 'view:diary',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending | sent | accepted | declined | expired | converted' },
        query: { type: 'string', description: 'Search by quote number or customer/vehicle (optional).' },
        limit: { type: 'number', description: 'Max rows (default 25, max 100).' },
      },
    },
    run: async (args) => {
      const db = sb()
      let q = db.from('workshop_quotes')
        .select('quote_seq, status, total, subtotal, gst, order_number, issue_date, due_date, created_at, customer:workshop_customers(name, mobile, phone), vehicle:workshop_vehicles(rego, make, model, year)')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(clampLimit(args.limit))
      if (args.status) q = q.eq('status', String(args.status))
      const { data, error } = await q
      if (error) throw new Error(error.message)
      let rows = data || []
      // Lightweight client-side text filter (joins make server-side OR awkward).
      if (args.query) {
        const t = String(args.query).toLowerCase()
        rows = rows.filter((r: any) => `${r.quote_seq || ''} ${r.customer?.name || ''} ${r.vehicle?.rego || ''} ${r.vehicle?.make || ''} ${r.vehicle?.model || ''}`.toLowerCase().includes(t))
      }
      return { count: rows.length, quotes: rows }
    },
  },
  {
    name: 'get_jobs',
    description: 'Workshop jobs / diary bookings with status, customer, vehicle and totals. Filter by status. Use for workshop pipeline / job status questions.',
    permission: 'view:diary',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. booking | confirmed | in_progress | awaiting_parts | ready | done | invoiced | paid' },
        from: { type: 'string', description: 'Only jobs starting on/after this date YYYY-MM-DD.' },
        limit: { type: 'number', description: 'Max rows (default 25, max 100).' },
      },
    },
    run: async (args) => {
      const db = sb()
      let q = db.from('workshop_bookings')
        .select('starts_at, status, job_type, description, order_number, total_inc_gst, estimated_value, customer:workshop_customers(name, mobile, phone), vehicle:workshop_vehicles(rego, make, model, year)')
        .order('starts_at', { ascending: false })
        .limit(clampLimit(args.limit))
      if (args.status) q = q.eq('status', String(args.status))
      if (args.from) q = q.gte('starts_at', String(args.from))
      const { data, error } = await q
      if (error) throw new Error(error.message)
      return { count: data?.length || 0, jobs: data || [] }
    },
  },
  {
    name: 'get_sales',
    description: 'Sales dashboard summary (Monday-backed): orders, distributor bookings and per-rep quote stats over a date range. Use for sales totals / rep performance questions.',
    permission: 'view:leads',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default this financial year).' },
        to: { type: 'string', description: 'End date YYYY-MM-DD (default today).' },
      },
    },
    run: async (args) => {
      const today = new Date()
      const fyStart = `${today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1}-07-01`
      const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from || '') ? args.from : fyStart
      const to = /^\d{4}-\d{2}-\d{2}$/.test(args.to || '') ? args.to : today.toISOString().slice(0, 10)
      const s: any = await fetchSalesSummary(from, to)
      // Condense — drop the large activeLeads array, keep the headline figures.
      return {
        period: s.period,
        orders: s.orders ? { totalOrders: s.orders.totalOrders, totalValue: s.orders.totalValue, tracedOrders: s.orders.tracedOrders, byType: s.orders.byType, monthly: s.orders.monthly } : null,
        distributors: s.distributors ? { total: s.distributors.total, mtdTotal: s.distributors.mtdTotal, byPerson: s.distributors.byPerson } : null,
        quotes: (s.quotes || []).map((q: any) => ({ rep: q.rep, totalItems: q.totalItems, stats: q.stats })),
      }
    },
  },
]

export function listToolsFor(user: McpUser) {
  return TOOLS
    .filter(t => roleHasPermission(user.role as any, t.permission))
    .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

export async function callTool(name: string, args: any, user: McpUser): Promise<any> {
  const tool = TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  if (!roleHasPermission(user.role as any, tool.permission)) {
    throw new Error(`Your portal role (${user.role}) doesn't have access to ${name} (requires ${tool.permission}).`)
  }
  return tool.run(args || {}, user)
}
