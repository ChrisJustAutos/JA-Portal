// lib/ac-deal-migrate.ts
// Move quoted deals out of the "Old Quotes" archive into the New Quote
// Pipeline, so the nightly sweep can action them.
//
// WHAT WENT WRONG
// Group 5 "Old Quotes" is an archive (33,958 deals, one stage). Until they
// were switched off, the Make/Zapier form automations were still creating
// enquiry deals in it rather than in group 6 "New Quote Pipeline" — which was
// only built in Dec 2025. Pipeline A then found those deals (its contact
// lookup is not pipeline-filtered), appended the quote number and updated
// them IN PLACE, leaving live quoted work sitting in the archive.
//
// The boundary is clean and worth knowing: group 5 holds quoted deals only
// from April 2026, which is when Pipeline A went live. Every group-5 deal
// before that is an unquoted enquiry worth $0 — genuine archive material that
// this must not touch. As at 2026-09-04 the affected set was 1,052 open
// quoted deals worth $13.1M, against a live pipeline of $14.4M. Nearly half
// the pipeline was invisible.
//
// WHAT THIS DOES
// Moves each matching deal to group 6 at stage 38 "Quote Sent" — they carry a
// quote number, so Quote Sent is where they belong — and writes a note
// recording exactly where it came from, so the move can be audited or undone.
// It changes nothing else: not the value, not the owner, not the title, and
// NOT the status. Won/Lost is the sweep's job, on its own evidence, the
// following night.
//
// Verified against the live API: PUT /deals/{id} with {group, stage} moves a
// deal between pipelines, preserves the value, and is reversible by putting
// the original group and stage back.
//
// DRY BY DEFAULT. This is a bulk write with no batch undo.

import {
  AC_GROUP,
  STAGE_QUOTE_LOST,
  STAGE_QUOTE_WON,
  quoteNumbersFromTitle,
  LOST_AFTER_DAYS,
} from './ac-deal-sweep'

export const ARCHIVE_GROUP = '5'
export const STAGE_QUOTE_SENT = '38'

/** Quoted deals only exist in the archive from Pipeline A's go-live. */
export const DEFAULT_CUTOFF = process.env.AC_MIGRATE_CUTOFF || '2026-04-01'

function acFetch(path: string, opts: RequestInit = {}) {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) throw new Error('ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY not set')
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    ...opts,
    headers: {
      'Api-Token': apiKey, 'Content-Type': 'application/json', Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
}

