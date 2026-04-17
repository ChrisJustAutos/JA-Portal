// pages/api/distributors.ts — DIAGNOSTIC BUILD
// Returns JSON no matter what. If you still see Vercel's HTML 500 page after
// deploying this, the deploy didn't happen.

import type { NextApiRequest, NextApiResponse } from 'next'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // BUILD MARKER — if this string shows up in the response, the new code deployed
  const BUILD = 'distributors-diagnostic-v1'

  try {
    // Try importing each lib one at a time and report which one fails
    const probes: Record<string, any> = { build: BUILD, query: req.query }

    try {
      const authMod = await import('../../lib/auth')
      probes.auth = {
        ok: true,
        exports: Object.keys(authMod),
        requireAuthType: typeof (authMod as any).requireAuth,
      }
    } catch (e: any) {
      probes.auth = { ok: false, error: e?.message || String(e) }
    }

    try {
      const cdataMod = await import('../../lib/cdata')
      probes.cdata = {
        ok: true,
        exports: Object.keys(cdataMod),
        cdataQueryType: typeof (cdataMod as any).cdataQuery,
        parseDateRangeType: typeof (cdataMod as any).parseDateRange,
      }
    } catch (e: any) {
      probes.cdata = { ok: false, error: e?.message || String(e) }
    }

    // Try a trivial MYOB query if cdata loaded
    if (probes.cdata?.ok && probes.cdata?.cdataQueryType === 'function') {
      try {
        const { cdataQuery } = await import('../../lib/cdata')
        const r: any = await cdataQuery(
          'JAWS',
          "SELECT TOP 1 [Number] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]"
        )
        probes.testQuery = {
          ok: true,
          resultType: typeof r,
          hasResults: !!r?.results,
          rowCount: r?.results?.[0]?.rows?.length ?? 'n/a',
          sample: r?.results?.[0]?.rows?.[0] ?? null,
        }
      } catch (e: any) {
        probes.testQuery = {
          ok: false,
          error: e?.message || String(e),
          stack: e?.stack?.split('\n').slice(0, 4),
        }
      }
    }

    return res.status(200).json(probes)
  } catch (e: any) {
    return res.status(500).json({
      error: 'Top-level crash',
      build: BUILD,
      message: e?.message || String(e),
      stack: e?.stack?.split('\n').slice(0, 6),
    })
  }
}
