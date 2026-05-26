// lib/b2b-machship.ts
//
// Typed wrapper around the MachShip API. Used by the freight-quote
// endpoint, the admin "Book via MachShip" endpoint, the cron poller
// and the "Refresh from MachShip" button.
//
// Auth: custom header `token: <api_token>` (NOT Bearer). The token
// lives in b2b_freight_carrier_connections.credentials JSONB under
// provider='machship'. We fetch it once per request rather than
// caching across requests so an admin can rotate the token via the
// settings page and the next API call picks the new value up.
//
// Base URL is fixed: there is no separate sandbox host. Test vs live
// is a property of the MachShip user the token was minted on.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const MACHSHIP_BASE = 'https://live.machship.com'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Token resolution ───────────────────────────────────────────────

export class MachShipNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`MachShip not configured: ${reason}`)
    this.name = 'MachShipNotConfiguredError'
  }
}

export class MachShipApiError extends Error {
  status: number
  detail: any
  constructor(message: string, status: number, detail: any) {
    super(message)
    this.name = 'MachShipApiError'
    this.status = status
    this.detail = detail
  }
}

async function getApiToken(): Promise<string> {
  const c = sb()
  const { data, error } = await c
    .from('b2b_freight_carrier_connections')
    .select('credentials, is_active')
    .eq('provider', 'machship')
    .maybeSingle()
  if (error) throw new Error(`MachShip token lookup failed: ${error.message}`)
  if (!data) throw new MachShipNotConfiguredError('no connection row — add credentials in B2B Settings')
  if (!data.is_active) throw new MachShipNotConfiguredError('connection is disabled')
  const token = (data.credentials as any)?.api_token
  if (!token || typeof token !== 'string') {
    throw new MachShipNotConfiguredError('credentials.api_token missing')
  }
  return token
}

// ── Shared request helper ──────────────────────────────────────────

interface MachShipEnvelope<T> {
  object: T | null
  // MachShip's error shape varies across endpoints — sometimes `message`,
  // sometimes `errorMessage`, sometimes nested under `description`. We
  // type it loosely and read defensively in extractErrorMessage().
  errors: Array<Record<string, any>> | null
}

// MachShip is inconsistent about which field carries the human error
// text. Walk the common variants in priority order; if none match, dump
// the whole error object as JSON so at least the operator sees what
// MachShip actually said. Never returns the empty string — callers can
// `||` against it confidently.
function extractErrorMessage(errors: any): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const e = errors[0]
  if (!e || typeof e !== 'object') return String(e || '') || null
  const pick =
       e.message
    || e.errorMessage
    || e.description
    || e.detail
    || e.error
    || e.reason
  if (typeof pick === 'string' && pick.trim()) return pick
  // Last resort — dump the full error object so we can see fields like
  // code/field/path that MachShip uses for validation failures.
  try { return JSON.stringify(e) } catch { return null }
}

