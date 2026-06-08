// pages/api/projects/index.ts
// Lists every person's "Projects"-group items across the six Monday To-Do
// boards, for the /projects graph. Live read from Monday, cached 5 min in
// memory (?refresh=true bypasses). Mirrors the caching shape of /api/todos.

import type { NextApiResponse, NextApiRequest } from 'next'
import { withAuth, PortalUser } from '../../../lib/authServer'
import { fetchAllProjects, PersonProjects } from '../../../lib/monday-projects'

export const config = { maxDuration: 30 }

interface CacheEntry { data: any; timestamp: number }
const CACHE_TTL = 5 * 60 * 1000
let cache: CacheEntry | null = null

// Exported so POST /api/projects/[itemId]/updates can bust it after a comment
// is posted (hasUpdates may flip from false → true).
export function invalidateProjectsCache() { cache = null }

export default withAuth('view:projects', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  if (!process.env.MONDAY_API_TOKEN) {
    return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
  }

  const forceRefresh = req.query.refresh === 'true'
  if (!forceRefresh && cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return res.status(200).json(cache.data)
  }

  try {
    const people: PersonProjects[] = await fetchAllProjects()
    const result = { fetchedAt: new Date().toISOString(), people }
    cache = { data: result, timestamp: Date.now() }
    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to load projects from Monday' })
  }
})
