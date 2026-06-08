// lib/monday-projects.ts
// Read helpers for the /projects board (Obsidian-style project graph).
//
// Pulls the "Projects" group from each of the six per-person "Hidden To Do"
// boards and exposes each item's comment thread (Monday "updates"). This is the
// READ side; posting a comment reuses createUpdate() from lib/monday-update.ts.
//
// All GraphQL goes through the shared mondayQuery() (lib/monday-followup.ts) so
// there's ONE client + ONE token (MONDAY_API_TOKEN, full read+write) across the
// codebase. The board list mirrors MANAGER_BOARDS in pages/api/todos.ts — only
// Chris's board carries a Priority column.

import { mondayQuery } from './monday-followup'

// Per-person To-Do boards. `color` matches the MC map in pages/todos.tsx so the
// graph hubs and the chip row stay in lockstep.
export interface PersonBoard {
  key: string        // stable id (manager first name)
  name: string       // display name
  color: string      // accent
  boardId: number
  hasPriority: boolean
}

export const PERSON_BOARDS: PersonBoard[] = [
  { key: 'Chris',  name: 'Chris',  color: '#4f8ef7', boardId: 1838427899, hasPriority: true  },
  { key: 'Matt H', name: 'Matt H', color: '#a78bfa', boardId: 2006328423, hasPriority: false },
  { key: 'Amanda', name: 'Amanda', color: '#ff5ac4', boardId: 2063839393, hasPriority: false },
  { key: 'Morgan', name: 'Morgan', color: '#f5a623', boardId: 2006328760, hasPriority: false },
  { key: 'Ryan',   name: 'Ryan',   color: '#2dd4bf', boardId: 1839578010, hasPriority: false },
  { key: 'Sam',    name: 'Sam',    color: '#34c77b', boardId: 5024204351, hasPriority: false },
]

// Chris's board is the only one with a Priority column (see board discovery).
const PRIORITY_COLUMN_ID = 'color_mks0522q'

export interface ProjectItem {
  id: string
  name: string
  status: string
  priority: string | null
  url: string
  createdAt: string
  updatedAt: string
  hasUpdates: boolean
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
  body: string        // text_body (plain text)
  author: string
  createdAt: string
}

// Match the "Projects" group regardless of its per-board group id (Chris's is
// group_mm3qm3x2; the others differ). Case/whitespace tolerant.
function isProjectsGroup(title: string | null | undefined): boolean {
  return !!title && title.trim().toLowerCase() === 'projects'
}

// Pull one board's Projects-group items. We fetch every group's items in a
// single round-trip (each board has <= ~225 items total) and keep only the
// "Projects" group — robust to the group id differing per board.
async function fetchBoardProjects(board: PersonBoard): Promise<PersonProjects> {
  const cols = board.hasPriority ? `["status","${PRIORITY_COLUMN_ID}"]` : `["status"]`
  const query = `{
    boards(ids: [${board.boardId}]) {
      groups {
        id
        title
        items_page(limit: 200) {
          items {
            id
            name
            url
            created_at
            updated_at
            column_values(ids: ${cols}) { id text }
            updates(limit: 1) { id }
          }
        }
      }
    }
  }`
  const data = await mondayQuery<{ boards: Array<{ groups: any[] }> }>(query)
  const groups = data?.boards?.[0]?.groups || []
  const projectsGroup = groups.find((g: any) => isProjectsGroup(g?.title))
  const items: any[] = projectsGroup?.items_page?.items || []

  const projects: ProjectItem[] = items.map((it: any) => {
    const status = it.column_values?.find((c: any) => c.id === 'status')?.text || ''
    const priority = board.hasPriority
      ? (it.column_values?.find((c: any) => c.id === PRIORITY_COLUMN_ID)?.text || null)
      : null
    return {
      id: String(it.id),
      name: it.name || '(untitled)',
      status,
      priority,
      url: it.url || `https://just-autos.monday.com/boards/${board.boardId}/pulses/${it.id}`,
      createdAt: it.created_at || '',
      updatedAt: it.updated_at || '',
      hasUpdates: Array.isArray(it.updates) && it.updates.length > 0,
    }
  })

  return { key: board.key, name: board.name, color: board.color, boardId: board.boardId, projects }
}

// Fetch all six boards in parallel; a board that errors yields an empty list
// rather than failing the whole response.
export async function fetchAllProjects(): Promise<PersonProjects[]> {
  const results = await Promise.all(
    PERSON_BOARDS.map(async (b) => {
      try {
        return await fetchBoardProjects(b)
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
