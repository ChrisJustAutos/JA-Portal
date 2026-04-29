// lib/microsoft-graph.ts
// Microsoft Graph API helpers for Pipeline A's mailbox webhook.
//
// Auth: OAuth client credentials flow (app-only). No user signin — the
// Azure App Registration is granted Mail.Read application permission.
//
// We watch each rep's Inbox for new messages. When a Mechanics Desk quote
// email arrives in someone's Inbox, Graph POSTs a notification to our
// webhook (lib/../pages/api/webhooks/graph-mail.ts), which then uses
// these helpers to fetch the message + attachments by ID.
//
// Subscription lifecycle:
//   - Outlook message subscriptions max out at 4230 mins (~70.5 hrs).
//   - We renew via PATCH before expiry.
//   - Renewal cron runs frequently to catch expirations.
//
// Token caching: in-memory, lasts ~50 mins (Graph tokens are 60-min by
// default; we refresh at 50 to be safe). Module-scoped cache; Vercel
// serverless functions reuse warm instances so this is generally fine.
// On a cold start we acquire a fresh token, ~150ms.

import { createClient } from '@supabase/supabase-js'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const TOKEN_LIFETIME_MS = 50 * 60 * 1000   // refresh at 50 mins (token expires at 60)

// ── Token cache ────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null

async function getAppToken(): Promise<string> {
  // Reuse cached token if still valid
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

async function graphFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await getAppToken()
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`
  return fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
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
 * List attachment metadata for a message. Returns name + contentType so
 * the caller can decide which attachments to actually download.
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
 * Download a single attachment as base64. Graph returns the contentBytes
 * field already base64-encoded for FileAttachment types — perfect, no
 * re-encoding needed.
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

// ── Subscription management ────────────────────────────────────────────

export interface GraphSubscription {
  id: string
  resource: string
  changeType: string
  notificationUrl: string
  expirationDateTime: string       // ISO
  clientState: string
}

/**
 * Create a Graph subscription. For mailbox-level Inbox watching, resource
 * should be `users/{mailbox}/mailFolders('Inbox')/messages`.
 *
 * Note: Outlook message subscriptions max ~4230 mins from now. We default
 * to 4200 mins (just shy of the cap) to give plenty of headroom on the
 * server side.
 */
export async function createSubscription(input: {
  resource: string
  notificationUrl: string
  clientState: string
  changeType?: string              // default 'created'
  expirationMinutes?: number       // default 4200 (just under 70-hr cap)
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

/**
 * Renew (extend) an existing subscription. Pushes the expiration forward.
 */
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

/**
 * List all subscriptions owned by this app. Useful for diagnosing duplicates
 * and dead subscriptions.
 */
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

/**
 * Delete a subscription. Used during cleanup or when re-subscribing.
 */
export async function deleteSubscription(subscriptionId: string): Promise<void> {
  const r = await graphFetch(`/subscriptions/${subscriptionId}`, { method: 'DELETE' })
  if (!r.ok && r.status !== 404) {
    const errText = await r.text()
    throw new Error(`Graph DELETE subscription ${subscriptionId} failed ${r.status}: ${errText.substring(0, 300)}`)
  }
}

// ── Helper: random hex string for clientState ──────────────────────────
//
// clientState is a random secret echoed back by Graph in every notification.
// Used for verifying notifications are genuine. Generated when subscribing
// and stored in graph_subscriptions table for later comparison.

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
  id: string                       // Our row UUID
  mailbox: string
  resource: string
  subscription_id: string          // Graph's UUID
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
