// lib/distGroups.ts
// Supabase-backed distributor grouping. Cached in-memory for 60s.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (_client) return _client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)')
  _client = createClient(url, key, { auth: { persistSession: false } })
  return _client
}

// Types
export interface Alias {
  myob_name: string
  canonical_name: string
}
export interface Group {
  id: number
  dimension: string
  name: string
  sort_order: number
  color: string | null
}
export interface GroupMember {
  group_id: number
  canonical_name: string
}
export interface GroupingSnapshot {
  aliases: Alias[]
  groups: Group[]
  members: GroupMember[]
  aliasMap: Record<string, string>           // myob_name → canonical_name
  groupsByDimension: Record<string, Group[]> // dimension → groups
  membersByCanonical: Record<string, number[]> // canonical_name → group_ids
  fetchedAt: number
}

let _cache: GroupingSnapshot | null = null
const CACHE_TTL_MS = 60 * 1000

export async function getGrouping(force = false): Promise<GroupingSnapshot> {
  const now = Date.now()
  if (!force && _cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) return _cache

  const sb = getClient()
  const [aliasesRes, groupsRes, membersRes] = await Promise.all([
    sb.from('dist_aliases').select('myob_name, canonical_name'),
    sb.from('dist_groups').select('id, dimension, name, sort_order, color').order('dimension').order('sort_order'),
    sb.from('dist_group_members').select('group_id, canonical_name'),
  ])
  if (aliasesRes.error) throw aliasesRes.error
  if (groupsRes.error) throw groupsRes.error
  if (membersRes.error) throw membersRes.error

  const aliases: Alias[] = aliasesRes.data || []
  const groups: Group[] = groupsRes.data || []
  const members: GroupMember[] = membersRes.data || []

  const aliasMap: Record<string, string> = {}
  aliases.forEach(a => { aliasMap[a.myob_name] = a.canonical_name })

  const groupsByDimension: Record<string, Group[]> = {}
  groups.forEach(g => {
    if (!groupsByDimension[g.dimension]) groupsByDimension[g.dimension] = []
    groupsByDimension[g.dimension].push(g)
  })

  const membersByCanonical: Record<string, number[]> = {}
  members.forEach(m => {
    if (!membersByCanonical[m.canonical_name]) membersByCanonical[m.canonical_name] = []
    membersByCanonical[m.canonical_name].push(m.group_id)
  })

  _cache = { aliases, groups, members, aliasMap, groupsByDimension, membersByCanonical, fetchedAt: now }
  return _cache
}

export function invalidateGroupingCache() { _cache = null }

// Convenience: resolve a MYOB raw name to canonical.
// Falls back to raw name (with trim) if no alias configured.
export function resolveCanonical(myobName: string, snapshot: GroupingSnapshot): string {
  if (!myobName) return ''
  if (snapshot.aliasMap[myobName]) return snapshot.aliasMap[myobName]
  return myobName.trim()
}

// Convenience: given a canonical name, return true if it belongs to a group by name within a dimension.
export function isInGroup(canonicalName: string, dimension: string, groupName: string, snapshot: GroupingSnapshot): boolean {
  const groupIds = snapshot.membersByCanonical[canonicalName] || []
  const group = (snapshot.groupsByDimension[dimension] || []).find(g => g.name === groupName)
  if (!group) return false
  return groupIds.includes(group.id)
}

// Convenience: which group (by name) does this canonical belong to within a dimension?
// Returns the group name or null if none.
export function groupNameFor(canonicalName: string, dimension: string, snapshot: GroupingSnapshot): string | null {
  const groupIds = snapshot.membersByCanonical[canonicalName] || []
  const groupsInDim = snapshot.groupsByDimension[dimension] || []
  for (const g of groupsInDim) {
    if (groupIds.includes(g.id)) return g.name
  }
  return null
}
