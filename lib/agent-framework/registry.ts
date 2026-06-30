// lib/agents/registry.ts
// The set of agents the framework knows about. Add new agents here.

import type { AgentDef } from './types'
import { runComms } from './comms'
import { runAccounts } from './accounts'

export const AGENTS: Record<string, AgentDef> = {
  comms: { id: 'comms', label: 'Communications', run: runComms },
  accounts: { id: 'accounts', label: 'Accounts', run: runAccounts },
  // marketing: … (Phase 3)
  // ops: …       (Phase 4)
}

export function getAgent(id: string): AgentDef | null {
  return AGENTS[id] || null
}
