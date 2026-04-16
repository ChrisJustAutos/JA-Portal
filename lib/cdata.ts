// lib/cdata.ts — Server-side only
// Queries MYOB via CData MCP SSE endpoint

const CDATA_USER = process.env.CDATA_USERNAME || ''
const CDATA_PAT  = process.env.CDATA_PAT || ''
const MCP_URL    = 'https://mcp.cloud.cdata.com/mcp'

function authHeader() {
  const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
  return {
    'Authorization': `Basic ${creds}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
}

export async function cdataQuery(_catalog: string, sql: string) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'queryData', arguments: { query: sql } }
    }),
    cache: 'no-store',
  })

  if (!res.ok) throw new Error(`CData MCP ${res.status}`)

  const raw = await res.text()

  // SSE format: "event: message\ndata: {...}\n\n"
  // Extract the data line
  const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
  if (!dataLine) throw new Error('No data line in SSE response')

  const envelope = JSON.parse(dataLine.replace(/^data:\s*/, ''))

  if (envelope.error) throw new Error(`CData error: ${JSON.stringify(envelope.error)}`)

  // Result is nested: envelope.result.content[0].text = actual JSON string
  const textContent = envelope?.result?.content?.[0]?.text
  if (!textContent) throw new Error('No content in MCP response')

  return JSON.parse(textContent)
}

// ── JAWS queries ─────────────────────────────────────────────

export async function getJawsRecentInvoices() {
  return cdataQuery('JAWS', `SELECT TOP 30 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)
}
export async function getJawsOpenInvoices() {
  return cdataQuery('JAWS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)
}
export async function getJawsTopCustomers(startDate: string, endDate: string) {
  return cdataQuery('JAWS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] WHERE [Date] >= '${startDate}' AND [Date] <= '${endDate}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 12`)
}
export async function getJawsPnL(startDate: string, endDate: string) {
  return cdataQuery('JAWS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${startDate}' AND [EndDate] = '${endDate}' ORDER BY [AccountDisplayID]`)
}
export async function getJawsStockItems() {
  return cdataQuery('JAWS', `SELECT TOP 30 [Name],[CurrentValue],[QuantityOnHand],[QuantityCommitted],[QuantityAvailable],[AverageCost],[BaseSellingPrice] FROM [MYOB_POWERBI_JAWS].[MYOB].[Items] ORDER BY [CurrentValue] DESC`)
}
export async function getJawsStockSummary() {
  return cdataQuery('JAWS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]`)
}
export async function getJawsOpenBills() {
  return cdataQuery('JAWS', `SELECT TOP 20 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)
}

// ── VPS queries ──────────────────────────────────────────────

export async function getVpsRecentInvoices() {
  return cdataQuery('VPS', `SELECT TOP 30 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC`)
}
export async function getVpsOpenInvoices() {
  return cdataQuery('VPS', `SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)
}
export async function getVpsTopCustomers(startDate: string, endDate: string) {
  return cdataQuery('VPS', `SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices] WHERE [Date] >= '${startDate}' AND [Date] <= '${endDate}' AND [TotalAmount] > 0 GROUP BY [CustomerName] ORDER BY TotalRevenue DESC LIMIT 12`)
}
export async function getVpsOpenBills() {
  return cdataQuery('VPS', `SELECT TOP 20 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status] FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills] WHERE [Status] = 'Open' ORDER BY [BalanceDueAmount] DESC`)
}
export async function getVpsPnL(startDate: string, endDate: string) {
  return cdataQuery('VPS', `SELECT [AccountName],[AccountDisplayID],[AccountTotal] FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport] WHERE [StartDate] = '${startDate}' AND [EndDate] = '${endDate}' ORDER BY [AccountDisplayID]`)
}
export async function getVpsStockSummary() {
  return cdataQuery('VPS', `SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount FROM [MYOB_POWERBI_VPS].[MYOB].[Items]`)
}

// ── Trend queries ────────────────────────────────────────────

export async function getMonthlyTrend(catalog: string, year: number, month: number) {
  const start = `${year}-${String(month).padStart(2,'0')}-01`
  const end   = `${year}-${String(month).padStart(2,'0')}-${new Date(year, month, 0).getDate()}`
  return cdataQuery(catalog, `SELECT SUM([AccountTotal]) AS Income FROM [${catalog}].[MYOB].[ProfitAndLossSummaryReport] WHERE [AccountDisplayID] LIKE '4-%' AND [StartDate] = '${start}' AND [EndDate] = '${end}'`)
}
export async function getMonthlyExpenseTrend(catalog: string, year: number, month: number) {
  const start = `${year}-${String(month).padStart(2,'0')}-01`
  const end   = `${year}-${String(month).padStart(2,'0')}-${new Date(year, month, 0).getDate()}`
  return cdataQuery(catalog, `SELECT SUM([AccountTotal]) AS Expenses FROM [${catalog}].[MYOB].[ProfitAndLossSummaryReport] WHERE ([AccountDisplayID] LIKE '5-%' OR [AccountDisplayID] LIKE '6-%') AND [StartDate] = '${start}' AND [EndDate] = '${end}'`)
}

export function currentMonthRange() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]
  return { start, end }

      // AU Financial Year helper - FY ends 30 June
      // e.g. FY2026 = 1 Jul 2025 to 30 Jun 2026
  export function currentFYRange() {
      const now = new Date()
      const fyYear = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear()
      const start = `${fyYear - 1}-07-01`
      const end   = `${fyYear}-06-30`
      return { start, end, fyYear }
  }

  export function getFYRange(fyYear: number) {
      const start = `${fyYear - 1}-07-01`
      const end   = `${fyYear}-06-30`
      return { start, end, fyYear }
  }

  export function parseDateRange(req: { query: Record<string, string | string[]> }) {
      const s = req.query.startDate as string | undefined
      const e = req.query.endDate   as string | undefined
      if (s && e) return { start: s, end: e }
      return currentFYRange()
  }
}
