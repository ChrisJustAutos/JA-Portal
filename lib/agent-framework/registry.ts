// lib/agents/registry.ts
// The set of agents the framework knows about. Add new agents here.

import type { AgentDef } from './types'
import { runComms } from './comms'

export const AGENTS: Record<string, AgentDef> = {
  comms: { id: 'comms', label: 'Communications', run: runComms },
  // accounts: …  (Phase 2)
  // marketing: … (Phase 3)
  // ops: …       (Phase 4)
}

export function getAgent(id: string): AgentDef | null {
  return AGENTS[id] || null
}
