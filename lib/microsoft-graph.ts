// lib/microsoft-graph.ts
// Microsoft Graph API helpers for Pipeline A's mailbox webhook + AP inbox pull.
//
// Auth: OAuth client credentials flow (app-only). The Azure App Registration
// is granted Mail.Read (read mailboxes) and Mail.ReadWrite (mark-as-read,
// move). Token cached ~30 min in-process.
//
// **401/403 token-bust retry:** If a Graph call returns 401 (Unauthorized)
// or 403 (Forbidden) and we're holding a cached token, the helper assumes
// the token was issued *before* a permission was granted/changed and tries
// once more with a freshly-acquired token. This makes the system
// self-healing after Azure permission grants — no redeploy or wait for
// natural token expiry needed. Persistent 403s (real permission missing)
// still bubble up as errors.

import { createClient } from '@supabase/supabase-js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
// Shorter-than-stock token TTL: 30 mins. Vercel functions can stay warm
// across ~hours, and Azure permission grants typically take effect almost
// immediately — a 30-min ceiling means worst-case staleness is half an
// hour. The 401/403 retry below covers everything inside that window.
const TOKEN_LIFETIME_MS = 30 * 60 * 1000

// ── Token cache ────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null

/**
 * Force the next getAppToken() call to fetch a brand-new token from Azure.
 * Used by the 401/403 retry path in graphFetch when a cached token appears
 * to be missing newly-granted scopes.
 */
function invalidateAppToken(): void {
  cachedToken = null
}

async function getAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value
  }

  const tenantId = process.env.GRAPH_TENANT_ID
  const clientId = process.env.GRAPH_CLIENT_ID
  const clientSecret = process.env.GRAPH_CLIENT_SECRET
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET must be set')
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  })

  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Graph token acquire failed ${r.status}: ${errText.substring(0, 300)}`)
  }

  const data = await r.json() as { access_token: string; expires_in?: number }
  if (!data.access_token) {
    throw new Error('Graph token response missing access_token')
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + TOKEN_LIFETIME_MS,
  }
  return data.access_token
}

// ── Generic Graph request ──────────────────────────────────────────────

/**
 * Low-level Graph fetch with built-in 401/403 retry.
 *
 * If the first call returns 401 or 403 AND we used a cached (non-fresh)
 * token, we discard the cache, get a fresh token, and retry once. If the
 * fresh-token call also fails, the original failure is the real one (real
 * permission gap, expired secret, etc.) and we return it.
 */
async function graphFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`

  const tokenWasCachedBefore = !!cachedToken
  const token = await getAppToken()

  const r1 = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })

  // Only retry if the failing token was a reused cache hit. A 401/403 from
  // a freshly-fetched token is the real answer.
  if ((r1.status === 401 || r1.status === 403) && tokenWasCachedBefore) {
    invalidateAppToken()
    const freshToken = await getAppToken()
    return fetch(url, {
      ...opts,
      headers: {
        Authorization: `Bearer ${freshToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    })
  }

  return r1
}

async function graphJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await graphFetch(path, opts)
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Graph API ${r.status} on ${path}: ${errText.substring(0, 500)}`)
  }
  return r.json()
}

// ── Message + attachment fetching ──────────────────────────────────────

export interface GraphMessageMeta {
  id: string
  subject: string | null
  from: string | null              // The sender's email address
  receivedDateTime: string         // ISO
  hasAttachments: boolean
  parentFolderId: string | null
}

export interface GraphAttachmentMeta {
  id: string
  name: string                     // The filename
  contentType: string
  size: number                     // bytes
}

/**
 * Fetch message metadata by ID. Used by the webhook to check whether a
 * notification's message is even worth processing (has attachments).
 */
export async function getMessageMeta(mailbox: string, messageId: string): Promise<GraphMessageMeta> {
  const data = await graphJson<any>(
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}?$select=id,subject,from,receivedDateTime,hasAttachments,parentFolderId`,
  )
  return {
    id: data.id,
    subject: data.subject || null,
    from: data.from?.emailAddress?.address || null,
    receivedDateTime: data.receivedDateTime,
    hasAttachments: !!data.hasAttachments,
    parentFolderId: data.parentFolderId || null,
  }
}

/**
 * List attachment metadata for a message.
 */
export async function listAttachmentMeta(mailbox: string, messageId: string): Promise<GraphAttachmentMeta[]> {
  const data = await graphJson<{ value: any[] }>(
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments?$select=id,name,contentType,size`,
  )
  return (data.value || []).map(a => ({
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
  }))
}

/**
 * Download a single attachment as base64.
 */
export async function getAttachmentBase64(
  mailbox: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const data = await graphJson<any>(
    `/users/${encodeURIComponent(mailbox)}/messages/${messageId}/attachments/${attachmentId}`,
  )
  if (data['@odata.type'] !== '#microsoft.graph.fileAttachment') {
    throw new Error(`Attachment ${attachmentId} is not a fileAttachment (${data['@odata.type']}) — cannot download as bytes`)
  }
  if (typeof data.contentBytes !== 'string') {
    throw new Error(`Attachment ${attachmentId} has no contentBytes — Graph response shape unexpected`)
  }
  return data.contentBytes as string
}

