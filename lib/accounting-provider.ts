// lib/accounting-provider.ts
//
// THE SWITCH for the MYOB → Xero migration (Chris 2026-08-05).
//
// Every accounting-touching module asks this resolver which provider to use
// for a given entity, instead of assuming MYOB. Settings live in
// integration_settings (DB-first, env fallback — same resolver as every
// other integration):
//
//   ACCOUNTING_PROVIDER_VPS  = myob | xero      (entity-wide)
//   ACCOUNTING_PROVIDER_JAWS = myob | xero
//   ACCOUNTING_PROVIDER_VPS_AP = xero           (optional per-module override,
//                                                wins over the entity value —
//                                                lets us cut modules over one
//                                                at a time)
//
// Defaults to 'myob' everywhere, so shipping this changes nothing until the
// keys are set. After cutover MYOB stays connected READ-ONLY for history.
//
// Module keys (used in the per-module override): AP, STATEMENTS, LETTERS,
// WORKSHOP, INVENTORY, B2B, REPORTING, STRIPE, BANK.

import { getIntegration } from './integration-config'

export type AccountingEntity = 'VPS' | 'JAWS'
export type AccountingProviderName = 'myob' | 'xero'

export async function accountingProvider(
  entity: AccountingEntity,
  module?: string,
): Promise<AccountingProviderName> {
  if (module) {
    const specific = (await getIntegration(`ACCOUNTING_PROVIDER_${entity}_${module.toUpperCase()}`)).toLowerCase()
    if (specific === 'xero' || specific === 'myob') return specific
  }
  const entityWide = (await getIntegration(`ACCOUNTING_PROVIDER_${entity}`)).toLowerCase()
  return entityWide === 'xero' ? 'xero' : 'myob'
}
