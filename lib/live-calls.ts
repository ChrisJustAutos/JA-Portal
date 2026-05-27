// lib/live-calls.ts
//
// Shared types + helpers for live call monitoring.
//
// Transport (decided 2026-05-27, Option B — Supabase as the bus):
//   • Snapshot: the on-PBX agent (ja-ami-monitor.service) writes the active
//     channel list straight into live_call_snapshot (id='freepbx-1') with the
//     service-role key. The portal reads it via the gated /api/calls/live
//     route (service role, monitor:calls) — it does NOT subscribe in the
//     browser, so live caller PII stays behind the permission gate.
//   • ChanSpy: the portal enqueues a request into call_monitor_events
//     (/api/calls/live/spy). The agent SUBSCRIBES to that table via Realtime
//     (service role), claims the row, runs ChanSpy, and writes the outcome
//     back. Nothing is exposed inbound on the PBX.

// ── Snapshot shape ───────────────────────────────────────────────────────
// One entry per Asterisk channel. A bridged call appears as two entries that
// reference each other via peer_uniqueid / peer_channel; groupCalls() collapses
// each pair into a single card.
export interface LiveChannel {
  uniqueid: string                 // Asterisk Uniqueid — stable across transfers
  channel: string                  // e.g. "PJSIP/203-000015eb"
  state: 'ringing' | 'up' | 'dialing' | 'busy' | 'down' | 'unknown'
  caller_id_num: string | null
  caller_id_name: string | null
  connected_num: string | null     // the other party once bridged
  connected_name: string | null
  extension: string | null         // dialled exten in dialplan
  context: string | null           // dialplan context
  peer_channel: string | null      // the bridged peer's channel name
  peer_uniqueid: string | null
  direction: 'in' | 'out' | null   // best-effort from dialplan context
  started_at: string               // ISO timestamp
  bridged_at: string | null        // ISO timestamp once the legs are bridged
}

// ── Derived, de-duplicated "one card per call" view for the board ──────────
export interface LiveCallCard {
  key: string                      // uniqueid of the leg we spy on (stable React key)
  spyTargetChannel: string         // the agent-leg channel ChanSpy attaches to
  spyTargetUniqueid: string
  agentExt: string | null          // extension digits parsed from the agent leg, e.g. "203"
  externalNumber: string | null    // the other party (customer / outside line)
  externalName: string | null
  direction: 'in' | 'out' | null
  state: LiveChannel['state']
  startedAt: string
  bridgedAt: string | null
  monitorable: boolean             // true only once state==='up' && bridged_at != null
}

export type SpyMode = 'listen' | 'whisper' | 'barge'
export const SPY_MODES: SpyMode[] = ['listen', 'whisper', 'barge']

// Single-row snapshot key — the only PBX today.
export const SNAPSHOT_ID = 'freepbx-1'

// The agent flushes the snapshot every ~2s; if we haven't seen an update in
// this window the board shows "monitor agent offline?".
export const SNAPSHOT_STALE_MS = 20_000

// Connections-tab health thresholds against live_call_snapshot.updated_at
// (we can't reach the agent's /healthz from Vercel — Tailscale — so freshness
// of the snapshot it writes is the liveness signal). Yellow > 60s, red > 5min.
export const MONITOR_HEALTH_WARN_MS = 60_000
export const MONITOR_HEALTH_DOWN_MS = 300_000

// Pending spy requests older than this are swept to 'expired' so a phone
// doesn't ring for a request the manager has forgotten about.
export const REQUEST_TTL_MS = 60_000

// Service-token scope the on-PBX agent's token carries (legacy HTTP fallback
// routes under /api/calls/live/agent/* — superseded by direct Supabase access).
export const MONITOR_SCOPE = 'calls:monitor'

// ── Channel helpers ────────────────────────────────────────────────────────
// A local extension leg looks like "PJSIP/203-000015eb"; capture the ext.
const EXT_CHANNEL_RE = /^PJSIP\/(\d{1,6})-/i

