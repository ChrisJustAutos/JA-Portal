// lib/monday-projects.ts
// Read helpers for the /projects board (project tracking graph).
//
// Pulls the "Projects" group from each of the six per-person "Hidden To Do"
// boards, with each project's subitems and the people tagged on it (item-level
// people columns + subitem owners, mapped back to one of our six hubs). This is
// the READ side; posting a comment reuses createUpdate() from lib/monday-update.
//
// All GraphQL goes through the shared mondayQuery() (lib/monday-followup.ts) so
// there's ONE client + ONE token (MONDAY_API_TOKEN, full read+write) across the
// codebase. Boards mirror MANAGER_BOARDS in pages/api/todos.ts.

import { mondayQuery } from './monday-followup'

export interface PersonBoard {
  key: string        // stable id (manager first name)
  name: string       // display name
  color: string      // accent (matches MC map in pages/todos.tsx)
  boardId: number
}

export const PERSON_BOARDS: PersonBoard[] = [
  { key: 'Chris',  name: 'Chris',  color: '#4f8ef7', boardId: 1838427899 },
  { key: 'Matt H', name: 'Matt H', color: '#a78bfa', boardId: 2006328423 },
  { key: 'Amanda', name: 'Amanda', color: '#ff5ac4', boardId: 2063839393 },
  { key: 'Morgan', name: 'Morgan', color: '#f5a623', boardId: 2006328760 },
  { key: 'Ryan',   name: 'Ryan',   color: '#2dd4bf', boardId: 1839578010 },
  { key: 'Sam',    name: 'Sam',    color: '#34c77b', boardId: 5024204351 },
]

