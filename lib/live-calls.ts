// lib/live-calls.ts
//
// Shared types + constants for live call monitoring (command-queue model).
//
// The on-PBX agent pushes the active-call list to /api/calls/live/agent/snapshot
// and polls /api/calls/live/agent/requests for spy commands — all over its
// existing outbound X-Service-Token channel, so nothing is exposed on the PBX.

export interface LiveCall {
  linkedid: string
  channel: string                 // the agent-leg Asterisk channel to spy on
  direction: 'inbound' | 'outbound' | null
  external_number: string | null
  caller_name: string | null
  agent_ext: string | null
  agent_name: string | null
  started_at: string | null
  duration_seconds: number | null
  state: string | null
}

export type SpyMode = 'listen' | 'whisper' | 'barge'
export const SPY_MODES: SpyMode[] = ['listen', 'whisper', 'barge']

// Single-row snapshot key.
export const SNAPSHOT_ID = 'pbx'

// If the agent hasn't pushed a snapshot within this window, the board treats
// the live view as stale (agent likely offline).
export const SNAPSHOT_STALE_MS = 20_000

// Pending spy requests older than this are swept to 'expired' by the agent
// poll, so a phone doesn't ring for a request the manager has forgotten about.
export const REQUEST_TTL_MS = 60_000

// Service-token scope the on-PBX agent's token must carry to push snapshots
// and drain the spy queue.
export const MONITOR_SCOPE = 'calls:monitor'