export function extOfChannel(channel: string | null | undefined): string | null {
  if (!channel) return null
  const m = EXT_CHANNEL_RE.exec(channel)
  return m ? m[1] : null
}

export function isExtensionChannel(c: LiveChannel): boolean {
  return extOfChannel(c.channel) != null
}

// Buttons are only meaningful once both legs are bridged and talking.
export function isMonitorable(state: LiveChannel['state'], bridgedAt: string | null): boolean {
  return state === 'up' && !!bridgedAt
}

// PBX-side name fields are often junk for display ("<unknown>", "CID:074…").
function cleanName(name: string | null | undefined): string | null {
  const n = (name || '').trim()
  if (!n) return null
  if (/^<.*>$/.test(n)) return null   // "<unknown>"
  if (/^CID:/i.test(n)) return null   // "CID:0754760066"
  if (/^unknown$/i.test(n)) return null
  return n
}

// Do two channels belong to the same call? The agent doesn't always populate
// peer_uniqueid (observed null on live data), so when it's absent we pair the
// legs by their mirrored numbers: leg A's caller is leg B's connected, and
// vice-versa.
function sameCall(a: LiveChannel, b: LiveChannel): boolean {
  if (a.uniqueid === b.uniqueid) return false
  return !!a.caller_id_num && !!a.connected_num &&
    a.caller_id_num === b.connected_num &&
    a.connected_num === b.caller_id_num
}

// Collapse the raw channel list into one card per logical call. We spy the
// agent's extension leg (so Whisper reaches the agent); the external party is
// read from that leg's connected line (the customer it's bridged to).
//
// Verified against a live bridged snapshot 2026-05-27: peer_uniqueid was null,
// so pairing falls back to mirrored caller/connected ids. If the agent starts
// emitting peer_uniqueid, that path is preferred automatically.
export function groupCalls(channels: LiveChannel[] | null | undefined): LiveCallCard[] {
  const list = Array.isArray(channels) ? channels.filter(c => c && c.uniqueid && c.channel) : []
  const seen = new Set<string>()
  const cards: LiveCallCard[] = []

  for (const ch of list) {
    if (seen.has(ch.uniqueid)) continue
    // Prefer an explicit peer link; otherwise pair by mirrored caller/connected.
    let peer = ch.peer_uniqueid ? list.find(c => c.uniqueid === ch.peer_uniqueid) : undefined
    if (!peer) peer = list.find(c => !seen.has(c.uniqueid) && sameCall(ch, c))
    seen.add(ch.uniqueid)
    if (peer) seen.add(peer.uniqueid)

    const legs = peer ? [ch, peer] : [ch]
    // Prefer the internal PJSIP/<ext> leg as the spy target; fall back to the
    // first leg if neither (or both) is internal.
    const internal = legs.find(isExtensionChannel) ?? legs[0]
    const other = legs.find(l => l.uniqueid !== internal.uniqueid)

    const externalNumber =
      internal.connected_num || other?.caller_id_num || internal.caller_id_num || null
    const externalName =
      cleanName(internal.connected_name) || cleanName(other?.caller_id_name) || cleanName(internal.caller_id_name)
    const bridgedAt = internal.bridged_at || other?.bridged_at || null
    const startedAt =
      [internal.started_at, other?.started_at].filter(Boolean).sort()[0] || internal.started_at

    cards.push({
      key: internal.uniqueid,
      spyTargetChannel: internal.channel,
      spyTargetUniqueid: internal.uniqueid,
      agentExt: extOfChannel(internal.channel),
      externalNumber,
      externalName,
      direction: internal.direction ?? other?.direction ?? null,
      state: internal.state,
      startedAt,
      bridgedAt,
      monitorable: isMonitorable(internal.state, bridgedAt),
    })
  }

  // Live/bridged calls first, then longest-running first.
  cards.sort((a, b) => {
    if (a.monitorable !== b.monitorable) return a.monitorable ? -1 : 1
    return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  })
  return cards
}