// First-name → hub key, so a tagged Monday user ("Sam Perry", "Christopher
// Russell") links back to the right person hub. Names not in this map (e.g.
// "Laura Smith") simply don't produce a cross-link.
const NAME_TO_KEY: Record<string, string> = {
  chris: 'Chris', christopher: 'Chris',
  matt: 'Matt H', matthew: 'Matt H',
  amanda: 'Amanda',
  morgan: 'Morgan',
  ryan: 'Ryan',
  sam: 'Sam', samuel: 'Sam',
}
function nameToKey(fullName: string): string | undefined {
  const first = fullName.trim().split(/\s+/)[0]?.toLowerCase()
  return first ? NAME_TO_KEY[first] : undefined
}
function splitNames(text: string | null | undefined): string[] {
  if (!text) return []
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

export interface SubItem {
  id: string
  name: string
  status: string
  owner: string          // display string of owner name(s)
  url: string
  hasUpdates: boolean
}

export interface ProjectItem {
  id: string
  name: string
  status: string
  priority: string | null
  url: string
  createdAt: string
  updatedAt: string
  hasUpdates: boolean
  subitems: SubItem[]
  tagged: string[]       // hub keys of OTHER people tagged on this project
}

export interface PersonProjects {
  key: string
  name: string
  color: string
  boardId: number
  projects: ProjectItem[]
}

export interface ProjectComment {
  id: string
  body: string           // text_body (plain text)
  author: string
  createdAt: string
}

function isProjectsGroup(title: string | null | undefined): boolean {
  return !!title && title.trim().toLowerCase() === 'projects'
}

// Step 1: resolve the "Projects" group id for every board in one round-trip
// (group ids differ per board — Chris's is group_mm3qm3x2, others differ).
async function fetchProjectsGroupMap(): Promise<Record<number, string>> {
  const ids = PERSON_BOARDS.map(b => b.boardId).join(',')
  const data = await mondayQuery<{ boards: Array<{ id: string; groups: Array<{ id: string; title: string }> }> }>(
    `{ boards(ids: [${ids}]) { id groups { id title } } }`,
  )
  const map: Record<number, string> = {}
  for (const b of data?.boards || []) {
    const g = (b.groups || []).find(g => isProjectsGroup(g.title))
    if (g) map[Number(b.id)] = g.id
  }
  return map
}

// Pull the "status"/"Priority"/people values + subitems for one board's
// Projects group. Detects columns by type/title so it works across the boards'
// differing column ids.
async function fetchBoardProjects(board: PersonBoard, groupId: string): Promise<PersonProjects> {
  const query = `{
    boards(ids: [${board.boardId}]) {
      groups(ids: ["${groupId}"]) {
        items_page(limit: 100) {
          items {
            id name url created_at updated_at
            column_values { id text type column { title } }
            updates(limit: 1) { id }
            subitems {
              id name url
              column_values { id text type }
              updates(limit: 1) { id }
            }
          }
        }
      }
    }
  }`
  const data = await mondayQuery<{ boards: Array<{ groups: Array<{ items_page: { items: any[] } }> }> }>(query)
  const items: any[] = data?.boards?.[0]?.groups?.[0]?.items_page?.items || []

  const projects: ProjectItem[] = items.map((it: any) => {
    const cvs: any[] = it.column_values || []
    const statusCv = cvs.find(c => c.column?.title === 'Status')
      || cvs.find(c => c.type === 'status' && c.column?.title !== 'Priority')
    const priorityCv = cvs.find(c => c.column?.title === 'Priority')
    const itemPeople = cvs.filter(c => c.type === 'people').flatMap(c => splitNames(c.text))

    const subitems: SubItem[] = (it.subitems || []).map((s: any) => {
      const scv: any[] = s.column_values || []
      const sStatus = scv.find(c => c.type === 'status')?.text || ''
      const sOwners = scv.filter(c => c.type === 'people').flatMap(c => splitNames(c.text))
      return {
        id: String(s.id),
        name: s.name || '(untitled)',
        status: sStatus,
        owner: sOwners.join(', '),
        url: s.url || '',
        hasUpdates: Array.isArray(s.updates) && s.updates.length > 0,
        // ownerNames kept transiently for tag computation below
        ownerNames: sOwners,
      } as SubItem & { ownerNames: string[] }
    })

    // Tagged = item people + subitem owners, mapped to hubs, minus the owner.
    const taggedKeys = new Set<string>()
    for (const nm of itemPeople) { const k = nameToKey(nm); if (k && k !== board.key) taggedKeys.add(k) }
    for (const s of subitems as any[]) {
      for (const nm of (s.ownerNames || [])) { const k = nameToKey(nm); if (k && k !== board.key) taggedKeys.add(k) }
    }

    return {
      id: String(it.id),
      name: it.name || '(untitled)',
      status: statusCv?.text || '',
      priority: priorityCv?.text || null,
      url: it.url || `https://just-autos.monday.com/boards/${board.boardId}/pulses/${it.id}`,
      createdAt: it.created_at || '',
      updatedAt: it.updated_at || '',
      hasUpdates: Array.isArray(it.updates) && it.updates.length > 0,
      subitems: subitems.map(({ ...s }: any) => { delete s.ownerNames; return s as SubItem }),
      tagged: Array.from(taggedKeys),
    }
  })

  return { key: board.key, name: board.name, color: board.color, boardId: board.boardId, projects }
}

// Fetch all six boards. A board with no Projects group, or that errors, yields
// an empty project list rather than failing the whole response.
export async function fetchAllProjects(): Promise<PersonProjects[]> {
  const groupMap = await fetchProjectsGroupMap()
  const results = await Promise.all(
    PERSON_BOARDS.map(async (b) => {
      const gid = groupMap[b.boardId]
      if (!gid) return { key: b.key, name: b.name, color: b.color, boardId: b.boardId, projects: [] as ProjectItem[] }
      try {
        return await fetchBoardProjects(b, gid)
      } catch (e: any) {
        console.error(`monday-projects: board ${b.boardId} (${b.name}) failed:`, (e?.message || String(e)).slice(0, 300))
        return { key: b.key, name: b.name, color: b.color, boardId: b.boardId, projects: [] as ProjectItem[] }
      }
    }),
  )
  return results
}

// Full comment thread for one item, oldest → newest (chat order).
export async function fetchItemUpdates(itemId: string): Promise<ProjectComment[]> {
  const query = `{
    items(ids: [${JSON.stringify(itemId)}]) {
      updates(limit: 50) {
        id
        text_body
        created_at
        creator { id name }
      }
    }
  }`
  const data = await mondayQuery<{ items: Array<{ updates: any[] }> }>(query)
  const updates: any[] = data?.items?.[0]?.updates || []
  return updates
    .map((u: any) => ({
      id: String(u.id),
      body: u.text_body || '',
      author: u.creator?.name || 'Unknown',
      createdAt: u.created_at || '',
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
