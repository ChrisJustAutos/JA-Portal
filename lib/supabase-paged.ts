// lib/supabase-paged.ts
//
// PostgREST caps EVERY response at the project's `db-max-rows` (1000 here) no
// matter what `.limit()` asks for, and it truncates SILENTLY — no error, no
// flag on the response. A select whose result set grows past 1000 rows simply
// starts losing rows off the end of the sort order.
//
// This broke the Monday-morning Quotes & Jobs Map report on 2026-08-24: its
// 35-day md_quotes window had grown to 1385 rows, the 1000 that came back were
// all baseline weeks, and the email told Matt/Ryan/Chris "0 quotes issued" for
// a week that actually had 313. It had been quietly under-counting for weeks
// before that (222 reported vs 290 actual on 2026-08-16) — the failure mode is
// a plausible-looking smaller number, which is why nobody caught it earlier.
//
// Use selectAllRows() for ANY select whose row count can realistically exceed
// 1000. Never rely on a big `.limit()`.

// PostgREST refuses to return more than db-max-rows per request, so the page
// size can never usefully exceed it.
const MAX_PAGE = 1000

/**
 * Run a Supabase select in pages of <= 1000 rows and return every row.
 *
 * `build` must return a FRESH query builder each call (filters applied, no
 * .order/.range/.limit) — the paging adds its own ordering and range.
 *
 * `orderBy` must be a UNIQUE column (the table's primary key is the safe
 * choice). Paging on a non-unique column lets rows that tie across a page
 * boundary be skipped or repeated.
 */
export async function selectAllRows<T = any>(
  build: () => any,
  orderBy: string,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.min(Math.max(Math.floor(opts.pageSize ?? MAX_PAGE), 1), MAX_PAGE)
  // Backstop so a runaway filter can't page a whole table into memory.
  const maxRows = Math.max(Math.floor(opts.maxRows ?? 200_000), pageSize)
  const out: T[] = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await build()
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw error
    const rows = (data || []) as T[]
    out.push(...rows)
    // A short page means we've reached the end. A full page that also hits the
    // backstop is a genuine truncation — loud, not silent.
    if (rows.length < pageSize) return out
  }
  throw new Error(`selectAllRows: hit the ${maxRows}-row backstop paging on "${orderBy}" — narrow the filter or raise maxRows`)
}
