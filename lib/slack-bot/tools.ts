// lib/slack-bot/tools.ts
//
// Tool definitions + implementations for the JA Portal Slack bot.
// Each tool has a name, a JSON-schema input definition exposed to Claude,
// and an execute() that runs server-side.

import { getConnection, myobFetch } from '../myob'

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeOData(s: string): string {
  return String(s).replace(/'/g, "''")
}

async function resolveCompanyFile(company: string): Promise<{ connId: string; cfId: string; label: string }> {
  const label = company.toUpperCase() === 'VPS' ? 'VPS' : 'JAWS'
  const conn = await getConnection(label)
  if (!conn) throw new Error(`No MYOB connection for ${label} — has it been connected on the portal?`)
  if (!conn.company_file_id) throw new Error(`MYOB ${label} has no company file selected`)
  return { connId: conn.id, cfId: conn.company_file_id, label }
}

// ── Tool: search_myob_customer ─────────────────────────────────────────

async function execSearchCustomer(input: { name: string; company?: string }): Promise<string> {
  const { connId, cfId, label } = await resolveCompanyFile(input.company || 'JAWS')
  const tokens = (input.name || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3)
  if (tokens.length === 0) return 'No search term given.'
  const clauses = tokens.map(t => {
    const s = escapeOData(t)
    return `(substringof('${s}',tolower(CompanyName)) or substringof('${s}',tolower(LastName)) or substringof('${s}',tolower(FirstName)))`
  })
  const filter = `IsActive eq true and ` + clauses.join(' and ')
  const { data } = await myobFetch(connId, `/accountright/${cfId}/Contact/Customer`, {
    query: { '$top': 10, '$orderby': 'CompanyName', '$filter': filter },
  })
  const items: any[] = Array.isArray(data?.Items) ? data.Items : []
  if (items.length === 0) return `No customers in MYOB ${label} matching "${input.name}".`
  const lines = items.map(c => {
    const name = (c.CompanyName || `${c.FirstName || ''} ${c.LastName || ''}`).trim() || '(unnamed)'
    const phone = c.Addresses?.[0]?.Phone1 || ''
    const email = c.Addresses?.[0]?.Email || ''
    return `• ${name} (${c.DisplayID || '–'})${email ? ` · ${email}` : ''}${phone ? ` · ${phone}` : ''}`
  })
  return `Found ${items.length} customer(s) in MYOB ${label}:\n${lines.join('\n')}`
}

// ── Tool: lookup_myob_invoice ──────────────────────────────────────────

async function execLookupInvoice(input: { invoice_number: string; company?: string }): Promise<string> {
  const { connId, cfId, label } = await resolveCompanyFile(input.company || 'JAWS')
  const num = String(input.invoice_number || '').trim()
  if (!num) return 'No invoice number given.'
  const filter = `Number eq '${escapeOData(num)}'`
  const { data } = await myobFetch(connId, `/accountright/${cfId}/Sale/Invoice`, {
    query: { '$filter': filter, '$top': 5 },
  })
  const items: any[] = Array.isArray(data?.Items) ? data.Items : []
  if (items.length === 0) return `Invoice #${num} not found in MYOB ${label}.`
  const i = items[0]
  const balance = Number(i.BalanceDueAmount || 0).toFixed(2)
  const total = Number(i.TotalAmount || 0).toFixed(2)
  const customer = i.Customer?.Name || '(unknown)'
  const status = i.Status || (Number(i.BalanceDueAmount || 0) <= 0 ? 'Closed' : 'Open')
  return `MYOB ${label} invoice #${num}:\n• Customer: ${customer}\n• Date: ${i.Date?.slice(0, 10) || '?'}\n• Total: $${total}\n• Balance due: $${balance}\n• Status: ${status}`
}

// ── Tool: list_unpaid_invoices ─────────────────────────────────────────

async function execListUnpaid(input: { customer_name?: string; company?: string; limit?: number }): Promise<string> {
  const { connId, cfId, label } = await resolveCompanyFile(input.company || 'JAWS')
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50)
  const parts = ['Status eq \'Open\'']
  if (input.customer_name) {
    const tokens = input.customer_name.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 2)
    for (const t of tokens) {
      const s = escapeOData(t)
      parts.push(`substringof('${s}',tolower(Customer/Name))`)
    }
  }
  const filter = parts.join(' and ')
  const { data } = await myobFetch(connId, `/accountright/${cfId}/Sale/Invoice`, {
    query: { '$filter': filter, '$orderby': 'Date desc', '$top': limit },
  })
  const items: any[] = Array.isArray(data?.Items) ? data.Items : []
  if (items.length === 0) return `No open invoices in MYOB ${label}${input.customer_name ? ` for "${input.customer_name}"` : ''}.`
  const totalBalance = items.reduce((sum, i) => sum + Number(i.BalanceDueAmount || 0), 0)
  const lines = items.slice(0, limit).map(i => {
    const bal = Number(i.BalanceDueAmount || 0).toFixed(2)
    return `• #${i.Number} · ${i.Customer?.Name || '?'} · $${bal} · ${i.Date?.slice(0, 10) || '?'}`
  })
  return `${items.length} open invoice(s) in MYOB ${label}${input.customer_name ? ` for "${input.customer_name}"` : ''} · total outstanding $${totalBalance.toFixed(2)}:\n${lines.join('\n')}`
}