async function acJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await acFetch(path, opts)
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}: ${(await r.text()).substring(0, 300)}`)
  return r.json()
}

export interface MigrateCandidate {
  id: string
  title: string
  value: number
  cdate: string
  mdate: string
  quote: string
  daysIdle: number
  wouldBeLost: boolean
}

export interface MigrateReport {
  live: boolean
  cutoff: string
  archiveScanned: number
  candidates: number
  totalValue: number
  moved: number
  notesWritten: number
  wouldBeLostImmediately: number
  wouldBeLostValue: number
  capped: boolean
  timeBudgetHit: boolean
  elapsedMs: number
  byMonth: Array<{ month: string; deals: number; value: number }>
  samples: MigrateCandidate[]
  errors: string[]
}

/**
 * Find open, quoted deals sitting in the archive.
 * Pages newest-first and stops at the cutoff — the archive is 34k deals and
 * there is no reason to read the pre-2026 bulk of it.
 */
export async function findArchivedQuotedDeals(cutoff: string, maxPages = 200): Promise<{
  candidates: MigrateCandidate[]; scanned: number; complete: boolean
}> {
  const cutMs = new Date(cutoff).getTime()
  const out: MigrateCandidate[] = []
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  let offset = 0, pages = 0, scanned = 0, complete = false

  while (pages < maxPages) {
    const data = await acJson<{ deals: any[] }>(
      `/deals?filters[group]=${ARCHIVE_GROUP}&orders[cdate]=DESC&limit=100&offset=${offset}`,
    )
    const page = data.deals || []
    pages++
    if (page.length === 0) { complete = true; break }

    let crossed = false
    for (const d of page) {
      // Re-verify group client-side — AC ignores a filter it doesn't know
      // rather than rejecting it, and moving deals out of the WRONG pipeline
      // would be a genuine mess.
      if (String(d.group) !== ARCHIVE_GROUP) continue
      const t = new Date(d.cdate).getTime()
      if (Number.isFinite(t) && t < cutMs) { crossed = true; continue }
      scanned++
      if (Number(d.status) !== 0) continue              // open only
      const qs = quoteNumbersFromTitle(String(d.title || ''))
      if (qs.length === 0) continue                     // quoted only

      const mdate = String(d.mdate || d.cdate || '')
      const touched = new Date(mdate).getTime()
      const daysIdle = Number.isFinite(touched) ? Math.floor((now - touched) / DAY) : 0
      out.push({
        id: String(d.id),
        title: String(d.title || ''),
        value: (Number(d.value) || 0) / 100,
        cdate: String(d.cdate || ''),
        mdate,
        quote: qs[qs.length - 1],
        daysIdle,
        wouldBeLost: daysIdle >= LOST_AFTER_DAYS,
      })
    }
    if (crossed) { complete = true; break }
    offset += 100
  }
  return { candidates: out, scanned, complete }
}

export async function runArchiveMigration(opts: {
  live: boolean
  cutoff?: string
  limit?: number
}): Promise<MigrateReport> {
  const cutoff = opts.cutoff || DEFAULT_CUTOFF
  const limit = opts.limit ?? 250
  const CONCURRENCY = Number(process.env.AC_MIGRATE_CONCURRENCY || 6)
  const BUDGET_MS = Number(process.env.AC_MIGRATE_BUDGET_MS || 230000)
  const startedAt = Date.now()

  const report: MigrateReport = {
    live: opts.live, cutoff,
    archiveScanned: 0, candidates: 0, totalValue: 0,
    moved: 0, notesWritten: 0,
    wouldBeLostImmediately: 0, wouldBeLostValue: 0,
    capped: false, timeBudgetHit: false, elapsedMs: 0,
    byMonth: [], samples: [], errors: [],
  }

  const found = await findArchivedQuotedDeals(cutoff)
  report.archiveScanned = found.scanned
  report.candidates = found.candidates.length
  report.totalValue = Math.round(found.candidates.reduce((s, c) => s + c.value, 0) * 100) / 100

  // What the sweep would do to them the following night. Stated up front
  // because moving a deal into the pipeline is also volunteering it for the
  // Lost pass, and that is the part with no undo.
  const lost = found.candidates.filter(c => c.wouldBeLost)
  report.wouldBeLostImmediately = lost.length
  report.wouldBeLostValue = Math.round(lost.reduce((s, c) => s + c.value, 0) * 100) / 100

  const months = new Map<string, { deals: number; value: number }>()
  for (const c of found.candidates) {
    const m = c.cdate.substring(0, 7)
    const cur = months.get(m) || { deals: 0, value: 0 }
    cur.deals++; cur.value += c.value
    months.set(m, cur)
  }
  report.byMonth = Array.from(months.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, v]) => ({ month, deals: v.deals, value: Math.round(v.value) }))

  report.samples = found.candidates.slice(0, 25)

  const queue = found.candidates.slice(0, limit)
  report.capped = found.candidates.length > limit

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) { report.timeBudgetHit = true; break }
    const group = queue.slice(i, i + CONCURRENCY)
    await Promise.all(group.map(async c => {
      if (!opts.live) return
      try {
        await acJson(`/deals/${c.id}`, {
          method: 'PUT',
          body: JSON.stringify({ deal: { group: AC_GROUP, stage: STAGE_QUOTE_SENT } }),
        })
        report.moved++
        try {
          const note = [
            `Moved into the New Quote Pipeline by the portal on ${new Date().toISOString().substring(0, 10)}.`,
            `It was created in "Old Quotes" (pipeline ${ARCHIVE_GROUP}, stage 32) because the Make/Zapier form`,
            'automations were still writing there; those are now switched off.',
            `Quote ${c.quote}. Nothing else was changed — value, owner and status are untouched.`,
            'To undo: put the deal back to pipeline 5, stage 32.',
          ].join('\n')
          await acJson(`/notes`, {
            method: 'POST',
            body: JSON.stringify({ note: { note, relid: Number(c.id), reltype: 'Deal' } }),
          })
          report.notesWritten++
        } catch (e: any) {
          // The move is the deliverable; the audit note is not worth failing on.
          console.warn(`[ac-migrate] note failed on deal ${c.id}:`, e?.message)
        }
      } catch (e: any) {
        report.errors.push(`deal ${c.id}: ${e?.message || String(e)}`)
      }
    }))
  }

  report.elapsedMs = Date.now() - startedAt
  return report
}

// Re-exported so the endpoint can describe what happens next without
// re-deriving the stage numbers.
export const NEXT_STEP_STAGES = { won: STAGE_QUOTE_WON, lost: STAGE_QUOTE_LOST }
