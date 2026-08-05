// lib/accounting/index.ts
//
// The accounting-adapter factory for the MYOB → Xero migration.
//
//   const acc = await getAccountingAdapter('VPS', 'AP')
//   await acc.createBill({ ... })
//
// Consults accountingProvider() (lib/accounting-provider.ts — THE SWITCH,
// integration_settings-backed, defaults to 'myob') and returns the matching
// AccountingAdapter. Callers never import a concrete adapter directly —
// that's what makes per-module cutover (ACCOUNTING_PROVIDER_VPS_AP=xero)
// a pure settings change.

import type { AccountingAdapter, AccountingEntity } from './types'
import { accountingProvider } from '../accounting-provider'
import { MyobAdapter } from './myob-adapter'

export type { AccountingAdapter, AccountingEntity }
export * from './types'
export { MyobAdapter } from './myob-adapter'

// './xero-adapter' is being authored on a parallel branch. The specifier is
// assembled at runtime so THIS file typechecks and builds while that file is
// still landing — once it exists the import resolves normally. Expected
// export: `export class XeroAdapter implements AccountingAdapter` with a
// `new XeroAdapter(entity)` constructor (default export also accepted).
const XERO_ADAPTER_MODULE = './xero' + '-adapter'

export async function getAccountingAdapter(
  entity: AccountingEntity,
  module?: string,
): Promise<AccountingAdapter> {
  const provider = await accountingProvider(entity, module)

  if (provider === 'xero') {
    let mod: any
    try {
      mod = await import(`${XERO_ADAPTER_MODULE}`)
    } catch (e: any) {
      throw new Error(
        `xero adapter unavailable — ACCOUNTING_PROVIDER says '${entity}${module ? '/' + module : ''}' is on Xero ` +
        `but ./xero-adapter could not be loaded: ${e?.message || e}`,
      )
    }
    const XeroAdapter = mod?.XeroAdapter || mod?.default
    if (typeof XeroAdapter !== 'function') {
      throw new Error('xero adapter unavailable — ./xero-adapter loaded but exports no XeroAdapter class')
    }
    return new XeroAdapter(entity) as AccountingAdapter
  }

  return new MyobAdapter(entity)
}
