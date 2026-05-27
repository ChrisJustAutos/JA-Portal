// pages/api/calls/live/index.ts
// GET — list calls currently in progress (for the live monitoring board).
// Proxies the FreePBX-side service (see lib/pbx-live.ts). Gated to monitor:calls.
// Returns { configured:false, calls:[] } when the PBX service env isn't set,
// so the UI can show a setup hint instead of an error.

import { withAuth } from '../../../../lib/authServer'
import { isPbxLiveConfigured, listLiveChannels } from '../../../../lib/pbx-live'

export const config = { maxDuration: 15 }

export default withAuth('monitor:calls', async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (!isPbxLiveConfigured()) {
    return res.status(200).json({ configured: false, calls: [] })
  }
  try {
    const calls = await listLiveChannels()
    return res.status(200).json({ configured: true, calls })
  } catch (e: any) {
    return res.status(502).json({ configured: true, calls: [], error: e?.message || 'PBX unreachable' })
  }
})
