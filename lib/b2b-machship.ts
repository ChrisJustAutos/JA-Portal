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

// ⚠ Object.setPrototypeOf is REQUIRED, not decoration. tsconfig targets ES5,
// and TypeScript's ES5 downlevel of `class X extends Error` breaks the
// prototype chain, so `err instanceof X` is ALWAYS FALSE. Every caller here
// gates on instanceof — b2b-freight-book, b2b-freight, b2b-ship-now and
// b2b-machship-refresh — so without this a "not configured" error came back
// as a generic 500, and a 404 never reached the branch that handles a dead
// consignment. Found 2026-08-25 chasing MS70727168.
export class MachShipNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`MachShip not configured: ${reason}`)
    Object.setPrototypeOf(this, MachShipNotConfiguredError.prototype)
    this.name = 'MachShipNotConfiguredError'
  }
}

export class MachShipApiError extends Error {
  status: number
  detail: any
  constructor(message: string, status: number, detail: any) {
    super(message)
    Object.setPrototypeOf(this, MachShipApiError.prototype)   // see note above — ES5
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
  // When true, flags the item for manual handling so the carrier's quote/
  // booking price is adjusted for it (set from the catalogue tickbox).
  manualHandling?: boolean
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

  // Desired despatch (collection) date/time — ISO "yyyy-MM-ddThh:mm:ss.000Z".
  // The consignment is created/booked now; the carrier collects at this time.
  // A missing/past value makes MachShip default to NOW.
  // NOTE: MachShip uses the British spelling "despatch" (with an e). Sending the
  // American "dispatch" spelling is silently ignored → it defaults to NOW.
  despatchDateTimeUtc?: string
  dispatchDateTimeUtc?: string   // tolerated alias; harmless if the API ignores it

  items: MachShipItem[]
}

export interface Consignment {
  id: number
  // The company that owns the consignment. MachShip REQUIRES this on
  // /apiv2/manifests/manifest, and the createConsignment response is the one
  // place we reliably see it — GET /apiv2/consignments/{id} is not a real
  // route (it 404s for every consignment; see b2b-ship-now).
  companyId?: number | null
  company?: { id?: number | null } | null
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

// Manifest a booked consignment so the CARRIER actually receives the job —
// createConsignment alone leaves it sitting "Unmanifested" in MachShip
// (Chris 2026-08-06, first live order). Pickup window: if booked before 2pm
// Brisbane, today from an hour ahead until 5pm; otherwise next weekday
// 9am–5pm.
export async function manifestConsignments(
  consignmentIds: number[],
  opts: { companyId?: number | null; shape?: number } = {},
): Promise<any> {
  const BRIS_OFFSET_MS = 10 * 3600_000
  const nowBris = new Date(Date.now() + BRIS_OFFSET_MS)
  let pickup = new Date(nowBris)
  pickup.setUTCHours(pickup.getUTCHours() + 1, 0, 0, 0)
  if (nowBris.getUTCHours() >= 14) {
    pickup = new Date(nowBris)
    pickup.setUTCDate(pickup.getUTCDate() + 1)
    while ([0, 6].includes(pickup.getUTCDay())) pickup.setUTCDate(pickup.getUTCDate() + 1)
    pickup.setUTCHours(9, 0, 0, 0)
  }
  const close = new Date(pickup)
  close.setUTCHours(17, 0, 0, 0)
  const toUtcIso = (d: Date) => new Date(d.getTime() - BRIS_OFFSET_MS).toISOString()
  const core = {
    ...(opts.companyId ? { companyId: opts.companyId } : {}),
    pickupDateTime: toUtcIso(pickup),
    pickupClosingTime: toUtcIso(close),
    pickupAlreadyBooked: false,
  }
  // MachShip's manifest request body is undocumented and its Swagger is behind
  // auth. On 2026-08-27 the shape below returned 200 with NO validation errors
  // and `id: 0` — it accepted the request and manifested nothing, leaving the
  // consignment "Unmanifested" in MachShip while the portal reported the order
  // shipped. So the property name for the ids is a guess, and the caller must
  // VERIFY against the carrier rather than trust the 200.
  const shapes: any[] = [
    [{ ...core, consignmentIds }],
    [{ ...core, consignmentIds: consignmentIds.map(String) }],
    [{ ...core, ids: consignmentIds }],
    { ...core, consignmentIds },
    { ...core, consignmentIds: consignmentIds.map(String) },
  ]
  const idx = Math.max(0, Math.min(opts.shape ?? 0, shapes.length - 1))
  return machshipFetch<any>('POST', '/apiv2/manifests/manifest', shapes[idx])
}

/** How many request shapes manifestConsignments knows how to try. */
export const MANIFEST_SHAPE_COUNT = 5

export async function getConsignment(consignmentId: string | number): Promise<Consignment> {
  return machshipFetch<Consignment>('GET', `/apiv2/consignments/${encodeURIComponent(String(consignmentId))}`)
}

// ── Finding a consignment WITHOUT MachShip's internal id ────────────────
//
// When a consignment is deleted and re-created in MachShip, our stored
// machship_consignment_id 404s forever even though the shipment is alive and
// moving under the same carrier tracking number. These let the poller
// re-resolve the id instead of parking the order (see b2b-machship-refresh).
//
// MachShip documents the PATHS but not the request bodies, and its Swagger is
// behind auth, so the body shape is NEGOTIATED: we try the plausible shapes in
// order and keep the first that MachShip accepts. A total failure returns []
// rather than throwing — the caller then behaves exactly as it did before, so
// the worst case is no improvement rather than a regression.
//   docs: https://developers.live.machship.com/api/supporting/tracking-pods
// Both endpoints are capped at 10 values per request.
async function lookupConsignments(path: string, key: string, values: string[]): Promise<Consignment[]> {
  const vals = values.map(v => String(v || '').trim()).filter(Boolean).slice(0, 10)
  if (!vals.length) return []

  const shapes: any[] = [
    vals,                    // bare array — matches MachShip's other bulk id endpoints
    { [key]: vals },         // named property, e.g. { carrierConsignmentIds: [...] }
    { values: vals },
  ]
  for (const body of shapes) {
    try {
      const res = await machshipFetch<any>('POST', path, body)
      const list: any[] = Array.isArray(res) ? res : (res?.consignments || res?.items || [])
      if (Array.isArray(list)) return list as Consignment[]
    } catch (e: any) {
      // 400/415 = wrong shape, try the next one. Anything else (401, 5xx) is a
      // real failure and there's no point retrying it two more times.
      const st = e instanceof MachShipApiError ? e.status : 0
      if (st !== 400 && st !== 415 && st !== 422) {
        console.error(`[machship] ${path} lookup failed (${st}):`, e?.message || e)
        return []
      }
    }
  }
  console.error(`[machship] ${path}: no accepted request shape — lookup skipped`)
  return []
}

/** Find consignments by the CARRIER's tracking number (e.g. TNT "EYA000002055"). */
export async function findConsignmentsByCarrierConsignmentId(ids: string[]): Promise<Consignment[]> {
  return lookupConsignments('/apiv2/consignments/returnConsignmentsByCarrierConsignmentId', 'carrierConsignmentIds', ids)
}

/** Find consignments by Reference 1 — we send "<order number> / <customer PO>". */
export async function findConsignmentsByReference1(refs: string[]): Promise<Consignment[]> {
  return lookupConsignments('/apiv2/consignments/returnConsignmentsByReference1', 'references', refs)
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
