// lib/library-docs.ts
// SERVER-ONLY registry for the admin Library (/admin/library).
//
// The documents live in docs/ as markdown (the editable source) alongside a
// rendered PDF. The Library reads both straight off disk: the markdown becomes
// the on-screen reader, the PDF is what people download.
//
// Adding a document = drop the .md and .pdf into docs/, add a row here. Nothing
// else needs touching. If you add one, regenerate its PDF with
//   REPO=$PWD node scripts/render-doc-pdf.js docs/X.md docs/X.pdf "Title" "Sub"
//
// NOTE: docs/** is force-included in the serverless bundle via
// outputFileTracingIncludes in next.config.js — Next's tracer can't see these
// reads because the paths are built at runtime. If a doc 404s in production but
// works locally, that config is the first thing to check.

import fs from 'fs'
import path from 'path'

export interface LibraryDoc {
  slug: string
  title: string
  /** One line, shown on the Library card. */
  description: string
  /** Who it's for — shown as a hint under the title. */
  audience: string
  md: string
  pdf: string
  /** Sensitive docs are called out in the UI so nobody forwards them casually. */
  confidential?: boolean
}

export const LIBRARY_DOCS: LibraryDoc[] = [
  {
    slug: 'sop',
    title: 'Standard Operating Procedures',
    description: 'How to use the portal, task by task — bookings through to invoicing, distributor despatch, AP, the follow-up cadence and reporting.',
    audience: 'All staff',
    md: 'docs/SOP.md',
    pdf: 'docs/SOP.pdf',
  },
  {
    slug: 'distributor-app-install',
    title: 'Installing the Just Autos Wholesale app',
    description: 'Step-by-step install for distributors — iPhone, Android, Windows and Mac — plus turning on order notifications. Written to be sent to them as-is.',
    audience: 'Distributors (send them the PDF)',
    md: 'docs/distributor-app-install-sop.md',
    pdf: 'docs/distributor-app-install-sop.pdf',
  },
  {
    slug: 'handover',
    title: 'Full Handover Document',
    description: 'How the portal is built, where it runs, every integration and credential location, the scheduled automation, and known risks.',
    audience: 'Admins & technical',
    md: 'docs/HANDOVER.md',
    pdf: 'docs/HANDOVER.pdf',
    confidential: true,
  },
]

export function findDoc(slug: string | string[] | undefined): LibraryDoc | null {
  if (typeof slug !== 'string') return null
  return LIBRARY_DOCS.find(d => d.slug === slug) || null
}

const abs = (rel: string) => path.join(process.cwd(), rel)

export function readMarkdown(doc: LibraryDoc): string {
  return fs.readFileSync(abs(doc.md), 'utf8')
}

export function readPdf(doc: LibraryDoc): Buffer {
  return fs.readFileSync(abs(doc.pdf))
}

/** Card metadata. Never throws — a missing file shows as unavailable rather
 *  than breaking the whole Library listing. */
export function docStats(doc: LibraryDoc): { updatedAt: string | null; pdfKb: number | null } {
  try {
    const mdStat = fs.statSync(abs(doc.md))
    let pdfKb: number | null = null
    try { pdfKb = Math.round(fs.statSync(abs(doc.pdf)).size / 1024) } catch { /* pdf not built */ }
    return { updatedAt: mdStat.mtime.toISOString(), pdfKb }
  } catch {
    return { updatedAt: null, pdfKb: null }
  }
}