// ── Bulk message listing ────────────────────────────────────────────────

export interface GraphMessageSummary {
  id: string
  subject: string | null
  from: string | null
  receivedDateTime: string
  hasAttachments: boolean
}

/**
 * List recent messages from a mailbox's Inbox folder.
 *
 * **hasAttachments is filtered client-side, not server-side.** Combining
 * `hasAttachments eq true` with `receivedDateTime ge X` and `$orderby
 * receivedDateTime desc` triggers Graph's "InefficientFilter" error.
 * Filter on a single indexed property + sort on the same property is the
 * canonical pattern that reliably works.
 */
export async function listMessagesWithAttachments(
  mailbox: string,
  opts: { sinceIsoDate?: string; top?: number } = {},
): Promise<GraphMessageSummary[]> {
  const wanted = Math.min(Math.max(opts.top || 50, 1), 100)
  const fetchTop = Math.min(wanted * 2, 200)

  const queryParams: Record<string, string> = {
    '$select':  'id,subject,from,receivedDateTime,hasAttachments',
    '$orderby': 'receivedDateTime desc',
    '$top':     String(fetchTop),
  }
  if (opts.sinceIsoDate) {
    queryParams['$filter'] = `receivedDateTime ge ${opts.sinceIsoDate}`
  }
  const params = new URLSearchParams(queryParams)
  const path = `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?${params.toString()}`

  const data = await graphJson<{ value: any[] }>(path)
  const all = (data.value || []).map(m => ({
    id: m.id,
    subject: m.subject || null,
    from: m.from?.emailAddress?.address || null,
    receivedDateTime: m.receivedDateTime,
    hasAttachments: !!m.hasAttachments,
  }))

  return all.filter(m => m.hasAttachments).slice(0, wanted)
}

// ── Mailbox write operations ────────────────────────────────────────────

/**
 * Mark a message as read. Requires Mail.ReadWrite app permission.
 */
export async function markMessageAsRead(mailbox: string, messageId: string): Promise<void> {
  const r = await graphFetch(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true }),
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Graph mark-as-read ${r.status}: ${errText.substring(0, 300)}`)
  }
}

/**
 * Find a mail folder by display name. Searches Inbox children first (the
 * most common location for user-created subfolders like "Read /Printed"),
 * then falls back to top-level folders.
 */
export async function findFolderByDisplayName(
  mailbox: string,
  displayName: string,
): Promise<string | null> {
  const escaped = displayName.replace(/'/g, "''")
  const filter = `displayName eq '${escaped}'`
  const select = 'id,displayName'

  try {
    const params1 = new URLSearchParams({ '$filter': filter, '$select': select, '$top': '5' })
    const data1 = await graphJson<{ value: any[] }>(
      `/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/childFolders?${params1.toString()}`,
    )
    const m1 = (data1.value || [])[0]
    if (m1?.id) return m1.id as string
  } catch {
    // ignore — fall through to top-level search
  }

  try {
    const params2 = new URLSearchParams({ '$filter': filter, '$select': select, '$top': '5' })
    const data2 = await graphJson<{ value: any[] }>(
      `/users/${encodeURIComponent(mailbox)}/mailFolders?${params2.toString()}`,
    )
    const m2 = (data2.value || [])[0]
    if (m2?.id) return m2.id as string
  } catch {
    // ignore
  }

  return null
}

/**
 * Move a message to a folder. Requires Mail.ReadWrite. The Graph response
 * returns the message at its new location with a new ID — the original
 * message ID is no longer valid afterwards, so do all read-side work first
 * and call move LAST.
 */
export async function moveMessageToFolder(
  mailbox: string,
  messageId: string,
  destinationFolderId: string,
): Promise<void> {
  const r = await graphFetch(`/users/${encodeURIComponent(mailbox)}/messages/${messageId}/move`, {
    method: 'POST',
    body: JSON.stringify({ destinationId: destinationFolderId }),
  })
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Graph move-to-folder ${r.status}: ${errText.substring(0, 300)}`)
  }
}

// ── Subscription management ────────────────────────────────────────────

export interface GraphSubscription {
  id: string
  resource: string
  changeType: string
  notificationUrl: string
  expirationDateTime: string
  clientState: string
}