async function machshipFetch<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: any,
): Promise<T> {
  const token = await getApiToken()
  const url = `${MACHSHIP_BASE}${path}`
  const r = await fetch(url, {
    method,
    headers: {
      'token':        token,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let parsed: MachShipEnvelope<T> | null = null
  try { parsed = text ? JSON.parse(text) : null } catch {}

  if (!r.ok) {
    const detailMsg =
      extractErrorMessage(parsed?.errors)
      || (parsed as any)?.message
      || text.slice(0, 300)
      || `${method} ${path} returned ${r.status}`
    console.error(`[machship] ${method} ${path} → ${r.status}:`, text.slice(0, 1000))
    throw new MachShipApiError(`MachShip ${r.status}: ${detailMsg}`, r.status, parsed ?? text)
  }
  // A 200 with errors[] populated is still a failure per MachShip's
  // envelope convention. Log the full envelope to console so we can
  // diagnose unexpected error shapes server-side.
  if (parsed?.errors && parsed.errors.length > 0) {
    const detailMsg = extractErrorMessage(parsed.errors) || 'errors[] populated on 200 response'
    console.error(`[machship] ${method} ${path} → 200 with errors:`, JSON.stringify(parsed.errors).slice(0, 1000))
    throw new MachShipApiError(`MachShip ${r.status} (envelope): ${detailMsg}`, r.status, parsed)
  }
  if (parsed?.object == null) {
    throw new MachShipApiError(`MachShip ${r.status} returned empty object`, r.status, parsed)
  }
  return parsed.object
}

// ── Types ──────────────────────────────────────────────────────────
//
// Narrowed to the fields we actually use. Anything else from MachShip
// is preserved when we want it (we store the raw route snapshot in
// b2b_orders.freight_chosen_quote) but isn't typed here.

export interface MachShipLocation {
  suburb: string
  postcode: string
}

export interface MachShipItem {
  itemType: 'Carton' | 'Pallet' | 'Satchel' | 'Skid' | string
  name: string
  quantity: number
  weight: number   // kg
  length: number   // cm
  width:  number   // cm
  height: number   // cm
  sku?:   string
}

export interface RoutesRequest {
  fromLocation: MachShipLocation
  toLocation:   MachShipLocation
  items:        MachShipItem[]
}

export interface RouteOption {
  carrier:        { id: number; name: string }
  carrierService: { id: number; name: string }
  carrierAccount?: { id?: number; name?: string }
  companyCarrierAccountId?: number
  consignmentTotal: {
    totalSellPrice:    number
    totalTaxSellPrice?: number
  }
  despatchOptions: Array<{
    etaLocal?: string
    etaUtc?:   string
    totalDays?: number
    totalBusinessDays?: number
  }>
}

export interface RoutesResponse {
  routes: RouteOption[]
}

export async function getRoutes(req: RoutesRequest): Promise<RoutesResponse> {
  return machshipFetch<RoutesResponse>('POST', '/apiv2/routes/returnRoutes', req)
}

export interface CreateConsignmentRequest {
  carrierId: number
  carrierServiceId: number
  companyCarrierAccountId?: number

  fromName?: string
  fromContact?: string
  fromCompany?: string
  fromPhone?: string
  fromEmail?: string
  fromAddressLine1?: string
  fromAddressLine2?: string
  fromLocation: MachShipLocation

  toName?: string
  toContact?: string
  toCompany?: string
  toPhone?: string
  toEmail?: string
  toAddressLine1?: string
  toAddressLine2?: string
  toLocation: MachShipLocation

  customerReference?: string
  customerReference2?: string
  sendingTrackingEmail?: boolean

  items: MachShipItem[]
}

export interface Consignment {
  id: number
  consignmentNumber: string                       // e.g. "MS123456"
  carrierConsignmentId?: string | null            // the tracking number (carrier-issued)
  status?: { id?: number; name?: string } | null  // e.g. "Unmanifested" / "InTransit" / "Delivered"
  etaLocal?: string | null
  etaUtc?:   string | null
  despatchDateLocal?: string | null
  despatchDateUtc?:   string | null
  trackingPageAccessToken?: string | null
  consignmentTotal?: {
    totalSellPrice?: number
    totalTaxSellPrice?: number
  } | null
}

export async function createConsignment(req: CreateConsignmentRequest): Promise<Consignment> {
  return machshipFetch<Consignment>('POST', '/apiv2/consignments/createConsignment', req)
}

export async function getConsignment(consignmentId: string | number): Promise<Consignment> {
  return machshipFetch<Consignment>('GET', `/apiv2/consignments/${encodeURIComponent(String(consignmentId))}`)
}

// MachShip returns label PDFs as base64 inside the response envelope.
// The caller is responsible for decoding and uploading to storage.
export interface LabelPdfFileInfo {
  fileName?: string
  contentType?: string
  content: string   // base64-encoded PDF bytes
}

export async function getLabelPdfBase64(
  consignmentId: string | number,
  opts: { a4?: boolean } = {},
): Promise<LabelPdfFileInfo> {
  const a4 = opts.a4 === true ? 'true' : 'false'
  return machshipFetch<LabelPdfFileInfo>(
    'GET',
    `/apiv2/labels/getItemPdfFileInfo?consignmentId=${encodeURIComponent(String(consignmentId))}&printA4=${a4}`,
  )
}

// ── Convenience: the public tracking page URL for a consignment ─────
//
// MachShip serves a customer-facing tracking page at:
//   https://live.machship.com/track/{access_token}
// We store the token on the order and build the URL on demand so we
// never need to hit MachShip just to render the link.
export function buildTrackingPageUrl(accessToken: string): string {
  return `${MACHSHIP_BASE}/track/${encodeURIComponent(accessToken)}`
}