// ── Tool: search_stock_delays (Monday board) ───────────────────────────

const STOCK_DELAY_BOARD_ID = 2060835661

async function execSearchStockDelays(input: { query: string }): Promise<string> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) return 'Monday API not configured (MONDAY_API_TOKEN missing).'
  const q = (input.query || '').trim().toLowerCase()
  if (!q) return 'No search term given.'

  // Pull all items from the board (delay board is small — <300 items)
  const items: any[] = []
  let cursor: string | null = null
  for (let p = 0; p < 10; p++) {
    const gql = `query ($boardId: [ID!], $limit: Int!, $cursor: String) {
      boards(ids: $boardId) {
        items_page(limit: $limit, cursor: $cursor) {
          cursor
          items { id name column_values { id text } }
        }
      }
    }`
    const r = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
      body: JSON.stringify({ query: gql, variables: { boardId: [STOCK_DELAY_BOARD_ID], limit: 100, cursor } }),
    })
    const j = await r.json() as any
    if (j.errors) return `Monday API error: ${JSON.stringify(j.errors).slice(0, 200)}`
    const page = j.data?.boards?.[0]?.items_page
    items.push(...(page?.items || []))
    cursor = page?.cursor || null
    if (!cursor) break
  }

  // Filter by name/part-number containing query
  const hits = items.filter(i => {
    const name = String(i.name || '').toLowerCase()
    if (name.includes(q)) return true
    const cols: any[] = i.column_values || []
    return cols.some(c => String(c.text || '').toLowerCase().includes(q))
  })
  if (hits.length === 0) return `No items on the Product Availability Delays board matching "${input.query}".`

  const lines = hits.slice(0, 15).map(i => {
    const cols: any[] = i.column_values || []
    const part = cols.find(c => c.id === 'text_mkv0n9h7')?.text || ''
    const avail = cols.find(c => c.id === 'status')?.text || '?'
    const eta = cols.find(c => c.id === 'color_mkncj8ds')?.text || '?'
    return `• ${i.name}${part ? ` (${part})` : ''} · Avail: ${avail} · ETA: ${eta}`
  })
  return `${hits.length} item(s) on the delay board matching "${input.query}":\n${lines.join('\n')}${hits.length > 15 ? `\n(+${hits.length - 15} more — refine the query for fewer)` : ''}`
}

// ── Registry ───────────────────────────────────────────────────────────

export interface ToolDef {
  name: string
  description: string
  input_schema: any
  execute: (input: any) => Promise<string>
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_myob_customer',
    description: 'Search MYOB for an active customer by name. Returns up to 10 matches with DisplayID, email, and phone. Use when the user asks about a customer.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Customer name or partial name to search.' },
        company: { type: 'string', enum: ['JAWS', 'VPS'], description: 'Which MYOB company file to search (default JAWS).' },
      },
      required: ['name'],
    },
    execute: execSearchCustomer,
  },
  {
    name: 'lookup_myob_invoice',
    description: 'Fetch a specific MYOB invoice by its invoice number. Returns customer, total, balance, status.',
    input_schema: {
      type: 'object',
      properties: {
        invoice_number: { type: 'string', description: 'The invoice number to look up (e.g. "12345" or "INV-12345").' },
        company: { type: 'string', enum: ['JAWS', 'VPS'], description: 'Which MYOB company file to search (default JAWS).' },
      },
      required: ['invoice_number'],
    },
    execute: execLookupInvoice,
  },
  {
    name: 'list_unpaid_invoices',
    description: 'List open (unpaid) invoices in MYOB. Optionally filter by customer name. Returns list with totals.',
    input_schema: {
      type: 'object',
      properties: {
        customer_name: { type: 'string', description: 'Optional customer-name filter.' },
        company: { type: 'string', enum: ['JAWS', 'VPS'], description: 'Which MYOB company file (default JAWS).' },
        limit: { type: 'number', description: 'Max invoices to return (1-50, default 20).' },
      },
    },
    execute: execListUnpaid,
  },
  {
    name: 'search_stock_delays',
    description: 'Search the Monday "Product Availability Delays" board (Morgan\'s board of below-alert stock items synced from Mechanics Desk). Use this for questions like "what\'s stock on X part?" or "is X on the delay list?".',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part number or product-name fragment to search.' },
      },
      required: ['query'],
    },
    execute: execSearchStockDelays,
  },
]

export const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]))
