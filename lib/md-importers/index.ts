// lib/md-importers/index.ts
// Registry of MD importer modules.

import { ImportType, ImportTypeConfig } from './types'
import { CUSTOMERS_CONFIG } from './customers'
import { JOB_TYPES_CONFIG } from './job-types'
import { VEHICLES_CONFIG } from './vehicles'
import { INVENTORY_CONFIG } from './inventory'
import { QUOTES_CONFIG } from './quotes'
import { INVOICES_CONFIG } from './invoices'

export const IMPORTERS: Record<ImportType, ImportTypeConfig> = {
  customers:  CUSTOMERS_CONFIG,
  job_types:  JOB_TYPES_CONFIG,
  vehicles:   VEHICLES_CONFIG,
  inventory:  INVENTORY_CONFIG,
  quotes:     QUOTES_CONFIG,
  invoices:   INVOICES_CONFIG,
}

export const IMPORTER_TYPES: ImportType[] = ['customers', 'job_types', 'vehicles', 'inventory', 'quotes', 'invoices']

export function getImporter(type: string): ImportTypeConfig | null {
  return (IMPORTERS as any)[type] || null
}

export * from './types'
