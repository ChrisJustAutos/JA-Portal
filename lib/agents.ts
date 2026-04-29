// lib/agents.ts
// Mailbox → rep mapping for Pipeline A (email-driven quote ingestion).
//
// Each rep has a Microsoft 365 mailbox that receives Mechanics Desk quote
// PDFs. When a notification arrives via Microsoft Graph webhook (or the
// stub-mode endpoint), we look up the mailbox here to know:
//   - Which rep "owns" this quote (used for AC deal owner via the existing
//     ACTIVECAMPAIGN_OWNER_MAP env var, keyed by rep name).
//   - Which Monday board the rep's leads live on (for Pipeline A's
//     match-and-update flow).
//
// AC owner IDs do NOT live here — they live in the existing
// ACTIVECAMPAIGN_OWNER_MAP env var consumed by lib/activecampaign.ts. We
// just expose the rep's first name; the AC layer maps name → owner ID.
//
// MAILBOXES THAT AREN'T IN THIS MAP get dead-lettered (logged to
// quote_events with action='failed', visible to ops). No fallback owner —
// silently swallowing unknown mailboxes would route quotes into the wrong
// rep's board.
//
// SOURCE OF TRUTH for Monday board IDs is lib/monday-followup.ts > REP_BOARDS.
// We import it here rather than duplicating, so renaming a rep / changing a
// board ID is a one-place edit.

import { REP_BOARDS } from './monday-followup'

export interface Agent {
  // First name as it appears in calls.agent_name and as keyed in
  // ACTIVECAMPAIGN_OWNER_MAP (case-insensitive lookup downstream).
  name: string
  // Monday board ID for this rep's Quote Channel board.
  mondayBoardId: string
}

// ── Mailbox → agent map ────────────────────────────────────────────────
// Keys are lower-cased mailbox addresses. Lookup is case-insensitive
// (we lowercase the input before indexing) so capitalisation differences
// from Microsoft Graph's notifications don't cause misses.
//
// TODO at build time:
//   - Confirm exact mailbox addresses with Chris. The placeholder pattern
//     is `<firstname>@justautosmechanical.com.au` per the design doc, but
//     reality may differ (e.g. shared mailboxes, alternate domains).
export const AGENTS_BY_MAILBOX: Record<string, Agent> = {
  'graham@justautosmechanical.com.au':  { name: 'Graham',  mondayBoardId: REP_BOARDS.graham.boardId },
  'kaleb@justautosmechanical.com.au':   { name: 'Kaleb',   mondayBoardId: REP_BOARDS.kaleb.boardId },
  'dom@justautosmechanical.com.au':     { name: 'Dom',     mondayBoardId: REP_BOARDS.dom.boardId },
  'james@justautosmechanical.com.au':   { name: 'James',   mondayBoardId: REP_BOARDS.james.boardId },
  'tyronne@justautosmechanical.com.au': { name: 'Tyronne', mondayBoardId: REP_BOARDS.tyronne.boardId },
}

/**
 * Resolve a mailbox address to a rep. Case-insensitive.
 *
 * @param mailbox  Email address, e.g. 'Kaleb@justautosmechanical.com.au'
 * @returns        Agent or null if not in the map.
 */
export function getAgentByMailbox(mailbox: string | null | undefined): Agent | null {
  if (!mailbox) return null
  const key = mailbox.trim().toLowerCase()
  return AGENTS_BY_MAILBOX[key] || null
}

/**
 * For ops/debug: list all configured mailboxes. Used in error messages
 * when a webhook arrives from an unknown mailbox.
 */
export function listConfiguredMailboxes(): string[] {
  return Object.keys(AGENTS_BY_MAILBOX)
}