export async function createSubscription(input: {
  resource: string
  notificationUrl: string
  clientState: string
  changeType?: string
  expirationMinutes?: number
}): Promise<GraphSubscription> {
  const expirationMins = input.expirationMinutes ?? 4200
  const expirationDateTime = new Date(Date.now() + expirationMins * 60 * 1000).toISOString()

  const payload = {
    changeType: input.changeType || 'created',
    notificationUrl: input.notificationUrl,
    resource: input.resource,
    expirationDateTime,
    clientState: input.clientState,
  }

  const data = await graphJson<any>(`/subscriptions`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  return {
    id: data.id,
    resource: data.resource,
    changeType: data.changeType,
    notificationUrl: data.notificationUrl,
    expirationDateTime: data.expirationDateTime,
    clientState: data.clientState,
  }
}

export async function renewSubscription(
  subscriptionId: string,
  expirationMinutes: number = 4200,
): Promise<GraphSubscription> {
  const expirationDateTime = new Date(Date.now() + expirationMinutes * 60 * 1000).toISOString()

  const data = await graphJson<any>(`/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ expirationDateTime }),
  })

  return {
    id: data.id,
    resource: data.resource,
    changeType: data.changeType,
    notificationUrl: data.notificationUrl,
    expirationDateTime: data.expirationDateTime,
    clientState: data.clientState,
  }
}

export async function listSubscriptions(): Promise<GraphSubscription[]> {
  const data = await graphJson<{ value: any[] }>(`/subscriptions`)
  return (data.value || []).map(s => ({
    id: s.id,
    resource: s.resource,
    changeType: s.changeType,
    notificationUrl: s.notificationUrl,
    expirationDateTime: s.expirationDateTime,
    clientState: s.clientState,
  }))
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
  const r = await graphFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) {
    const errText = await r.text()
    throw new Error(`Graph DELETE subscription ${subscriptionId} failed ${r.status}: ${errText.substring(0, 300)}`)
  }
}

export function generateClientState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Supabase helpers for graph_subscriptions table ─────────────────────

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export interface StoredSubscription {
  id: string
  mailbox: string
  resource: string
  subscription_id: string
  expiration_date_time: string
  client_state: string
  notification_url: string
  change_type: string
  status: 'active' | 'expired' | 'failed' | 'deleted'
  created_at: string
  last_renewed_at: string | null
  last_renewal_attempt_at: string | null
  last_renewal_error: string | null
}

export async function listActiveSubscriptions(): Promise<StoredSubscription[]> {
  const sb = supa()
  const { data, error } = await sb
    .from('graph_subscriptions')
    .select('*')
    .eq('status', 'active')
    .order('expiration_date_time', { ascending: true })

  if (error) throw new Error(`graph_subscriptions select failed: ${error.message}`)
  return (data || []) as StoredSubscription[]
}

export async function findSubscriptionByGraphId(graphSubscriptionId: string): Promise<StoredSubscription | null> {
  const sb = supa()
  const { data, error } = await sb
    .from('graph_subscriptions')
    .select('*')
    .eq('subscription_id', graphSubscriptionId)
    .maybeSingle()

  if (error) throw new Error(`graph_subscriptions lookup failed: ${error.message}`)
  return (data as StoredSubscription) || null
}

export async function insertSubscriptionRow(input: {
  mailbox: string
  resource: string
  subscription: GraphSubscription
}): Promise<StoredSubscription> {
  const sb = supa()
  const { data, error } = await sb
    .from('graph_subscriptions')
    .insert({
      mailbox: input.mailbox,
      resource: input.resource,
      subscription_id: input.subscription.id,
      expiration_date_time: input.subscription.expirationDateTime,
      client_state: input.subscription.clientState,
      notification_url: input.subscription.notificationUrl,
      change_type: input.subscription.changeType,
      status: 'active',
    })
    .select()
    .single()

  if (error) throw new Error(`graph_subscriptions insert failed: ${error.message}`)
  return data as StoredSubscription
}

export async function updateSubscriptionRowAfterRenewal(
  rowId: string,
  newExpirationDateTime: string,
): Promise<void> {
  const sb = supa()
  const { error } = await sb
    .from('graph_subscriptions')
    .update({
      expiration_date_time: newExpirationDateTime,
      last_renewed_at: new Date().toISOString(),
      last_renewal_attempt_at: new Date().toISOString(),
      last_renewal_error: null,
    })
    .eq('id', rowId)

  if (error) throw new Error(`graph_subscriptions update failed: ${error.message}`)
}

export async function markSubscriptionRenewalFailure(
  rowId: string,
  errorMessage: string,
  newStatus?: 'active' | 'expired' | 'failed',
): Promise<void> {
  const sb = supa()
  const { error } = await sb
    .from('graph_subscriptions')
    .update({
      last_renewal_attempt_at: new Date().toISOString(),
      last_renewal_error: errorMessage,
      ...(newStatus ? { status: newStatus } : {}),
    })
    .eq('id', rowId)

  if (error) throw new Error(`graph_subscriptions update failed: ${error.message}`)
}

export async function markSubscriptionDeleted(rowId: string): Promise<void> {
  const sb = supa()
  const { error } = await sb
    .from('graph_subscriptions')
    .update({ status: 'deleted' })
    .eq('id', rowId)

  if (error) throw new Error(`graph_subscriptions update failed: ${error.message}`)
}
