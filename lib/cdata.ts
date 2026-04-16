// lib/cdata.ts — Server-side only CData Connect Cloud queries

const CDATA_BASE = process.env.CDATA_BASE_URL || 'https://cloud.cdata.com/api/odata4'
const CDATA_USER = process.env.CDATA_USERNAME || ''
const CDATA_PAT  = process.env.CDATA_PAT || ''

function authHeader() {
  const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
  return {
    'Authorization': `Basic ${creds}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
}

export async function cdataQuery(catalog: string, sql: string) {
  const url = `${CDATA_BASE}/${catalog}/query`
  
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({ query: sql }),
    cache: 'no-store',
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`CData ${res.status}: ${text.substring(0, 200)}`)
  }

  return res.json()
}

// ── JAWS queries ────────────────────────────────────────────

export async function getJawsRecentInvoices() {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT TOP 30 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType]
    FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
    ORDER BY [Date] DESC
  `)
}

export async function getJawsOpenInvoices() {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status]
    FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
    WHERE [Status] = 'Open'
    ORDER BY [BalanceDueAmount] DESC
  `)
}

export async function getJawsTopCustomers(startDate: string, endDate: string) {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount
    FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
    WHERE [Date] >= '${startDate}' AND [Date] <= '${endDate}' AND [TotalAmount] > 0
    GROUP BY [CustomerName]
    ORDER BY TotalRevenue DESC
    LIMIT 12
  `)
}

export async function getJawsPnL(startDate: string, endDate: string) {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT [AccountName],[AccountDisplayID],[AccountTotal]
    FROM [MYOB_POWERBI_JAWS].[MYOB].[ProfitAndLossSummaryReport]
    WHERE [StartDate] = '${startDate}' AND [EndDate] = '${endDate}'
    ORDER BY [AccountDisplayID]
  `)
}

export async function getJawsStockItems() {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT TOP 30 [Name],[CurrentValue],[QuantityOnHand],[QuantityCommitted],[QuantityAvailable],[AverageCost],[BaseSellingPrice]
    FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]
    ORDER BY [CurrentValue] DESC
  `)
}

export async function getJawsStockSummary() {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount
    FROM [MYOB_POWERBI_JAWS].[MYOB].[Items]
  `)
}

export async function getJawsOpenBills() {
  return cdataQuery('MYOB_POWERBI_JAWS', `
    SELECT TOP 20 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status]
    FROM [MYOB_POWERBI_JAWS].[MYOB].[PurchaseBills]
    WHERE [Status] = 'Open'
    ORDER BY [BalanceDueAmount] DESC
  `)
}

// ── VPS queries ─────────────────────────────────────────────

export async function getVpsRecentInvoices() {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT TOP 30 [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],[InvoiceType]
    FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices]
    ORDER BY [Date] DESC
  `)
}

export async function getVpsOpenInvoices() {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status]
    FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices]
    WHERE [Status] = 'Open'
    ORDER BY [BalanceDueAmount] DESC
  `)
}

export async function getVpsTopCustomers(startDate: string, endDate: string) {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT [CustomerName], SUM([TotalAmount]) AS TotalRevenue, COUNT(*) AS InvoiceCount
    FROM [MYOB_POWERBI_VPS].[MYOB].[SaleInvoices]
    WHERE [Date] >= '${startDate}' AND [Date] <= '${endDate}' AND [TotalAmount] > 0
    GROUP BY [CustomerName]
    ORDER BY TotalRevenue DESC
    LIMIT 12
  `)
}

export async function getVpsOpenBills() {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT TOP 20 [Number],[Date],[SupplierName],[TotalAmount],[BalanceDueAmount],[Status]
    FROM [MYOB_POWERBI_VPS].[MYOB].[PurchaseBills]
    WHERE [Status] = 'Open'
    ORDER BY [BalanceDueAmount] DESC
  `)
}

export async function getVpsPnL(startDate: string, endDate: string) {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT [AccountName],[AccountDisplayID],[AccountTotal]
    FROM [MYOB_POWERBI_VPS].[MYOB].[ProfitAndLossSummaryReport]
    WHERE [StartDate] = '${startDate}' AND [EndDate] = '${endDate}'
    ORDER BY [AccountDisplayID]
  `)
}

export async function getVpsStockSummary() {
  return cdataQuery('MYOB_POWERBI_VPS', `
    SELECT SUM([CurrentValue]) AS TotalStockValue, COUNT(*) AS ItemCount
    FROM [MYOB_POWERBI_VPS].[MYOB].[Items]
  `)
}

// ── Trend queries ────────────────────────────────────────────

export async function getMonthlyTrend(catalog: string, year: number, month: number) {
  const start = `${year}-${String(month).padStart(2,'0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end = `${year}-${String(month).padStart(2,'0')}-${lastDay}`
  return cdataQuery(catalog, `
    SELECT SUM([AccountTotal]) AS Income
    FROM [${catalog}].[MYOB].[ProfitAndLossSummaryReport]
    WHERE [AccountDisplayID] LIKE '4-%'
      AND [StartDate] = '${start}' AND [EndDate] = '${end}'
  `)
}

export async function getMonthlyExpenseTrend(catalog: string, year: number, month: number) {
  const start = `${year}-${String(month).padStart(2,'0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end = `${year}-${String(month).padStart(2,'0')}-${lastDay}`
  return cdataQuery(catalog, `
    SELECT SUM([AccountTotal]) AS Expenses
    FROM [${catalog}].[MYOB].[ProfitAndLossSummaryReport]
    WHERE ([AccountDisplayID] LIKE '5-%' OR [AccountDisplayID] LIKE '6-%')
      AND [StartDate] = '${start}' AND [EndDate] = '${end}'
  `)
}

// Helper
export function currentMonthRange() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]
  return { start, end }
}
