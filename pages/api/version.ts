// pages/api/version.ts
// Returns the CURRENTLY DEPLOYED build id. The client bundle was built with its
// own NEXT_PUBLIC_BUILD_ID baked in; when this runtime value differs, a newer
// version has shipped and the UpdateNotifier prompts a reload.
//
// Public + uncached (no auth) so every open tab — staff, B2B, supplier — can poll.

import type { NextApiRequest, NextApiResponse } from 'next'

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.NEXT_PUBLIC_BUILD_ID ||
    'dev'
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.status(200).json({ version })
}
