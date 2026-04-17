// pages/api/distributors.ts — NO-IMPORT DIAGNOSTIC
// Zero dependencies on lib/*. If this still 500s, the route itself isn't building.
// If this returns 200 JSON, we know the lib imports are the problem.

import type { NextApiRequest, NextApiResponse } from 'next'

export const config = { maxDuration: 10 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    return res.status(200).json({
      ok: true,
      build: 'no-import-diagnostic-v2',
      time: new Date().toISOString(),
      query: req.query,
      env: {
        hasCdataUser: !!process.env.CDATA_USERNAME,
        hasCdataPat: !!process.env.CDATA_PAT,
        nodeVersion: process.version,
      },
    })
  } catch (e: any) {
    return res.status(500).json({
      error: 'Top-level crash',
      message: e?.message || String(e),
    })
  }
}
